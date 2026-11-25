import cluster, { type Worker } from 'node:cluster';
import {
	hashToken,
	hashUserIdentity,
	MetricsCounter,
	type ProtocolEra,
	type ServerDiscoverOutcome,
	type SubscriptionAttempt,
} from '../../shared/transport-metrics.js';

export const isClusterWorker = cluster.isWorker && process.env.MCP_CLUSTER_WORKER === '1';
export const clusterWorkerId = isClusterWorker
	? (cluster.worker?.id ?? (Number.parseInt(process.env.MCP_WORKER_ID ?? '0', 10) || 0))
	: 0;

export class IpcTimeoutError extends Error {
	constructor(message = 'IPC request timed out') {
		super(message);
		this.name = 'IpcTimeoutError';
	}
}

const MAX_PENDING_ITEMS = 50_000;
const BATCH_FLUSH_THRESHOLD = 500;
const BATCH_FLUSH_INTERVAL_MS = 100;

type RegisteredHandler = (...args: unknown[]) => unknown;

const handlers = new Map<string, RegisteredHandler>();

let pending: Array<[string, unknown[]]> = [];
let ipcDropped = 0;
let flushTimer: NodeJS.Timeout | undefined;
let sendingBatch = false;
let inFlightBatchSize = 0;
let inFlightSend: Promise<void> | undefined;
let earlyShutdownDrainMs: number | undefined;
let earlyShutdownListenerInstalled = false;

/**
 * Install an early worker message + signal capture before heavy modules load so
 * a `{ t: 'shutdown', drainMs }` sent during worker boot is never missed.
 */
export function installEarlyWorkerShutdownCapture(): void {
	if (!isClusterWorker || earlyShutdownListenerInstalled) return;
	earlyShutdownListenerInstalled = true;
	const noopSignal = (): void => undefined;
	process.on('SIGINT', noopSignal);
	process.on('SIGTERM', noopSignal);
	process.on('message', (raw: unknown) => {
		if (!raw || typeof raw !== 'object') return;
		const msg = raw as { t?: unknown; drainMs?: unknown };
		if (msg.t !== 'shutdown') return;
		earlyShutdownDrainMs =
			typeof msg.drainMs === 'number' && Number.isFinite(msg.drainMs) && msg.drainMs > 0 ? msg.drainMs : 0;
	});
}

export function consumeEarlyWorkerShutdown(): number | undefined {
	const val = earlyShutdownDrainMs;
	earlyShutdownDrainMs = undefined;
	return val;
}

function scheduleFlush(): void {
	if (flushTimer || pending.length === 0) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		sendNextBatch();
	}, BATCH_FLUSH_INTERVAL_MS);
	flushTimer.unref();
}

function sendNextBatch(): void {
	if (sendingBatch || pending.length === 0) return;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}

	if (typeof process.send !== 'function' || !process.connected) {
		ipcDropped += pending.length;
		pending = [];
		return;
	}

	const items = pending;
	pending = [];
	sendingBatch = true;
	inFlightBatchSize = items.length;

	let resolveSend!: () => void;
	const sendPromise = new Promise<void>((resolve) => {
		resolveSend = resolve;
	});
	inFlightSend = sendPromise;

	const finish = (err?: Error | null): void => {
		sendingBatch = false;
		inFlightBatchSize = 0;
		if (inFlightSend === sendPromise) {
			inFlightSend = undefined;
		}
		if (err) {
			ipcDropped += items.length;
		}
		resolveSend();
		if (!err && pending.length > 0) {
			if (pending.length >= BATCH_FLUSH_THRESHOLD) {
				sendNextBatch();
			} else {
				scheduleFlush();
			}
		}
	};

	try {
		process.send({ t: 'batch', items, dropped: ipcDropped }, undefined, undefined, (err) => {
			finish(err);
		});
	} catch (err) {
		finish(err instanceof Error ? err : new Error(String(err)));
	}
}

function enqueue(name: string, args: unknown[]): void {
	if (pending.length >= MAX_PENDING_ITEMS) {
		ipcDropped += 1;
		return;
	}
	pending.push([name, args]);
	if (pending.length >= BATCH_FLUSH_THRESHOLD) {
		sendNextBatch();
	} else {
		scheduleFlush();
	}
}

