import { type ToolResult } from '@llmindset/hf-mcp';
import { logToolQuery, type QueryLoggerOptions } from './query-logger.js';

import { DYNAMIC_SPACE_OPERATIONS, type DynamicSpaceOperation } from '../../shared/dynamic-space-metrics.js';
import { recordDynamicSpaceLiveMetrics } from './dynamic-space-live-metrics.js';

type SharedFailure = NonNullable<ToolResult['errorMetadata']>;
interface ServerFailure {
	stage: 'configuration' | 'unexpected';
	code: 'invoke_disabled' | 'unexpected_error';
}
type Failure = SharedFailure | ServerFailure;

export interface DynamicSpaceTelemetry {
	dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1';
	dynamicSpaceStage?: Failure['stage'];
	dynamicSpaceErrorCode?: Failure['code'];
}

export function normalizeDynamicSpaceOperation(operation?: string): DynamicSpaceOperation {
	if (!operation) return 'help';
	const normalized = operation.toLowerCase();
	return DYNAMIC_SPACE_OPERATIONS.find((value) => value !== 'help' && value === normalized) ?? 'unknown';
}

/**
 * Coverage begins at handler entry; SDK input validation happens outside this boundary.
 * Observe the shared result before formatting so metadata never has to be inferred from text.
 * Only bounded operation/outcome data is logged, not arguments or response content.
 */
export async function withDynamicSpaceOutcome<T extends { isError?: boolean; _meta?: Record<string, unknown> }>(
	operation: string | undefined,
	options: QueryLoggerOptions,
	run: (observe: (result: { errorMetadata?: Failure }) => void) => Promise<T>,
	log: typeof logToolQuery = logToolQuery
): Promise<T> {
	const start = performance.now();
	let failure: Failure | undefined;
	let success = false;
	try {
		const result = await run((result) => {
			failure = result.errorMetadata;
		});
		success = !result.isError;
		if (!success && !failure) failure = { stage: 'unexpected', code: 'unexpected_error' };
		// Stages describe the failing operation phase, not an inferred HTTP cause.
		return !success && failure
			? {
					...result,
					_meta: { ...result._meta, 'huggingface.co/dynamic-space': { stage: failure.stage, code: failure.code } },
				}
			: result;
	} catch (error) {
		failure = { stage: 'unexpected', code: 'unexpected_error' };
		throw error;
	} finally {
		const normalizedOperation = normalizeDynamicSpaceOperation(operation);
		recordDynamicSpaceLiveMetrics(normalizedOperation, success, failure?.stage);
		try {
			log(
				'dynamic_space',
				normalizedOperation,
				{},
				{
					...options,
					dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
					durationMs: performance.now() - start,
					success,
					...(success
						? {}
						: {
								dynamicSpaceStage: failure?.stage,
								dynamicSpaceErrorCode: failure?.code,
							}),
				}
			);
		} catch {
			// Best-effort telemetry must not replace the result or primary exception.
		}
	}
}
