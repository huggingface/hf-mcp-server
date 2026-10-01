import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatelessHttpTransport } from '../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../src/server/transport/base-transport.js';
import { skillsLiveMetrics } from '../../src/server/utils/skills-live-metrics.js';
import type { SkillsMetricsFilters } from '../../src/shared/skills-metrics.js';

const filters: SkillsMetricsFilters = { window: '1h', method: 'all', outcome: 'all', client: 'live-hook-test' };

describe('Skills live event hook', () => {
	afterEach(() => vi.unstubAllEnvs());
	it.each(['disabled', 'throws'])('counts each classified event once when historical logger %s', (mode) => {
		vi.stubEnv('LOG_SKILL_EVENTS', 'false');
		const historical = vi.fn(() => {
			if (mode === 'throws') throw new Error('historical unavailable');
		});
		const transport = new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express(), historical);
		const hook = transport as unknown as {
			recordSkillEvent(
				request: { method: string; params?: { uri: string } },
				start: number,
				success: boolean,
				context: { protocolEra: string; isAuthenticated: boolean; clientInfo: { name: string; version: string } }
			): void;
		};
		const before = skillsLiveMetrics.snapshot(filters).totals;
		const context = {
			protocolEra: 'modern',
			isAuthenticated: false,
			clientInfo: { name: 'live-hook-test', version: '1' },
		};
		for (const method of ['skills/list', 'skills/get', 'resources/read', 'resources/directory/read', 'tools/list']) {
			hook.recordSkillEvent({ method, params: { uri: 'skill://private/%53KILL.md' } }, Date.now(), true, context);
		}
		hook.recordSkillEvent(
			{ method: 'skills/get', params: { uri: 'skill://private/file.txt' } },
			Date.now(),
			false,
			context
		);
		const after = skillsLiveMetrics.snapshot(filters).totals;
		expect(after.requests - before.requests).toBe(5);
		expect(after.successes - before.successes).toBe(4);
		expect(after.failures - before.failures).toBe(1);
		expect(after.skillDocumentReads - before.skillDocumentReads).toBe(1);
		expect(after.supportingFileReads - before.supportingFileReads).toBe(0);
		expect(historical).toHaveBeenCalledTimes(5);
	});
});
