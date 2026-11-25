/** Served PTC bouquet names (`?bouquet=ptc` and its aliases). */
export const PTC_BOUQUETS = ['ptc', 'codemode', 'openaiptc'] as const;
export type PtcBouquet = (typeof PTC_BOUQUETS)[number];

/** Process-local (or cluster-aggregated) PTC bouquet usage, served at /api/ptc-metrics. */
interface PtcToolMetrics {
	name: string;
	family: string;
	calls: number;
	errors: number;
	avgDurationMs: number;
	lastCalled: string | null;
}

export interface PtcBouquetMetrics {
	requests: number;
	toolCalls: number;
	toolErrors: number;
	access: { anonymous: number; authenticated: number; write: number };
	lastSeen: string | null;
}

export interface PtcClientMetrics {
	name: string;
	version: string;
	bouquet: PtcBouquet;
	/** MCP requests served with the PTC bouquet (tools/list, tools/call, ...). */
	requests: number;
	toolCalls: number;
	toolErrors: number;
	anonymousRequests: number;
	firstSeen: string;
	lastSeen: string;
}

export interface PtcMetricsResponse {
	startedAt: string;
	requests: number;
	toolCalls: number;
	toolErrors: number;
	/** Requests by the access level that decided the listed tools. */
	access: { anonymous: number; authenticated: number; write: number };
	/** Usage split by served bouquet alias (ptc, codemode, openaiptc). */
	bouquets: Record<PtcBouquet, PtcBouquetMetrics>;
	tools: PtcToolMetrics[];
	clients: PtcClientMetrics[];
	errorCodes: Record<string, number>;
}
