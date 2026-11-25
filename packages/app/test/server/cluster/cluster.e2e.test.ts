import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockHub, type MockHubHandle } from '../../support/mock-hub.js';

const APP_ROOT = path.resolve(import.meta.dirname, '../../..');
const DIST_ENTRY = path.resolve(APP_ROOT, 'dist/server/streamableHttp.js');

async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close(() => reject(new Error('Failed to allocate ephemeral port')));
				return;
			}
			const { port } = addr;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
		srv.on('error', reject);
	});
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 150): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const val = await fn();
			if (val !== undefined) return val;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${String(timeoutMs)}ms${lastErr ? `: ${String(lastErr)}` : ''}`);
}

interface TransportMetricsApi {
	requests: { total: number };
	connections: { uniqueUsers?: number; unauthorized: number };
	sessionLifecycle?: { created: number; deleted: number };
	runtimeMetrics?: {
		http: { totalRequests: number };
		cluster?: {
			enabled: boolean;
			desiredWorkers: number;
			activeWorkers: number;
			totalRestarts: number;
			ipcDropped: number;
			sessionRpcFailures: number;
			workers: Array<{ workerId: number; pid: number; totalRequests: number }>;
		};
	};
}

describe('Cluster mode E2E (2 workers + Mock Hub)', () => {
	let mockHub: MockHubHandle | null = null;
	let child: ChildProcess | null = null;

	beforeAll(() => {
		if (process.env.MCP_SERVER_TEST_BUILT !== '1' || !existsSync(DIST_ENTRY)) {
			const tscBin = path.resolve(APP_ROOT, 'node_modules/typescript/bin/tsc');
			const mcpRoot = path.resolve(APP_ROOT, '../mcp');
			execFileSync(process.execPath, [tscBin, '--declaration'], {
				cwd: mcpRoot,
				stdio: 'pipe',
			});
			execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.server.json'], {
				cwd: APP_ROOT,
				stdio: 'pipe',
			});
		}
	});

	afterAll(async () => {
		if (child && child.exitCode === null) {
			child.kill('SIGKILL');
			await new Promise<void>((resolve) => child?.once('exit', () => resolve()));
		}
		if (mockHub) {
			await mockHub.close();
		}
	});

	it('serves cross-worker sessions, aggregates metrics & PTC, survives worker SIGKILL, and flushes dataset logs on SIGTERM', async () => {
		mockHub = await startMockHub();
		const port = await getFreePort();
		const baseUrl = `http://127.0.0.1:${String(port)}`;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: 'production',
			MCP_WORKERS: '2',
			ANALYTICS_MODE: 'true',
			MCP_WORKER_HEADER: 'true',
			METRICS_PAGE_PASSWORD: 'e2epass',
			LOGGING_DATASET_ID: 'hf-internal/mcp-cluster-e2e',
			LOGGING_HF_TOKEN: 'hf_e2e_logging_token',
			LOGGING_HUB_URL: mockHub.baseUrl,
			LOGGING_FLUSH_INTERVAL: '60000',
			HF_WHOAMI_URL: mockHub.whoamiUrl,
			SHUTDOWN_GRACE_MS: '15000',
		};
		// Delete VITEST so real Pino dataset logger worker threads run in supervisor,
		// and strip external Hub/config env vars so tests stay 100% hermetic.
		delete env.VITEST;
		delete env.VITEST_POOL_ID;
		delete env.VITEST_WORKER_ID;
		delete env.USER_CONFIG_API;
		delete env.PROXY_TOOLS_CSV;
		delete env.HF_TOKEN;
		delete env.DEFAULT_HF_TOKEN;

		child = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
			env,
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderrLog = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrLog += chunk.toString('utf8');
		});

		const fetchMetrics = async (): Promise<TransportMetricsApi> => {
			const res = await fetch(`${baseUrl}/api/transport-metrics`, {
				headers: { 'X-Metrics-Password': 'e2epass' },
			});
			if (!res.ok) {
				throw new Error(`metrics status ${String(res.status)}`);
			}
			return (await res.json()) as TransportMetricsApi;
		};

		// Wait for both workers to be listening and reporting heartbeats
		const initialMetrics = await waitFor(async () => {
			const m = await fetchMetrics();
			const cluster = m.runtimeMetrics?.cluster;
			if (cluster?.enabled && cluster.activeWorkers === 2 && cluster.workers.length === 2) {
				return m;
			}
			return undefined;
		}, 15_000);
		expect(initialMetrics.runtimeMetrics?.cluster?.desiredWorkers).toBe(2);

		// 1. Cross-worker legacy session
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Connection: 'close',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'e2e-legacy', version: '1.0' },
				},
			}),
		});
		expect(initRes.status).toBe(200);
		const sessionId = initRes.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();

		const seenWorkers = new Set<string>();
		const initWorker = initRes.headers.get('x-mcp-worker');
		if (initWorker) seenWorkers.add(initWorker);

		let expectedMcpRequests = 1; // initialize
		for (let i = 0; i < 40 && seenWorkers.size < 2; i++) {
			const method = i % 2 === 0 ? 'ping' : 'tools/list';
			const pingRes = await fetch(method === 'tools/list' ? `${baseUrl}/mcp?gradio=none` : `${baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					'Mcp-Session-Id': sessionId!,
					'Mcp-Protocol-Version': '2025-06-18',
					Connection: 'close',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: i + 2,
					method,
					params: {},
				}),
			});
			expect(pingRes.status).toBe(200);
			expectedMcpRequests++;
			const w = pingRes.headers.get('x-mcp-worker');
			if (w) seenWorkers.add(w);
		}
		expect(seenWorkers.has('1')).toBe(true);
		expect(seenWorkers.has('2')).toBe(true);

		// DELETE /mcp (200) -> second DELETE (404) -> post-DELETE ping (404)
		const del1 = await fetch(`${baseUrl}/mcp`, {
			method: 'DELETE',
			headers: { 'Mcp-Session-Id': sessionId!, Connection: 'close' },
		});
		expect(del1.status).toBe(200);
		expectedMcpRequests++;

		const del2 = await fetch(`${baseUrl}/mcp`, {
			method: 'DELETE',
			headers: { 'Mcp-Session-Id': sessionId!, Connection: 'close' },
		});
		expect(del2.status).toBe(404);
		expectedMcpRequests++;

		const postDelPing = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'Mcp-Session-Id': sessionId!,
				'Mcp-Protocol-Version': '2025-06-18',
				Connection: 'close',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping', params: {} }),
		});
		expect(postDelPing.status).toBe(404);
		expectedMcpRequests++;

		// 2. Authenticated & PTC requests (modern 2026-07-28)
		const modernHeaders = (method: string, token?: string): Record<string, string> => ({
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'MCP-Method': method,
			'User-Agent': 'e2e-modern/1.0',
			Connection: 'close',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		});
		const modernBody = (id: number, method: string): string =>
			JSON.stringify({
				jsonrpc: '2.0',
				id,
				method,
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientInfo': { name: 'e2e-modern', version: '1.0' },
						'io.modelcontextprotocol/clientCapabilities': {},
					},
				},
			});

		const rAlice = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: modernHeaders('server/discover', 'hf_oauth_alice'),
			body: modernBody(101, 'server/discover'),
		});
		const aliceText = await rAlice.text();
		expect(rAlice.status, aliceText).toBe(200);
		expectedMcpRequests++;

		const rBob = await fetch(`${baseUrl}/mcp?gradio=none`, {
			method: 'POST',
			headers: modernHeaders('tools/list', 'hf_pat_bob'),
			body: modernBody(102, 'tools/list'),
		});
		expect(rBob.status).toBe(200);
		expectedMcpRequests++;

		const rInvalid = await fetch(`${baseUrl}/mcp?gradio=none`, {
			method: 'POST',
			headers: modernHeaders('tools/list', 'hf_invalid_bad'),
			body: modernBody(103, 'tools/list'),
		});
		expect(rInvalid.status).toBe(401);
		expectedMcpRequests++;

		const rPtc = await fetch(`${baseUrl}/mcp?bouquet=ptc`, {
			method: 'POST',
			headers: modernHeaders('tools/list'),
			body: modernBody(104, 'tools/list'),
		});
		expect(rPtc.status).toBe(200);
		expectedMcpRequests++;

		// 3. Dashboard parity (wait for worker 5s heartbeat + 1.5s metrics cache to reflect both workers)
		const metricsAfterTraffic = await waitFor(
			async () => {
				const m = await fetchMetrics();
				const workers = m.runtimeMetrics?.cluster?.workers ?? [];
				const bothWorkersServed = workers.length === 2 && workers.every((w) => w.totalRequests > 0);
				if (
					bothWorkersServed &&
					m.requests.total >= expectedMcpRequests &&
					(m.connections.uniqueUsers ?? 0) === 2 &&
					(m.sessionLifecycle?.deleted ?? 0) >= 1
				) {
					return m;
				}
				return undefined;
			},
			12_000,
			400
		);

		expect(metricsAfterTraffic.requests.total).toBe(expectedMcpRequests);
		expect(metricsAfterTraffic.connections.uniqueUsers).toBe(2);
		expect(metricsAfterTraffic.connections.unauthorized).toBeGreaterThanOrEqual(1);
		expect(metricsAfterTraffic.sessionLifecycle?.created).toBe(1);
		expect(metricsAfterTraffic.sessionLifecycle?.deleted).toBe(1);
		expect(metricsAfterTraffic.runtimeMetrics?.cluster?.activeWorkers).toBe(2);
		expect(metricsAfterTraffic.runtimeMetrics?.cluster?.ipcDropped).toBe(0);
		expect(metricsAfterTraffic.runtimeMetrics?.cluster?.sessionRpcFailures).toBe(0);

		const ptcRes = await fetch(`${baseUrl}/api/ptc-metrics`, {
			headers: { 'X-Metrics-Password': 'e2epass' },
		});
		expect(ptcRes.status).toBe(200);
		const ptcJson = (await ptcRes.json()) as { requests: number };
		expect(ptcJson.requests).toBeGreaterThanOrEqual(1);

		const skillsRes = await fetch(`${baseUrl}/api/skills-metrics`, {
			headers: { 'X-Metrics-Password': 'e2epass' },
		});
		expect(skillsRes.status).toBe(200);
		const skillsJson = (await skillsRes.json()) as {
			workerSnapshots?: Array<{ workerId: number; pid: number; stale: boolean; snapshot: { state: string } }>;
		};
		expect(skillsJson.workerSnapshots).toHaveLength(2);
		expect(skillsJson.workerSnapshots?.map((w) => w.workerId)).toEqual([1, 2]);
		expect(skillsJson.workerSnapshots?.every((w) => !w.stale)).toBe(true);

		const sessionsRes = await fetch(`${baseUrl}/api/sessions`, {
			headers: { 'X-Metrics-Password': 'e2epass' },
		});
		expect(sessionsRes.status).toBe(200);
		expect(sessionsRes.headers.get('x-total-count')).toBe('0');
		expect(sessionsRes.headers.get('x-sessions-truncated')).toBe('false');

		// Verify 1.5s /api/transport-metrics JSON cache over Node JSON IPC
		await new Promise((r) => setTimeout(r, 1_650));
		let cacheVerified = false;
		for (let attempt = 0; attempt < 2 && !cacheVerified; attempt++) {
			const tCache = Date.now();
			const cachedBefore = await fetchMetrics();
			const cacheProbe = await fetch(`${baseUrl}/mcp?gradio=none`, {
				method: 'POST',
				headers: modernHeaders('server/discover'),
				body: modernBody(199 + attempt, 'server/discover'),
			});
			expect(cacheProbe.status).toBe(200);
			await new Promise((r) => setTimeout(r, 150));
			const cachedHit = await fetchMetrics();
			if (Date.now() - tCache >= 1_400) {
				await new Promise((r) => setTimeout(r, 1_650));
				continue;
			}
			expect(cachedHit.requests.total).toBe(cachedBefore.requests.total);
			await new Promise((r) => setTimeout(r, 1_550));
			const cachedRefreshed = await fetchMetrics();
			expect(cachedRefreshed.requests.total).toBe(cachedBefore.requests.total + 1);
			cacheVerified = true;
		}
		expect(cacheVerified).toBe(true);

		// 4. Worker crash resilience
		const init2 = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Connection: 'close',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 200,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'e2e-survivor', version: '1.0' },
				},
			}),
		});
		expect(init2.status).toBe(200);
		const survivorSessionId = init2.headers.get('mcp-session-id');
		expect(survivorSessionId).toBeTruthy();

		const preKillTotalRequests = metricsAfterTraffic.runtimeMetrics!.http.totalRequests;
		const worker1 = metricsAfterTraffic.runtimeMetrics!.cluster!.workers.find((w) => w.workerId === 1)!;
		process.kill(worker1.pid, 'SIGKILL');

		const postKillMetrics = await waitFor(
			async () => {
				const m = await fetchMetrics();
				const c = m.runtimeMetrics?.cluster;
				if (
					c &&
					c.activeWorkers === 2 &&
					c.totalRestarts === 1 &&
					c.workers.length === 2 &&
					c.workers.every((w) => w.pid !== worker1.pid)
				) {
					return m;
				}
				return undefined;
			},
			12_000,
			300
		);

		expect(postKillMetrics.runtimeMetrics!.http.totalRequests).toBeGreaterThanOrEqual(preKillTotalRequests);

		// Surviving legacy session still resumes 200!
		const survivorPing = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'Mcp-Session-Id': survivorSessionId!,
				'Mcp-Protocol-Version': '2025-06-18',
				Connection: 'close',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'ping', params: {} }),
		});
		expect(survivorPing.status).toBe(200);

		// 5. Graceful SIGTERM + Dataset Log Drop verification
		const exitPromise = new Promise<number | null>((resolve) => {
			child!.once('exit', (code) => resolve(code));
		});
		child.kill('SIGTERM');
		const exitCode = await exitPromise;
		expect(exitCode, `Supervisor stderr:\n${stderrLog}`).toBe(0);

		const sessionLogFiles = mockHub.uploadedFiles.filter(
			(f) => f.path.startsWith('sessions/') && f.path.endsWith('.jsonl')
		);
		expect(sessionLogFiles.length).toBeGreaterThan(0);

		const allEntries = sessionLogFiles.flatMap((f) => f.entries);
		const initEntries = allEntries.filter((e) => e.methodName === 'initialize');
		const deleteEntries = allEntries.filter((e) => e.methodName === 'session_delete');
		expect(initEntries.length).toBeGreaterThanOrEqual(1);
		expect(deleteEntries.length).toBeGreaterThanOrEqual(1);

		const serverSessionIds = new Set(
			allEntries.map((e) => e.mcpServerSessionId).filter((v): v is string => typeof v === 'string' && v.length > 0)
		);
		expect(serverSessionIds.size).toBe(1);
	}, 45_000);

	it('keeps 1-worker supervisor alive across sole-worker SIGKILL (without dataset loggers) and exits 1 on crash loop', async () => {
		const port = await getFreePort();
		const baseUrl = `http://127.0.0.1:${String(port)}`;
		const baseEnv: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: 'production',
			MCP_WORKERS: '1',
			ANALYTICS_MODE: 'true',
			METRICS_PAGE_PASSWORD: 'e2epass',
			CLUSTER_RESPAWN_DELAY_MS: '100',
			SHUTDOWN_GRACE_MS: '5000',
		};
		delete baseEnv.VITEST;
		delete baseEnv.VITEST_POOL_ID;
		delete baseEnv.VITEST_WORKER_ID;
		delete baseEnv.LOGGING_DATASET_ID;
		delete baseEnv.LOGGING_HF_TOKEN;
		delete baseEnv.USER_CONFIG_API;
		delete baseEnv.PROXY_TOOLS_CSV;
		delete baseEnv.HF_TOKEN;
		delete baseEnv.DEFAULT_HF_TOKEN;

		const sup = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
			env: baseEnv,
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		try {
			const fetchM = async (): Promise<TransportMetricsApi> => {
				const res = await fetch(`${baseUrl}/api/transport-metrics`, {
					headers: { 'X-Metrics-Password': 'e2epass', Connection: 'close' },
					signal: AbortSignal.timeout(1_500),
				});
				if (!res.ok) throw new Error(`status ${String(res.status)}`);
				return (await res.json()) as TransportMetricsApi;
			};

			const first = await waitFor(async () => {
				const m = await fetchM();
				return m.runtimeMetrics?.cluster?.activeWorkers === 1 ? m : undefined;
			}, 10_000);
			const solePid = first.runtimeMetrics!.cluster!.workers[0]!.pid;
			process.kill(solePid, 'SIGKILL');

			const respawned = await waitFor(async () => {
				const m = await fetchM();
				const c = m.runtimeMetrics?.cluster;
				if (c?.activeWorkers === 1 && c.totalRestarts === 1 && c.workers[0]?.pid !== solePid) {
					return m;
				}
				return undefined;
			}, 10_000);
			expect(respawned.runtimeMetrics?.cluster?.totalRestarts).toBe(1);

			const exitCode = await new Promise<number | null>((resolve) => {
				sup.once('exit', (code) => resolve(code));
				sup.kill('SIGTERM');
			});
			expect(exitCode).toBe(0);
		} finally {
			if (sup.exitCode === null) sup.kill('SIGKILL');
		}

		// Sustained EADDRINUSE crash loop exits with code 1 (not 0)
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
		const blockedPort = (blocker.address() as { port: number }).port;
		const crashSup = spawn(process.execPath, [DIST_ENTRY, '--port', String(blockedPort)], {
			env: { ...baseEnv, CLUSTER_RESPAWN_DELAY_MS: '50' },
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		try {
			const crashCode = await new Promise<number | null>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Crash loop did not exit within 15s')), 15_000);
				crashSup.once('exit', (code) => {
					clearTimeout(timer);
					resolve(code);
				});
			});
			expect(crashCode).toBe(1);
		} finally {
			if (crashSup.exitCode === null) crashSup.kill('SIGKILL');
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 35_000);

	it('exits cleanly (code 0) when SIGTERM arrives during worker boot with short SHUTDOWN_GRACE_MS=3000', async () => {
		const port = await getFreePort();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: 'production',
			MCP_WORKERS: '2',
			SHUTDOWN_GRACE_MS: '3000',
		};
		delete env.VITEST;
		delete env.VITEST_POOL_ID;
		delete env.VITEST_WORKER_ID;
		delete env.LOGGING_DATASET_ID;
		delete env.LOGGING_HF_TOKEN;
		delete env.USER_CONFIG_API;
		delete env.PROXY_TOOLS_CSV;
		delete env.HF_TOKEN;
		delete env.DEFAULT_HF_TOKEN;

		const sup = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let resolvePrimaryStarted: (() => void) | undefined;
		const primaryStarted = new Promise<void>((resolve) => {
			resolvePrimaryStarted = resolve;
		});
		sup.stdout?.on('data', (c: Buffer) => {
			stdout += c.toString('utf8');
			if (stdout.includes('Starting cluster supervisor')) {
				resolvePrimaryStarted?.();
			}
		});
		sup.stderr?.on('data', (c: Buffer) => {
			stderr += c.toString('utf8');
		});
		try {
			// Wait until supervisor has registered SIGTERM and forked workers, then hit SIGTERM mid-worker-boot
			await Promise.race([primaryStarted, new Promise((r) => setTimeout(r, 3_000))]);
			await new Promise((r) => setTimeout(r, 20));
			const startedAt = Date.now();
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Early SIGTERM hung:\n${stderr}`)), 8_000);
				sup.once('exit', (code) => {
					clearTimeout(timer);
					resolve(code);
				});
				sup.kill('SIGTERM');
			});
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
			expect(Date.now() - startedAt).toBeLessThan(2_900);
		} finally {
			if (sup.exitCode === null) sup.kill('SIGKILL');
		}
	}, 15_000);

	it('exits cleanly (code 0) within 1.5s when SIGTERM arrives while workers are stalled in loadProxyToolsConfig()', async () => {
		// Local server that stalls proxy tool schema fetches for 8 seconds
		const heldResponses: Array<NodeJS.Timeout> = [];
		let resolveFetchHit: (() => void) | undefined;
		const fetchHit = new Promise<void>((resolve) => {
			resolveFetchHit = resolve;
		});
		const slowServer = createHttpServer((_req, res) => {
			resolveFetchHit?.();
			const timer = setTimeout(() => {
				if (!res.writableEnded) {
					res.statusCode = 504;
					res.end('timeout');
				}
			}, 8_000);
			timer.unref();
			heldResponses.push(timer);
		});
		await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
		const slowPort = (slowServer.address() as { port: number }).port;

		const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hf-mcp-slow-proxy-'));
		const csvPath = path.join(tmpDir, 'proxy-tools.csv');
		writeFileSync(csvPath, `proxy_id,url,response_type\nslow_proxy,http://127.0.0.1:${String(slowPort)}/mcp,JSON\n`);

		const port = await getFreePort();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: 'production',
			MCP_WORKERS: '2',
			SHUTDOWN_GRACE_MS: '3000',
			PROXY_TOOLS_CSV: csvPath,
		};
		delete env.VITEST;
		delete env.VITEST_POOL_ID;
		delete env.VITEST_WORKER_ID;
		delete env.LOGGING_DATASET_ID;
		delete env.LOGGING_HF_TOKEN;
		delete env.USER_CONFIG_API;
		delete env.HF_TOKEN;
		delete env.DEFAULT_HF_TOKEN;

		const sup = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		sup.stderr?.on('data', (c: Buffer) => {
			stderr += c.toString('utf8');
		});

		try {
			// Wait until at least one worker is actively stalled inside loadProxyToolsConfig()
			await Promise.race([
				fetchHit,
				new Promise((_, reject) => setTimeout(() => reject(new Error('Worker never hit slow proxy')), 5_000)),
			]);

			const startedAt = Date.now();
			const exitCode = await new Promise<number | null>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Slow-boot SIGTERM hung:\n${stderr}`)), 6_000);
				sup.once('exit', (code) => {
					clearTimeout(timer);
					resolve(code);
				});
				sup.kill('SIGTERM');
			});
			const elapsedMs = Date.now() - startedAt;
			expect(exitCode, stderr).toBe(0);
			expect(elapsedMs).toBeLessThan(1_500);
		} finally {
			if (sup.exitCode === null) sup.kill('SIGKILL');
			for (const t of heldResponses) clearTimeout(t);
			slowServer.closeAllConnections();
			await new Promise<void>((resolve) => slowServer.close(() => resolve()));
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 15_000);

	it('shares one verified PROXY_TOOLS_CSV snapshot across all workers and respawns', async () => {
		let listToolsCalls = 0;
		const proxyUpstream = createHttpServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				if (req.method !== 'POST') {
					res.statusCode = 405;
					res.end();
					return;
				}
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown; method?: string };
				res.setHeader('Content-Type', 'application/json');
				if (body.method === 'initialize') {
					res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							id: body.id ?? 1,
							result: {
								protocolVersion: '2025-03-26',
								capabilities: { tools: {} },
								serverInfo: { name: 'mock-upstream-proxy', version: '1.0.0' },
							},
						})
					);
					return;
				}
				if (body.method === 'notifications/initialized') {
					res.statusCode = 202;
					res.end();
					return;
				}
				if (body.method === 'tools/list') {
					listToolsCalls += 1;
					// Succeed only once: if workers fetched independently, worker 2 or respawn would fail!
					if (listToolsCalls > 1) {
						res.statusCode = 500;
						res.end('unexpected duplicate discovery');
						return;
					}
					res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							id: body.id ?? 2,
							result: {
								tools: [
									{
										name: 'upstream_echo',
										description: 'Shared proxy tool',
										inputSchema: { type: 'object', properties: {} },
									},
								],
							},
						})
					);
					return;
				}
				res.statusCode = 400;
				res.end();
			});
		});
		await new Promise<void>((resolve) => proxyUpstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (proxyUpstream.address() as { port: number }).port;

		const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hf-mcp-shared-proxy-'));
		const csvPath = path.join(tmpDir, 'proxy-tools.csv');
		writeFileSync(
			csvPath,
			`proxy_id,url,response_type,allow_anonymous,forward_hf_token
shared_proxy,http://127.0.0.1:${String(upstreamPort)}/mcp,JSON,true,false
`
		);

		const port = await getFreePort();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: 'production',
			MCP_WORKERS: '2',
			MCP_WORKER_HEADER: 'true',
			CLUSTER_RESPAWN_DELAY_MS: '100',
			PROXY_TOOLS_CSV: csvPath,
		};
		delete env.VITEST;
		delete env.VITEST_POOL_ID;
		delete env.VITEST_WORKER_ID;
		delete env.LOGGING_DATASET_ID;
		delete env.LOGGING_HF_TOKEN;
		delete env.USER_CONFIG_API;
		delete env.HF_TOKEN;
		delete env.DEFAULT_HF_TOKEN;
		delete env.METRICS_PAGE_PASSWORD;

		const sup = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let supLogs = '';
		sup.stdout?.on('data', (c: Buffer) => {
			supLogs += c.toString('utf8');
		});
		sup.stderr?.on('data', (c: Buffer) => {
			supLogs += c.toString('utf8');
		});
		try {
			const baseUrl = `http://127.0.0.1:${String(port)}`;
			const fetchClusterMetrics = async (): Promise<TransportMetricsApi> => {
				const res = await fetch(`${baseUrl}/api/transport-metrics`);
				if (!res.ok) throw new Error(`Status ${String(res.status)}`);
				return (await res.json()) as TransportMetricsApi;
			};

			const readyMetrics = await waitFor(async () => {
				const m = await fetchClusterMetrics();
				const c = m.runtimeMetrics?.cluster;
				return c?.enabled && c.activeWorkers === 2 && c.workers.length === 2 ? m : undefined;
			}, 15_000).catch((err: unknown) => {
				throw new Error(`Cluster failed to become ready: ${String(err)}\n${supLogs}`);
			});

			const callToolsList = async (reqId: number): Promise<{ worker: string | null; tools: string[] }> => {
				const res = await fetch(`${baseUrl}/mcp?bouquet=proxy&gradio=none`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json, text/event-stream',
						'MCP-Protocol-Version': '2025-06-18',
						Connection: 'close',
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: reqId, method: 'tools/list', params: {} }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
				return {
					worker: res.headers.get('x-mcp-worker'),
					tools: (body.result?.tools ?? []).map((t) => t.name),
				};
			};

			const seenWorkers = new Set<string>();
			for (let i = 0; i < 16 && seenWorkers.size < 2; i++) {
				const { worker, tools } = await callToolsList(i + 1);
				if (worker) seenWorkers.add(worker);
				expect(tools).toContain('shared_proxy');
			}
			expect(seenWorkers.size).toBe(2);
			expect(listToolsCalls).toBe(1);

			// Kill one worker and verify the respawned replacement inherits the identical cached snapshot
			const victimPid = readyMetrics.runtimeMetrics?.cluster?.workers[0]?.pid;
			expect(victimPid).toBeTypeOf('number');
			process.kill(victimPid!, 'SIGKILL');

			await waitFor(async () => {
				const m = await fetchClusterMetrics();
				const c = m.runtimeMetrics?.cluster;
				return c && c.totalRestarts >= 1 && c.activeWorkers === 2 && c.workers.length === 2 ? m : undefined;
			}, 15_000);

			const postRespawnWorkers = new Set<string>();
			for (let i = 0; i < 12 && postRespawnWorkers.size < 2; i++) {
				const { worker, tools } = await callToolsList(100 + i);
				if (worker) postRespawnWorkers.add(worker);
				expect(tools).toContain('shared_proxy');
			}
			expect(postRespawnWorkers.size).toBe(2);
			expect(listToolsCalls).toBe(1);
		} finally {
			if (sup.exitCode === null) {
				sup.kill('SIGTERM');
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						sup.kill('SIGKILL');
						resolve();
					}, 4_000);
					sup.once('exit', () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			proxyUpstream.closeAllConnections();
			await new Promise<void>((resolve) => proxyUpstream.close(() => resolve()));
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 45_000);
});
