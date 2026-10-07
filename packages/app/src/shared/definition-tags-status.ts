/** Dashboard view of definition tags (served only in test mode). */
export interface DefinitionTagsStatus {
	/** False when DEFINITION_TAGS=off. */
	enabled: boolean;
	ttlMs: number;
	/** DEFINITION_TAGS_SALT (deploy-wide). */
	deploySalt: string;
	/** Runtime test salt, set from the dashboard or /api/definition-tags/salt. */
	testSalt: string;
	testSaltUpdatedAt?: string;
	/** JSON-RPC error code returned for a mismatch. */
	errorCode: number;
	stats: DefinitionTagsStats;
}

/** Process-local counters since start (or since the last reset). */
export interface DefinitionTagsStats {
	taggedLists: number;
	taggedDiscoveries: number;
	checkedCalls: number;
	/** Checked calls answered by string comparison against remembered tags (no full server build). */
	memoChecks: number;
	matched: number;
	mismatched: number;
	staleTools: number;
	/** Checked calls with a stale `server/discover` tag. */
	staleDiscovery: number;
	lastCheckedAt?: string;
	lastMismatchAt?: string;
	since: string;
}
