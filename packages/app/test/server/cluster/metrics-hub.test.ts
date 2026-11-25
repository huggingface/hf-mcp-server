import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeMetricsResponse } from '../../../src/shared/runtime-metrics.js';
import type { SkillCatalogStatus } from '../../../src/shared/skill-catalog-status.js';
import {
	ClusterMetricsHub,
	WORKER_STALE_THRESHOLD_MS,
	aggregateClusterRuntimeMetrics,
	emptyRetiredTotals,
	type WorkerStatsPayload,
} from '../../../src/server/cluster/metrics-hub.js';
import { computeClusterShutdownBudget, parseMcpWorkers } from '../../../src/server/cluster/workers-config.js';

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

	it('computes coordinated cluster shutdown budgets with supervisor headroom across grace values', () => {
		for (const graceMs of [1_500, 3_000, 10_000, 25_000]) {
			const budget = computeClusterShutdownBudget(graceMs);
			const workerTotalMs = budget.drainMs + budget.ipcFlushMs + budget.finalStatsMs;
			expect(budget.supervisorWaitMs).toBeGreaterThan(workerTotalMs);
			expect(budget.supervisorWaitMs).toBeLessThan(graceMs);
			expect(graceMs - budget.supervisorWaitMs).toBeGreaterThanOrEqual(Math.min(250, Math.floor(graceMs * 0.25)));
		}
		// Verify default 25s grace gives workers full 5s drain + 2s IPC flush + 500ms stats
		const defaultBudget = computeClusterShutdownBudget(25_000);
		expect(defaultBudget).toEqual({
			drainMs: 5_000,
			ipcFlushMs: 2_000,
			finalStatsMs: 500,
			supervisorWaitMs: 8_500,
		});
	});

	it('retains IPC drops reported between heartbeats and retires them on worker exit without double-counting', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		// Worker 1 sends initial heartbeat with 2 drops, then drops 5 more via batch-meta before crashing
		hub.recordWorkerStats(makeWorkerStats(1, 101, { ipcDropped: 2 }), 10_000);
		hub.recordWorkerIpcDropped(1, 7);
		// Worker 2 reports drops before ever sending its first heartbeat
		hub.recordWorkerIpcDropped(2, 4);

		const beforeExit = hub.buildClusterRuntimeMetrics(10_500);
		expect(beforeExit.cluster?.ipcDropped).toBe(11);

		hub.onWorkerExit(1);
		hub.onWorkerExit(2);
		// Subsequent exit call must not double-count
		hub.onWorkerExit(1);

		const afterExit = hub.buildClusterRuntimeMetrics(11_000);
		expect(afterExit.cluster?.ipcDropped).toBe(11);
		expect(afterExit.cluster?.activeWorkers).toBe(0);
	});

	it('marks worker heartbeats as stale past WORKER_STALE_THRESHOLD_MS and excludes frozen current samples', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		const w1 = makeWorkerStats(1, 201, {
			runtime: makeRuntimeSnapshot({
				pid: 201,
				current: {
					at: new Date(10_000).toISOString(),
					eventLoopUtilization: 0.95,
					cpuPercent: 99,
					eventLoopDelayP50Ms: 10,
					eventLoopDelayP99Ms: 80,
					eventLoopDelayMaxMs: 120,
					httpRequestsPerSecond: 500,
					newConnectionsPerSecond: 10,
					openSockets: 5,
					rssBytes: 100,
					heapUsedBytes: 50,
				},
			}),
		});
		const w2 = makeWorkerStats(2, 202, {
			runtime: makeRuntimeSnapshot({
				pid: 202,
				current: {
					at: new Date(26_000).toISOString(),
					eventLoopUtilization: 0.2,
					cpuPercent: 25,
					eventLoopDelayP50Ms: 1,
					eventLoopDelayP99Ms: 5,
					eventLoopDelayMaxMs: 8,
					httpRequestsPerSecond: 40,
					newConnectionsPerSecond: 2,
					openSockets: 2,
					rssBytes: 100,
					heapUsedBytes: 50,
				},
			}),
		});

		hub.recordWorkerStats(w1, 10_000);
		hub.recordWorkerStats(w2, 10_000);

		// At 10s age (< 15s threshold), both workers are fresh
		const fresh = hub.buildClusterRuntimeMetrics(20_000);
		expect(fresh.cluster?.staleWorkers).toBe(0);
		expect(fresh.cluster?.workers.every((w) => !w.stale)).toBe(true);
		expect(fresh.current?.eventLoopUtilization).toBe(0.95);

		// Worker 2 sends a fresh heartbeat at 26_000; worker 1 is now 16s old (> WORKER_STALE_THRESHOLD_MS)
		hub.recordWorkerStats(w2, 26_000);
		const withStale = hub.buildClusterRuntimeMetrics(10_000 + WORKER_STALE_THRESHOLD_MS + 1_000);
		expect(withStale.cluster?.staleWorkers).toBe(1);
		const summary1 = withStale.cluster?.workers.find((w) => w.workerId === 1);
		const summary2 = withStale.cluster?.workers.find((w) => w.workerId === 2);
		expect(summary1?.stale).toBe(true);
		expect(summary1?.heartbeatAgeMs).toBe(16_000);
		expect(summary2?.stale).toBe(false);
		// Frozen current sample from stale w1 is excluded from live fleet current
		expect(withStale.current?.eventLoopUtilization).toBe(0.2);
	});

	it('synthesizes fleet Skills catalog health across workers without hiding partial loads or refresh failures', () => {
		const hub = new ClusterMetricsHub({ desiredWorkers: 2 });
		const readyCatalog: SkillCatalogStatus = {
			state: 'ready',
			loadedAt: 100_000,
			lastAttemptAt: 100_000,
			lastFailureAt: null,
			nextRefreshAt: 200_000,
			refreshing: false,
			skillCount: 12,
			resourceCount: 48,
			remainingTtlMs: 90_000,
			servingPreviousSnapshot: false,
			refreshFailures: 0,
			sizeVerification: 'verified',
			warning: null,
		};
		const unloadedCatalog: SkillCatalogStatus = {
			state: 'not-loaded',
			loadedAt: null,
			lastAttemptAt: null,
			lastFailureAt: null,
			nextRefreshAt: null,
			refreshing: false,
			skillCount: 0,
			resourceCount: 0,
			remainingTtlMs: 0,
			servingPreviousSnapshot: false,
			refreshFailures: 0,
			sizeVerification: 'verified',
			warning: null,
		};

		hub.recordWorkerStats(makeWorkerStats(1, 301, { skillCatalog: readyCatalog }), 100_000);
		hub.recordWorkerStats(makeWorkerStats(2, 302, { skillCatalog: unloadedCatalog }), 100_000);

		const partial = hub.buildClusterSkillsCatalog(101_000);
		expect(partial.workerSnapshots).toHaveLength(2);
		expect(partial.snapshot.state).toBe('ready');
		expect(partial.snapshot.skillCount).toBe(12);
		expect(partial.snapshot.resourceCount).toBe(48);
		expect(partial.snapshot.warning).toContain('1/2 workers have loaded the Skills catalog');

		// If worker 2 fails to refresh, top-level snapshot surfaces degraded state + failure warning
		const degradedCatalog: SkillCatalogStatus = {
			...readyCatalog,
			state: 'degraded',
			lastFailureAt: 105_000,
			servingPreviousSnapshot: true,
			refreshFailures: 3,
			warning: 'Digest mismatch on refresh',
		};
		hub.recordWorkerStats(makeWorkerStats(2, 302, { skillCatalog: degradedCatalog }), 105_000);

		const degraded = hub.buildClusterSkillsCatalog(106_000);
		expect(degraded.snapshot.state).toBe('degraded');
		expect(degraded.snapshot.refreshFailures).toBe(3);
		expect(degraded.snapshot.lastFailureAt).toBe(105_000);
		expect(degraded.snapshot.servingPreviousSnapshot).toBe(true);
		expect(degraded.snapshot.warning).toBe('Digest mismatch on refresh');
	});

	it('excludes the sample ending exactly at the fleet rate window cutoff', () => {
		const rt = aggregateClusterRuntimeMetrics({
			supervisor: makeRuntimeSnapshot({ pid: 100 }),
			supervisorStartedAtMs: 0,
			liveWorkers: [
				makeWorkerStats(1, 101, {
					runtime: makeRuntimeSnapshot({
						pid: 101,
						windows: {
							'1m': {
								samples: 6,
								eventLoopUtilization: { avg: 0.1, max: 0.2 },
								cpuPercent: { avg: 10, max: 20 },
								eventLoopDelayP99Ms: { avg: 1, max: 2 },
								httpRequestsPerSecond: { avg: 50, max: 50 },
								newConnectionsPerSecond: { avg: 5, max: 5 },
							},
							'15m': null,
							'1h': null,
						},
					}),
				}),
			],
			retired: emptyRetiredTotals(),
			desiredWorkers: 1,
			totalRestarts: 0,
			sessionRpcFailures: 0,
			legacySessions: 0,
			fleetRateSamples: [
				{ atMs: 0, rps: 999, cps: 999 },
				{ atMs: 10_000, rps: 50, cps: 5 },
				{ atMs: 20_000, rps: 50, cps: 5 },
				{ atMs: 30_000, rps: 50, cps: 5 },
				{ atMs: 40_000, rps: 50, cps: 5 },
				{ atMs: 50_000, rps: 50, cps: 5 },
				{ atMs: 60_000, rps: 50, cps: 5 },
			],
			now: 60_000,
		});
		expect(rt.windows['1m']?.httpRequestsPerSecond).toEqual({ avg: 50, max: 50 });
		expect(rt.windows['1m']?.newConnectionsPerSecond).toEqual({ avg: 5, max: 5 });
	});
});
