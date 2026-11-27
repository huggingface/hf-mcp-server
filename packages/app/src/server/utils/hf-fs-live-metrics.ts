import type { HfFsLiveMetricsResponse } from '../../shared/transport-metrics.js';
import type { HfFsQueryTelemetry } from './hf-fs-telemetry.js';
import { forward } from '../cluster/ipc.js';

function emptyMetrics(): HfFsLiveMetricsResponse {
	return {
		reportingSchema: 'hf_fs_batch_v1',
		batches: {
			total: 0,
			complete: 0,
			partial: 0,
			noneSucceeded: 0,
			failed: 0,
			cancelled: 0,
		},
		operations: {
			completed: 0,
			succeeded: 0,
			requestErrors: 0,
			targetErrors: 0,
			policyLimitErrors: 0,
			serviceErrors: 0,
		},
		lastUpdated: null,
	};
}

let metrics = emptyMetrics();

export const recordHfFsLiveMetrics = forward('hfFsLiveMetrics.record', (telemetry: HfFsQueryTelemetry): void => {
	metrics.batches.total += 1;
	switch (telemetry.hfFsBatchOutcome) {
		case 'complete':
			metrics.batches.complete += 1;
			break;
		case 'partial':
			metrics.batches.partial += 1;
			break;
		case 'none_succeeded':
			metrics.batches.noneSucceeded += 1;
			break;
		case 'failed':
			metrics.batches.failed += 1;
			break;
		case 'cancelled':
			metrics.batches.cancelled += 1;
			break;
	}
	metrics.operations.completed += telemetry.hfFsOperationsCompleted ?? 0;
	metrics.operations.succeeded += telemetry.hfFsOperationsSucceeded ?? 0;
	metrics.operations.requestErrors += telemetry.hfFsRequestErrorCount ?? 0;
	metrics.operations.targetErrors += telemetry.hfFsTargetErrorCount ?? 0;
	metrics.operations.policyLimitErrors += telemetry.hfFsPolicyLimitErrorCount ?? 0;
	metrics.operations.serviceErrors += telemetry.hfFsServiceErrorCount ?? 0;
	metrics.lastUpdated = new Date().toISOString();
});

export function getHfFsLiveMetrics(): HfFsLiveMetricsResponse {
	return {
		reportingSchema: metrics.reportingSchema,
		batches: { ...metrics.batches },
		operations: { ...metrics.operations },
		lastUpdated: metrics.lastUpdated,
	};
}

export function resetHfFsLiveMetricsForTests(): void {
	metrics = emptyMetrics();
}
