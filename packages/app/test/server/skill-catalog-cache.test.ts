import { describe, expect, it, vi } from 'vitest';
import {
	SkillCatalogCache,
	getSkillCatalogStatus,
	SKILL_SNAPSHOT_MAX_AGE_MS,
	SKILL_SNAPSHOT_RETRY_DELAY_MS,
} from '../../src/server/skills/skill-catalog-cache.js';
import type { SkillCatalog } from '../../src/server/skills/skill-types.js';

function catalog(loadedAt: number, name: string): SkillCatalog {
	return {
		manifestPath: '/skills/skills.json',
		loadedAt,
		entries: [
			{
				uri: `skill://${name}/SKILL.md`,
				skillPath: name,
				frontmatter: { name, description: name },
				resources: [],
			},
		],
		entriesByUri: new Map(),
		resourcesByUri: new Map(),
		directories: new Map(),
	};
}

describe('SkillCatalogCache', () => {
	it('single-flights the blocking initial load', async () => {
		let resolveLoad: ((value: SkillCatalog) => void) | undefined;
		const loader = vi.fn(
			() =>
				new Promise<SkillCatalog>((resolve) => {
					resolveLoad = resolve;
				})
		);
		const cache = new SkillCatalogCache('/skills', loader, () => 10);
		const first = cache.get();
		const second = cache.get();
		expect(loader).toHaveBeenCalledTimes(1);
		resolveLoad?.(catalog(10, 'alpha'));
		expect(await first).toBe(await second);
	});

	it('serves the old snapshot while one stale refresh runs, then swaps atomically', async () => {
		let now = 0;
		let resolveRefresh: ((value: SkillCatalog) => void) | undefined;
		const loader = vi
			.fn<() => Promise<SkillCatalog>>()
			.mockResolvedValueOnce(catalog(0, 'old'))
			.mockImplementationOnce(
				() =>
					new Promise<SkillCatalog>((resolve) => {
						resolveRefresh = resolve;
					})
			);
		const cache = new SkillCatalogCache('/skills', loader, () => now);
		const original = await cache.get();

		now = SKILL_SNAPSHOT_MAX_AGE_MS;
		expect(await cache.get()).toBe(original);
		expect(await cache.get()).toBe(original);
		expect(loader).toHaveBeenCalledTimes(2);

		const replacement = catalog(now, 'new');
		resolveRefresh?.(replacement);
		await vi.waitFor(async () => expect(await cache.get()).toBe(replacement));
	});

	it('retains the previous snapshot when refresh fails', async () => {
		let now = 0;
		const loader = vi
			.fn<() => Promise<SkillCatalog>>()
			.mockResolvedValueOnce(catalog(0, 'old'))
			.mockRejectedValueOnce(new Error('torn bucket sync'))
			.mockResolvedValueOnce(catalog(SKILL_SNAPSHOT_MAX_AGE_MS + SKILL_SNAPSHOT_RETRY_DELAY_MS, 'new'));
		const cache = new SkillCatalogCache('/skills', loader, () => now);
		const original = await cache.get();
		now = SKILL_SNAPSHOT_MAX_AGE_MS;
		expect(await cache.get()).toBe(original);
		await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
		expect(await cache.get()).toBe(original);
		expect(loader).toHaveBeenCalledTimes(2);
		now += SKILL_SNAPSHOT_RETRY_DELAY_MS;
		await cache.get();
		expect(loader).toHaveBeenCalledTimes(3);
	});

	it('reports the remaining three-hour freshness window', async () => {
		let now = 1_000;
		const snapshot = catalog(now, 'alpha');
		const cache = new SkillCatalogCache(
			'/skills',
			async () => snapshot,
			() => now
		);
		await cache.get();
		expect(cache.getRemainingTtlMs(snapshot)).toBe(SKILL_SNAPSHOT_MAX_AGE_MS);
		now += 60_000;
		expect(cache.getRemainingTtlMs(snapshot)).toBe(SKILL_SNAPSHOT_MAX_AGE_MS - 60_000);
	});
});

