import { describe, expect, it } from 'vitest';
import {
	EVENTS_MAX_AGE_MS,
	EVENTS_MAX_EVENTS,
	EventsLiveMetrics,
	parseEventsMetricsFilters,
} from '../../src/server/utils/events-live-metrics.js';
import type { EventsMetricsFilters } from '../../src/shared/events-metrics.js';

const ALL: EventsMetricsFilters = { window: '1h', client: '', method: 'all', outcome: 'all' };

describe('parseEventsMetricsFilters', () => {
	it('accepts valid defaults and explicit filter values', () => {
		expect(parseEventsMetricsFilters({})).toEqual(ALL);
		expect(
			parseEventsMetricsFilters({
				window: '15m',
				client: 'fast-agent',
				method: 'events/poll',
				outcome: 'success',
			})
		).toEqual({
			window: '15m',
			client: 'fast-agent',
			method: 'events/poll',
			outcome: 'success',
		});
	});

	it('rejects unknown keys, invalid enums, arrays, and overlong client filters', () => {
		expect(parseEventsMetricsFilters({ extra: '1' })).toBeNull();
		expect(parseEventsMetricsFilters({ window: '7d' })).toBeNull();
		expect(parseEventsMetricsFilters({ method: 'tools/call' })).toBeNull();
		expect(parseEventsMetricsFilters({ outcome: 'delivered' })).toBeNull();
		expect(parseEventsMetricsFilters({ client: ['a', 'b'] })).toBeNull();
		expect(parseEventsMetricsFilters({ client: 'x'.repeat(129) })).toBeNull();
	});
});

describe('EventsLiveMetrics', () => {
	it('aggregates capability advertisements, poll outcomes, clients, event names, and timelines', () => {
		let now = 1_700_000_000_000;
		const metrics = new EventsLiveMetrics(() => now);

		metrics.recordAdvertised({ clientName: 'FastAgent', clientVersion: '1.0' });
		metrics.recordAdvertised({ clientName: 'FastAgent', clientVersion: '1.0' });
		metrics.recordAdvertised({ clientName: 'OtherClient', clientVersion: '2.0' });

		metrics.record({
			method: 'events/list',
			success: true,
			outcome: 'ok',
			clientName: 'FastAgent',
			clientVersion: '1.0',
		});

		now += 60_000;
		metrics.record({
			method: 'events/poll',
			eventName: 'job.status_changed',
			success: true,
			outcome: 'empty',
			deliveredEventCount: 0,
			clientName: 'FastAgent',
			clientVersion: '1.0',
		});
		metrics.record({
			method: 'events/poll',
			eventName: 'job.status_changed',
			success: true,
			outcome: 'delivered',
			deliveredEventCount: 1,
			clientName: 'FastAgent',
			clientVersion: '1.0',
		});
		metrics.record({
			method: 'events/poll',
			eventName: 'job.status_changed',
			success: true,
			outcome: 'truncated',
			deliveredEventCount: 0,
			clientName: 'FastAgent',
			clientVersion: '1.0',
		});
		metrics.record({
			method: 'events/poll',
			eventName: '[unknown]',
			success: false,
			outcome: 'not_found',
			clientName: 'OtherClient',
			clientVersion: '2.0',
		});

		const snap = metrics.snapshot(ALL);
		expect(snap.discovery).toEqual({
			advertisedResponses: 3,
			uniqueClients: 2,
			lastAdvertised: 1_700_000_000_000,
		});
		expect(snap.totals).toMatchObject({
			requests: 5,
			successes: 4,
			failures: 1,
			listRequests: 1,
			pollRequests: 4,
			deliveredPolls: 1,
			emptyPolls: 1,
			truncatedPolls: 1,
			deliveredEvents: 1,
		});
		expect(snap.byClient).toHaveLength(2);
		const fastAgent = snap.byClient.find((c) => c.name === 'FastAgent');
		expect(fastAgent).toMatchObject({
			advertisedCount: 2,
			requests: 4,
			successes: 4,
			failures: 0,
			deliveredPolls: 1,
			emptyPolls: 1,
			truncatedPolls: 1,
			deliveredEvents: 1,
		});
		expect(snap.byEventName.map((e) => [e.eventName, e.requests])).toEqual([
			['job.status_changed', 3],
			['[unknown]', 1],
		]);
		expect(snap.byOutcome).toHaveLength(5);
		expect(snap.timeline).toHaveLength(2);

		// Client filter applies to both discovery and event requests
		const filtered = metrics.snapshot({ ...ALL, client: 'other', outcome: 'failure' });
		expect(filtered.discovery.advertisedResponses).toBe(1);
		expect(filtered.totals.requests).toBe(1);
		expect(filtered.totals.failures).toBe(1);
		expect(filtered.byOutcome).toEqual([{ outcome: 'not_found', count: 1, lastSeen: now }]);
	});

	it('enforces bounded retention and flags truncated windows', () => {
		let now = 10_000_000;
		const metrics = new EventsLiveMetrics(() => now);
		for (let i = 0; i < EVENTS_MAX_EVENTS + 5; i++) {
			now += 1;
			metrics.record({
				method: 'events/poll',
				eventName: 'job.status_changed',
				success: true,
				outcome: 'empty',
				clientName: 'burst-client',
				clientVersion: '1',
			});
		}

		const snap = metrics.snapshot({ window: '24h', client: '', method: 'all', outcome: 'all' });
		expect(snap.retention.retainedEvents).toBe(EVENTS_MAX_EVENTS);
		expect(snap.retention.capacityEvictions).toBe(5);
		expect(snap.retention.truncated).toBe(true);

		// Expire everything after 24h + 1ms
		now += EVENTS_MAX_AGE_MS + 1;
		const expiredSnap = metrics.snapshot({ window: '24h', client: '', method: 'all', outcome: 'all' });
		expect(expiredSnap.retention.retainedEvents).toBe(0);
		expect(expiredSnap.retention.expiredEvents).toBe(EVENTS_MAX_EVENTS);
	});
});
