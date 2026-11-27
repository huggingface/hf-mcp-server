import { type TransportType } from '../shared/constants.js';
import { Application } from './application.js';
import {
	clusterWorkerId,
	consumeEarlyWorkerShutdown,
	flushIpcBatch,
	getWorkerIpcDropped,
	installEarlyWorkerShutdownCapture,
	isClusterWorker,
	type WorkerShutdownMessage,
} from './cluster/ipc.js';
import type { WorkerStatsPayload } from './cluster/metrics-hub.js';
import { computeClusterShutdownBudget, type ClusterShutdownBudget } from './cluster/workers-config.js';
import { getSkillCatalogStatus } from './skills/skill-catalog-cache.js';
import { getCacheStats } from './utils/gradio-cache.js';
import { logger } from './utils/logger.js';
import { runtimeMetrics } from './utils/runtime-metrics.js';
import { closeTransportLoggers } from './utils/transport-loggers.js';
import { WebServer } from './web-server.js';

const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;

interface RunApplicationOptions {
	transportType: Exclude<TransportType, 'unknown'>;
	port: number;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;
const MAX_HTTP_DRAIN_MS = 5_000;

/**
 * Total time allowed for a graceful shutdown before the process exits anyway.
 * Keep it below the orchestrator's stop timeout so the final log upload is not
 * cut off by SIGKILL.
 */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.SHUTDOWN_GRACE_MS ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

/** Drain HTTP briefly so most of the budget remains for flushing dataset logs. */
export function httpDrainMs(graceMs: number): number {
	return Math.min(MAX_HTTP_DRAIN_MS, Math.floor(graceMs / 3));
}

function attachShutdownHandlers(app: Application): void {
	let shutdownStartedAt: number | undefined;

	const shutdown = async (signal: NodeJS.Signals) => {
		shutdownStartedAt = Date.now();
		const graceMs = shutdownGraceMs();
		// warn: production runs at LOG_LEVEL=warn and these lines measure the platform's stop grace period.
		logger.warn({ signal, graceMs }, 'Shutdown signal received');

		const deadline = setTimeout(() => {
			console.error(`[shutdown] grace period of ${graceMs}ms exceeded; exiting`);
			process.exit(1);
		}, graceMs);
		deadline.unref();

		let exitCode = 0;
		try {
			await app.stop({ drainMs: httpDrainMs(graceMs) });
			logger.warn({ elapsedMs: Date.now() - shutdownStartedAt }, 'HTTP drained; flushing log transports');
		} catch (error) {
			exitCode = 1;
			logger.error({ error }, 'Error during shutdown');
		}

		// Ending the transports performs the final dataset upload; the main
		// logger is one of them, so use stderr from here on.
		const remainingMs = graceMs - (Date.now() - shutdownStartedAt) - 500;
		const { timedOut, unsent } = await closeTransportLoggers(remainingMs);
		console.error(
			`[shutdown] complete in ${String(Date.now() - shutdownStartedAt)}ms` +
				(timedOut > 0 ? `; ${String(timedOut)} dataset log transport(s) timed out` : '') +
				(unsent > 0 ? `; ${String(unsent)} dataset log entries not uploaded` : '')
		);
		process.exit(exitCode);
	};

	const onSignal = (signal: NodeJS.Signals) => {
		if (shutdownStartedAt !== undefined) {
			if (signal === 'SIGINT') {
				console.error('[shutdown] force exit requested');
				process.exit(1);
			}
			return;
		}
		void shutdown(signal);
	};

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
}

function resolveWorkerShutdownBudget(raw?: WorkerShutdownMessage): ClusterShutdownBudget {
	const fallback = computeClusterShutdownBudget(shutdownGraceMs());
	const positiveOr = (value: unknown, def: number): number =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : def;
	return {
		drainMs: positiveOr(raw?.drainMs, fallback.drainMs),
		ipcFlushMs: positiveOr(raw?.ipcFlushMs, fallback.ipcFlushMs),
		finalStatsMs: positiveOr(raw?.finalStatsMs, fallback.finalStatsMs),
		supervisorWaitMs: fallback.supervisorWaitMs,
	};
}

function buildWorkerStats(startedAtMs: number): WorkerStatsPayload {
	return {
		workerId: clusterWorkerId,
		pid: process.pid,
		startedAtMs,
		runtime: runtimeMetrics.snapshot(),
		gradioCache: getCacheStats(),
		skillCatalog: getSkillCatalogStatus(),
		ipcDropped: getWorkerIpcDropped(),
	};
}

function sendWorkerStats(startedAtMs: number): void {
	if (typeof process.send !== 'function' || !process.connected) return;
	try {
		process.send({ t: 'worker-stats', stats: buildWorkerStats(startedAtMs) });
	} catch {
		// IPC channel closed during shutdown
	}
}

function sendWorkerStatsAsync(startedAtMs: number, timeoutMs = 500): Promise<boolean> {
	const send = process.send?.bind(process);
	if (!send || !process.connected) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const done = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		timer.unref();
		try {
			send({ t: 'worker-stats', stats: buildWorkerStats(startedAtMs) }, undefined, undefined, (err) => done(!err));
		} catch {
			done(false);
		}
	});
}

