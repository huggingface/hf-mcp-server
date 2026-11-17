import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SpaceHttpModule from '../../space/utils/space-http.js';
import { callPtcTool, type PtcTool } from '../core/tool.js';
import { SPACES_TOOLS } from './spaces.js';

const schemaMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());

vi.mock('../../space/utils/space-http.js', async (importOriginal) => ({
	...(await importOriginal<typeof SpaceHttpModule>()),
	fetchGradioSchema: schemaMock,
}));
vi.mock('../../space/utils/gradio-caller.js', () => ({ callGradioToolWithHeaders: callMock }));

function tool(name: string): PtcTool {
	const found = SPACES_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

function hubFetchMock(body: unknown) {
	return vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(Response.json(body)));
}

const SPACE = {
	id: 'acme/painter',
	subdomain: 'acme-painter',
	private: false,
	sdk: 'gradio',
	runtime: { stage: 'RUNNING', hardware: { current: 'zero-a10g' } },
};
const TOOLS = [
	{
		name: 'painter_generate',
		description: 'Generate an image',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				steps: { type: 'number', default: 20 },
				image: { type: 'string', title: 'ImageData' },
			},
			required: ['prompt'],
		},
	},
];

afterEach(() => {
	vi.clearAllMocks();
});

describe('hf_space_tools', () => {
	it('resolves the Space with expand params and lists all tools', async () => {
		const fetch = hubFetchMock(SPACE);
		schemaMock.mockResolvedValue(TOOLS);
		const { structured } = await callPtcTool(tool('hf_space_tools'), { space: 'hf://spaces/acme/painter' }, { fetch });
		const url = new URL(fetch.mock.calls[0]?.[0] as string);
		expect(url.pathname).toBe('/api/spaces/acme/painter');
		expect(url.searchParams.getAll('expand')).toEqual(['subdomain', 'runtime', 'private', 'sdk']);
		expect(schemaMock).toHaveBeenCalledWith('acme-painter', false, undefined);
		expect(structured).toMatchObject({
			space: {
				kind: 'space',
				id: 'acme/painter',
				uri: 'hf://spaces/acme/painter',
				running: true,
				hardware: 'zero-a10g',
			},
			returned_count: 1,
			truncated: false,
			tools: [{ name: 'painter_generate', file_inputs: ['image'], locally_validated: true }],
		});
	});

	it('reports a sleeping Space without tools instead of failing', async () => {
		const fetch = hubFetchMock({ ...SPACE, runtime: { stage: 'SLEEPING' } });
		schemaMock.mockRejectedValue(new Error('connect failed'));
		const { structured } = await callPtcTool(tool('hf_space_tools'), { space: 'acme/painter' }, { fetch });
		expect(structured).toMatchObject({ tools: [], space: { running: false, stage: 'SLEEPING' } });
		expect(structured.note).toContain('not running');
	});

	it('maps a missing Space to NOT_FOUND', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('nope', { status: 404 }));
		await expect(callPtcTool(tool('hf_space_tools'), { space: 'acme/missing' }, { fetch })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});

describe('hf_space_invoke', () => {
	it('validates, applies defaults, relays progress and returns content blocks', async () => {
		const fetch = hubFetchMock(SPACE);
		schemaMock.mockResolvedValue(TOOLS);
		callMock.mockImplementation(
			async (
				_url: string,
				_name: string,
				_args: unknown,
				_token: string | undefined,
				options: { onProgress?: (p: { progress: number; total?: number }) => Promise<void> }
			) => {
				await options.onProgress?.({ progress: 1, total: 2 });
				return {
					result: {
						content: [
							{ type: 'text', text: 'done' },
							{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' },
							{ type: 'resource_link', uri: 'https://acme-painter.hf.space/file=out.png', name: 'out.png' },
						],
					},
					capturedHeaders: {},
				};
			}
		);
		const onProgress = vi.fn();
		const { structured, content } = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'cat', extra: 1 } },
			{ fetch, hfToken: 'hf_secret', onProgress }
		);
		expect(callMock).toHaveBeenCalledWith(
			'https://acme-painter.hf.space/gradio_api/mcp/',
			'painter_generate',
			{ prompt: 'cat', extra: 1, steps: 20 },
			'hf_secret',
			expect.any(Object)
		);
		expect(onProgress).toHaveBeenCalledWith({ progress: 1, total: 2 });
		expect(content).toHaveLength(3);
		expect(content[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' });
		expect(structured).toMatchObject({
			space: { id: 'acme/painter' },
			tool: 'painter_generate',
			is_error: false,
			text: 'done',
			media: [
				{ type: 'image', mime_type: 'image/webp' },
				{ type: 'resource_link', uri: 'https://acme-painter.hf.space/file=out.png' },
			],
		});
		expect((structured.warnings as string[])[0]).toContain('extra');
	});

	it('rejects missing required parameters before calling the Space', async () => {
		const fetch = hubFetchMock(SPACE);
		schemaMock.mockResolvedValue(TOOLS);
		await expect(
			callPtcTool(
				tool('hf_space_invoke'),
				{ space: 'acme/painter', tool: 'painter_generate', arguments: {} },
				{ fetch }
			)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		expect(callMock).not.toHaveBeenCalled();
	});

	it('reports unknown tool names with the available ones', async () => {
		const fetch = hubFetchMock(SPACE);
		schemaMock.mockResolvedValue(TOOLS);
		await expect(
			callPtcTool(tool('hf_space_invoke'), { space: 'acme/painter', tool: 'nope' }, { fetch })
		).rejects.toThrow(/painter_generate/);
	});

	it('returns Space tool errors as is_error results', async () => {
		const fetch = hubFetchMock(SPACE);
		schemaMock.mockResolvedValue(TOOLS);
		callMock.mockResolvedValue({
			result: { isError: true, content: [{ type: 'text', text: 'GPU quota exceeded' }] },
			capturedHeaders: {},
		});
		const result = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch }
		);
		expect(result.structured).toMatchObject({ is_error: true, text: 'GPU quota exceeded' });
		// The MCP result is marked isError so registration and metrics count the failure.
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: 'text', text: 'GPU quota exceeded' }]);
	});

	it('uses mutating, anonymous metadata', () => {
		const invoke = tool('hf_space_invoke');
		expect(invoke.access).toBe('anonymous');
		expect(invoke.annotations.readOnlyHint).toBe(false);
		expect(invoke.annotations.destructiveHint).toBe(false);
		for (const t of SPACES_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});
});

