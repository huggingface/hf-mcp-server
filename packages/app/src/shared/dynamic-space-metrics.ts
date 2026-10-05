export const DYNAMIC_SPACE_OPERATIONS = ['help', 'find', 'discover', 'view_parameters', 'invoke', 'unknown'] as const;
export type DynamicSpaceOperation = (typeof DYNAMIC_SPACE_OPERATIONS)[number];

export const DYNAMIC_SPACE_FAILURE_STAGES = [
	'request',
	'configuration',
	'metadata',
	'schema',
	'selection',
	'validation',
	'invocation',
	'operation',
	'unexpected',
] as const;
type DynamicSpaceFailureStage = (typeof DYNAMIC_SPACE_FAILURE_STAGES)[number];

export interface DynamicSpaceOutcomeCounts {
	total: number;
	succeeded: number;
	failed: number;
}

/** Process-local completed handler outcomes, independent of remote logging. */
export interface DynamicSpaceLiveMetricsResponse {
	reportingSchema: 'dynamic_space_outcome_v1';
	calls: DynamicSpaceOutcomeCounts;
	operations: Record<DynamicSpaceOperation, DynamicSpaceOutcomeCounts>;
	failuresByStage: Record<DynamicSpaceFailureStage, number>;
	lastUpdated: string | null;
}
