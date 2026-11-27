import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsMetricsResponse } from '../../src/shared/events-metrics.js';
import { DEFAULT_EVENTS_FILTERS, eventsMetricsFetcher, eventsMetricsUrl } from '../../src/web/lib/events-metrics.js';

const { swr } = vi.hoisted(() => ({ swr: vi.fn() }));
vi.mock('swr', () => ({ default: swr }));
import { Tabs, TabsContent } from '../../src/web/components/ui/tabs.js';
import { EventsMetricsCard, EventsMetricsSnapshot } from '../../src/web/components/EventsMetricsCard.js';

const counts = {
	requests: 5,
	successes: 4,
	failures: 1,
	deliveredPolls: 2,
	emptyPolls: 1,
	truncatedPolls: 0,
	deliveredEvents: 2,
	lastSeen: 60_000,
};

function fixture(): EventsMetricsResponse {
	return {
		transport: 'streamableHttpJson',
		enabled: true,
		supported: true,
		unsupportedReason: null,
		live: {
			filters: { ...DEFAULT_EVENTS_FILTERS },
			generatedAt: 120_000,
			windowStart: 0,
			windowEnd: 120_000,
			totals: { ...counts, listRequests: 1, pollRequests: 4, requestsPerMinute: 5 / 60 },
			discovery: { advertisedResponses: 3, uniqueClients: 2, lastAdvertised: 60_000 },
			byClient: [{ ...counts, name: '<script>agent</script>', version: '1.0', advertisedCount: 2 }],
			byMethod: [{ ...counts, method: 'events/poll' }],
			byEventName: [{ ...counts, eventName: 'job.status_changed' }],
			byOutcome: [
				{ outcome: 'delivered', count: 2, lastSeen: 60_000 },
				{ outcome: 'empty', count: 1, lastSeen: 60_000 },
				{ outcome: 'not_found', count: 1, lastSeen: 60_000 },
			],
			timeline: [{ ...counts, minute: 60_000 }],
			retention: {
				maxEvents: 10000,
				maxAgeMs: 86400000,
				retainedEvents: 5,
				capacityEvictions: 1,
				expiredEvents: 2,
				availableSince: 30_000,
				truncated: true,
			},
		},
	};
}

beforeEach(() => {
	swr.mockReset();
	swr.mockReturnValue({ data: undefined, error: undefined, mutate: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('Events metrics API', () => {
	it('sends the exact server query keys and bounds client input', () => {
		const url = eventsMetricsUrl({
			window: '24h',
			client: 'Agent & V1/β',
			method: 'events/poll',
			outcome: 'failure',
		});
		expect(Object.fromEntries(new URL(url, 'http://localhost').searchParams)).toEqual({
			window: '24h',
			client: 'Agent & V1/β',
			method: 'events/poll',
			outcome: 'failure',
		});
		expect(eventsMetricsUrl(DEFAULT_EVENTS_FILTERS)).toBe(
			'/api/events-metrics?window=1h&client=&method=all&outcome=all'
		);
		const longUrl = eventsMetricsUrl({ ...DEFAULT_EVENTS_FILTERS, client: 'x'.repeat(129) });
		expect(new URL(longUrl, 'http://localhost').searchParams.get('client')).toHaveLength(128);
	});

	it('fetches the typed response and rejects HTTP failures', async () => {
		const data = fixture();
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
		vi.stubGlobal('fetch', fetch);
		await expect(eventsMetricsFetcher('/api/events-metrics')).resolves.toEqual(data);
		fetch.mockResolvedValue({ ok: false, status: 400 });
		await expect(eventsMetricsFetcher('/api/events-metrics')).rejects.toThrow('400');
	});
});

describe('Events dashboard', () => {
	it('mounts the poller only inside the active Radix tab', () => {
		const renderTab = (active: string) =>
			renderToStaticMarkup(
				React.createElement(
					Tabs,
					{ value: active },
					React.createElement(TabsContent, { value: 'events' }, React.createElement(EventsMetricsCard))
				)
			);
		expect(renderTab('metrics')).not.toContain('Loading Events metrics');
		expect(swr).not.toHaveBeenCalled();
		expect(renderTab('events')).toContain('Loading Events metrics');
		expect(swr).toHaveBeenCalledTimes(1);
	});

	it('renders status, discovery funnel, outcomes, and escapes untrusted client names', () => {
		const html = renderToStaticMarkup(React.createElement(EventsMetricsSnapshot, { metrics: fixture() }));
		expect(html).toContain('MCP Events Extension (SEP-3415)');
		expect(html).toContain('Enabled');
		expect(html).toContain('Capability advertised');
		expect(html).toContain('Transitions delivered');
		expect(html).toContain('Delivered transition');
		expect(html).toContain('Unknown event (-32023)');
		expect(html).toContain('job.status_changed');
		expect(html).toContain('&lt;script&gt;agent&lt;/script&gt;');
		expect(html).not.toContain('<script>agent</script>');
	});

	it('shows disabled banner when MCP_EVENTS_ENABLED is off', () => {
		const disabled = fixture();
		disabled.enabled = false;
		const html = renderToStaticMarkup(React.createElement(EventsMetricsSnapshot, { metrics: disabled }));
		expect(html).toContain('Disabled');
		expect(html).toContain('MCP_EVENTS_ENABLED=true');
	});
});
