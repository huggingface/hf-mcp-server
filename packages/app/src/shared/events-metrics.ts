import type { TransportType } from './constants.js';

export const EVENT_METRIC_METHODS = ['events/list', 'events/poll'] as const;
export type EventMetricMethod = (typeof EVENT_METRIC_METHODS)[number];

export const EVENT_METRIC_OUTCOMES = [
	'ok',
	'delivered',
	'empty',
	'truncated',
	'auth_rejected',
	'header_mismatch',
	'not_found',
	'forbidden',
	'invalid_params',
	'method_not_found',
	'error',
] as const;
export type EventMetricOutcome = (typeof EVENT_METRIC_OUTCOMES)[number];

type EventsMetricsWindow = '15m' | '1h' | '24h';

export interface EventsMetricsFilters {
	window: EventsMetricsWindow;
	/** Case-insensitive substring of either self-reported client field; at most 128 characters. */
	client: string;
	method: EventMetricMethod | 'all';
	outcome: 'success' | 'failure' | 'all';
}

export interface EventsMetricsCounts {
	requests: number;
	successes: number;
	failures: number;
	/** Successful events/poll responses that emitted one or more events (e.g. a stage transition). */
	deliveredPolls: number;
	/** Successful events/poll responses with zero events and truncated: false. */
	emptyPolls: number;
	/** Successful events/poll responses with truncated: true (cursor reset or maxAgeMs exceeded). */
	truncatedPolls: number;
	/** Total individual events emitted across delivered events/poll responses. */
	deliveredEvents: number;
	lastSeen: number | null;
}

export interface EventsDiscoverySummary {
	/** Successful server/discover responses advertising io.modelcontextprotocol/events in the window. */
	advertisedResponses: number;
	/** Distinct self-reported (name, version) client pairs offered Events in the window. */
	uniqueClients: number;
	lastAdvertised: number | null;
}

export interface EventsLiveMetricsSnapshot {
	filters: EventsMetricsFilters;
	generatedAt: number;
	/** Inclusive event timestamp bounds, in Unix milliseconds. */
	windowStart: number;
	windowEnd: number;
	totals: EventsMetricsCounts & {
		listRequests: number;
		pollRequests: number;
		/** requests / full requested window minutes, NOT observed coverage. */
		requestsPerMinute: number;
	};
	discovery: EventsDiscoverySummary;
	/**
	 * Clients that made matching events/list or events/poll requests in the window.
	 * advertisedCount reflects how many times that client received the Events capability
	 * via server/discover in the same window.
	 */
	byClient: (EventsMetricsCounts & { name: string; version: string; advertisedCount: number })[];
	byMethod: (EventsMetricsCounts & { method: EventMetricMethod })[];
	/** Breakdown of events/poll requests by normalized event name (known name or [unknown]). */
	byEventName: (EventsMetricsCounts & { eventName: string })[];
	/** Breakdown of matching requests by classified outcome. */
	byOutcome: { outcome: EventMetricOutcome; count: number; lastSeen: number | null }[];
	/** Sparse UTC minute buckets; absent minutes have zero events. Edge buckets may be partial. */
	timeline: (EventsMetricsCounts & { minute: number })[];
	retention: {
		maxEvents: number;
		maxAgeMs: number;
		retainedEvents: number;
		/** Process lifetime counts, before filters. */
		capacityEvictions: number;
		expiredEvents: number;
		/** Earliest timestamp from which coverage is complete; not the oldest matching event. */
		availableSince: number;
		/** Requested window includes time before complete coverage (including process startup). */
		truncated: boolean;
	};
}

export interface EventsMetricsResponse {
	transport: TransportType;
	/** Whether MCP_EVENTS_ENABLED is currently active in this process. */
	enabled: boolean;
	supported: boolean;
	unsupportedReason: string | null;
	/** Null on unsupported transports; never implies zero Events usage there. */
	live: EventsLiveMetricsSnapshot | null;
}