export function getWorkerIpcDropped(): number {
	return ipcDropped;
}

export async function flushIpcBatch(timeoutMs = 3_000): Promise<{ completed: boolean; unsent: number }> {
	if (!isClusterWorker) return { completed: true, unsent: 0 };

	const droppedBefore = ipcDropped;
	const deadline = Date.now() + Math.max(0, timeoutMs);

	while (pending.length > 0 || sendingBatch) {
		if (!process.connected || typeof process.send !== 'function') {
			break;
		}
		if (pending.length > 0 && !sendingBatch) {
			sendNextBatch();
		}
		const currentSend = inFlightSend;
		if (!currentSend) {
			break;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			break;
		}

		await new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				process.off('disconnect', done);
				resolve();
			};
			const timer = setTimeout(done, remaining);
			timer.unref();
			process.once('disconnect', done);
			void currentSend.finally(done);
		});
	}

	const remainingUnsent = pending.length + (sendingBatch ? inFlightBatchSize : 0);
	if (remainingUnsent > 0) {
		ipcDropped += remainingUnsent;
		pending = [];
	}
	const totalLostInFlush = ipcDropped - droppedBefore;
	if (totalLostInFlush > 0 || sendingBatch) {
		return { completed: false, unsent: Math.max(remainingUnsent, totalLostInFlush) };
	}

	return { completed: true, unsent: 0 };
}

export function forward<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
	handlers.set(name, fn as RegisteredHandler);
	if (!isClusterWorker) {
		return fn;
	}
	return (...args: A): void => {
		enqueue(name, args);
	};
}

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const pendingRpcs = new Map<number, PendingRpc>();
let rpcSeq = 0;
let workerRpcListenersInstalled = false;

interface RpcResponseMessage {
	t: 'rpc-res';
	id: number;
	ok: boolean;
	val?: unknown;
	err?: string;
}

function isRpcResponseMessage(msg: unknown): msg is RpcResponseMessage {
	return (
		typeof msg === 'object' &&
		msg !== null &&
		(msg as { t?: unknown }).t === 'rpc-res' &&
		typeof (msg as { id?: unknown }).id === 'number' &&
		typeof (msg as { ok?: unknown }).ok === 'boolean'
	);
}

function ensureWorkerRpcListeners(): void {
	if (workerRpcListenersInstalled) return;
	workerRpcListenersInstalled = true;

	process.on('message', (msg: unknown) => {
		if (!isRpcResponseMessage(msg)) return;
		const entry = pendingRpcs.get(msg.id);
		if (!entry) return;
		pendingRpcs.delete(msg.id);
		clearTimeout(entry.timer);
		if (msg.ok) {
			entry.resolve(msg.val);
		} else {
			entry.reject(new Error(msg.err || 'Remote IPC call failed'));
		}
	});

	process.on('disconnect', () => {
		for (const [id, entry] of pendingRpcs) {
			pendingRpcs.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new IpcTimeoutError('IPC channel disconnected'));
		}
	});
}

