import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:cluster';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashUserIdentity, MetricsCounter } from '../../../src/shared/transport-metrics.js';
import {
	attachWorkerIpc,
	clusterWorkerId,
	createForwardingMetrics,
	flushIpcBatch,
	forward,
	getWorkerIpcDropped,
	IpcTimeoutError,
	isClusterWorker,
	remote,
} from '../../../src/server/cluster/ipc.js';

function asClusterWorker(child: ChildProcess): Worker {
	return {
		id: 1,
		on: (event: string, listener: (...args: unknown[]) => void) => child.on(event, listener),
		isConnected: () => child.connected,
		send: (msg: unknown, _sendHandle?: unknown, _options?: unknown, cb?: (err: Error | null) => void) =>
			child.send(msg as Parameters<ChildProcess['send']>[0], undefined, undefined, cb),
	} as unknown as Worker;
}

describe('Cluster IPC primitives', () => {
	it('runs directly with zero IPC overhead in single-process mode', async () => {
		expect(isClusterWorker).toBe(false);
		expect(clusterWorkerId).toBe(0);
		expect(getWorkerIpcDropped()).toBe(0);

		const seen: number[] = [];
		const direct = forward('test.direct', (n: number) => {
			seen.push(n);
		});
		direct(42);
		expect(seen).toEqual([42]);

		const rpc = remote('test.directRpc', (a: number, b: number) => a + b);
		await expect(rpc(20, 22)).resolves.toBe(42);

		const counter = new MetricsCounter();
		expect(createForwardingMetrics(counter)).toBe(counter);
		await expect(flushIpcBatch(100)).resolves.toEqual({ completed: true, unsent: 0 });
	});

	it('round-trips forward batches, error isolation, forwarding metrics, remote RPCs, timeouts, and flushIpcBatch over a forked worker', async () => {
		const primaryCounter = new MetricsCounter();
		createForwardingMetrics(primaryCounter);

		const receivedEvents: string[] = [];
		forward('test.event', (label: string) => {
			receivedEvents.push(label);
		});
		forward('test.boom', () => {
			throw new Error('intentional handler error');
		});

		remote('test.add', (a: number, b: number) => a + b);
		remote('test.fail', () => {
			throw new Error('boom from primary');
		});
		remote('test.slow', async () => {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			return 'too-late';
		});

		const ipcModulePath = path.resolve(import.meta.dirname, '../../../src/server/cluster/ipc.ts');
		const metricsModulePath = path.resolve(import.meta.dirname, '../../../src/shared/transport-metrics.ts');
		const workerScript = `
			import {
				isClusterWorker,
				clusterWorkerId,
				forward,
				remote,
				flushIpcBatch,
				getWorkerIpcDropped,
				createForwardingMetrics,
				IpcTimeoutError,
			} from ${JSON.stringify(ipcModulePath)};
			import { MetricsCounter } from ${JSON.stringify(metricsModulePath)};

			const emitEvent = forward('test.event', () => {});
			const emitBoom = forward('test.boom', () => {});
			const callAdd = remote('test.add', () => 0, 2000);
			const callFail = remote('test.fail', () => 0, 2000);
			const callSlow = remote('test.slow', () => '', 120);

			const forwardedMetrics = createForwardingMetrics(new MetricsCounter());

			const results = {
				isClusterWorker,
				clusterWorkerId,
				addResult: null,
				failError: null,
				timeoutIsIpcTimeout: false,
				userHash: null,
				dropped: 0,
			};

			// Test batch forwarding + error isolation in the same batch
			emitEvent('first');
			emitBoom();
			emitEvent('second');

			// Test forwarding metrics (plain-data serialization + local hashing)
			forwardedMetrics.trackRequest();
			forwardedMetrics.associateSessionWithClient({ name: 'worker-client', version: '1.0' });
			results.userHash = forwardedMetrics.trackAuthenticatedUser('Alice', 'legacy', '2025-03-26', {
				name: 'worker-client',
				version: '1.0',
			});
			forwardedMetrics.trackClientAuth('hf_secret_token_never_sent_raw', {
				name: 'worker-client',
				version: '1.0',
			});
			forwardedMetrics.trackError(500, new TypeError('bad payload'));

			// Test RPC success, error, and timeout
			results.addResult = await callAdd(17, 25);
			try {
				await callFail();
			} catch (err) {
				results.failError = err instanceof Error ? err.message : String(err);
			}
			try {
				await callSlow();
			} catch (err) {
				results.timeoutIsIpcTimeout = err instanceof IpcTimeoutError;
			}

			await flushIpcBatch(2000);
			results.dropped = getWorkerIpcDropped();
			process.send({ t: 'worker-done', results }, () => process.exit(0));
		`;

		const tsxImport = pathToFileURL(
			path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/esm/index.mjs')
		).href;
		const child = spawn(process.execPath, ['--import', tsxImport, '--input-type=module', '-e', workerScript], {
			env: {
				...process.env,
				NODE_UNIQUE_ID: '7',
				MCP_CLUSTER_WORKER: '1',
				MCP_WORKER_ID: '7',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		let stderrBuf = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrBuf += chunk.toString('utf8');
		});

		const customMessages: Array<Record<string, unknown>> = [];
		let resolveDone!: (results: Record<string, unknown>) => void;
		const donePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveDone = resolve;
			child.once('error', reject);
			child.once('exit', (code) => {
				if (code !== 0) {
					reject(new Error(`Worker exited with code ${String(code)}: ${stderrBuf}`));
				}
			});
		});

		attachWorkerIpc(asClusterWorker(child), (_worker, msg) => {
			customMessages.push(msg);
			if (msg.t === 'worker-done') {
				resolveDone(msg.results as Record<string, unknown>);
			}
		});

		const results = await donePromise;
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) resolve();
			else child.once('exit', () => resolve());
		});

		expect(results.isClusterWorker).toBe(true);
		expect(results.clusterWorkerId).toBe(7);
		expect(results.addResult).toBe(42);
		expect(results.failError).toBe('boom from primary');
		expect(results.timeoutIsIpcTimeout).toBe(true);
		expect(results.userHash).toBe(hashUserIdentity('Alice'));
		expect(results.dropped).toBe(0);

		// Per-item error isolation: 'second' still ran even though 'test.boom' threw!
		expect(receivedEvents).toEqual(['first', 'second']);
		expect(customMessages.some((m) => m.t === 'batch-meta' && m.dropped === 0)).toBe(true);

		// Verify primaryCounter received all forwarded metrics accurately
		const snapshot = primaryCounter.getMetrics();
		expect(snapshot.requests.total).toBe(1);
		expect(snapshot.connections.uniqueUsers).toBe(1);
		expect(snapshot.errors.unexpected).toBe(1);
		expect(snapshot.errors.lastError?.type).toBe('TypeError');
		expect(snapshot.errors.lastError?.message).toBe('bad payload');

		const client = snapshot.clients.get('worker-client 1.0');
		expect(client?.uniqueAuthCount).toBe(1);
		expect(client?.uniqueUserCount).toBe(1);
	}, 15_000);

	it('rejects in-flight remote RPC with IpcTimeoutError when IPC channel disconnects', async () => {
		const ipcModulePath = path.resolve(import.meta.dirname, '../../../src/server/cluster/ipc.ts');
		const workerScript = `
			import { remote, IpcTimeoutError } from ${JSON.stringify(ipcModulePath)};
			const callHang = remote('test.hang', () => 'never', 5000);
			process.send({ t: 'ready' });
			try {
				await callHang();
				process.exit(2);
			} catch (err) {
				process.exit(err instanceof IpcTimeoutError ? 0 : 3);
			}
		`;

		const tsxImport = pathToFileURL(
			path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/esm/index.mjs')
		).href;
		const child = spawn(process.execPath, ['--import', tsxImport, '--input-type=module', '-e', workerScript], {
			env: {
				...process.env,
				NODE_UNIQUE_ID: '8',
				MCP_CLUSTER_WORKER: '1',
				MCP_WORKER_ID: '8',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.on('message', (msg: unknown) => {
				if (typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'ready') {
					setTimeout(() => {
						child.disconnect();
					}, 30);
				}
			});
			child.once('exit', (code) => resolve(code));
		});

		expect(exitCode).toBe(0);
	}, 15_000);

	it('chunks outgoing IPC batches by byte limit and delivers all items in order', async () => {
		const received: number[] = [];
		forward('test.chunked', (idx: number, _payload: string) => {
			received.push(idx);
		});

		const ipcModulePath = path.resolve(import.meta.dirname, '../../../src/server/cluster/ipc.ts');
		const workerScript = `
			import { forward, flushIpcBatch, getWorkerIpcDropped } from ${JSON.stringify(ipcModulePath)};
			const emit = forward('test.chunked', () => {});
			const pad = 'x'.repeat(1024);
			for (let i = 0; i < 20; i++) {
				emit(i, pad);
			}
			const flush = await flushIpcBatch(3000);
			process.send({ t: 'done', flush, dropped: getWorkerIpcDropped() }, () => process.exit(0));
		`;

		const tsxImport = pathToFileURL(
			path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/esm/index.mjs')
		).href;
		const child = spawn(process.execPath, ['--import', tsxImport, '--input-type=module', '-e', workerScript], {
			env: {
				...process.env,
				NODE_UNIQUE_ID: '9',
				MCP_CLUSTER_WORKER: '1',
				MCP_WORKER_ID: '9',
				CLUSTER_IPC_MAX_BATCH_BYTES: '4096',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});

		let batchCount = 0;
		const rawBatchSizes: number[] = [];
		child.on('message', (raw: unknown) => {
			if (raw && typeof raw === 'object' && (raw as { t?: unknown }).t === 'batch') {
				batchCount++;
				const items = (raw as { items?: unknown[] }).items ?? [];
				rawBatchSizes.push(items.length);
			}
		});

		let resolveDone!: (msg: Record<string, unknown>) => void;
		const donePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveDone = resolve;
			child.once('error', reject);
			child.once('exit', (code) => {
				if (code !== 0) reject(new Error(`Worker exited with code ${String(code)}`));
			});
		});

		attachWorkerIpc(asClusterWorker(child), (_w, msg) => {
			if (msg.t === 'done') resolveDone(msg);
		});

		const done = await donePromise;
		expect(done.dropped).toBe(0);
		expect(done.flush).toEqual({ completed: true, unsent: 0 });
		// 20 items of ~1KB each with 4096-byte batch cap must span multiple batches (<= 4 items per batch)
		expect(batchCount).toBeGreaterThanOrEqual(5);
		expect(Math.max(...rawBatchSizes)).toBeLessThanOrEqual(4);
		expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i));
	}, 15_000);

	it('drops excess items and increments getWorkerIpcDropped when CLUSTER_IPC_MAX_PENDING_BYTES is exceeded', async () => {
		const received: number[] = [];
		forward('test.bounded', (idx: number, _payload: string) => {
			received.push(idx);
		});

		const ipcModulePath = path.resolve(import.meta.dirname, '../../../src/server/cluster/ipc.ts');
		const workerScript = `
			import { forward, flushIpcBatch, getWorkerIpcDropped } from ${JSON.stringify(ipcModulePath)};
			const emit = forward('test.bounded', () => {});
			// Oversized single item (> MAX_PENDING_BYTES) is dropped immediately
			emit(-1, 'z'.repeat(10_000));
			// Burst of 1KB items exceeding the 4096-byte pending backlog cap while first batch is in flight
			const pad = 'y'.repeat(1024);
			for (let i = 0; i < 30; i++) {
				emit(i, pad);
			}
			await flushIpcBatch(3000);
			process.send({ t: 'done', dropped: getWorkerIpcDropped() }, () => process.exit(0));
		`;

		const tsxImport = pathToFileURL(
			path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/esm/index.mjs')
		).href;
		const child = spawn(process.execPath, ['--import', tsxImport, '--input-type=module', '-e', workerScript], {
			env: {
				...process.env,
				NODE_UNIQUE_ID: '10',
				MCP_CLUSTER_WORKER: '1',
				MCP_WORKER_ID: '10',
				CLUSTER_IPC_MAX_BATCH_BYTES: '2048',
				CLUSTER_IPC_MAX_PENDING_BYTES: '4096',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});

		let resolveDone!: (msg: Record<string, unknown>) => void;
		const donePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveDone = resolve;
			child.once('error', reject);
			child.once('exit', (code) => {
				if (code !== 0) reject(new Error(`Worker exited with code ${String(code)}`));
			});
		});

		attachWorkerIpc(asClusterWorker(child), (_w, msg) => {
			if (msg.t === 'done') resolveDone(msg);
		});

		const done = await donePromise;
		expect(Number(done.dropped)).toBeGreaterThan(0);
		expect(received).not.toContain(-1);
		expect(received.length + Number(done.dropped)).toBe(31);
	}, 15_000);
});