function invokeWith(content: unknown[], isError = false) {
	callMock.mockResolvedValue({ result: { content, ...(isError ? { isError } : {}) }, capturedHeaders: {} });
}

describe('hf_space_invoke result budgets (A2)', () => {
	it('bounds text across all content blocks and in the structured mirror', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		invokeWith([
			{ type: 'text', text: 'a'.repeat(15_000) },
			{ type: 'text', text: 'b'.repeat(15_000) },
			{ type: 'resource', resource: { uri: 'https://x.hf.space/file=r.txt', text: 'c'.repeat(10_000) } },
		]);
		const result = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch: hubFetchMock(SPACE) }
		);
		const contentText = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
		expect(contentText.length).toBe(20_000);
		expect(result.content).toHaveLength(2);
		expect((result.structured.text as string).replace(/\n/g, '').length).toBe(20_000);
		expect(result.structured.text_truncated).toBe(true);
		expect(result.isError).toBeFalsy();
	});

	it('applies one aggregate media budget and a block cap', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		const fiveMiB = 'A'.repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3));
		invokeWith([
			{ type: 'image', data: fiveMiB, mimeType: 'image/png' },
			{ type: 'image', data: fiveMiB, mimeType: 'image/png' },
			{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
			...Array.from({ length: 40 }, (_, i) => ({ type: 'resource_link', uri: `https://x.hf.space/file=${i}.png` })),
		]);
		const { structured, content } = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch: hubFetchMock(SPACE) }
		);
		expect(content.filter((block) => block.type === 'image')).toHaveLength(1);
		expect(content.filter((block) => block.type === 'audio')).toHaveLength(1);
		expect(content.length).toBeLessThanOrEqual(32);
		expect((structured.media as unknown[]).length).toBe(content.length);
		const warnings = structured.warnings as string[];
		expect(warnings.some((w) => w.includes('8 MiB total'))).toBe(true);
		expect(warnings.some((w) => w.includes('first 32'))).toBe(true);
	});

	it('bounds link metadata and drops overlong URIs', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		invokeWith([
			{ type: 'resource_link', uri: `https://x.hf.space/${'u'.repeat(3000)}` },
			{
				type: 'resource_link',
				uri: 'https://x.hf.space/ok.png',
				name: 'n'.repeat(1000),
				description: 'd'.repeat(5000),
			},
		]);
		const { structured, content } = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch: hubFetchMock(SPACE) }
		);
		expect(content).toHaveLength(1);
		const link = content[0] as { name: string; description: string };
		expect(link.name.length).toBeLessThanOrEqual(201);
		expect(link.description.length).toBeLessThanOrEqual(501);
		expect(structured.media).toEqual([{ type: 'resource_link', uri: 'https://x.hf.space/ok.png' }]);
	});
});