export function remote<A extends unknown[], R>(
	name: string,
	fn: (...args: A) => R | Promise<R>,
	timeoutMs = 2_000
): (...args: A) => Promise<Awaited<R>> {
	handlers.set(name, fn as RegisteredHandler);
	if (!isClusterWorker) {
		return async (...args: A): Promise<Awaited<R>> => await fn(...args);
	}

	return (...args: A): Promise<Awaited<R>> => {
		ensureWorkerRpcListeners();
		const send = process.send?.bind(process);
		if (!send || !process.connected) {
			return Promise.reject(new IpcTimeoutError('IPC channel is not connected'));
		}

		const id = ++rpcSeq;
		return new Promise<Awaited<R>>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!pendingRpcs.delete(id)) return;
				reject(new IpcTimeoutError(`IPC RPC '${name}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();

			pendingRpcs.set(id, {
				resolve: (value) => resolve(value as Awaited<R>),
				reject,
				timer,
			});

			try {
				send({ t: 'rpc', id, name, args }, undefined, undefined, (err) => {
					if (err && pendingRpcs.delete(id)) {
						clearTimeout(timer);
						reject(new IpcTimeoutError(`IPC RPC '${name}' send failed: ${err.message}`));
					}
				});
			} catch (err) {
				if (pendingRpcs.delete(id)) {
					clearTimeout(timer);
					const message = err instanceof Error ? err.message : String(err);
					reject(new IpcTimeoutError(`IPC RPC '${name}' send failed: ${message}`));
				}
			}
		});
	};
}

function safeWorkerSend(worker: Worker, msg: Record<string, unknown>): void {
	if (!worker.isConnected()) return;
	try {
		worker.send(msg, undefined, undefined, () => {
			// Ignore send errors if worker exited mid-reply
		});
	} catch {
		// Ignore synchronous send errors on closed channel
	}
}

export function attachWorkerIpc(
	worker: Worker,
	onCustomMessage?: (worker: Worker, msg: Record<string, unknown>) => void
): void {
	worker.on('message', (raw: unknown) => {
		if (typeof raw !== 'object' || raw === null || !('t' in raw)) return;
		const msg = raw as Record<string, unknown>;

		if (msg.t === 'batch') {
			const items = Array.isArray(msg.items) ? msg.items : [];
			for (const item of items) {
				if (!Array.isArray(item) || item.length < 2) continue;
				const [name, args] = item as [unknown, unknown];
				if (typeof name !== 'string' || !Array.isArray(args)) continue;
				const handler = handlers.get(name);
				if (!handler) continue;
				try {
					handler(...args);
				} catch (err) {
					console.error(`[Cluster IPC] Handler '${name}' threw:`, err);
				}
			}
			if (onCustomMessage && typeof msg.dropped === 'number') {
				onCustomMessage(worker, { t: 'batch-meta', dropped: msg.dropped });
			}
			return;
		}

		if (msg.t === 'rpc') {
			const id = typeof msg.id === 'number' ? msg.id : -1;
			const name = typeof msg.name === 'string' ? msg.name : '';
			const args = Array.isArray(msg.args) ? msg.args : [];
			const handler = handlers.get(name);
			if (!handler) {
				safeWorkerSend(worker, {
					t: 'rpc-res',
					id,
					ok: false,
					err: `Unknown IPC RPC handler: ${name}`,
				});
				return;
			}
			void (async () => {
				try {
					const val = await handler(...args);
					safeWorkerSend(worker, { t: 'rpc-res', id, ok: true, val });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					safeWorkerSend(worker, { t: 'rpc-res', id, ok: false, err: message });
				}
			})();
			return;
		}

		onCustomMessage?.(worker, msg);
	});
}

class ForwardingMetricsCounter extends MetricsCounter {
	override trackRequest(): void {
		enqueue('metrics.trackRequest', []);
	}
	override trackProtocolEra(era: ProtocolEra): void {
		enqueue('metrics.trackProtocolEra', [era]);
	}
	override trackProtocolRequest(era: ProtocolEra, version: string): void {
		enqueue('metrics.trackProtocolRequest', [era, version]);
	}
	override trackClientProtocol(clientInfo: { name: string; version: string }, era: ProtocolEra, version: string): void {
		enqueue('metrics.trackClientProtocol', [clientInfo, era, version]);
	}
	override trackProtocolToolCall(
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): void {
		enqueue('metrics.trackProtocolToolCall', [era, version, clientInfo]);
	}
	override recordAuthenticatedUserHash(
		userHash: string,
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): void {
		enqueue('metrics.recordAuthenticatedUserHash', [userHash, era, version, clientInfo]);
	}
	override trackAuthenticatedUser(
		username: string,
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): string {
		const userHash = hashUserIdentity(username);
		enqueue('metrics.recordAuthenticatedUserHash', [userHash, era, version, clientInfo]);
		return userHash;
	}
	override trackError(statusCode?: number, error?: Error | { type: string; message: string }): void {
		const serialized = error
			? error instanceof Error
				? { type: error.constructor?.name || error.name || 'Error', message: error.message }
				: { type: error.type, message: error.message }
			: undefined;
		enqueue('metrics.trackError', [statusCode, serialized]);
	}
	override trackNewConnection(): void {
		enqueue('metrics.trackNewConnection', []);
	}
	override trackIpAddress(ipAddress: string | undefined): void {
		enqueue('metrics.trackIpAddress', [ipAddress]);
	}
	override trackClientIpAddress(ipAddress: string | undefined, clientInfo?: { name: string; version: string }): void {
		enqueue('metrics.trackClientIpAddress', [ipAddress, clientInfo]);
	}
	override recordClientTokenHash(clientInfo: { name: string; version: string } | undefined, tokenHash?: string): void {
		enqueue('metrics.recordClientTokenHash', [clientInfo, tokenHash]);
	}
	override trackClientAuth(authToken: string | undefined, clientInfo?: { name: string; version: string }): void {
		if (!clientInfo) return;
		enqueue('metrics.recordClientTokenHash', [clientInfo, authToken ? hashToken(authToken) : undefined]);
	}
	override updateActiveConnections(count: number): void {
		enqueue('metrics.updateActiveConnections', [count]);
	}
	override trackSessionCleaned(): void {
		enqueue('metrics.trackSessionCleaned', []);
	}
	override associateSessionWithClient(clientInfo: { name: string; version: string }): void {
		enqueue('metrics.associateSessionWithClient', [clientInfo]);
	}
	override updateClientActivity(clientInfo?: { name: string; version: string }): void {
		enqueue('metrics.updateClientActivity', [clientInfo]);
	}
	override disconnectClient(clientInfo?: { name: string; version: string }): void {
		enqueue('metrics.disconnectClient', [clientInfo]);
	}
	override trackMethod(
		methodName: string | null,
		durationMs: number,
		isError = false,
		clientInfo?: { name: string; version: string },
		protocol?: { era: ProtocolEra; version: string }
	): void {
		enqueue('metrics.trackMethod', [methodName, durationMs, isError, clientInfo, protocol]);
	}
	override trackServerDiscoverOutcome(outcome: ServerDiscoverOutcome): void {
		enqueue('metrics.trackServerDiscoverOutcome', [outcome]);
	}
	override trackSubscriptionAttempt(attempt: SubscriptionAttempt): void {
		enqueue('metrics.trackSubscriptionAttempt', [attempt]);
	}
	override trackStaticPageHit(statusCode: number): void {
		enqueue('metrics.trackStaticPageHit', [statusCode]);
	}
	override trackAuthenticatedConnection(): void {
		enqueue('metrics.trackAuthenticatedConnection', []);
	}
	override trackAnonymousConnection(): void {
		enqueue('metrics.trackAnonymousConnection', []);
	}
	override trackUnauthorizedConnection(): void {
		enqueue('metrics.trackUnauthorizedConnection', []);
	}
	override trackSessionCreated(): void {
		enqueue('metrics.trackSessionCreated', []);
	}
	override trackSessionResumeFailed(): void {
		enqueue('metrics.trackSessionResumeFailed', []);
	}
	override trackSessionDeleted(): void {
		enqueue('metrics.trackSessionDeleted', []);
	}
	override trackSessionsExpired(count: number): void {
		enqueue('metrics.trackSessionsExpired', [count]);
	}
	override trackSessionsEvicted(count: number): void {
		enqueue('metrics.trackSessionsEvicted', [count]);
	}
	override trackSessionResumeGap(gapMs: number): void {
		enqueue('metrics.trackSessionResumeGap', [gapMs]);
	}
	override trackSessionRpcFailure(): void {
		enqueue('metrics.trackSessionRpcFailure', []);
	}
}

export function createForwardingMetrics(primaryCounter: MetricsCounter): MetricsCounter {
	handlers.set('metrics.trackRequest', () => primaryCounter.trackRequest());
	handlers.set('metrics.trackProtocolEra', (era) => primaryCounter.trackProtocolEra(era as ProtocolEra));
	handlers.set('metrics.trackProtocolRequest', (era, version) =>
		primaryCounter.trackProtocolRequest(era as ProtocolEra, version as string)
	);
	handlers.set('metrics.trackClientProtocol', (clientInfo, era, version) =>
		primaryCounter.trackClientProtocol(
			clientInfo as { name: string; version: string },
			era as ProtocolEra,
			version as string
		)
	);
	handlers.set('metrics.trackProtocolToolCall', (era, version, clientInfo) =>
		primaryCounter.trackProtocolToolCall(
			era as ProtocolEra,
			version as string,
			clientInfo as { name: string; version: string } | undefined
		)
	);
	handlers.set('metrics.recordAuthenticatedUserHash', (userHash, era, version, clientInfo) =>
		primaryCounter.recordAuthenticatedUserHash(
			userHash as string,
			era as ProtocolEra,
			version as string,
			clientInfo as { name: string; version: string } | undefined
		)
	);
	handlers.set('metrics.trackError', (statusCode, error) =>
		primaryCounter.trackError(statusCode as number | undefined, error as { type: string; message: string } | undefined)
	);
	handlers.set('metrics.trackNewConnection', () => primaryCounter.trackNewConnection());
	handlers.set('metrics.trackIpAddress', (ipAddress) => primaryCounter.trackIpAddress(ipAddress as string | undefined));
	handlers.set('metrics.trackClientIpAddress', (ipAddress, clientInfo) =>
		primaryCounter.trackClientIpAddress(
			ipAddress as string | undefined,
			clientInfo as { name: string; version: string } | undefined
		)
	);
	handlers.set('metrics.recordClientTokenHash', (clientInfo, tokenHash) =>
		primaryCounter.recordClientTokenHash(
			clientInfo as { name: string; version: string } | undefined,
			tokenHash as string | undefined
		)
	);
	handlers.set('metrics.updateActiveConnections', (count) => primaryCounter.updateActiveConnections(count as number));
	handlers.set('metrics.trackSessionCleaned', () => primaryCounter.trackSessionCleaned());
	handlers.set('metrics.associateSessionWithClient', (clientInfo) =>
		primaryCounter.associateSessionWithClient(clientInfo as { name: string; version: string })
	);
	handlers.set('metrics.updateClientActivity', (clientInfo) =>
		primaryCounter.updateClientActivity(clientInfo as { name: string; version: string } | undefined)
	);
	handlers.set('metrics.disconnectClient', (clientInfo) =>
		primaryCounter.disconnectClient(clientInfo as { name: string; version: string } | undefined)
	);
	handlers.set('metrics.trackMethod', (methodName, durationMs, isError, clientInfo, protocol) =>
		primaryCounter.trackMethod(
			methodName as string | null,
			durationMs as number,
			isError as boolean | undefined,
			clientInfo as { name: string; version: string } | undefined,
			protocol as { era: ProtocolEra; version: string } | undefined
		)
	);
	handlers.set('metrics.trackServerDiscoverOutcome', (outcome) =>
		primaryCounter.trackServerDiscoverOutcome(outcome as ServerDiscoverOutcome)
	);
	handlers.set('metrics.trackSubscriptionAttempt', (attempt) =>
		primaryCounter.trackSubscriptionAttempt(attempt as SubscriptionAttempt)
	);
	handlers.set('metrics.trackStaticPageHit', (statusCode) => primaryCounter.trackStaticPageHit(statusCode as number));
	handlers.set('metrics.trackAuthenticatedConnection', () => primaryCounter.trackAuthenticatedConnection());
	handlers.set('metrics.trackAnonymousConnection', () => primaryCounter.trackAnonymousConnection());
	handlers.set('metrics.trackUnauthorizedConnection', () => primaryCounter.trackUnauthorizedConnection());
	handlers.set('metrics.trackSessionCreated', () => primaryCounter.trackSessionCreated());
	handlers.set('metrics.trackSessionResumeFailed', () => primaryCounter.trackSessionResumeFailed());
	handlers.set('metrics.trackSessionDeleted', () => primaryCounter.trackSessionDeleted());
	handlers.set('metrics.trackSessionsExpired', (count) => primaryCounter.trackSessionsExpired(count as number));
	handlers.set('metrics.trackSessionsEvicted', (count) => primaryCounter.trackSessionsEvicted(count as number));
	handlers.set('metrics.trackSessionResumeGap', (gapMs) => primaryCounter.trackSessionResumeGap(gapMs as number));
	handlers.set('metrics.trackSessionRpcFailure', () => primaryCounter.trackSessionRpcFailure());

	if (!isClusterWorker) {
		return primaryCounter;
	}
	return new ForwardingMetricsCounter();
}
