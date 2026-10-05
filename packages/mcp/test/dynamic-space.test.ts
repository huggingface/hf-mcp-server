import * as findCommand from '../src/space/commands/dynamic-find.js';
import * as discoverCommand from '../src/space/commands/discover.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { SpaceTool } from '../src/space/dynamic-space-tool.js';
import { dynamicSpaceArgsSchema, spaceArgsSchema, type SpaceArgs } from '../src/space/types.js';
import { fetchSpaceMetadata, fetchGradioSchema, SpaceHttpError } from '../src/space/utils/space-http.js';
import { callGradioToolWithHeaders } from '../src/space/utils/gradio-caller.js';

vi.mock('../src/space/utils/space-http.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/space/utils/space-http.js')>()),
	fetchSpaceMetadata: vi.fn(),
	fetchGradioSchema: vi.fn(),
}));
vi.mock('../src/space/utils/gradio-caller.js');
const tools: Tool[] = [
	{ name: 'first', inputSchema: { type: 'object', properties: {} } },
	{
		name: 'second',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				count: { type: 'integer', default: 0 },
			},
			required: ['prompt'],
		},
	},
];
const execute = (args: Partial<SpaceArgs> = {}) =>
	new SpaceTool('token').execute({ operation: 'invoke', space_name: 'org/space', parameters: {}, ...args });

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv('DYNAMIC_SPACE_DATA', '');
	vi.mocked(fetchSpaceMetadata).mockResolvedValue({ subdomain: 'org-space', private: false });
	vi.mocked(fetchGradioSchema).mockResolvedValue(tools);
	vi.mocked(callGradioToolWithHeaders).mockResolvedValue({ result: { content: [] }, capturedHeaders: {} });
});

afterEach(() => vi.unstubAllEnvs());

describe('dynamic_space selection and inputs', () => {
	it('invokes the actual inspected example unchanged, including tool selection and native defaults', async () => {
		const inspection = await execute({ operation: 'view_parameters', tool_name: 'second' });
		if (!('formatted' in inspection)) throw new Error('Expected formatted inspection');
		const block = /```json\n([\s\S]*?)\n```/.exec(inspection.formatted)?.[1];
		if (!block) throw new Error('Expected JSON example');
		const request = spaceArgsSchema.parse(JSON.parse(block));
		const result = await new SpaceTool().execute(request);
		expect(result.isError).toBeUndefined();
		expect(callGradioToolWithHeaders).toHaveBeenCalledWith(
			expect.any(String),
			'second',
			{ prompt: 'example value', count: 0 },
			undefined,
			expect.any(Object)
		);
	});

	it.each([spaceArgsSchema, dynamicSpaceArgsSchema])(
		'accepts objects and legacy JSON strings in both schemas',
		(schema) => {
			for (const parameters of [{ prompt: 'hi' }, '{"prompt":"hi"}']) {
				expect(schema.parse({ operation: 'invoke', tool_name: 'second', parameters })).toMatchObject({
					tool_name: 'second',
					parameters,
				});
			}
			for (const parameters of [null, [], 42]) expect(schema.safeParse({ parameters }).success).toBe(false);
		}
	);

	it.each([undefined, 'second'])('uses the same tool for inspection and invocation: %s', async (tool_name) => {
		const inspection = await execute({ operation: 'view_parameters', tool_name });
		expect('formatted' in inspection && inspection.formatted).toContain(`# Parameters for: ${tool_name ?? 'first'}`);
		await execute({ tool_name, parameters: { prompt: 'hi' } });
		expect(callGradioToolWithHeaders).toHaveBeenCalledWith(
			expect.any(String),
			tool_name ?? 'first',
			tool_name ? { prompt: 'hi', count: 0 } : { prompt: 'hi' },
			'token',
			expect.any(Object)
		);
	});

	it.each(['{"prompt":"hi"}', { prompt: 'hi' }])(
		'preserves legacy and object callers and progress',
		async (parameters) => {
			const onProgress = vi.fn();
			const result = await new SpaceTool().execute(
				{ operation: 'invoke', space_name: 'org/space', tool_name: 'second', parameters },
				{ onProgress }
			);
			expect(result.isError).toBeUndefined();
			expect(result.errorMetadata).toBeUndefined();
			expect(callGradioToolWithHeaders).toHaveBeenCalledWith(
				expect.any(String),
				'second',
				{ prompt: 'hi', count: 0 },
				undefined,
				{ logProxiedReplica: true, onProgress }
			);
		}
	);

	it.each(['invoke', 'view_parameters'] as const)(
		'provides exact-name recovery for %s without falling back',
		async (operation) => {
			const result = await execute({ operation, tool_name: 'SECOND' });
			expect(result.errorMetadata).toEqual({ stage: 'selection', code: 'tool_not_found' });
			expect('formatted' in result && result.formatted).toContain('"first", "second"');
			expect(callGradioToolWithHeaders).not.toHaveBeenCalled();
		}
	);

	it('preserves raw upstream content and warnings on upstream errors', async () => {
		const raw = { content: [{ type: 'text' as const, text: 'failed' }], isError: true };
		vi.mocked(callGradioToolWithHeaders).mockResolvedValue({ result: raw, capturedHeaders: {} });
		const result = await execute({ parameters: { extra: true } });
		expect(result).toMatchObject({
			result: raw,
			warnings: [expect.stringContaining('extra')],
			isError: true,
			errorMetadata: { stage: 'invocation', code: 'upstream_tool_error' },
		});
	});
});

