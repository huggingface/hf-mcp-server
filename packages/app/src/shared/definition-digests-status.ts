/** Dashboard view of definition digests (served only in test mode). */
export interface DefinitionDigestsStatus {
	/** False when DEFINITION_DIGESTS=off. */
	enabled: boolean;
	ttlMs: number;
	/** DEFINITION_DIGESTS_SALT (deploy-wide). */
	deploySalt: string;
	/** Runtime test salt, set from the dashboard or /api/definition-digests/salt. */
	testSalt: string;
	testSaltUpdatedAt?: string;
	/** JSON-RPC error code returned for a mismatch. */
	errorCode: number;
	stats: DefinitionDigestsStats;
}

/** Process-local counters since start (or since the last reset). */
export interface DefinitionDigestsStats {
	digestedLists: number;
	digestedDiscoveries: number;
	checkedCalls: number;
	matched: number;
	mismatched: number;
	staleTools: number;
	staleInstructions: number;
	lastCheckedAt?: string;
	lastMismatchAt?: string;
	since: string;
}
