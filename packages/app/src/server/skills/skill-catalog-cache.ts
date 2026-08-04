import { logger } from '../utils/logger.js';
import { loadSkills } from './skill-loader.js';
import type { SkillCatalog } from './skill-types.js';

const SKILLS_DIR = process.env.HF_SKILLS_DIR ?? '/mnt/hf-skills/distribution/latest';

export const SKILL_SNAPSHOT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export const SKILL_SNAPSHOT_RETRY_DELAY_MS = 5 * 60 * 1000;

type SnapshotLoader = (rootDir: string, loadedAt?: number) => Promise<SkillCatalog>;

export class SkillCatalogCache {
	private current: SkillCatalog | null = null;
	private refreshInFlight: Promise<SkillCatalog | null> | null = null;
	private nextRefreshAttemptAt = 0;

	constructor(
		private readonly rootDir: string,
		private readonly loader: SnapshotLoader = loadSkills,
		private readonly now: () => number = Date.now
	) {}

	private refresh(): Promise<SkillCatalog | null> {
		if (this.refreshInFlight) return this.refreshInFlight;

		const startedAt = this.now();
		this.refreshInFlight = this.loader(this.rootDir, startedAt)
			.then((candidate) => {
				this.current = candidate;
				this.nextRefreshAttemptAt = candidate.loadedAt + SKILL_SNAPSHOT_MAX_AGE_MS;
				logger.info(
					{
						rootDir: this.rootDir,
						skills: candidate.entries.length,
						resources: candidate.resourcesByUri.size,
					},
					'loaded verified skills snapshot'
				);
				return candidate;
			})
			.catch((err: unknown) => {
				this.nextRefreshAttemptAt = this.now() + SKILL_SNAPSHOT_RETRY_DELAY_MS;
				logger.warn(
					{ err, rootDir: this.rootDir, retainingPrevious: this.current !== null },
					'failed to refresh skills snapshot'
				);
				return this.current;
			})
			.finally(() => {
				this.refreshInFlight = null;
			});
		return this.refreshInFlight;
	}

	async get(): Promise<SkillCatalog | null> {
		if (!this.current) {
			return this.now() >= this.nextRefreshAttemptAt ? this.refresh() : null;
		}

		if (this.now() >= this.nextRefreshAttemptAt) {
			// Serve the complete old snapshot while one background candidate is loaded
			// and verified. The candidate becomes visible only through an atomic swap.
			void this.refresh();
		}
		return this.current;
	}

	getRemainingTtlMs(snapshot: SkillCatalog): number {
		return Math.max(0, SKILL_SNAPSHOT_MAX_AGE_MS - (this.now() - snapshot.loadedAt));
	}
}

const skillCatalogCache = new SkillCatalogCache(SKILLS_DIR);

export function getSkillCatalog(): Promise<SkillCatalog | null> {
	return skillCatalogCache.get();
}

export function getSkillCatalogRemainingTtlMs(snapshot: SkillCatalog): number {
	return skillCatalogCache.getRemainingTtlMs(snapshot);
}
