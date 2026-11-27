import {
	EVENT_METRIC_METHODS,
	type EventMetricMethod,
	type EventMetricOutcome,
	type EventsLiveMetricsSnapshot,
	type EventsMetricsCounts,
	type EventsMetricsFilters,
} from '../../shared/events-metrics.js';
import { forward } from '../cluster/ipc.js';

export const EVENTS_MAX_EVENTS = 10_000;
export const EVENTS_MAX_DISCOVER_EVENTS = 10_000;
export const EVENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLIENT_LIMIT = 128;
const WINDOWS = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': EVENTS_MAX_AGE_MS };

/** Reject arrays, duplicate/unknown keys, nested values and overlong input without echoing it. */
export function parseEventsMetricsFilters(query: Record<string, unknown>): EventsMetricsFilters | null {
	if (Object.keys(query).some((key) => !['window', 'client', 'method', 'outcome'].includes(key))) return null;
	for (const value of Object.values(query)) {
		if (typeof value !== 'string' || value.length > CLIENT_LIMIT) return null;
	}
	const window = query.window ?? '1h';
	const client = query.client ?? '';
	const method = query.method ?? 'all';
	const outcome = query.outcome ?? 'all';
	if (window !== '15m' && window !== '1h' && window !== '24h') return null;
	if (method !== 'all' && !EVENT_METRIC_METHODS.includes(method as EventMetricMethod)) return null;
	if (outcome !== 'all' && outcome !== 'success' && outcome !== 'failure') return null;
	return { window, client: client as string, method: method as EventMetricMethod | 'all', outcome };
}

interface LiveEvent {
	at: number;
	method: EventMetricMethod;
	eventName: string | null;
	success: boolean;
	outcome: EventMetricOutcome;
	deliveredEventCount: number;
	name: string;
	version: string;
}

interface LiveDiscoverAdvertisement {
	at: number;
	name: string;
	version: string;
}

export interface EventLiveRecordInput {
	method: EventMetricMethod;
	eventName?: string | null;
	success: boolean;
	outcome: EventMetricOutcome;
	deliveredEventCount?: number;
	clientName?: string;
	clientVersion?: string;
}

export interface EventDiscoverAdvertisementInput {
	clientName?: string;
	clientVersion?: string;
}

function counts(): EventsMetricsCounts {
	return {
		requests: 0,
		successes: 0,
		failures: 0,
		deliveredPolls: 0,
		emptyPolls: 0,
		truncatedPolls: 0,
		deliveredEvents: 0,
		lastSeen: null,
	};
}

function add(count: EventsMetricsCounts, event: LiveEvent): void {
	count.requests++;
	if (event.success) count.successes++;
	else count.failures++;
	if (event.method === 'events/poll') {
		if (event.outcome === 'delivered') {
			count.deliveredPolls++;
			count.deliveredEvents += event.deliveredEventCount;
		} else if (event.outcome === 'empty') {
			count.emptyPolls++;
		} else if (event.outcome === 'truncated') {
			count.truncatedPolls++;
		}
	}
	count.lastSeen = Math.max(count.lastSeen ?? event.at, event.at);
}

function boundedClient(value: string | undefined): string {
	// Explicitly strip control characters from untrusted, self-reported display metadata.
	// eslint-disable-next-line no-control-regex
	return (typeof value === 'string' ? value : '').slice(0, CLIENT_LIMIT).replace(/[\u0000-\u001f\u007f]/g, '');
}

function clientKey(name: string, version: string): string {
	return JSON.stringify([name, version]);
}

/** Process-local bounded rolling ledger, independent of historical dataset event logging. */
export class EventsLiveMetrics {
	private events: LiveEvent[] = [];
	private discoveries: LiveDiscoverAdvertisement[] = [];
	private readonly startedAt: number;
	private capacityFloor: number;
	private capacityEvictions = 0;
	private expiredEvents = 0;

	constructor(private readonly now: () => number = Date.now) {
		this.startedAt = now();
		this.capacityFloor = this.startedAt;
	}

	private prune(now: number): void {
		const cutoff = now - EVENTS_MAX_AGE_MS;
		const retained = this.events.filter((event) => event.at >= cutoff);
		this.expiredEvents += this.events.length - retained.length;
		this.events = retained;
		this.discoveries = this.discoveries.filter((entry) => entry.at >= cutoff);
	}

	record(input: EventLiveRecordInput): void {
		const at = this.now();
		this.prune(at);
		if (this.events.length === EVENTS_MAX_EVENTS) {
			const removed = this.events.shift();
			if (removed) this.capacityFloor = Math.max(this.capacityFloor, removed.at + 1);
			this.capacityEvictions++;
		}
		const deliveredEventCount =
			input.deliveredEventCount !== undefined &&
			Number.isSafeInteger(input.deliveredEventCount) &&
			input.deliveredEventCount > 0
				? input.deliveredEventCount
				: 0;
		// Explicit allowlist: never spread input, even if the caller supplies extra fields.
		this.events.push({
			at,
			method: input.method,
			eventName: typeof input.eventName === 'string' && input.eventName.length > 0 ? input.eventName : null,
			success: input.success,
			outcome: input.outcome,
			deliveredEventCount,
			name: boundedClient(input.clientName),
			version: boundedClient(input.clientVersion),
		});
	}

