import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeMetricsResponse } from '../../../src/shared/runtime-metrics.js';
import {
	ClusterMetricsHub,
	aggregateClusterRuntimeMetrics,
	emptyRetiredTotals,
	type WorkerStatsPayload,
} from '../../../src/server/cluster/metrics-hub.js';
import { parseMcpWorkers } from '../../../src/server/cluster/workers-config.js';

function makeRuntimeSnapshot(overrides: Partial<RuntimeMetricsResponse> = {}): RuntimeMetricsResponse {
	return {
		reportingSchema: 'runtime_v1',
		pid: 100,
		nodeVersion: 'v24.2.0',
		availableParallelism: 8,
		sampleIntervalMs: 10_000,
		current: null,
		windows: { '1m': null, '15m': null, '1h': null },
		memory: {
			rssBytes: 100 * 1024 * 1024,
			heapUsedBytes: 40 * 1024 * 1024,
			heapTotalBytes: 60 * 1024 * 1024,
			heapLimitBytes: 512 * 1024 * 1024,
			externalBytes: 5 * 1024 * 1024,
		},
		http: {
			openSockets: 0,
			totalConnections: 0,
			totalRequests: 0,
			requestsPerSocket: { '1': 0, '2-10': 0, '11-100': 0, '101-1000': 0, '1001+': 0 },
			closedSockets: 0,
			closedSocketRequests: 0,
		},
		forwardedForHops: { '0': 0, '1': 0, '2': 0, '3': 0, '4+': 0 },
		legacySessions: 0,
		...overrides,
	};
}

function makeWorkerStats(
	workerId: number,
	pid: number,
	overrides: Partial<WorkerStatsPayload> = {}
): WorkerStatsPayload {
	return {
		workerId,
		pid,
		startedAtMs: 1_000,
		runtime: makeRuntimeSnapshot({ pid }),
		gradioCache: {
			metadataHits: 0,
			metadataMisses: 0,
			metadataEtagRevalidations: 0,
			metadataCacheSize: 0,
			schemaHits: 0,
			schemaMisses: 0,
			schemaCacheSize: 0,
		},
		ipcDropped: 0,
		...overrides,
	};
}

describe('parseMcpWorkers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('handles unset, empty, 0, auto, valid integers, and invalid values', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(parseMcpWorkers(undefined, 8)).toBe(0);
		expect(parseMcpWorkers('', 8)).toBe(0);
		expect(parseMcpWorkers('  ', 8)).toBe(0);
		expect(parseMcpWorkers('0', 8)).toBe(0);

		expect(parseMcpWorkers('auto', 1)).toBe(1);
		expect(parseMcpWorkers('auto', 2)).toBe(1);
		expect(parseMcpWorkers('auto', 4)).toBe(3);
		expect(parseMcpWorkers('auto', 16)).toBe(7);

		expect(parseMcpWorkers('1', 8)).toBe(1);
		expect(parseMcpWorkers('4', 8)).toBe(4);
		expect(parseMcpWorkers('64', 8)).toBe(64);
		expect(warnSpy).not.toHaveBeenCalled();

		expect(parseMcpWorkers('65', 8)).toBe(0);
		expect(parseMcpWorkers('-2', 8)).toBe(0);
		expect(parseMcpWorkers('2.5', 8)).toBe(0);
		expect(parseMcpWorkers('1e2', 8)).toBe(0);
		expect(parseMcpWorkers('fast', 8)).toBe(0);
		expect(warnSpy).toHaveBeenCalledTimes(5);
	});
});

