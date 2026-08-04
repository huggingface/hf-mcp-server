import { describe, expect, it, vi } from 'vitest';
import {
	SkillCatalogCache,
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
