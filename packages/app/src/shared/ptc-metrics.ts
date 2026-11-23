/** Process-local PTC bouquet usage, served at /api/ptc-metrics. */
interface PtcToolMetrics {
	name: string;
	family: string;
	calls: number;
	errors: number;
	avgDurationMs: number;
	lastCalled: string | null;
}

export interface PtcClientMetrics {
	name: string;
	version: string;
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
	tools: PtcToolMetrics[];
	clients: PtcClientMetrics[];
	errorCodes: Record<string, number>;
}