	recordAdvertised(input: EventDiscoverAdvertisementInput): void {
		const at = this.now();
		this.prune(at);
		if (this.discoveries.length === EVENTS_MAX_DISCOVER_EVENTS) {
			this.discoveries.shift();
		}
		this.discoveries.push({
			at,
			name: boundedClient(input.clientName),
			version: boundedClient(input.clientVersion),
		});
	}

	snapshot(filters: EventsMetricsFilters): EventsLiveMetricsSnapshot {
		const now = this.now();
		this.prune(now);
		const windowStart = now - WINDOWS[filters.window];
		const availableSince = Math.max(this.startedAt, this.capacityFloor, now - EVENTS_MAX_AGE_MS);
		const client = filters.client.toLowerCase();

		const selectedDiscoveries = this.discoveries.filter(
			(entry) =>
				entry.at >= windowStart &&
				entry.at <= now &&
				(entry.name.toLowerCase().includes(client) || entry.version.toLowerCase().includes(client))
		);
		const advertisedByClient = new Map<string, number>();
		let lastAdvertised: number | null = null;
		for (const entry of selectedDiscoveries) {
			const key = clientKey(entry.name, entry.version);
			advertisedByClient.set(key, (advertisedByClient.get(key) ?? 0) + 1);
			lastAdvertised = Math.max(lastAdvertised ?? entry.at, entry.at);
		}

		const selected = this.events.filter(
			(event) =>
				event.at >= windowStart &&
				event.at <= now &&
				(filters.method === 'all' || event.method === filters.method) &&
				(filters.outcome === 'all' || event.success === (filters.outcome === 'success')) &&
				(event.name.toLowerCase().includes(client) || event.version.toLowerCase().includes(client))
		);

		const totals = { ...counts(), listRequests: 0, pollRequests: 0, requestsPerMinute: 0 };
		const clients = new Map<string, EventsLiveMetricsSnapshot['byClient'][number]>();
		const methods = new Map<EventMetricMethod, EventsLiveMetricsSnapshot['byMethod'][number]>(
			EVENT_METRIC_METHODS.map((method) => [method, { method, ...counts() }])
		);
		const eventNames = new Map<string, EventsLiveMetricsSnapshot['byEventName'][number]>();
		const outcomes = new Map<EventMetricOutcome, EventsLiveMetricsSnapshot['byOutcome'][number]>();
		const minutes = new Map<number, EventsLiveMetricsSnapshot['timeline'][number]>();

		for (const event of selected) {
			add(totals, event);
			if (event.method === 'events/list') totals.listRequests++;
			if (event.method === 'events/poll') totals.pollRequests++;

			const key = clientKey(event.name, event.version);
			const group = clients.get(key) ?? {
				name: event.name,
				version: event.version,
				advertisedCount: advertisedByClient.get(key) ?? 0,
				...counts(),
			};
			add(group, event);
			clients.set(key, group);

			const method = methods.get(event.method);
			if (method) add(method, event);

			if (event.method === 'events/poll' && event.eventName) {
				const byName = eventNames.get(event.eventName) ?? { eventName: event.eventName, ...counts() };
				add(byName, event);
				eventNames.set(event.eventName, byName);
			}

			const outcomeRow = outcomes.get(event.outcome) ?? { outcome: event.outcome, count: 0, lastSeen: null };
			outcomeRow.count++;
			outcomeRow.lastSeen = Math.max(outcomeRow.lastSeen ?? event.at, event.at);
			outcomes.set(event.outcome, outcomeRow);

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
			discovery: {
				advertisedResponses: selectedDiscoveries.length,
				uniqueClients: advertisedByClient.size,
				lastAdvertised,
			},
			byClient: [...clients.values()],
			byMethod: [...methods.values()],
			byEventName: [...eventNames.values()].sort((a, b) => b.requests - a.requests),
			byOutcome: [...outcomes.values()].sort((a, b) => b.count - a.count),
			timeline: [...minutes.values()].sort((a, b) => a.minute - b.minute),
			retention: {
				maxEvents: EVENTS_MAX_EVENTS,
				maxAgeMs: EVENTS_MAX_AGE_MS,
				retainedEvents: this.events.length,
				capacityEvictions: this.capacityEvictions,
				expiredEvents: this.expiredEvents,
				availableSince,
				truncated: windowStart < availableSince,
			},
		};
	}
}

export const eventsLiveMetrics = new EventsLiveMetrics();
const recordEventsLiveEventLocal = EventsLiveMetrics.prototype.record.bind(eventsLiveMetrics);
eventsLiveMetrics.record = forward('eventsLiveMetrics.record', recordEventsLiveEventLocal);
const recordEventsAdvertisedLocal = EventsLiveMetrics.prototype.recordAdvertised.bind(eventsLiveMetrics);
eventsLiveMetrics.recordAdvertised = forward('eventsLiveMetrics.recordAdvertised', recordEventsAdvertisedLocal);
