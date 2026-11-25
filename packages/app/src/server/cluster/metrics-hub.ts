import type {
	ClusterRuntimeInfo,
	ClusterWorkerSummary,
	ForwardedForHops,
	RequestsPerSocketBucket,
	RuntimeMetricsResponse,
	RuntimeSample,
	RuntimeWindow,
} from '../../shared/runtime-metrics.js';
import type { SkillsMetricsFilters } from '../../shared/skills-metrics.js';
import type { PtcMetricsResponse } from '../../shared/ptc-metrics.js';
import { MetricsCounter, formatMetricsForAPI } from '../../shared/transport-metrics.js';
import { definitionTagsStats } from '../definition-tags/stats.js';
import { getPtcMetrics } from '../ptc/metrics.js';
import { ClusterSessionStore, SessionRegistry } from '../sessions/session-registry.js';
import type { SessionMetadata } from '../transport/base-transport.js';
import { apiMetrics } from '../utils/api-metrics.js';
import { getDynamicSpaceLiveMetrics } from '../utils/dynamic-space-live-metrics.js';
import { gradioMetrics } from '../utils/gradio-metrics.js';
import { getHfFsLiveMetrics } from '../utils/hf-fs-live-metrics.js';
import { logger } from '../utils/logger.js';
import { runtimeMetrics } from '../utils/runtime-metrics.js';
import { skillsLiveMetrics } from '../utils/skills-live-metrics.js';
import { createForwardingMetrics, forward, remote } from './ipc.js';

const REQUESTS_PER_SOCKET_BUCKETS: readonly RequestsPerSocketBucket[] = ['1', '2-10', '11-100', '101-1000', '1001+'];
const FORWARDED_FOR_HOP_BUCKETS: readonly ForwardedForHops[] = ['0', '1', '2', '3', '4+'];
const TRANSPORT_METRICS_CACHE_TTL_MS = 1_500;
const RPC_TIMEOUT_MS = 5_000;
const FLEET_RATE_SAMPLE_INTERVAL_MS = 10_000;
const MAX_FLEET_RATE_SAMPLES = 8_640;
const WINDOW_DURATION_MS = {
	'1m': 60_000,
	'15m': 15 * 60_000,
	'1h': 60 * 60_000,
} as const;

export interface FleetRateSample {
	atMs: number;
	rps: number;
	cps: number;
}

interface WorkerGradioCacheStats {
	metadataHits: number;
	metadataMisses: number;
	metadataEtagRevalidations: number;
	metadataCacheSize: number;
	schemaHits: number;
	schemaMisses: number;
	schemaCacheSize: number;
}

export interface WorkerStatsPayload {
	workerId: number;
	pid: number;
	startedAtMs: number;
	runtime: RuntimeMetricsResponse;
	gradioCache: WorkerGradioCacheStats;
	ipcDropped: number;
}

export interface RetiredWorkerTotals {
	totalConnections: number;
	totalRequests: number;
	closedSockets: number;
	closedSocketRequests: number;
	requestsPerSocket: Record<RequestsPerSocketBucket, number>;
	forwardedForHops: Record<ForwardedForHops, number>;
	metadataHits: number;
	metadataMisses: number;
	metadataEtagRevalidations: number;
	schemaHits: number;
	schemaMisses: number;
	ipcDropped: number;
}

export interface TempLogClaimResult {
	logNumber: number;
	total: number;
	activeSessionCount: number;
}

interface ClientInfo {
	name: string;
	version: string;
}

interface ModernInflightEntry {
	info: ClientInfo;
	count: number;
}

interface AggregatedGradioCacheMetrics {
	spaceMetadata: {
		hits: number;
		misses: number;
		hitRate: number;
		etagRevalidations: number;
		cacheSize: number;
	};
	schemas: {
		hits: number;
		misses: number;
		hitRate: number;
		cacheSize: number;
	};
	totalHits: number;
	totalMisses: number;
	overallHitRate: number;
}

export function emptyRetiredTotals(): RetiredWorkerTotals {
	return {
		totalConnections: 0,
		totalRequests: 0,
		closedSockets: 0,
		closedSocketRequests: 0,
		requestsPerSocket: { '1': 0, '2-10': 0, '11-100': 0, '101-1000': 0, '1001+': 0 },
		forwardedForHops: { '0': 0, '1': 0, '2': 0, '3': 0, '4+': 0 },
		metadataHits: 0,
		metadataMisses: 0,
		metadataEtagRevalidations: 0,
		schemaHits: 0,
		schemaMisses: 0,
		ipcDropped: 0,
	};
}