export async function runApplication(options: RunApplicationOptions): Promise<void> {
	if (isClusterWorker) {
		installEarlyWorkerShutdownCapture();
		const earlyBeforeInit = consumeEarlyWorkerShutdown();
		if (earlyBeforeInit !== undefined) {
			const budget = resolveWorkerShutdownBudget(earlyBeforeInit);
			await flushIpcBatch(budget.ipcFlushMs);
			if (process.connected && typeof process.disconnect === 'function') {
				process.disconnect();
			}
			process.exit(0);
		}
	}

	const webServer = new WebServer();
	const app = new Application({
		transportType: options.transportType,
		webAppPort: options.port,
		webServerInstance: webServer,
	});

	if (!isClusterWorker) {
		await app.start();
		attachShutdownHandlers(app);
		return;
	}

	const startedAtMs = Date.now();
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	const runWorkerShutdown = (budget: ClusterShutdownBudget): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		shutdownPromise = (async () => {
			let workerExitCode = 0;
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
			}
			if (app.isServing()) {
				try {
					await app.stop({ drainMs: budget.drainMs });
				} catch (error) {
					workerExitCode = 1;
					logger.error({ error, workerId: clusterWorkerId }, 'Error stopping cluster worker');
				}
			}
			const flushRes = await flushIpcBatch(budget.ipcFlushMs);
			if (!flushRes.completed) {
				console.error(
					`[shutdown] worker ${String(clusterWorkerId)} timed out flushing ${String(flushRes.unsent)} IPC items`
				);
				workerExitCode = 1;
			}
			const statsSent = await sendWorkerStatsAsync(startedAtMs, budget.finalStatsMs);
			if (!statsSent) {
				workerExitCode = 1;
			}
			if (process.connected && typeof process.disconnect === 'function') {
				process.disconnect();
			}
			process.exit(workerExitCode);
		})();
		return shutdownPromise;
	};

	// Register BEFORE app.start() so a shutdown arriving during boot (even while
	// awaiting slow schema fetches) is honored immediately without waiting for listen.
	process.on('message', (raw: unknown) => {
		if (!raw || typeof raw !== 'object') return;
		const msg = raw as { t?: unknown; drainMs?: unknown; ipcFlushMs?: unknown; finalStatsMs?: unknown };
		if (msg.t !== 'shutdown') return;
		const budget = resolveWorkerShutdownBudget({
			drainMs: typeof msg.drainMs === 'number' ? msg.drainMs : undefined,
			ipcFlushMs: typeof msg.ipcFlushMs === 'number' ? msg.ipcFlushMs : undefined,
			finalStatsMs: typeof msg.finalStatsMs === 'number' ? msg.finalStatsMs : undefined,
		});
		void runWorkerShutdown(budget);
	});

	try {
		await app.start({ shouldAbort: () => shuttingDown });
	} catch (error) {
		if (shuttingDown && shutdownPromise) {
			await shutdownPromise;
			return;
		}
		throw error;
	}

	if (shuttingDown && shutdownPromise) {
		await shutdownPromise;
		return;
	}

	const earlyDuringBoot = consumeEarlyWorkerShutdown();
	if (earlyDuringBoot !== undefined) {
		await runWorkerShutdown(resolveWorkerShutdownBudget(earlyDuringBoot));
		return;
	}

	sendWorkerStats(startedAtMs);
	heartbeatTimer = setInterval(() => sendWorkerStats(startedAtMs), WORKER_HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref();
}