describe('SkillCatalogCache status', () => {
	it('starts not-loaded and polling never starts a load, even after time advances', () => {
		let now = 0;
		const loader = vi.fn<() => Promise<SkillCatalog>>();
		const cache = new SkillCatalogCache('/private/skills', loader, () => now);
		const initial = {
			state: 'not-loaded',
			loadedAt: null,
			lastAttemptAt: null,
			lastFailureAt: null,
			nextRefreshAt: null,
			refreshing: false,
			skillCount: 0,
			resourceCount: 0,
			remainingTtlMs: 0,
			servingPreviousSnapshot: false,
			refreshFailures: 0,
			sizeVerification: 'not-implemented',
			warning: null,
		};
		expect(cache.getStatus()).toEqual(initial);
		now = SKILL_SNAPSHOT_MAX_AGE_MS * 2;
		expect(cache.getStatus()).toEqual(initial);
		expect(loader).not.toHaveBeenCalled();
		expect(getSkillCatalogStatus()).toEqual(initial);
	});

	it('reports singleflight loading, first success, safe counts and zero TTL without refreshing', async () => {
		let now = 10;
		let resolveLoad!: (value: SkillCatalog) => void;
		const loader = vi.fn(
			() =>
				new Promise<SkillCatalog>((resolve) => {
					resolveLoad = resolve;
				})
		);
		const cache = new SkillCatalogCache('/private/skills', loader, () => now);
		const first = cache.get();
		const second = cache.get();
		expect(cache.getStatus()).toMatchObject({
			state: 'loading',
			refreshing: true,
			lastAttemptAt: 10,
			nextRefreshAt: null,
			skillCount: 0,
			resourceCount: 0,
			servingPreviousSnapshot: false,
		});
		const snapshot = catalog(now, 'alpha');
		snapshot.resourcesByUri.set('skill://alpha/file', {
			uri: 'skill://alpha/file',
			bytes: Buffer.from('hello'),
			mimeType: 'text/plain',
			isText: true,
			name: 'file',
			digest: 'abc',
		});
		resolveLoad(snapshot);
		expect(await first).toBe(await second);
		expect(cache.getStatus()).toMatchObject({
			state: 'ready',
			loadedAt: 10,
			lastAttemptAt: 10,
			lastFailureAt: null,
			nextRefreshAt: 10 + SKILL_SNAPSHOT_MAX_AGE_MS,
			refreshing: false,
			skillCount: 1,
			resourceCount: 1,
			remainingTtlMs: SKILL_SNAPSHOT_MAX_AGE_MS,
			servingPreviousSnapshot: false,
			refreshFailures: 0,
			sizeVerification: 'not-implemented',
		});
		expect(cache.getStatus().warning).toMatch(/size.*not implemented/i);
		now += SKILL_SNAPSHOT_MAX_AGE_MS;
		expect(cache.getStatus()).toMatchObject({ state: 'stale', remainingTtlMs: 0 });
		now += 1;
		const status = cache.getStatus();
		expect(status.remainingTtlMs).toBe(0);
		status.skillCount = 999;
		expect(cache.getStatus().skillCount).toBe(1);
		expect(JSON.stringify(status)).not.toMatch(/private|skill:\/\/|alpha|abc/);
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('reports initial failure, retry backoff, consecutive failures and recovery', async () => {
		let now = 0;
		const loader = vi
			.fn<() => Promise<SkillCatalog>>()
			.mockRejectedValueOnce(new Error('/secret/path skill://private raw failure'))
			.mockRejectedValueOnce(new Error('again'))
			.mockImplementationOnce(async () => catalog(now, 'recovered'));
		const cache = new SkillCatalogCache('/secret/path', loader, () => now);
		expect(await cache.get()).toBeNull();
		expect(cache.getStatus()).toMatchObject({
			state: 'unavailable',
			loadedAt: null,
			lastAttemptAt: 0,
			lastFailureAt: 0,
			nextRefreshAt: SKILL_SNAPSHOT_RETRY_DELAY_MS,
			refreshing: false,
			refreshFailures: 1,
			servingPreviousSnapshot: false,
		});
		expect(cache.getStatus().warning).toMatch(/inspect server logs/i);
		expect(JSON.stringify(cache.getStatus())).not.toMatch(/secret|private|raw failure/);
		await cache.get();
		expect(loader).toHaveBeenCalledTimes(1);
		now += SKILL_SNAPSHOT_RETRY_DELAY_MS;
		expect(cache.getStatus().refreshFailures).toBe(1);
		await cache.get();
		expect(cache.getStatus()).toMatchObject({ refreshFailures: 2, lastFailureAt: now });
		now += SKILL_SNAPSHOT_RETRY_DELAY_MS;
		await cache.get();
		expect(cache.getStatus()).toMatchObject({
			state: 'ready',
			lastFailureAt: null,
			refreshFailures: 0,
			loadedAt: now,
		});
	});

	it('retains stale counts through refresh failure and swaps status on recovery', async () => {
		let now = 0;
		let rejectRefresh!: (error: Error) => void;
		let resolveRefresh!: (value: SkillCatalog) => void;
		const loader = vi
			.fn<() => Promise<SkillCatalog>>()
			.mockResolvedValueOnce(catalog(0, 'old'))
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectRefresh = reject;
					})
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveRefresh = resolve;
					})
			);
		const cache = new SkillCatalogCache('/skills', loader, () => now);
		const original = await cache.get();
		now = SKILL_SNAPSHOT_MAX_AGE_MS;
		expect(await cache.get()).toBe(original);
		await cache.get();
		expect(cache.getStatus()).toMatchObject({
			state: 'stale',
			refreshing: true,
			servingPreviousSnapshot: true,
			loadedAt: 0,
			skillCount: 1,
		});
		expect(loader).toHaveBeenCalledTimes(2);
		rejectRefresh(new Error('private details'));
		await vi.waitFor(() => expect(cache.getStatus().refreshing).toBe(false));
		expect(cache.getStatus()).toMatchObject({
			state: 'degraded',
			lastFailureAt: now,
			refreshFailures: 1,
			nextRefreshAt: now + SKILL_SNAPSHOT_RETRY_DELAY_MS,
			servingPreviousSnapshot: true,
			remainingTtlMs: 0,
			skillCount: 1,
		});
		expect(cache.getStatus().warning).toMatch(/inspect server logs/i);
		expect(cache.getStatus().warning).toMatch(/size.*not implemented/i);
		now += SKILL_SNAPSHOT_RETRY_DELAY_MS;
		cache.getStatus();
		expect(loader).toHaveBeenCalledTimes(2);
		await cache.get();
		expect(cache.getStatus()).toMatchObject({ state: 'degraded', refreshing: true });
		const replacement = catalog(now, 'new');
		replacement.entries = [];
		resolveRefresh(replacement);
		await vi.waitFor(() => expect(cache.getStatus().refreshing).toBe(false));
		expect(cache.getStatus()).toMatchObject({
			state: 'ready',
			loadedAt: now,
			lastFailureAt: null,
			refreshFailures: 0,
			skillCount: 0,
			servingPreviousSnapshot: false,
			remainingTtlMs: SKILL_SNAPSHOT_MAX_AGE_MS,
		});
	});
});