function aggregateFleetRateWindow(
	samples: readonly FleetRateSample[],
	windowMs: number
): { rps: { avg: number; max: number }; cps: { avg: number; max: number } } | null {
	const latest = samples[samples.length - 1];
	if (!latest) return null;
	const cutoff = latest.atMs - windowMs;
	let count = 0;
	let rpsSum = 0;
	let rpsMax = 0;
	let cpsSum = 0;
	let cpsMax = 0;

	for (let i = samples.length - 1; i >= 0; i--) {
		const s = samples[i];
		if (!s || s.atMs < cutoff) break;
		count++;
		rpsSum += s.rps;
		if (s.rps > rpsMax) rpsMax = s.rps;
		cpsSum += s.cps;
		if (s.cps > cpsMax) cpsMax = s.cps;
	}

	if (count === 0) return null;
	return {
		rps: { avg: rpsSum / count, max: rpsMax },
		cps: { avg: cpsSum / count, max: cpsMax },
	};
}

function aggregateWindow(
	windows: Array<RuntimeWindow | null>,
	fleetRateSamples: readonly FleetRateSample[] | undefined,
	windowMs: number
): RuntimeWindow | null {
	const present = windows.filter((w): w is RuntimeWindow => w !== null);
	if (present.length === 0) return null;

	let samples = 0;
	let eluAvg = 0;
	let eluMax = 0;
	let cpuAvg = 0;
	let cpuMax = 0;
	let delayAvg = 0;
	let delayMax = 0;
	let rpsAvg = 0;
	let rpsMax = 0;
	let connAvg = 0;
	let connMax = 0;

	for (const w of present) {
		if (w.samples > samples) samples = w.samples;
		if (w.eventLoopUtilization.avg > eluAvg) eluAvg = w.eventLoopUtilization.avg;
		if (w.eventLoopUtilization.max > eluMax) eluMax = w.eventLoopUtilization.max;
		if (w.cpuPercent.avg > cpuAvg) cpuAvg = w.cpuPercent.avg;
		if (w.cpuPercent.max > cpuMax) cpuMax = w.cpuPercent.max;
		if (w.eventLoopDelayP99Ms.avg > delayAvg) delayAvg = w.eventLoopDelayP99Ms.avg;
		if (w.eventLoopDelayP99Ms.max > delayMax) delayMax = w.eventLoopDelayP99Ms.max;
		rpsAvg += w.httpRequestsPerSecond.avg;
		rpsMax += w.httpRequestsPerSecond.max;
		connAvg += w.newConnectionsPerSecond.avg;
		connMax += w.newConnectionsPerSecond.max;
	}

	const fleetRates = fleetRateSamples ? aggregateFleetRateWindow(fleetRateSamples, windowMs) : null;

	return {
		samples,
		eventLoopUtilization: { avg: eluAvg, max: eluMax },
		cpuPercent: { avg: cpuAvg, max: cpuMax },
		eventLoopDelayP99Ms: { avg: delayAvg, max: delayMax },
		httpRequestsPerSecond: fleetRates ? fleetRates.rps : { avg: rpsAvg, max: rpsMax },
		newConnectionsPerSecond: fleetRates ? fleetRates.cps : { avg: connAvg, max: connMax },
	};
}

export interface AggregateClusterRuntimeInput {
	supervisor: RuntimeMetricsResponse;
	supervisorStartedAtMs: number;
	liveWorkers: Iterable<WorkerStatsPayload>;
	retired: RetiredWorkerTotals;
	desiredWorkers: number;
	totalRestarts: number;
	sessionRpcFailures: number;
	legacySessions: number;
	fleetRateSamples?: readonly FleetRateSample[];
	now?: number;
}

/**
 * Pure aggregation of supervisor + live workers + retired worker accumulators
 * into a single fleet-wide `RuntimeMetricsResponse`.
 */
