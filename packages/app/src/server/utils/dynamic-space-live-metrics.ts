import {
	DYNAMIC_SPACE_FAILURE_STAGES,
	DYNAMIC_SPACE_OPERATIONS,
	type DynamicSpaceLiveMetricsResponse,
	type DynamicSpaceOperation,
	type DynamicSpaceOutcomeCounts,
} from '../../shared/dynamic-space-metrics.js';

function emptyMetrics(): DynamicSpaceLiveMetricsResponse {
	return {
		reportingSchema: 'dynamic_space_outcome_v1',
		calls: { total: 0, succeeded: 0, failed: 0 },
		operations: Object.fromEntries(
			DYNAMIC_SPACE_OPERATIONS.map((operation) => [operation, { total: 0, succeeded: 0, failed: 0 }])
		) as DynamicSpaceLiveMetricsResponse['operations'],
		failuresByStage: Object.fromEntries(
			DYNAMIC_SPACE_FAILURE_STAGES.map((stage) => [stage, 0])
		) as DynamicSpaceLiveMetricsResponse['failuresByStage'],
		lastUpdated: null,
	};
}

let metrics = emptyMetrics();

/** Called once at handler completion, independently of query/Gradio logging. */
export function recordDynamicSpaceLiveMetrics(
	operation: DynamicSpaceOperation,
	success: boolean,
	failureStage?: string
): void {
	const boundedOperation = DYNAMIC_SPACE_OPERATIONS.find((value) => value === operation) ?? 'unknown';
	const increment = (counts: DynamicSpaceOutcomeCounts): void => {
		counts.total++;
		if (success) counts.succeeded++;
		else counts.failed++;
	};
	increment(metrics.calls);
	increment(metrics.operations[boundedOperation]);
	if (!success) {
		const stage = DYNAMIC_SPACE_FAILURE_STAGES.find((value) => value === failureStage) ?? 'unexpected';
		metrics.failuresByStage[stage]++;
	}
	metrics.lastUpdated = new Date().toISOString();
}

export function getDynamicSpaceLiveMetrics(): DynamicSpaceLiveMetricsResponse {
	return structuredClone(metrics);
}

export function resetDynamicSpaceLiveMetricsForTests(): void {
	metrics = emptyMetrics();
}
