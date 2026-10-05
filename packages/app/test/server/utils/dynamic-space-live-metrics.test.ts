import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getDynamicSpaceLiveMetrics,
	recordDynamicSpaceLiveMetrics,
	resetDynamicSpaceLiveMetricsForTests,
} from '../../../src/server/utils/dynamic-space-live-metrics.js';
import { withDynamicSpaceOutcome } from '../../../src/server/utils/dynamic-space-outcome.js';

describe('Dynamic Spaces live metrics', () => {
	beforeEach(resetDynamicSpaceLiveMetricsForTests);

	it('starts empty and returns isolated snapshots', () => {
		const snapshot = getDynamicSpaceLiveMetrics();
		expect(snapshot.calls).toEqual({ total: 0, succeeded: 0, failed: 0 });
		expect(snapshot.lastUpdated).toBeNull();
		snapshot.calls.total = 100;
		snapshot.operations.invoke.failed = 100;
		snapshot.failuresByStage.invocation = 100;
		expect(getDynamicSpaceLiveMetrics().calls.total).toBe(0);
		expect(getDynamicSpaceLiveMetrics().operations.invoke.failed).toBe(0);
		expect(getDynamicSpaceLiveMetrics().failuresByStage.invocation).toBe(0);
	});

	it('aggregates bounded operation outcomes and failure stages', () => {
		recordDynamicSpaceLiveMetrics('find', true);
		recordDynamicSpaceLiveMetrics('invoke', true);
		recordDynamicSpaceLiveMetrics('invoke', false, 'configuration');
		recordDynamicSpaceLiveMetrics('view_parameters', false, 'schema');
		recordDynamicSpaceLiveMetrics('unknown', false, 'PRIVATE unexpected stage');
		const metrics = getDynamicSpaceLiveMetrics();
		expect(metrics.calls).toEqual({ total: 5, succeeded: 2, failed: 3 });
		expect(metrics.operations.invoke).toEqual({ total: 2, succeeded: 1, failed: 1 });
		expect(metrics.failuresByStage).toMatchObject({ configuration: 1, schema: 1, unexpected: 1 });
		expect(Object.values(metrics.operations).reduce((sum, counts) => sum + counts.total, 0)).toBe(metrics.calls.total);
		expect(Object.values(metrics.failuresByStage).reduce((sum, count) => sum + count, 0)).toBe(metrics.calls.failed);
		expect(metrics.lastUpdated).toEqual(expect.any(String));
		expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
	});

	it('records every completed outcome once, including disabled calls and exceptions, without remote logging', async () => {
		// The default query logger is disabled during tests; local counts must still advance.
		for (const operation of [undefined, 'find', 'discover', 'view_parameters', 'INVOKE']) {
			await withDynamicSpaceOutcome(operation, {}, async () => ({ isError: false }));
		}
		await withDynamicSpaceOutcome('invoke', {}, async (observe) => {
			observe({ errorMetadata: { stage: 'configuration', code: 'invoke_disabled' } });
			return { isError: true };
		});
		await withDynamicSpaceOutcome('invoke', {}, async (observe) => {
			observe({ errorMetadata: { stage: 'invocation', code: 'upstream_tool_error' } });
			return { isError: true, content: [{ type: 'text', text: 'PRIVATE result' }] };
		});
		await expect(
			withDynamicSpaceOutcome('invoke', {}, async () => {
				throw new Error('PRIVATE exception');
			})
		).rejects.toThrow('PRIVATE exception');
		const metrics = getDynamicSpaceLiveMetrics();
		expect(metrics.calls).toEqual({ total: 8, succeeded: 5, failed: 3 });
		expect(metrics.operations.help.total).toBe(1);
		expect(metrics.operations.invoke).toEqual({ total: 4, succeeded: 1, failed: 3 });
		expect(metrics.failuresByStage).toMatchObject({ configuration: 1, invocation: 1, unexpected: 1 });
		expect(JSON.stringify(metrics)).not.toContain('PRIVATE');
	});

	it('does not depend on successful remote logging or count in-flight calls', async () => {
		let finish!: (value: { isError: boolean }) => void;
		const logger = vi.fn(() => {
			throw new Error('logging failed');
		});
		const call = withDynamicSpaceOutcome(
			'invoke',
			{},
			() =>
				new Promise<{ isError: boolean }>((resolve) => {
					finish = resolve;
				}),
			logger
		);
		expect(getDynamicSpaceLiveMetrics().calls.total).toBe(0);
		finish({ isError: false });
		await expect(call).resolves.toEqual({ isError: false });
		expect(getDynamicSpaceLiveMetrics().calls).toEqual({ total: 1, succeeded: 1, failed: 0 });
		expect(logger).toHaveBeenCalledTimes(1);
	});
});