export function aggregateClusterRuntimeMetrics(input: AggregateClusterRuntimeInput): RuntimeMetricsResponse {
	const now = input.now ?? Date.now();
	const live = Array.from(input.liveWorkers).sort((a, b) => a.workerId - b.workerId);
	const { supervisor, retired } = input;

	let openSockets = 0;
	let totalConnections = retired.totalConnections;
	let totalRequests = retired.totalRequests;
	let closedSockets = retired.closedSockets;
	let closedSocketRequests = retired.closedSocketRequests;
	const requestsPerSocket: Record<RequestsPerSocketBucket, number> = { ...retired.requestsPerSocket };
	const forwardedForHops: Record<ForwardedForHops, number> = { ...retired.forwardedForHops };

	let rssBytes = supervisor.memory.rssBytes;
	let heapUsedBytes = supervisor.memory.heapUsedBytes;
	let heapTotalBytes = supervisor.memory.heapTotalBytes;
	let heapLimitBytes = supervisor.memory.heapLimitBytes;
	let externalBytes = supervisor.memory.externalBytes;

	let ipcDropped = retired.ipcDropped;

	const currentSamples: RuntimeSample[] = [];
	const workerSummaries: ClusterWorkerSummary[] = [];

	for (const worker of live) {
		const rt = worker.runtime;
		openSockets += rt.http.openSockets;
		totalConnections += rt.http.totalConnections;
		totalRequests += rt.http.totalRequests;
		closedSockets += rt.http.closedSockets;
		closedSocketRequests += rt.http.closedSocketRequests;

		for (const bucket of REQUESTS_PER_SOCKET_BUCKETS) {
			requestsPerSocket[bucket] += rt.http.requestsPerSocket[bucket] ?? 0;
		}
		for (const bucket of FORWARDED_FOR_HOP_BUCKETS) {
			forwardedForHops[bucket] += rt.forwardedForHops[bucket] ?? 0;
		}

		rssBytes += rt.memory.rssBytes;
		heapUsedBytes += rt.memory.heapUsedBytes;
		heapTotalBytes += rt.memory.heapTotalBytes;
		heapLimitBytes += rt.memory.heapLimitBytes;
		externalBytes += rt.memory.externalBytes;
		ipcDropped += worker.ipcDropped;

		if (rt.current) {
			currentSamples.push(rt.current);
		}

		workerSummaries.push({
			workerId: worker.workerId,
			pid: worker.pid,
			uptimeSeconds: Math.max(0, Math.floor((now - worker.startedAtMs) / 1000)),
			eventLoopUtilization: rt.current ? rt.current.eventLoopUtilization : null,
			cpuPercent: rt.current ? rt.current.cpuPercent : null,
			eventLoopDelayP99Ms: rt.current ? rt.current.eventLoopDelayP99Ms : null,
			httpRequestsPerSecond: rt.current ? rt.current.httpRequestsPerSecond : null,
			openSockets: rt.http.openSockets,
			totalRequests: rt.http.totalRequests,
			rssBytes: rt.memory.rssBytes,
			heapUsedBytes: rt.memory.heapUsedBytes,
			gradioCacheSize: worker.gradioCache.metadataCacheSize + worker.gradioCache.schemaCacheSize,
		});
	}

	let aggregatedCurrent: RuntimeSample | null = null;
	if (currentSamples.length > 0) {
		let maxElu = 0;
		let maxCpu = 0;
		let maxP50 = 0;
		let maxP99 = 0;
		let maxDelay = 0;
		let sumRps = 0;
		let sumNewConn = 0;
		let latestAt = currentSamples[0]?.at ?? new Date(now).toISOString();

		for (const sample of currentSamples) {
			if (sample.eventLoopUtilization > maxElu) maxElu = sample.eventLoopUtilization;
			if (sample.cpuPercent > maxCpu) maxCpu = sample.cpuPercent;
			if (sample.eventLoopDelayP50Ms > maxP50) maxP50 = sample.eventLoopDelayP50Ms;
			if (sample.eventLoopDelayP99Ms > maxP99) maxP99 = sample.eventLoopDelayP99Ms;
			if (sample.eventLoopDelayMaxMs > maxDelay) maxDelay = sample.eventLoopDelayMaxMs;
			sumRps += sample.httpRequestsPerSecond;
			sumNewConn += sample.newConnectionsPerSecond;
			if (sample.at > latestAt) latestAt = sample.at;
		}

		const latestFleetRate =
			input.fleetRateSamples && input.fleetRateSamples.length > 0
				? input.fleetRateSamples[input.fleetRateSamples.length - 1]
				: undefined;
		aggregatedCurrent = {
			at: latestAt,
			eventLoopUtilization: maxElu,
			cpuPercent: maxCpu,
			eventLoopDelayP50Ms: maxP50,
			eventLoopDelayP99Ms: maxP99,
			eventLoopDelayMaxMs: maxDelay,
			httpRequestsPerSecond: latestFleetRate ? latestFleetRate.rps : sumRps,
			newConnectionsPerSecond: latestFleetRate ? latestFleetRate.cps : sumNewConn,
			openSockets,
			rssBytes,
			heapUsedBytes,
		};
	}

	const clusterInfo: ClusterRuntimeInfo = {
		enabled: true,
		desiredWorkers: input.desiredWorkers,
		activeWorkers: live.length,
		totalRestarts: input.totalRestarts,
		ipcDropped,
		sessionRpcFailures: input.sessionRpcFailures,
		supervisor: {
			pid: supervisor.pid,
			uptimeSeconds: Math.max(0, Math.floor((now - input.supervisorStartedAtMs) / 1000)),
			eventLoopUtilization: supervisor.current ? supervisor.current.eventLoopUtilization : null,
			cpuPercent: supervisor.current ? supervisor.current.cpuPercent : null,
			eventLoopDelayP99Ms: supervisor.current ? supervisor.current.eventLoopDelayP99Ms : null,
			rssBytes: supervisor.memory.rssBytes,
			heapUsedBytes: supervisor.memory.heapUsedBytes,
		},
		workers: workerSummaries,
	};

	return {
		reportingSchema: 'runtime_v1',
		pid: supervisor.pid,
		nodeVersion: supervisor.nodeVersion,
		availableParallelism: supervisor.availableParallelism,
		sampleIntervalMs: supervisor.sampleIntervalMs,
		current: aggregatedCurrent,
		windows: {
			'1m': aggregateWindow(
				live.map((w) => w.runtime.windows['1m']),
				input.fleetRateSamples,
				WINDOW_DURATION_MS['1m']
			),
			'15m': aggregateWindow(
				live.map((w) => w.runtime.windows['15m']),
				input.fleetRateSamples,
				WINDOW_DURATION_MS['15m']
			),
			'1h': aggregateWindow(
				live.map((w) => w.runtime.windows['1h']),
				input.fleetRateSamples,
				WINDOW_DURATION_MS['1h']
			),
		},
		memory: {
			rssBytes,
			heapUsedBytes,
			heapTotalBytes,
			heapLimitBytes,
			externalBytes,
		},
		http: {
			openSockets,
			totalConnections,
			totalRequests,
			requestsPerSocket,
			closedSockets,
			closedSocketRequests,
		},
		forwardedForHops,
		legacySessions: input.legacySessions,
		cluster: clusterInfo,
	};
}

