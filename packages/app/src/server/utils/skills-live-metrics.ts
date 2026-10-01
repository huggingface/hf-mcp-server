import {
	SKILL_METRIC_METHODS,
	type SkillMetricMethod,
	type SkillsLiveMetricsSnapshot,
	type SkillsMetricsCounts,
	type SkillsMetricsFilters,
} from '../../shared/skills-metrics.js';

export const SKILLS_MAX_EVENTS = 10_000;
export const SKILLS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLIENT_LIMIT = 128;
const WINDOWS = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': SKILLS_MAX_AGE_MS };

/** Reject arrays, duplicate/unknown keys, nested values and overlong input without echoing it. */
export function parseSkillsMetricsFilters(query: Record<string, unknown>): SkillsMetricsFilters | null {
	if (Object.keys(query).some((key) => !['window', 'client', 'method', 'outcome'].includes(key))) return null;
	for (const value of Object.values(query)) {
		if (typeof value !== 'string' || value.length > CLIENT_LIMIT) return null;
	}
	const window = query.window ?? '1h';
	const client = query.client ?? '';
	const method = query.method ?? 'all';
	const outcome = query.outcome ?? 'all';
	if (window !== '15m' && window !== '1h' && window !== '24h') return null;
	if (method !== 'all' && !SKILL_METRIC_METHODS.includes(method as SkillMetricMethod)) return null;
	if (outcome !== 'all' && outcome !== 'success' && outcome !== 'failure') return null;
	return { window, client: client as string, method: method as SkillMetricMethod | 'all', outcome };
}

/** URI is inspected transiently and is never retained. Decode the path, not query/fragment text. */
export function isSkillDocumentUri(uri: string | undefined): boolean {
	if (!uri) return false;
	try {
		return decodeURIComponent(new URL(uri).pathname).endsWith('/SKILL.md');
	} catch {
		return false;
	}
}

interface LiveEvent {
	at: number;
	method: SkillMetricMethod;
	success: boolean;
	document: boolean;
	name: string;
	version: string;
}
export interface SkillLiveEventInput {
	method: SkillMetricMethod;
	success: boolean;
	skillDocument: boolean;
	clientName?: string;
	clientVersion?: string;
}
function counts(): SkillsMetricsCounts {
	return { requests: 0, successes: 0, failures: 0, skillDocumentReads: 0, supportingFileReads: 0, lastSeen: null };
}
function add(count: SkillsMetricsCounts, event: LiveEvent): void {
	count.requests++;
	if (event.success) count.successes++;
	else count.failures++;
	if (event.success && event.method === 'skills/resource-read') {
		if (event.document) count.skillDocumentReads++;
		else count.supportingFileReads++;
	}
	count.lastSeen = Math.max(count.lastSeen ?? event.at, event.at);
}
function boundedClient(value: string | undefined): string {
	// Explicitly strip control characters from untrusted, self-reported display metadata.
	// eslint-disable-next-line no-control-regex
	return (typeof value === 'string' ? value : '').slice(0, CLIENT_LIMIT).replace(/[\u0000-\u001f\u007f]/g, '');
}

/** Process-local bounded rolling ledger, independent of historical event logging. */
export class SkillsLiveMetrics {
	private events: LiveEvent[] = [];
	private readonly startedAt: number;
	private capacityFloor: number;
	private capacityEvictions = 0;
	private expiredEvents = 0;
	constructor(private readonly now: () => number = Date.now) {
		this.startedAt = now();
		this.capacityFloor = this.startedAt;
	}
	private prune(now: number): void {
		const cutoff = now - SKILLS_MAX_AGE_MS;
		const retained = this.events.filter((event) => event.at >= cutoff);
		this.expiredEvents += this.events.length - retained.length;
		this.events = retained;
	}
	record(input: SkillLiveEventInput): void {
		const at = this.now();
		this.prune(at);
		if (this.events.length === SKILLS_MAX_EVENTS) {
			const removed = this.events.shift();
			if (removed) this.capacityFloor = Math.max(this.capacityFloor, removed.at + 1);
			this.capacityEvictions++;
		}
		// Explicit allowlist: never spread input, even if the caller supplies extra fields.
		this.events.push({
			at,
			method: input.method,
			success: input.success,
			document: input.skillDocument,
			name: boundedClient(input.clientName),
			version: boundedClient(input.clientVersion),
		});
	}
	snapshot(filters: SkillsMetricsFilters): SkillsLiveMetricsSnapshot {
		const now = this.now();
		this.prune(now);
		const windowStart = now - WINDOWS[filters.window];
		const availableSince = Math.max(this.startedAt, this.capacityFloor, now - SKILLS_MAX_AGE_MS);
		const client = filters.client.toLowerCase();
		const selected = this.events.filter(
			(event) =>
				event.at >= windowStart &&
				event.at <= now &&
				(filters.method === 'all' || event.method === filters.method) &&
				(filters.outcome === 'all' || event.success === (filters.outcome === 'success')) &&
				(event.name.toLowerCase().includes(client) || event.version.toLowerCase().includes(client))
		);
		const totals = { ...counts(), listRequests: 0, getRequests: 0, directoryRequests: 0, requestsPerMinute: 0 };
		const clients = new Map<string, SkillsLiveMetricsSnapshot['byClient'][number]>();
		const methods = new Map<SkillMetricMethod, SkillsLiveMetricsSnapshot['byMethod'][number]>(
			SKILL_METRIC_METHODS.map((method) => [method, { method, ...counts() }])
		);
		const minutes = new Map<number, SkillsLiveMetricsSnapshot['timeline'][number]>();
		for (const event of selected) {
			add(totals, event);
			if (event.method === 'skills/list') totals.listRequests++;
			if (event.method === 'skills/get') totals.getRequests++;
			if (event.method === 'skills/directory-read') totals.directoryRequests++;
			const key = JSON.stringify([event.name, event.version]);
			const group = clients.get(key) ?? { name: event.name, version: event.version, ...counts() };
			add(group, event);
			clients.set(key, group);
			const method = methods.get(event.method);
			if (method) add(method, event);
			const minute = Math.floor(event.at / 60_000) * 60_000;
			const bucket = minutes.get(minute) ?? { minute, ...counts() };
			add(bucket, event);
			minutes.set(minute, bucket);
		}
		totals.requestsPerMinute = totals.requests / (WINDOWS[filters.window] / 60_000);
		return {
			filters: { ...filters },
			generatedAt: now,
			windowStart,
			windowEnd: now,
			totals,
			byClient: [...clients.values()],
			byMethod: [...methods.values()],
			timeline: [...minutes.values()].sort((a, b) => a.minute - b.minute),
			retention: {
				maxEvents: SKILLS_MAX_EVENTS,
				maxAgeMs: SKILLS_MAX_AGE_MS,
				retainedEvents: this.events.length,
				capacityEvictions: this.capacityEvictions,
				expiredEvents: this.expiredEvents,
				availableSince,
				truncated: windowStart < availableSince,
			},
		};
	}
}

export const skillsLiveMetrics = new SkillsLiveMetrics();
