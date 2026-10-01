import { describe, expect, it } from 'vitest';
import {
	SkillsLiveMetrics,
	isSkillDocumentUri,
	parseSkillsMetricsFilters,
	SKILLS_MAX_AGE_MS,
	SKILLS_MAX_EVENTS,
} from '../../src/server/utils/skills-live-metrics.js';
import type { SkillsMetricsFilters } from '../../src/shared/skills-metrics.js';

const defaults: SkillsMetricsFilters = { window: '1h', client: '', method: 'all', outcome: 'all' };

describe('Skills live metrics', () => {
	it('aggregates successes and reads with consistent filters and full-window rates', () => {
		let now = 0;
		const metrics = new SkillsLiveMetrics(() => now);
		now = 60_000;
		metrics.record({ method: 'skills/list', success: true, skillDocument: false, clientName: 'Alpha' });
		metrics.record({ method: 'skills/get', success: true, skillDocument: true, clientName: 'Alpha' });
		metrics.record({ method: 'skills/get', success: false, skillDocument: true, clientName: 'Alpha' });
		now = 120_000;
		metrics.record({ method: 'skills/resource-read', success: true, skillDocument: false, clientVersion: 'BETA' });
		metrics.record({ method: 'skills/directory-read', success: true, skillDocument: false });
		const all = metrics.snapshot(defaults);
		expect(all.totals).toEqual({
			requests: 5,
			successes: 4,
			failures: 1,
			skillDocumentReads: 0,
			supportingFileReads: 1,
			listRequests: 1,
			getRequests: 2,
			directoryRequests: 1,
			requestsPerMinute: 5 / 60,
			lastSeen: now,
		});
		for (const filters of [
			{ client: 'aLpHa' },
			{ client: 'beta' },
			{ method: 'skills/get' as const },
			{ outcome: 'failure' as const },
			{ client: 'alpha', method: 'skills/get' as const, outcome: 'success' as const },
		]) {
			const result = metrics.snapshot({ ...defaults, ...filters });
			for (const groups of [result.byClient, result.byMethod, result.timeline]) {
				for (const field of [
					'requests',
					'successes',
					'failures',
					'skillDocumentReads',
					'supportingFileReads',
				] as const) {
					expect(groups.reduce((sum, group) => sum + group[field], 0)).toBe(result.totals[field]);
				}
			}
		}
		expect(metrics.snapshot({ ...defaults, client: 'beta' }).totals.requests).toBe(1);
		expect(metrics.snapshot({ ...defaults, outcome: 'failure' }).totals.skillDocumentReads).toBe(0);
		expect(metrics.snapshot({ ...defaults, window: '15m' }).totals.requestsPerMinute).toBe(5 / 15);
		now = 60_000 + 60 * 60_000;
		expect(metrics.snapshot(defaults).totals.requests).toBe(5); // inclusive start
		now++;
		expect(metrics.snapshot(defaults).totals.requests).toBe(2);
	});

	it('counts file content retrieval separately from metadata probes', () => {
		const metrics = new SkillsLiveMetrics(() => 0);
		metrics.record({ method: 'skills/get', success: true, skillDocument: true });
		metrics.record({ method: 'skills/get', success: true, skillDocument: false });
		expect(metrics.snapshot(defaults).totals).toMatchObject({
			requests: 2,
			skillDocumentReads: 0,
			supportingFileReads: 0,
		});
		metrics.record({ method: 'skills/resource-read', success: true, skillDocument: true });
		metrics.record({ method: 'skills/resource-read', success: false, skillDocument: true });
		metrics.record({ method: 'skills/resource-read', success: true, skillDocument: false });
		expect(metrics.snapshot(defaults).totals).toMatchObject({
			requests: 5,
			skillDocumentReads: 1,
			supportingFileReads: 1,
		});
	});

	it('bounds storage and reports capacity loss, startup coverage and TTL without confusing oldest event with coverage', () => {
		let now = 0;
		const metrics = new SkillsLiveMetrics(() => now);
		expect(metrics.snapshot(defaults).retention.truncated).toBe(true);
		now = 1000;
		for (let i = 0; i <= SKILLS_MAX_EVENTS; i++) {
			metrics.record({ method: 'skills/list', success: true, skillDocument: false });
		}
		let result = metrics.snapshot(defaults);
		expect(result.retention).toMatchObject({ retainedEvents: 10_000, capacityEvictions: 1, availableSince: 1001 });
		now += SKILLS_MAX_AGE_MS;
		expect(metrics.snapshot({ ...defaults, window: '24h' }).totals.requests).toBe(10_000);
		now++;
		result = metrics.snapshot(defaults);
		expect(result.retention).toMatchObject({
			retainedEvents: 0,
			expiredEvents: 10_000,
			capacityEvictions: 1,
			truncated: false,
		});
		expect(result.retention.availableSince).toBe(now - SKILLS_MAX_AGE_MS);
		expect(result.totals.lastSeen).toBeNull();
		expect(result.timeline).toEqual([]);
	});

	it('stores only bounded allowlisted fields and returns detached snapshots', () => {
		const metrics = new SkillsLiveMetrics(() => 0);
		const input = {
			method: 'skills/get' as const,
			success: true,
			skillDocument: true,
			clientName: 'a'.repeat(1000),
			clientVersion: 'b'.repeat(1000),
			userHash: 'PRIVATE',
			sessionId: 'PRIVATE',
			requestId: 'PRIVATE',
			targetUri: 'PRIVATE',
			body: 'PRIVATE',
			content: 'PRIVATE',
			error: 'PRIVATE',
		};
		metrics.record(input);
		expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
		const result = metrics.snapshot(defaults);
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(result.byClient[0]?.name.length).toBe(128);
		expect(result.byClient[0]?.version.length).toBe(128);
		result.totals.requests = 999;
		result.byClient.length = 0;
		expect(metrics.snapshot(defaults).totals.requests).toBe(1);
	});

	it('decodes only the URI path and safely handles malformed escapes', () => {
		expect(isSkillDocumentUri('hf://skills/example/%53KILL%2Emd?x=1')).toBe(true);
		expect(isSkillDocumentUri('hf://skills/example%2FSKILL.md')).toBe(true);
		for (const uri of [
			undefined,
			'bad',
			'hf://skills/%XX/SKILL.md',
			'hf://skills/file?x=/SKILL.md',
			'hf://skills/skill.md',
		]) {
			expect(isSkillDocumentUri(uri)).toBe(false);
		}
	});

	it('strictly validates bounded filters', () => {
		expect(parseSkillsMetricsFilters({})).toEqual(defaults);
		expect(
			parseSkillsMetricsFilters({ window: '24h', client: 'ABC', method: 'skills/get', outcome: 'failure' })
		).toEqual({ window: '24h', client: 'ABC', method: 'skills/get', outcome: 'failure' });
		for (const query of [
			{ window: '2h' },
			{ method: 'resources/read' },
			{ outcome: 'ok' },
			{ client: ['x'] },
			{ client: {} },
			{ client: 'x'.repeat(129) },
			{ extra: '' },
			{ window: '' },
		])
			expect(parseSkillsMetricsFilters(query)).toBeNull();
	});
});