export interface ClusterMetricsHubOptions {
	desiredWorkers: number;
	externalApiMode?: boolean;
}

export class ClusterMetricsHub {
	public readonly metricsCounter: MetricsCounter;
	public readonly sessionRegistry: SessionRegistry;
	public readonly sessionStore: ClusterSessionStore;

	private readonly desiredWorkers: number;
	private readonly externalApiMode: boolean;
	private readonly supervisorStartedAtMs = Date.now();
	private readonly liveWorkers = new Map<number, WorkerStatsPayload>();
	private readonly retired: RetiredWorkerTotals = emptyRetiredTotals();
	private readonly modernInflight = new Map<number, Map<string, ModernInflightEntry>>();
	private readonly fleetRateSamples: FleetRateSample[] = [];
	private lastFleetTotals: { atMs: number; totalRequests: number; totalConnections: number } | null = null;
	private fleetRateTimer: NodeJS.Timeout | undefined;
	private totalRestarts = 0;

	private readonly tempLogMax: number;
	private tempLogCounter = 0;
	private tempLogOriginalCount = 0;

	private cachedTransportMetricsJson: { json: string; expiresAt: number } | null = null;

	constructor(options: ClusterMetricsHubOptions) {
		this.desiredWorkers = options.desiredWorkers;
		this.externalApiMode = options.externalApiMode ?? Boolean(process.env.USER_CONFIG_API);
		this.metricsCounter = new MetricsCounter();
		createForwardingMetrics(this.metricsCounter);
		this.sessionRegistry = new SessionRegistry({ metrics: this.metricsCounter });
		this.sessionStore = new ClusterSessionStore(this.sessionRegistry);
		const parsedMax = Number.parseInt(process.env.TEMPLOG_MAX || '0', 10);
		this.tempLogMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 0;
	}

