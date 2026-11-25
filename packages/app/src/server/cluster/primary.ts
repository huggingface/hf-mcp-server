import cluster, { type Worker } from 'node:cluster';
import { logger } from '../utils/logger.js';
import '../utils/query-logger.js';
import '../utils/skill-event-logger.js';
import { runtimeMetrics } from '../utils/runtime-metrics.js';
import { startRuntimeSampleLogging, stopRuntimeSampleLogging } from '../utils/runtime-sample-logger.js';
import { closeTransportLoggers } from '../utils/transport-loggers.js';
import { attachWorkerIpc } from './ipc.js';
import { initPrimaryMetricsHub, type WorkerStatsPayload } from './metrics-hub.js';

const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;
const MAX_HTTP_DRAIN_MS = 5_000;
const DEFAULT_RESPAWN_DELAY_MS = 1_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX_EXITS = 5;

function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.SHUTDOWN_GRACE_MS ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

function httpDrainMs(graceMs: number): number {
	return Math.min(MAX_HTTP_DRAIN_MS, Math.floor(graceMs / 3));
}

function respawnDelayMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CLUSTER_RESPAWN_DELAY_MS?.trim();
	if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RESPAWN_DELAY_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : DEFAULT_RESPAWN_DELAY_MS;
}

function sendWorkerShutdown(worker: Worker, drainMs: number): void {
	try {
		if (worker.isConnected()) {
			worker.send({ t: 'shutdown', drainMs }, undefined, undefined, () => undefined);
		}
	} catch {
		// Worker channel already closed
	}
}

export interface ClusterPrimaryOptions {
	port: number;
	workerCount: number;
}

/**
 * Start the lightweight cluster supervisor (primary process).
 * Owns authoritative metrics, legacy SessionRegistry, Pino dataset loggers,
 * and worker lifecycle without importing Express, MCP SDK, or Gradio.
 */
