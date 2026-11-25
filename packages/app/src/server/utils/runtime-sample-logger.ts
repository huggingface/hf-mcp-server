import type { RuntimeMetricsResponse } from '../../shared/runtime-metrics.js';
import { getMcpServerSessionId, logSystemEvent } from './query-logger.js';
import { runtimeMetrics } from './runtime-metrics.js';

const DEFAULT_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | undefined;
let snapshotProvider: () => RuntimeMetricsResponse = () => runtimeMetrics.snapshot();

export interface RuntimeSampleLoggingOptions {
	intervalMs?: number;
	getSnapshot?: () => RuntimeMetricsResponse;
}

export function runtimeSampleLogIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.RUNTIME_METRICS_LOG_INTERVAL_MS;
	if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Record a compact runtime sample in the System dataset stream (methodName
 * `runtime_sample`) so load, CPU and connection reuse can be analysed over a
 * full daily cycle. Counters (requests, connections, hops) are cumulative since
 * process start; take deltas between rows. No-op when system logging is off.
 */
function logRuntimeSample(): void {
	const snapshot = snapshotProvider();
	logSystemEvent('runtime_sample', getMcpServerSessionId(), {
		requestJson: {
			pid: snapshot.pid,
			current: snapshot.current,
			lastMinute: snapshot.windows['1m'],
			memory: snapshot.memory,
			http: snapshot.http,
			forwardedForHops: snapshot.forwardedForHops,
			legacySessions: snapshot.legacySessions,
			...(snapshot.cluster ? { cluster: snapshot.cluster } : {}),
		},
	});
}

export function startRuntimeSampleLogging(options?: number | RuntimeSampleLoggingOptions): void {
	const intervalMs = typeof options === 'number' ? options : (options?.intervalMs ?? runtimeSampleLogIntervalMs());
	if (timer || intervalMs <= 0) return;
	snapshotProvider =
		typeof options === 'object' && options?.getSnapshot ? options.getSnapshot : () => runtimeMetrics.snapshot();
	timer = setInterval(logRuntimeSample, intervalMs);
	timer.unref();
}

export function stopRuntimeSampleLogging(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
	snapshotProvider = () => runtimeMetrics.snapshot();
}