	public recordWorkerStats(stats: WorkerStatsPayload): void {
		this.liveWorkers.set(stats.workerId, stats);
	}

	public recordWorkerRestart(): void {
		this.totalRestarts++;
	}

	public recordModernClientEnter(workerId: number, clientInfo: ClientInfo): void {
		let workerMap = this.modernInflight.get(workerId);
		if (!workerMap) {
			workerMap = new Map();
			this.modernInflight.set(workerId, workerMap);
		}
		const key = `${clientInfo.name}\0${clientInfo.version}`;
		const existing = workerMap.get(key);
		if (existing) {
			existing.count++;
		} else {
			workerMap.set(key, { info: clientInfo, count: 1 });
		}
		this.metricsCounter.associateSessionWithClient(clientInfo);
	}

	public recordModernClientExit(workerId: number, clientInfo: ClientInfo): boolean {
		const workerMap = this.modernInflight.get(workerId);
		if (!workerMap) return false;
		const key = `${clientInfo.name}\0${clientInfo.version}`;
		const existing = workerMap.get(key);
		if (!existing) return false;
		existing.count--;
		if (existing.count <= 0) {
			workerMap.delete(key);
			if (workerMap.size === 0) {
				this.modernInflight.delete(workerId);
			}
		}
		this.metricsCounter.disconnectClient(clientInfo);
		return true;
	}

	public recordFleetRateSample(now: number = Date.now()): void {
		let totalRequests = this.retired.totalRequests;
		let totalConnections = this.retired.totalConnections;
		for (const worker of this.liveWorkers.values()) {
			totalRequests += worker.runtime.http.totalRequests;
			totalConnections += worker.runtime.http.totalConnections;
		}
		if (this.lastFleetTotals && now > this.lastFleetTotals.atMs) {
			const elapsedSec = (now - this.lastFleetTotals.atMs) / 1000;
			const rps = Math.max(0, (totalRequests - this.lastFleetTotals.totalRequests) / elapsedSec);
			const cps = Math.max(0, (totalConnections - this.lastFleetTotals.totalConnections) / elapsedSec);
			this.fleetRateSamples.push({ atMs: now, rps, cps });
			if (this.fleetRateSamples.length > MAX_FLEET_RATE_SAMPLES) {
				this.fleetRateSamples.shift();
			}
		}
		this.lastFleetTotals = { atMs: now, totalRequests, totalConnections };
	}

	public startFleetRateSampling(intervalMs: number = FLEET_RATE_SAMPLE_INTERVAL_MS): void {
		if (this.fleetRateTimer || intervalMs <= 0) return;
		this.recordFleetRateSample();
		this.fleetRateTimer = setInterval(() => this.recordFleetRateSample(), intervalMs);
		this.fleetRateTimer.unref();
	}

	public stopFleetRateSampling(): void {
		if (this.fleetRateTimer) {
			clearInterval(this.fleetRateTimer);
			this.fleetRateTimer = undefined;
		}
	}

	/**
	 * Fold a departing worker's last observed cumulative stats into `retired`
	 * exactly once, and release any stranded modern client gauges for that worker.
	 */
	public onWorkerExit(workerId: number): void {
		const last = this.liveWorkers.get(workerId);
		if (last) {
			this.liveWorkers.delete(workerId);
			this.retired.totalConnections += last.runtime.http.totalConnections;
			this.retired.totalRequests += last.runtime.http.totalRequests;
			this.retired.closedSockets += last.runtime.http.closedSockets;
			this.retired.closedSocketRequests += last.runtime.http.closedSocketRequests;
			for (const bucket of REQUESTS_PER_SOCKET_BUCKETS) {
				this.retired.requestsPerSocket[bucket] += last.runtime.http.requestsPerSocket[bucket] ?? 0;
			}
			for (const bucket of FORWARDED_FOR_HOP_BUCKETS) {
				this.retired.forwardedForHops[bucket] += last.runtime.forwardedForHops[bucket] ?? 0;
			}
			this.retired.metadataHits += last.gradioCache.metadataHits;
			this.retired.metadataMisses += last.gradioCache.metadataMisses;
			this.retired.metadataEtagRevalidations += last.gradioCache.metadataEtagRevalidations;
			this.retired.schemaHits += last.gradioCache.schemaHits;
			this.retired.schemaMisses += last.gradioCache.schemaMisses;
			this.retired.ipcDropped += last.ipcDropped;
		}

		const stranded = this.modernInflight.get(workerId);
		if (stranded) {
			this.modernInflight.delete(workerId);
			for (const entry of stranded.values()) {
				for (let i = 0; i < entry.count; i++) {
					this.metricsCounter.disconnectClient(entry.info);
				}
			}
		}
	}