describe('hf_space_tools schema budget (A2)', () => {
	it('omits oversized schemas and stops at the total size budget', async () => {
		const huge = { type: 'object', properties: { p: { type: 'string', description: 'x'.repeat(40_000) } } };
		const big = { type: 'object', properties: { p: { type: 'string', description: 'y'.repeat(30_000) } } };
		schemaMock.mockResolvedValue([
			{ name: 'huge', description: 'h', inputSchema: huge },
			...Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, description: 'd', inputSchema: big })),
		]);
		const { structured } = await callPtcTool(
			tool('hf_space_tools'),
			{ space: 'acme/painter' },
			{ fetch: hubFetchMock(SPACE) }
		);
		const tools = structured.tools as { name: string; schema_omitted?: boolean; input_schema: unknown }[];
		expect(tools[0]).toMatchObject({ name: 'huge', schema_omitted: true, input_schema: { type: 'object' } });
		expect(JSON.stringify(tools).length).toBeLessThanOrEqual(200_000);
		expect(tools.length).toBeLessThan(11);
		expect(structured.truncated).toBe(true);
		expect(structured.note).toMatch(/omitted.*size budget/);
	});
});

describe('hf_space_invoke file inputs (A13)', () => {
	const FILE_TOOL = {
		name: 'edit',
		inputSchema: {
			type: 'object',
			properties: { image: { type: 'string', title: 'ImageData' }, prompt: { type: 'string' } },
		},
	};
	const COMPLEX_TOOL = {
		name: 'complex',
		inputSchema: {
			type: 'object',
			properties: {
				files: { type: 'array', items: { type: 'object' } },
				image: { title: 'FileData', type: 'object', properties: { url: { type: 'string' } } },
			},
		},
	};

	it.each([
		'file:///etc/passwd',
		'/etc/passwd',
		'data:image/png;base64,AAAA',
		'http://localhost:8080/x.png',
		'http://127.0.0.1/x.png',
		'http://[::1]/x.png',
		'http://10.0.0.5/x.png',
		'http://192.168.1.1/x.png',
		'http://169.254.169.254/latest/meta-data',
		'http://printer.local/x.png',
		'https://user:pass@example.com/x.png',
	])('rejects %s before calling the Space', async (url) => {
		schemaMock.mockResolvedValue([FILE_TOOL]);
		await expect(
			callPtcTool(
				tool('hf_space_invoke'),
				{ space: 'acme/painter', tool: 'edit', arguments: { image: url } },
				{ fetch: hubFetchMock(SPACE) }
			)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		expect(callMock).not.toHaveBeenCalled();
	});

	it('accepts public http(s) URLs and leaves non-file strings alone', async () => {
		schemaMock.mockResolvedValue([FILE_TOOL]);
		invokeWith([{ type: 'text', text: 'ok' }]);
		await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'edit', arguments: { image: 'https://example.com/cat.png', prompt: 'file:///x' } },
			{ fetch: hubFetchMock(SPACE) }
		);
		expect(callMock).toHaveBeenCalledTimes(1);
	});

	it('checks FileData fields and nested gradio.FileData objects in complex schemas', async () => {
		schemaMock.mockResolvedValue([COMPLEX_TOOL]);
		for (const args of [
			{ image: { url: 'http://10.1.2.3/a.png' } },
			{ files: [{ path: 'file:///tmp/a', meta: { _type: 'gradio.FileData' } }] },
		]) {
			await expect(
				callPtcTool(
					tool('hf_space_invoke'),
					{ space: 'acme/painter', tool: 'complex', arguments: args },
					{ fetch: hubFetchMock(SPACE) }
				)
			).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		}
		expect(callMock).not.toHaveBeenCalled();
		invokeWith([{ type: 'text', text: 'ok' }]);
		const { structured } = await callPtcTool(
			tool('hf_space_invoke'),
			{
				space: 'acme/painter',
				tool: 'complex',
				arguments: { files: [{ url: 'https://example.com/a.png', meta: { _type: 'gradio.FileData' } }] },
			},
			{ fetch: hubFetchMock(SPACE) }
		);
		expect((structured.warnings as string[])[0]).toContain('passed through unchanged');
	});
});