describe('dynamic_space failure metadata', () => {
	it.each([
		[{ operation: 'wrong' }, 'request', 'unknown_operation'],
		[{ space_name: undefined }, 'request', 'missing_space_name'],
		[{ parameters: undefined }, 'request', 'missing_parameters'],
		[{ parameters: '' }, 'request', 'invalid_parameters_json'],
		[{ parameters: '[]' }, 'request', 'invalid_parameters_json'],
		[{ parameters: 'null' }, 'request', 'invalid_parameters_json'],
		[{ tool_name: 'second', parameters: {} }, 'validation', 'invalid_parameters'],
	] as const)('classifies request failures %j', async (args, stage, code) => {
		const result = await execute(args as Partial<SpaceArgs>);
		expect(result).toMatchObject({ isError: true, errorMetadata: { stage, code } });
		expect(callGradioToolWithHeaders).not.toHaveBeenCalled();
	});

	it.each(['invoke', 'view_parameters'] as const)('classifies each preparation failure for %s', async (operation) => {
		vi.mocked(fetchSpaceMetadata).mockRejectedValueOnce(new Error('network'));
		expect((await execute({ operation })).errorMetadata).toEqual({ stage: 'metadata', code: 'metadata_fetch_failed' });
		vi.mocked(fetchGradioSchema).mockRejectedValueOnce(new Error('network'));
		expect((await execute({ operation })).errorMetadata).toEqual({ stage: 'schema', code: 'schema_fetch_failed' });
		vi.mocked(fetchGradioSchema).mockResolvedValueOnce([]);
		expect((await execute({ operation })).errorMetadata).toEqual({ stage: 'selection', code: 'no_tools' });
		vi.mocked(fetchGradioSchema).mockResolvedValueOnce([
			{
				name: 'complex',
				inputSchema: { type: 'object', properties: { x: { type: 'array', items: { type: 'object' } } } },
			},
		]);
		const complex = await execute({ operation });
		expect(complex.errorMetadata).toEqual({ stage: 'schema', code: 'unsupported_schema' });
		expect('formatted' in complex && complex.formatted).toContain('https://huggingface.co/settings/mcp');
	});

	it('distinguishes invocation exceptions from upstream isError', async () => {
		vi.mocked(callGradioToolWithHeaders).mockRejectedValueOnce(new Error('disconnected'));
		expect((await execute()).errorMetadata).toEqual({ stage: 'invocation', code: 'invocation_failed' });
	});

	it.each(['', 'configured'])('documents selectors, object inputs, and limitations in both modes', async (mode) => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', mode);
		const help = await execute({ operation: undefined });
		expect('formatted' in help && help.formatted).toContain('tool_name');
		expect('formatted' in help && help.formatted).toContain('JSON object string');
		expect('formatted' in help && help.formatted).toContain('not full JSON Schema');
	});
});

describe.each(['invoke', 'view_parameters'])('%s HTTP recovery', (operation) => {
	it.each([
		[401, 'authentication_required', 'valid Hugging Face token'],
		[403, 'access_denied', 'request access'],
		[404, 'not_found_or_inaccessible', 'missing or inaccessible'],
		[429, 'service_unavailable', 'wait before trying again'],
		[503, 'service_unavailable', 'wait before trying again'],
	] as const)('classifies HTTP %s at the fetching stage', async (status, code, action) => {
		for (const stage of ['metadata', 'schema'] as const) {
			const fetcher = stage === 'metadata' ? fetchSpaceMetadata : fetchGradioSchema;
			vi.mocked(fetcher).mockRejectedValueOnce(new SpaceHttpError(status, 'human message'));
			const result = await execute({ operation });
			expect(result).toMatchObject({
				isError: true,
				errorMetadata: { stage, code },
				formatted: expect.stringContaining(action),
			});
			expect(result).toMatchObject({ formatted: expect.stringContaining(`HTTP ${status}: human message`) });
		}
	});

	it.each([new Error('404 not found'), new Error('timeout'), new SpaceHttpError(400, 'Bad Request')])(
		'keeps unknown failures generic without heuristic guidance',
		async (error) => {
			for (const stage of ['metadata', 'schema'] as const) {
				const fetcher = stage === 'metadata' ? fetchSpaceMetadata : fetchGradioSchema;
				vi.mocked(fetcher).mockRejectedValueOnce(error);
				const result = await execute({ operation });
				expect(result.errorMetadata).toEqual({ stage, code: `${stage}_fetch_failed` });
				if (!('formatted' in result)) throw new Error('Expected formatted error');
				expect(result.formatted).not.toContain('Next action');
				expect(result.formatted).not.toContain('MUST');
			}
		}
	);
});

it.each(['find', 'discover'])('adds fallback metadata to returned %s failures', async (operation) => {
	if (operation === 'discover') vi.stubEnv('DYNAMIC_SPACE_DATA', 'https://example.com/spaces.json');
	const failure = { formatted: 'command failure', totalResults: 0, resultsShared: 0, isError: true };
	const spy = operation === 'find' ? vi.spyOn(findCommand, 'findSpaces') : vi.spyOn(discoverCommand, 'discoverSpaces');
	try {
		spy.mockResolvedValueOnce(failure);
		expect(await execute({ operation })).toEqual({
			...failure,
			errorMetadata: { stage: 'operation', code: 'operation_failed' },
		});
		const specific = { ...failure, errorMetadata: { stage: 'request', code: 'missing_parameters' } as const };
		spy.mockResolvedValueOnce(specific);
		expect(await execute({ operation })).toEqual(specific);
	} finally {
		spy.mockRestore();
	}
});