	public activateTempLogging(count: number): number {
		if (this.tempLogMax <= 0) return 0;
		this.tempLogCounter = Math.min(count, this.tempLogMax);
		this.tempLogOriginalCount = this.tempLogCounter;
		if (this.tempLogCounter > 0) {
			logger.info(`Temporary logging activated for ${String(this.tempLogCounter)} session resume failures`);
		}
		return this.tempLogCounter;
	}

	public getTempLogStatus(): { enabled: boolean; remaining: number; maxAllowed: number } {
		return {
			enabled: this.tempLogMax > 0,
			remaining: this.tempLogCounter,
			maxAllowed: this.tempLogMax,
		};
	}

	public claimTempLogSlot(): TempLogClaimResult | null {
		if (this.tempLogCounter <= 0) return null;
		const logNumber = this.tempLogOriginalCount - this.tempLogCounter + 1;
		this.tempLogCounter--;
		if (this.tempLogCounter === 0) {
			logger.info('Temporary logging completed - auto-disabled');
		}
		return {
			logNumber,
			total: this.tempLogOriginalCount,
			activeSessionCount: this.sessionRegistry.size,
		};
	}

	public buildClusterRuntimeMetrics(): RuntimeMetricsResponse {
		const rawMetrics = this.metricsCounter.getMetrics();
		return aggregateClusterRuntimeMetrics({
			supervisor: runtimeMetrics.snapshot(),
			supervisorStartedAtMs: this.supervisorStartedAtMs,
			liveWorkers: this.liveWorkers.values(),
			retired: this.retired,
			desiredWorkers: this.desiredWorkers,
			totalRestarts: this.totalRestarts,
			sessionRpcFailures: rawMetrics.sessions?.rpcFailures ?? 0,
			legacySessions: this.sessionRegistry.size,
			fleetRateSamples: this.fleetRateSamples,
		});
	}

	public buildClusterGradioCacheMetrics(): AggregatedGradioCacheMetrics {
		let metadataHits = this.retired.metadataHits;
		let metadataMisses = this.retired.metadataMisses;
		let metadataEtagRevalidations = this.retired.metadataEtagRevalidations;
		let metadataCacheSize = 0;
		let schemaHits = this.retired.schemaHits;
		let schemaMisses = this.retired.schemaMisses;
		let schemaCacheSize = 0;

		for (const worker of this.liveWorkers.values()) {
			metadataHits += worker.gradioCache.metadataHits;
			metadataMisses += worker.gradioCache.metadataMisses;
			metadataEtagRevalidations += worker.gradioCache.metadataEtagRevalidations;
			metadataCacheSize += worker.gradioCache.metadataCacheSize;
			schemaHits += worker.gradioCache.schemaHits;
			schemaMisses += worker.gradioCache.schemaMisses;
			schemaCacheSize += worker.gradioCache.schemaCacheSize;
		}

		const metadataTotal = metadataHits + metadataMisses;
		const metadataHitRate = metadataTotal > 0 ? Math.round((metadataHits / metadataTotal) * 10000) / 100 : 0;

		const schemaTotal = schemaHits + schemaMisses;
		const schemaHitRate = schemaTotal > 0 ? Math.round((schemaHits / schemaTotal) * 10000) / 100 : 0;

		const totalHits = metadataHits + schemaHits;
		const totalMisses = metadataMisses + schemaMisses;
		const grandTotal = totalHits + totalMisses;
		const overallHitRate = grandTotal > 0 ? Math.round((totalHits / grandTotal) * 10000) / 100 : 0;

		return {
			spaceMetadata: {
				hits: metadataHits,
				misses: metadataMisses,
				hitRate: metadataHitRate,
				etagRevalidations: metadataEtagRevalidations,
				cacheSize: metadataCacheSize,
			},
			schemas: {
				hits: schemaHits,
				misses: schemaMisses,
				hitRate: schemaHitRate,
				cacheSize: schemaCacheSize,
			},
			totalHits,
			totalMisses,
			overallHitRate,
		};
	}

