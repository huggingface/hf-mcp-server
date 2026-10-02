import type { SkillCatalogStatus } from './skill-catalog-status.js';
import type { TransportType } from './constants.js';

export const SKILL_METRIC_METHODS = [
	'skills/list',
	'skills/get',
	'skills/resource-read',
	'skills/directory-read',
] as const;
export type SkillMetricMethod = (typeof SKILL_METRIC_METHODS)[number];
type SkillsMetricsWindow = '15m' | '1h' | '24h';
export interface SkillsMetricsFilters {
	window: SkillsMetricsWindow;
	/** Case-insensitive substring of either self-reported client field; at most 128 characters. */
	client: string;
	method: SkillMetricMethod | 'all';
	outcome: 'success' | 'failure' | 'all';
}
export interface SkillsMetricsCounts {
	requests: number;
	successes: number;
	failures: number;
	/** Successful resources/read requests only; skills/get returns metadata, not file content. */
	skillDocumentReads: number;
	supportingFileReads: number;
	lastSeen: number | null;
}
export interface SkillsLiveMetricsSnapshot {
	filters: SkillsMetricsFilters;
	generatedAt: number;
	/** Inclusive event timestamp bounds, in Unix milliseconds. */
	windowStart: number;
	windowEnd: number;
	totals: SkillsMetricsCounts & {
		listRequests: number;
		getRequests: number;
		directoryRequests: number;
		/** requests / full requested window minutes, NOT observed coverage. */
		requestsPerMinute: number;
	};
	/**
	 * Clients that have made a skills/list request anywhere in the retained ledger (the
	 * identifying feature of a Skills client), independent of the method/outcome filters.
	 * Counts follow the selected filters. Client metadata is self-reported, bounded to
	 * 128 characters per field, not an identity.
	 */
	byClient: (SkillsMetricsCounts & { name: string; version: string })[];
	/** Selected requests from clients that have not called skills/list, so excluded from byClient. */
	nonListingClientRequests: number;
	byMethod: (SkillsMetricsCounts & { method: SkillMetricMethod })[];
	/** Sparse UTC minute buckets; absent minutes have zero events. Edge buckets may be partial. */
	timeline: (SkillsMetricsCounts & { minute: number })[];
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
export interface SkillsMetricsResponse {
	transport: TransportType;
	supported: boolean;
	unsupportedReason: string | null;
	snapshot: SkillCatalogStatus;
	/** Null on unsupported transports; never implies zero Skills usage there. */
	live: SkillsLiveMetricsSnapshot | null;
}