describe('aggregateClusterRuntimeMetrics & ClusterMetricsHub', () => {
	it('handles current: null safely before the first 10s sample', () => {
		const agg = aggregateClusterRuntimeMetrics({
			supervisor: makeRuntimeSnapshot({ pid: 100 }),
			supervisorStartedAtMs: 1_000,
			liveWorkers: [makeWorkerStats(1, 101), makeWorkerStats(2, 102)],
			retired: emptyRetiredTotals(),
			desiredWorkers: 2,
			totalRestarts: 0,
			sessionRpcFailures: 0,
			legacySessions: 5,
			now: 6_000,
		});

		expect(agg.current).toBeNull();
		expect(agg.windows['1m']).toBeNull();
		expect(agg.legacySessions).toBe(5);
		expect(agg.cluster?.enabled).toBe(true);
		expect(agg.cluster?.activeWorkers).toBe(2);
		expect(agg.cluster?.supervisor.eventLoopUtilization).toBeNull();
		expect(agg.cluster?.workers[0]?.eventLoopUtilization).toBeNull();
		expect(agg.memory.rssBytes).toBe(300 * 1024 * 1024);
	});

	it('sums RPS/connections/memory and takes max of ELU/CPU/delay across workers', () => {
		const w1 = makeWorkerStats(1, 101, {
			runtime: makeRuntimeSnapshot({
				pid: 101,
				current: {
					at: '2026-11-25T00:00:10.000Z',
					eventLoopUtilization: 0.25,
					cpuPercent: 30,
					eventLoopDelayP50Ms: 1.5,
					eventLoopDelayP99Ms: 8.0,
					eventLoopDelayMaxMs: 15.0,
					httpRequestsPerSecond: 120,
					newConnectionsPerSecond: 10,
					openSockets: 12,
					rssBytes: 120 * 1024 * 1024,
					heapUsedBytes: 50 * 1024 * 1024,
				},
				http: {
					openSockets: 12,
					totalConnections: 50,
					totalRequests: 400,
					requestsPerSocket: { '1': 10, '2-10': 20, '11-100': 8, '101-1000': 0, '1001+': 0 },
					closedSockets: 38,
					closedSocketRequests: 380,
				},
				forwardedForHops: { '0': 0, '1': 400, '2': 0, '3': 0, '4+': 0 },
			}),
		});
		const w2 = makeWorkerStats(2, 102, {
			runtime: makeRuntimeSnapshot({
				pid: 102,
				current: {
					at: '2026-11-25T00:00:11.000Z',
					eventLoopUtilization: 0.72,
					cpuPercent: 85,
					eventLoopDelayP50Ms: 3.0,
					eventLoopDelayP99Ms: 22.0,
					eventLoopDelayMaxMs: 45.0,
					httpRequestsPerSecond: 180,
					newConnectionsPerSecond: 15,
					openSockets: 18,
					rssBytes: 150 * 1024 * 1024,
					heapUsedBytes: 60 * 1024 * 1024,
				},
				http: {
					openSockets: 18,
					totalConnections: 60,
					totalRequests: 600,
					requestsPerSocket: { '1': 5, '2-10': 25, '11-100': 12, '101-1000': 0, '1001+': 0 },
					closedSockets: 42,
					closedSocketRequests: 550,
				},
				forwardedForHops: { '0': 0, '1': 550, '2': 50, '3': 0, '4+': 0 },
			}),
		});

		const agg = aggregateClusterRuntimeMetrics({
			supervisor: makeRuntimeSnapshot({ pid: 100 }),
			supervisorStartedAtMs: 1_000,
			liveWorkers: [w2, w1],
			retired: emptyRetiredTotals(),
			desiredWorkers: 2,
			totalRestarts: 0,
			sessionRpcFailures: 0,
			legacySessions: 10,
			now: 12_000,
		});

		expect(agg.current?.httpRequestsPerSecond).toBe(300);
		expect(agg.current?.newConnectionsPerSecond).toBe(25);
		expect(agg.current?.eventLoopUtilization).toBe(0.72);
		expect(agg.current?.cpuPercent).toBe(85);
		expect(agg.current?.eventLoopDelayP99Ms).toBe(22.0);
		expect(agg.current?.eventLoopDelayMaxMs).toBe(45.0);
		expect(agg.http.openSockets).toBe(30);
		expect(agg.http.totalRequests).toBe(1_000);
		expect(agg.forwardedForHops['1']).toBe(950);
		expect(agg.forwardedForHops['2']).toBe(50);
		// Workers sorted by workerId
		expect(agg.cluster?.workers.map((w) => w.workerId)).toEqual([1, 2]);
	});

	it('folds retired worker stats once and releases stranded modern client gauges on worker exit', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		const client = { name: 'modern-client', version: '1.0' };

		hub.recordModernClientEnter(1, client);
		hub.recordModernClientEnter(1, client);
		expect(hub.recordModernClientExit(1, client)).toBe(true);
		expect(hub.metricsCounter.getMetrics().clients.get('modern-client 1.0')?.activeConnections).toBe(1);

		hub.recordWorkerStats(
			makeWorkerStats(1, 201, {
				runtime: makeRuntimeSnapshot({
					pid: 201,
					http: {
						openSockets: 4,
						totalConnections: 20,
						totalRequests: 250,
						requestsPerSocket: { '1': 2, '2-10': 10, '11-100': 4, '101-1000': 0, '1001+': 0 },
						closedSockets: 16,
						closedSocketRequests: 240,
					},
				}),
				gradioCache: {
					metadataHits: 10,
					metadataMisses: 2,
					metadataEtagRevalidations: 3,
					metadataCacheSize: 5,
					schemaHits: 8,
					schemaMisses: 2,
					schemaCacheSize: 4,
				},
				ipcDropped: 1,
			})
		);

		// Exit worker 1 twice (idempotent check: must only fold once!)
		hub.onWorkerExit(1);
		hub.onWorkerExit(1);

		expect(hub.metricsCounter.getMetrics().clients.get('modern-client 1.0')?.activeConnections).toBe(0);

		const runtime = hub.buildClusterRuntimeMetrics();
		expect(runtime.http.totalRequests).toBe(250);
		expect(runtime.http.openSockets).toBe(0);
		expect(runtime.cluster?.activeWorkers).toBe(0);
		expect(runtime.cluster?.ipcDropped).toBe(1);

		// Extra exit after worker already left must not double-disconnect
		expect(hub.recordModernClientExit(1, client)).toBe(false);
		expect(hub.metricsCounter.getMetrics().clients.get('modern-client 1.0')?.activeConnections).toBe(0);

		const cache = hub.buildClusterGradioCacheMetrics();
		expect(cache.spaceMetadata.hits).toBe(10);
		expect(cache.spaceMetadata.cacheSize).toBe(0);
		expect(cache.totalHits).toBe(18);
		expect(cache.totalMisses).toBe(4);
	});

	it('computes true simultaneous fleet rate peaks instead of summing staggered worker maxima', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		const w1 = makeWorkerStats(1, 301, {
			runtime: makeRuntimeSnapshot({
				pid: 301,
				windows: {
					'1m': {
						samples: 2,
						eventLoopUtilization: { avg: 0.2, max: 0.3 },
						cpuPercent: { avg: 20, max: 30 },
						eventLoopDelayP99Ms: { avg: 2, max: 4 },
						httpRequestsPerSecond: { avg: 50, max: 100 },
						newConnectionsPerSecond: { avg: 5, max: 10 },
					},
					'15m': null,
					'1h': null,
				},
				http: {
					openSockets: 1,
					totalConnections: 0,
					totalRequests: 0,
					requestsPerSocket: { '1': 0, '2-10': 0, '11-100': 0, '101-1000': 0, '1001+': 0 },
					closedSockets: 0,
					closedSocketRequests: 0,
				},
			}),
		});
		const w2 = makeWorkerStats(2, 302, {
			runtime: makeRuntimeSnapshot({
				pid: 302,
				windows: {
					'1m': {
						samples: 2,
						eventLoopUtilization: { avg: 0.2, max: 0.3 },
						cpuPercent: { avg: 20, max: 30 },
						eventLoopDelayP99Ms: { avg: 2, max: 4 },
						httpRequestsPerSecond: { avg: 50, max: 100 },
						newConnectionsPerSecond: { avg: 5, max: 10 },
					},
					'15m': null,
					'1h': null,
				},
				http: {
					openSockets: 1,
					totalConnections: 0,
					totalRequests: 0,
					requestsPerSocket: { '1': 0, '2-10': 0, '11-100': 0, '101-1000': 0, '1001+': 0 },
					closedSockets: 0,
					closedSocketRequests: 0,
				},
			}),
		});

		hub.recordWorkerStats(w1);
		hub.recordWorkerStats(w2);
		hub.recordFleetRateSample(10_000);

		// Interval 1 (10s): worker 1 serves 1000 reqs (100 req/s), worker 2 serves 0
		w1.runtime.http.totalRequests = 1_000;
		w1.runtime.http.totalConnections = 100;
		hub.recordFleetRateSample(20_000);

		// Interval 2 (10s): worker 1 serves 0, worker 2 serves 1000 reqs (100 req/s)
		w2.runtime.http.totalRequests = 1_000;
		w2.runtime.http.totalConnections = 100;
		hub.recordFleetRateSample(30_000);

		const rt = hub.buildClusterRuntimeMetrics();
		// True simultaneous fleet max is 100 req/s (NOT 200 req/s from summing worker maxima!)
		expect(rt.windows['1m']?.httpRequestsPerSecond.max).toBe(100);
		expect(rt.windows['1m']?.httpRequestsPerSecond.avg).toBe(100);
		expect(rt.windows['1m']?.newConnectionsPerSecond.max).toBe(10);
	});

	it('normalizes JSON IPC null activateTempLog so the 1.5s transport-metrics cache hits', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		const first = hub.buildTransportMetricsJson(null);
		hub.metricsCounter.trackRequest();
		const second = hub.buildTransportMetricsJson(null);
		expect(second).toBe(first);
	});
});