	public buildTransportMetricsJson(activateTempLog?: number | null): string {
		const requestedTempLog =
			typeof activateTempLog === 'number' && Number.isFinite(activateTempLog) && activateTempLog > 0
				? activateTempLog
				: undefined;
		const now = Date.now();
		if (
			requestedTempLog === undefined &&
			this.cachedTransportMetricsJson &&
			this.cachedTransportMetricsJson.expiresAt > now
		) {
			return this.cachedTransportMetricsJson.json;
		}

		let tempLogStatus: { activated?: boolean; enabled?: boolean; remaining: number; maxAllowed: number } | undefined;
		if (requestedTempLog !== undefined) {
			const activated = this.activateTempLogging(requestedTempLog);
			tempLogStatus = {
				activated: true,
				remaining: activated,
				maxAllowed: this.getTempLogStatus().maxAllowed,
			};
		} else {
			const status = this.getTempLogStatus();
			if (status.enabled) {
				tempLogStatus = status;
			}
		}

		const rawMetrics = this.metricsCounter.getMetrics();
		const formattedMetrics = formatMetricsForAPI(rawMetrics, 'streamableHttpJson', true, []);
		formattedMetrics.hfFsMetrics = getHfFsLiveMetrics();
		formattedMetrics.dynamicSpaceMetrics = getDynamicSpaceLiveMetrics();
		formattedMetrics.runtimeMetrics = this.buildClusterRuntimeMetrics();
		if (this.externalApiMode) {
			formattedMetrics.apiMetrics = apiMetrics.getMetrics();
		}
		formattedMetrics.gradioMetrics = gradioMetrics.getMetrics();
		formattedMetrics.gradioCacheMetrics = this.buildClusterGradioCacheMetrics();

		const extendedMetrics = formattedMetrics as typeof formattedMetrics & { tempLogStatus?: unknown };
		if (tempLogStatus) {
			extendedMetrics.tempLogStatus = tempLogStatus;
		}

		const json = JSON.stringify(extendedMetrics);
		if (requestedTempLog === undefined) {
			this.cachedTransportMetricsJson = { json, expiresAt: now + TRANSPORT_METRICS_CACHE_TTL_MS };
		}
		return json;
	}
}

let activeHub: ClusterMetricsHub | null = null;

function requireHub(): ClusterMetricsHub {
	if (!activeHub) {
		throw new Error('ClusterMetricsHub has not been initialized on primary');
	}
	return activeHub;
}

export function initPrimaryMetricsHub(options: ClusterMetricsHubOptions): ClusterMetricsHub {
	activeHub = new ClusterMetricsHub(options);
	return activeHub;
}

export const forwardModernClientEnter = forward(
	'metrics.modernEnter',
	(workerId: number, clientInfo: ClientInfo): void => {
		activeHub?.recordModernClientEnter(workerId, clientInfo);
	}
);

export const forwardModernClientExit = forward(
	'metrics.modernExit',
	(workerId: number, clientInfo: ClientInfo): void => {
		activeHub?.recordModernClientExit(workerId, clientInfo);
	}
);

export const remoteTransportMetricsJson = remote(
	'api.transportMetricsJson',
	(activateTempLog?: number | null): string => requireHub().buildTransportMetricsJson(activateTempLog),
	RPC_TIMEOUT_MS
);

export const remoteSessions = remote(
	'api.sessions',
	(limit?: number): SessionMetadata[] => requireHub().sessionRegistry.list(limit).sessions,
	RPC_TIMEOUT_MS
);

export const remotePtcMetrics = remote('api.ptcMetrics', (): PtcMetricsResponse => getPtcMetrics(), RPC_TIMEOUT_MS);

export const remoteSkillsLiveMetrics = remote(
	'api.skillsLiveMetrics',
	(filters: SkillsMetricsFilters): ReturnType<typeof skillsLiveMetrics.snapshot> => skillsLiveMetrics.snapshot(filters),
	RPC_TIMEOUT_MS
);

export const remoteDefinitionTagsStats = remote(
	'api.definitionTagsStats',
	(): ReturnType<typeof definitionTagsStats> => definitionTagsStats(),
	RPC_TIMEOUT_MS
);

export const remoteClaimTempLogSlot = remote(
	'templog.claim',
	(): TempLogClaimResult | null => requireHub().claimTempLogSlot(),
	RPC_TIMEOUT_MS
);
