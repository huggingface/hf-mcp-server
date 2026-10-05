import { describe, expect, it, vi } from 'vitest';
import {
	withDynamicSpaceOutcome,
	normalizeDynamicSpaceOperation,
} from '../../../src/server/utils/dynamic-space-outcome.js';

describe('canonical dynamic_space handler outcomes', () => {
	const options = { requestId: 'request', clientSessionId: 'session', protocolEra: 'modern' as const };
	it.each([
		{ name: 'gradio=none', operation: 'invoke', stage: 'configuration', code: 'invoke_disabled' },
		{ name: 'returned upstream MCP error', operation: 'invoke', stage: 'invocation', code: 'upstream_tool_error' },
		{ name: 'formatted setup error', operation: 'invoke', stage: 'schema', code: 'schema_fetch_failed' },
		{ name: 'non-invoke error', operation: 'find', stage: 'operation', code: 'operation_failed' },
	] as const)('logs exactly once for $name', async ({ operation, stage, code }) => {
		const log = vi.fn();
		const response = { isError: true, content: [{ type: 'text', text: 'PRIVATE error detail' }] };
		expect(
			await withDynamicSpaceOutcome(
				operation,
				options,
				async (observe) => {
					observe({ errorMetadata: { stage, code } });
					return response;
				},
				log
			)
		).toEqual({
			...response,
			_meta: { 'huggingface.co/dynamic-space': { stage, code } },
		});
		expect(log).toHaveBeenCalledExactlyOnceWith(
			'dynamic_space',
			operation,
			{},
			{
				...options,
				durationMs: expect.any(Number),
				success: false,
				dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
				dynamicSpaceStage: stage,
				dynamicSpaceErrorCode: code,
			}
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
	});

	it.each([undefined, 'find', 'discover', 'view_parameters', 'invoke'])(
		'logs success once for %s without output',
		async (operation) => {
			const log = vi.fn();
			const response = { isError: false, content: [{ type: 'text', text: 'PRIVATE raw output' }] };
			expect(await withDynamicSpaceOutcome(operation, options, async () => response, log)).toBe(response);
			expect(log).toHaveBeenCalledExactlyOnceWith(
				'dynamic_space',
				operation ?? 'help',
				{},
				{
					...options,
					durationMs: expect.any(Number),
					success: true,
					dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
				}
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
		}
	);

	it.each(['invoke', 'find', undefined])('logs thrown exceptions once and rethrows for %s', async (operation) => {
		const log = vi.fn();
		const error = new Error('PRIVATE exception');
		await expect(
			withDynamicSpaceOutcome(
				operation,
				options,
				async (observe) => {
					observe({ errorMetadata: { stage: 'schema', code: 'schema_fetch_failed' } });
					throw error;
				},
				log
			)
		).rejects.toBe(error);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[3]).toMatchObject({
			...options,
			success: false,
			dynamicSpaceStage: 'unexpected',
			dynamicSpaceErrorCode: 'unexpected_error',
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
	});

	it('does not infer missing metadata from error text', async () => {
		const log = vi.fn();
		await withDynamicSpaceOutcome(
			'invoke',
			options,
			async () => ({
				isError: true,
				formatted: 'schema_fetch_failed',
			}),
			log
		);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[3]).toMatchObject({
			dynamicSpaceStage: 'unexpected',
			dynamicSpaceErrorCode: 'unexpected_error',
		});
	});

	it('preserves content, structured content and existing metadata', async () => {
		const response = {
			isError: true,
			content: [{ type: 'text', text: 'error' }],
			structuredContent: { unchanged: true },
			_meta: { upstream: 'retained' },
		};
		const result = await withDynamicSpaceOutcome('invoke', options, async () => response, vi.fn());
		expect(result).toEqual({
			...response,
			_meta: {
				upstream: 'retained',
				'huggingface.co/dynamic-space': { stage: 'unexpected', code: 'unexpected_error' },
			},
		});
		expect(result.content).toBe(response.content);
		expect(result.structuredContent).toBe(response.structuredContent);
		expect(response._meta).toEqual({ upstream: 'retained' });
	});

	it('does not let a throwing logger mask a result or primary exception', async () => {
		const log = vi.fn(() => {
			throw new Error('logger failed');
		});
		const response = { content: [], isError: false };
		expect(await withDynamicSpaceOutcome('invoke', options, async () => response, log)).toBe(response);
		const error = new Error('primary');
		await expect(
			withDynamicSpaceOutcome(
				'invoke',
				options,
				async () => {
					throw error;
				},
				log
			)
		).rejects.toBe(error);
	});

	it('bounds operation labels and normalizes help', () => {
		expect(normalizeDynamicSpaceOperation()).toBe('help');
		expect(normalizeDynamicSpaceOperation('')).toBe('help');
		expect(normalizeDynamicSpaceOperation('help')).toBe('unknown');
		expect(normalizeDynamicSpaceOperation('INVOKE')).toBe('invoke');
		expect(normalizeDynamicSpaceOperation('PRIVATE arbitrary input')).toBe('unknown');
	});
});
