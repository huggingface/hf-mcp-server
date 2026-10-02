import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillsMetricsResponse } from '../../src/shared/skills-metrics.js';
import { DEFAULT_SKILLS_FILTERS, skillsMetricsFetcher, skillsMetricsUrl } from '../../src/web/lib/skills-metrics.js';

const { swr } = vi.hoisted(() => ({ swr: vi.fn() }));
vi.mock('swr', () => ({ default: swr }));
import { Tabs, TabsContent } from '../../src/web/components/ui/tabs.js';
import { SkillsMetricsCard, SkillsMetricsSnapshot } from '../../src/web/components/SkillsMetricsCard.js';

const counts = {
	requests: 5,
	successes: 3,
	failures: 2,
	skillDocumentReads: 2,
	supportingFileReads: 1,
	lastSeen: 60_000,
};
function fixture(): SkillsMetricsResponse {
	return {
		transport: 'streamableHttpJson',
		supported: true,
		unsupportedReason: null,
		snapshot: {
			state: 'ready',
			loadedAt: 0,
			lastAttemptAt: 60_000,
			lastFailureAt: null,
			nextRefreshAt: 120_000,
			refreshing: false,
			skillCount: 4,
			resourceCount: 12,
			remainingTtlMs: 1000,
			servingPreviousSnapshot: false,
			refreshFailures: 0,
			sizeVerification: 'verified',
			warning: null,
		},
		live: {
			filters: { ...DEFAULT_SKILLS_FILTERS },
			generatedAt: 120_000,
			windowStart: 0,
			windowEnd: 120_000,
			totals: { ...counts, listRequests: 1, directoryRequests: 1, getRequests: 2, requestsPerMinute: 5 / 60 },
			byClient: [{ ...counts, name: '<script>client</script>', version: 'v1' }],
			byMethod: [{ ...counts, method: 'skills/get' }],
			timeline: [{ ...counts, minute: 60_000 }],
			retention: {
				maxEvents: 10000,
				maxAgeMs: 86400000,
				retainedEvents: 5,
				capacityEvictions: 2,
				expiredEvents: 3,
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

describe('Skills metrics API', () => {
	it('sends exactly the server query keys and preserves substring input safely', () => {
		const url = skillsMetricsUrl({
			window: '24h',
			client: 'Agent & V1/β',
			method: 'skills/resource-read',
			outcome: 'failure',
		});
		expect(Object.fromEntries(new URL(url, 'http://localhost').searchParams)).toEqual({
			window: '24h',
			client: 'Agent & V1/β',
			method: 'skills/resource-read',
			outcome: 'failure',
		});
		expect(skillsMetricsUrl(DEFAULT_SKILLS_FILTERS)).toBe(
			'/api/skills-metrics?window=1h&client=&method=all&outcome=all'
		);
	});
	it('bounds client input to the server limit', () => {
		const url = skillsMetricsUrl({ ...DEFAULT_SKILLS_FILTERS, client: 'x'.repeat(129) });
		expect(new URL(url, 'http://localhost').searchParams.get('client')).toHaveLength(128);
	});
	it('fetches the typed response and rejects HTTP failures', async () => {
		const data = fixture();
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
		vi.stubGlobal('fetch', fetch);
		await expect(skillsMetricsFetcher('/api/skills-metrics')).resolves.toEqual(data);
		expect(fetch).toHaveBeenCalledWith('/api/skills-metrics');
		fetch.mockResolvedValue({ ok: false, status: 400 });
		await expect(skillsMetricsFetcher('/api/skills-metrics')).rejects.toThrow('400');
		fetch.mockRejectedValue(new Error('offline'));
		await expect(skillsMetricsFetcher('/api/skills-metrics')).rejects.toThrow('offline');
	});
});

describe('Skills dashboard', () => {
	it('mounts the poller only inside the active Radix tab', () => {
		const renderTab = (active: string) =>
			renderToStaticMarkup(
				React.createElement(
					Tabs,
					{ value: active },
					React.createElement(TabsContent, { value: 'skills' }, React.createElement(SkillsMetricsCard))
				)
			);
		expect(renderTab('metrics')).not.toContain('Loading Skills metrics');
		expect(swr).not.toHaveBeenCalled();
		expect(renderTab('skills')).toContain('Loading Skills metrics');
		expect(swr).toHaveBeenCalledTimes(1);
	});
	it('bounds client and timeline tables without mutating the response', () => {
		const metrics = fixture();
		if (!metrics.live) throw new Error('Missing fixture');
		metrics.live.byClient = Array.from({ length: 55 }, (_, i) => ({
			...counts,
			name: `client-${i}`,
			version: '1',
			requests: i,
		}));
		metrics.live.timeline = Array.from({ length: 65 }, (_, i) => ({ ...counts, minute: i * 60_000 }));
		const html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics }));
		expect(html).toContain('client-54');
		expect(html).not.toContain('client-0 ·');
		expect((html.match(/scope="row"/g) ?? []).length).toBe(50 + 1 + 60);
		expect(metrics.live.byClient[0]?.name).toBe('client-0');
		expect(metrics.live.timeline[0]?.minute).toBe(0);
	});

	it('renders loading, filters and five-second SWR configuration without previous-filter data', () => {
		const html = renderToStaticMarkup(React.createElement(SkillsMetricsCard));
		expect(html).toContain('Loading Skills metrics');
		expect(html).toContain('value="15m"');
		expect(html).toContain('value="1h"');
		expect(html).toContain('value="24h"');
		expect(html).toContain('maxLength="128"');
		expect(html).toContain('Client name or version');
		expect(html).toContain('value="skills/directory-read"');
		expect(html).toContain('value="failure"');
		expect(html).toContain('self-reported');
		expect(html).toContain('not historical analytics');
		expect(html).toContain('does not prove a skill was used, executed, or fully installed');
		expect(swr).toHaveBeenCalledWith(
			skillsMetricsUrl(DEFAULT_SKILLS_FILTERS),
			skillsMetricsFetcher,
			expect.objectContaining({ refreshInterval: 5000, keepPreviousData: false })
		);
	});
	it('shows errors and retry, including stale-response warnings', () => {
		swr.mockReturnValue({ error: new Error('offline'), mutate: vi.fn() });
		let html = renderToStaticMarkup(React.createElement(SkillsMetricsCard));
		expect(html).toContain('role="alert"');
		expect(html).toContain('Retry');
		expect(html).not.toContain('Loading Skills metrics');
		swr.mockReturnValue({ data: fixture(), error: new Error('offline'), mutate: vi.fn() });
		html = renderToStaticMarkup(React.createElement(SkillsMetricsCard));
		expect(html).toContain('last successful response; it may be stale');
		expect(html).toContain('Catalog health');
	});
	it('shows health, retrieval counts, window rate, retention and escaped client metadata', () => {
		const html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics: fixture() }));
		for (const text of [
			'ready',
			'Snapshot skills',
			'Snapshot resources',
			'Last loaded',
			'Last attempt',
			'Next refresh / retry eligible',
			'Consecutive refresh failures',
			'demand-driven',
			'Truncated coverage',
			'capacity evictions: 2',
			'expired events: 3',
			'Metadata probes',
			'List: 1',
			'Directory: 1',
			'Get requests',
			'Skill document reads',
			'Supporting file reads',
			'Successes',
			'Failures',
			'0.08',
			'not instantaneous',
			'Clients',
			'Methods',
			'Timeline (UTC)',
			'edge buckets may be partial',
		]) {
			expect(html).toContain(text);
		}
		expect(html).toContain('&lt;script&gt;client&lt;/script&gt;');
		expect(html).not.toContain('<script>');
	});
	it.each(['not-loaded', 'loading', 'stale', 'degraded', 'unavailable'] as const)(
		'renders %s health without inferring enablement',
		(state) => {
			const metrics = fixture();
			metrics.snapshot = {
				...metrics.snapshot,
				state,
				loadedAt: null,
				refreshFailures: 2,
				servingPreviousSnapshot: true,
			};
			const html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics }));
			expect(html).toContain(state);
			expect(html).toContain('Never / unavailable');
			expect(html).toContain('bucket files alone do not establish that Skills are enabled');
		}
	);
	it('handles unsupported stdio without reporting zero usage', () => {
		const metrics = {
			...fixture(),
			transport: 'stdio' as const,
			supported: false,
			unsupportedReason: 'HTTP only.',
			live: null,
		};
		const html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics }));
		expect(html).toContain('unsupported on stdio');
		expect(html).toContain('HTTP only.');
		expect(html).toContain('do not mean zero activity');
		expect(html).toContain('Catalog health');
		expect(html).not.toContain('Window requests / min');
	});
	it('distinguishes empty filtered results from missing live data', () => {
		const metrics = fixture();
		if (!metrics.live) throw new Error('Missing fixture');
		metrics.live.totals.requests = 0;
		metrics.live.byClient = [];
		metrics.live.timeline = [];
		metrics.live.retention.truncated = false;
		let html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics }));
		expect(html).toContain('No events match these filters');
		expect(html).not.toContain('Truncated coverage');
		metrics.live = null;
		html = renderToStaticMarkup(React.createElement(SkillsMetricsSnapshot, { metrics }));
		expect(html).toContain('Live Skills metrics are unavailable');
		expect(html).not.toContain('No events match');
	});
});
