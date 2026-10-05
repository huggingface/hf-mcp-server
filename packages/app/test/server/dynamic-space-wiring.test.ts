import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), gradio: vi.fn() }));
vi.mock('../../src/server/utils/query-logger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/server/utils/query-logger.js')>()),
	logToolQuery: mocks.query,
	logGradioEvent: mocks.gradio,
}));
vi.mock('@llmindset/hf-mcp', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@llmindset/hf-mcp')>();
	return {
		...actual,
		// Exercise handler dispatch independently of the SDK's current enum validation.
		getDynamicSpaceToolConfig: () => {
			const config = actual.getDynamicSpaceToolConfig();
			return { ...config, schema: z.object({ operation: z.string().optional(), space_name: z.string().optional() }) };
		},
		SpaceTool: class {
			execute = mocks.execute;
		},
	};
});

async function call(operation: string | undefined, disabled = false) {
	const apiClient = new McpApiClient(
		{ type: 'static' },
		{
			transport: 'streamableHttpJson',
			port: 3000,
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		}
	);
	const { server } = await createServerFactory(apiClient)(
		{
			authorization: 'Bearer test-token',
			...(disabled ? { 'x-mcp-gradio': 'none' } : {}),
		},
		{ builtInTools: ['dynamic_space'], spaceTools: [] }
	);
	const client = new Client({ name: 'dynamic-space-test', version: '1.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await client.callTool({ name: 'dynamic_space', arguments: { operation, space_name: 'owner/space' } });
	} finally {
		await client.close();
		await server.close();
	}
}

describe('dynamic_space MCP wiring', () => {
	it.each([undefined, 'find', 'discover', 'view_parameters'])('logs successful %s once', async (operation) => {
		mocks.execute.mockResolvedValue({ formatted: 'Result', totalResults: 1, resultsShared: 1 });
		const result = await call(operation);
		expect(result.isError).toBeUndefined();
		expect(mocks.query.mock.calls[0]?.[1]).toBe(operation ?? 'help');
		expect(mocks.query.mock.calls[0]?.[3].success).toBe(true);
		expect(mocks.gradio).not.toHaveBeenCalled();
	});

	it('logs a thrown invocation once, retaining supplementary Gradio failure', async () => {
		mocks.execute.mockRejectedValue(new Error('Synthetic failure'));
		const result = await call('invoke');
		expect(result.isError).toBe(true);
		expect(mocks.gradio).toHaveBeenCalledTimes(1);
		expect(mocks.query.mock.calls[0]?.[3]).toMatchObject({
			success: false,
			dynamicSpaceStage: 'unexpected',
			dynamicSpaceErrorCode: 'unexpected_error',
		});
	});

	afterEach(() => {
		// The canonical wrapper owns the query event, even with supplemental Gradio logging.
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.query.mock.calls[0]?.[0]).toBe('dynamic_space');
		expect(mocks.query.mock.calls[0]?.[2]).toEqual({});
		expect(mocks.query.mock.calls[0]?.[3]).toMatchObject({
			dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
		});
		vi.clearAllMocks();
	});

	it.each(['invoke', 'INVOKE'])('blocks disabled %s before execution', async (operation) => {
		const result = await call(operation, true);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('invoke operation is disabled') }]);
		expect(result._meta).toEqual({
			'huggingface.co/dynamic-space': { stage: 'configuration', code: 'invoke_disabled' },
		});
	});

	it.each([false, true])('dispatches uppercase INVOKE as raw output (isError=%s)', async (isError) => {
		const content = [{ type: 'text', text: 'Raw upstream output' }];
		mocks.execute.mockResolvedValue({
			result: { content, isError },
			isError,
			warnings: [],
			...(isError ? { errorMetadata: { stage: 'invocation', code: 'upstream_tool_error' } } : {}),
		});
		const result = await call('INVOKE');
		expect(mocks.gradio).toHaveBeenCalledTimes(1);
		expect(mocks.query.mock.calls[0]?.[3].success).toBe(!isError);
		expect(result.content).toEqual(content);
		expect(result.isError).toBe(isError ? true : undefined);
		expect(result._meta).toEqual(
			isError ? { 'huggingface.co/dynamic-space': { stage: 'invocation', code: 'upstream_tool_error' } } : undefined
		);
	});

	it.each(['INVOKE', 'find'])('exposes formatted error metadata for %s', async (operation) => {
		mocks.execute.mockResolvedValue({
			formatted: 'Setup failed',
			isError: true,
			errorMetadata: { stage: 'schema', code: 'schema_fetch_failed' },
		});
		const result = await call(operation);
		expect(result.content).toEqual([{ type: 'text', text: 'Setup failed' }]);
		expect(result.isError).toBe(true);
		expect(result._meta).toEqual({ 'huggingface.co/dynamic-space': { stage: 'schema', code: 'schema_fetch_failed' } });
		expect(result.structuredContent).toBeUndefined();
	});
});
