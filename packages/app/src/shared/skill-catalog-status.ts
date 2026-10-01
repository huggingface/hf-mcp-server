/** Read-only, process-local dashboard health. Contains no catalog paths, URIs or raw errors. */
export interface SkillCatalogStatus {
	/** Failures take precedence over freshness; loading means no snapshot is available yet. */
	state: 'not-loaded' | 'loading' | 'ready' | 'stale' | 'degraded' | 'unavailable';
	loadedAt: number | null;
	lastAttemptAt: number | null;
	/** Most recent consecutive failure; cleared on successful refresh. */
	lastFailureAt: number | null;
	/** Earliest next demand-driven refresh, not a scheduled background task. */
	nextRefreshAt: number | null;
	refreshing: boolean;
	skillCount: number;
	resourceCount: number;
	/** Snapshot freshness, clamped to zero; independent of retry backoff. */
	remainingTtlMs: number;
	/** A snapshot is retained while refreshing or after a failed refresh. */
	servingPreviousSnapshot: boolean;
	/** Consecutive failed attempts, reset on success and capped at MAX_SAFE_INTEGER. */
	refreshFailures: number;
	sizeVerification: 'not-implemented';
	warning: string | null;
}
