import type { SkillCatalogStatus } from '../../shared/skill-catalog-status.js';
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
	private lastAttemptAt: number | null = null;
	private lastFailureAt: number | null = null;
	private refreshFailures = 0;

	constructor(
		private readonly rootDir: string,
		private readonly loader: SnapshotLoader = loadSkills,
		private readonly now: () => number = Date.now
	) {}

	private refresh(): Promise<SkillCatalog | null> {
		if (this.refreshInFlight) return this.refreshInFlight;

		const startedAt = this.now();
		this.lastAttemptAt = startedAt;
		this.refreshInFlight = this.loader(this.rootDir, startedAt)
			.then((candidate) => {
				this.current = candidate;
				this.lastFailureAt = null;
				this.refreshFailures = 0;
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
				this.lastFailureAt = this.now();
				this.refreshFailures = Math.min(Number.MAX_SAFE_INTEGER, this.refreshFailures + 1);
				this.nextRefreshAttemptAt = this.lastFailureAt + SKILL_SNAPSHOT_RETRY_DELAY_MS;
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

	/** Reads only in-memory state and the clock; never triggers loading or filesystem access. */
	getStatus(): SkillCatalogStatus {
		const snapshot = this.current;
		const refreshing = this.refreshInFlight !== null;
		const remainingTtlMs = snapshot ? this.getRemainingTtlMs(snapshot) : 0;
		let state: SkillCatalogStatus['state'];
		if (!snapshot) {
			state = refreshing ? 'loading' : this.lastFailureAt !== null ? 'unavailable' : 'not-loaded';
		} else {
			state = this.lastFailureAt !== null ? 'degraded' : remainingTtlMs === 0 ? 'stale' : 'ready';
		}

		const warnings: string[] = [];
		if (snapshot) warnings.push('Skill resource size validation is not implemented.');
		if (this.lastFailureAt !== null) {
			warnings.push(
				snapshot
					? 'Skill catalog refresh failed; serving the previous snapshot. Inspect server logs.'
					: 'Skill catalog load failed; no snapshot is available. Inspect server logs.'
			);
		}
		return {
			state,
			loadedAt: snapshot?.loadedAt ?? null,
			lastAttemptAt: this.lastAttemptAt,
			lastFailureAt: this.lastFailureAt,
			nextRefreshAt: snapshot || this.lastFailureAt !== null ? this.nextRefreshAttemptAt : null,
			refreshing,
			skillCount: snapshot?.entries.length ?? 0,
			resourceCount: snapshot?.resourcesByUri.size ?? 0,
			remainingTtlMs,
			servingPreviousSnapshot: snapshot !== null && (refreshing || this.lastFailureAt !== null),
			refreshFailures: this.refreshFailures,
			sizeVerification: 'not-implemented',
			warning: warnings.length ? warnings.join(' ') : null,
		};
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

/** Dashboard polling must not initiate catalog loads. */
export function getSkillCatalogStatus(): SkillCatalogStatus {
	return skillCatalogCache.getStatus();
}
