/**
 * Process runtime health, sampled in-process. Used to judge CPU headroom and
 * how traffic reaches the process (keep-alive reuse, proxy hops) before and
 * after enabling multiple workers.
 */

export type RequestsPerSocketBucket = '1' | '2-10' | '11-100' | '101-1000' | '1001+';
export type ForwardedForHops = '0' | '1' | '2' | '3' | '4+';

export interface RuntimeSample {
	at: string;
	/** Main-thread event loop utilisation (0..1) over the sample interval. */
	eventLoopUtilization: number;
	/** Process CPU over the interval, as % of one core (threads can push it past 100). */
	cpuPercent: number;
	eventLoopDelayP50Ms: number;
	eventLoopDelayP99Ms: number;
	eventLoopDelayMaxMs: number;
	httpRequestsPerSecond: number;
	newConnectionsPerSecond: number;
	openSockets: number;
	rssBytes: number;
	heapUsedBytes: number;
}

export interface RuntimeWindowStat {
	avg: number;
	max: number;
}

export interface RuntimeWindow {
	samples: number;
	eventLoopUtilization: RuntimeWindowStat;
	cpuPercent: RuntimeWindowStat;
	eventLoopDelayP99Ms: RuntimeWindowStat;
	httpRequestsPerSecond: RuntimeWindowStat;
	newConnectionsPerSecond: RuntimeWindowStat;
}

export interface RuntimeMetricsResponse {
	reportingSchema: 'runtime_v1';
	pid: number;
	nodeVersion: string;
	availableParallelism: number;
	sampleIntervalMs: number;
	current: RuntimeSample | null;
	windows: {
		'1m': RuntimeWindow | null;
		'15m': RuntimeWindow | null;
		'1h': RuntimeWindow | null;
	};
	memory: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		heapLimitBytes: number;
		externalBytes: number;
	};
	http: {
		openSockets: number;
		totalConnections: number;
		totalRequests: number;
		/** Requests served per socket, counted when each socket closes. */
		requestsPerSocket: Record<RequestsPerSocketBucket, number>;
		closedSockets: number;
		closedSocketRequests: number;
	};
	/** Entries in X-Forwarded-For on /mcp requests: how many proxies appended to it. */
	forwardedForHops: Record<ForwardedForHops, number>;
	legacySessions: number | null;
	cluster?: ClusterRuntimeInfo;
}

interface ClusterSupervisorSummary {
	pid: number;
	uptimeSeconds: number;
	eventLoopUtilization: number | null;
	cpuPercent: number | null;
	eventLoopDelayP99Ms: number | null;
	rssBytes: number;
	heapUsedBytes: number;
}

export interface ClusterWorkerSummary {
	workerId: number;
	pid: number;
	uptimeSeconds: number;
	eventLoopUtilization: number | null;
	cpuPercent: number | null;
	eventLoopDelayP99Ms: number | null;
	httpRequestsPerSecond: number | null;
	openSockets: number;
	totalRequests: number;
	rssBytes: number;
	heapUsedBytes: number;
	gradioCacheSize: number;
}

export interface ClusterRuntimeInfo {
	enabled: boolean;
	desiredWorkers: number;
	activeWorkers: number;
	totalRestarts: number;
	ipcDropped: number;
	sessionRpcFailures: number;
	supervisor: ClusterSupervisorSummary;
	workers: ClusterWorkerSummary[];
}