export async function startClusterPrimary(options: ClusterPrimaryOptions): Promise<void> {
	const { port, workerCount } = options;
	const hub = initPrimaryMetricsHub({ desiredWorkers: workerCount });
	const workerRespawnDelayMs = respawnDelayMs();

	hub.sessionRegistry.startSweep();
	hub.startFleetRateSampling();
	runtimeMetrics.start({ sessionCount: () => hub.sessionRegistry.size });
	startRuntimeSampleLogging({ getSnapshot: () => hub.buildClusterRuntimeMetrics() });

	logger.info({ port, workerCount, pid: process.pid }, 'Starting cluster supervisor');

	const activeWorkers = new Map<number, Worker>();
	const respawnTimers = new Set<NodeJS.Timeout>();
	const recentCrashTimestamps: number[] = [];
	let stopping = false;
	let shutdownStartedAt: number | undefined;
	let activeShutdownDrainMs = 0;
	let shutdownExitCode = 0;

	const shutdown = async (reason: string, initialExitCode: number): Promise<void> => {
		if (stopping) return;
		stopping = true;
		shutdownExitCode = initialExitCode;
		shutdownStartedAt = Date.now();
		const graceMs = shutdownGraceMs();
		const drainMs = httpDrainMs(graceMs);
		activeShutdownDrainMs = drainMs;

		logger.warn({ reason, graceMs, drainMs, activeWorkers: activeWorkers.size }, 'Cluster supervisor shutting down');

		for (const timer of respawnTimers) {
			clearTimeout(timer);
		}
		respawnTimers.clear();

		stopRuntimeSampleLogging();
		runtimeMetrics.stop();
		hub.stopFleetRateSampling();
		hub.sessionRegistry.stop();

		const deadline = setTimeout(() => {
			console.error(`[shutdown] cluster grace period of ${String(graceMs)}ms exceeded; exiting`);
			process.exit(1);
		}, graceMs);
		deadline.unref();

		const workersToStop = Array.from(activeWorkers.values());
		for (const worker of workersToStop) {
			sendWorkerShutdown(worker, drainMs);
		}

		// Wait for workers to drain HTTP and flush IPC batches (keep IPC active during wait)
		if (workersToStop.length > 0) {
			const waitTimeoutMs = Math.max(200, Math.min(drainMs + 1_500, Math.floor(graceMs * 0.6)));
			await new Promise<void>((resolve) => {
				let remaining = workersToStop.filter((w) => !w.isDead()).length;
				if (remaining === 0) {
					resolve();
					return;
				}
				const onDone = (): void => {
					remaining--;
					if (remaining <= 0) {
						clearTimeout(killTimer);
						resolve();
					}
				};
				const killTimer = setTimeout(() => {
					for (const worker of workersToStop) {
						if (!worker.isDead()) {
							shutdownExitCode = 1;
							console.error(
								`[shutdown] worker ${String(worker.id)} (pid ${String(worker.process.pid)}) timed out draining; sending SIGKILL`
							);
							try {
								worker.process.kill('SIGKILL');
							} catch {
								// Already dead
							}
						}
					}
					resolve();
				}, waitTimeoutMs);
				killTimer.unref();

				for (const worker of workersToStop) {
					if (!worker.isDead()) {
						worker.once('exit', onDone);
					}
				}
			});
		}

		const elapsed = Date.now() - shutdownStartedAt;
		const remainingMs = Math.max(100, graceMs - elapsed - 150);
		const { timedOut, unsent } = await closeTransportLoggers(remainingMs);
		console.error(
			`[shutdown] complete in ${String(Date.now() - shutdownStartedAt)}ms` +
				(timedOut > 0 ? `; ${String(timedOut)} dataset log transport(s) timed out` : '') +
				(unsent > 0 ? `; ${String(unsent)} dataset log entries not uploaded` : '')
		);
		process.exit(shutdownExitCode);
	};

	const spawnWorker = (slot: number): void => {
		if (stopping) return;
		const worker = cluster.fork({
			MCP_CLUSTER_WORKER: '1',
			MCP_WORKER_ID: String(slot),
		});
		activeWorkers.set(slot, worker);

		attachWorkerIpc(worker, (w, msg) => {
			if (msg.t === 'worker-stats' && msg.stats && typeof msg.stats === 'object') {
				hub.recordWorkerStats(msg.stats as WorkerStatsPayload);
				if (stopping) {
					sendWorkerShutdown(w, activeShutdownDrainMs);
				}
			} else if (msg.t === 'worker-ready' && stopping) {
				sendWorkerShutdown(w, activeShutdownDrainMs);
			}
		});

		worker.once('exit', (code, signal) => {
			if (activeWorkers.get(slot) === worker) {
				activeWorkers.delete(slot);
			}
			hub.onWorkerExit(worker.id);

			if (stopping) {
				if (code !== 0 || signal !== null) {
					shutdownExitCode = 1;
				}
				return;
			}

			logger.warn({ workerId: slot, pid: worker.process.pid, code, signal }, 'Cluster worker exited unexpectedly');
			hub.recordWorkerRestart();

			const now = Date.now();
			recentCrashTimestamps.push(now);
			while (recentCrashTimestamps.length > 0 && now - (recentCrashTimestamps[0] ?? 0) > CRASH_LOOP_WINDOW_MS) {
				recentCrashTimestamps.shift();
			}

			if (recentCrashTimestamps.length > CRASH_LOOP_MAX_EXITS) {
				logger.error(
					{ crashesInWindow: recentCrashTimestamps.length, windowMs: CRASH_LOOP_WINDOW_MS },
					'Worker crash loop detected; shutting down supervisor'
				);
				void shutdown('worker-crash-loop', 1);
				return;
			}

			// Keep timer ref'd so a supervisor with 0 live workers never exits 0 while waiting to respawn.
			const timer = setTimeout(() => {
				respawnTimers.delete(timer);
				spawnWorker(slot);
			}, workerRespawnDelayMs);
			respawnTimers.add(timer);
		});
	};

	const onSignal = (signal: NodeJS.Signals): void => {
		if (shutdownStartedAt !== undefined) {
			if (signal === 'SIGINT') {
				console.error('[shutdown] force exit requested');
				process.exit(1);
			}
			return;
		}
		void shutdown(signal, 0);
	};

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	for (let slot = 1; slot <= workerCount; slot++) {
		spawnWorker(slot);
	}
}
