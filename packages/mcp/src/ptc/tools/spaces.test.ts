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
		expect(schemaMock).toHaveBeenCalledWith('acme-painter', false, undefined, { maxBytes: 2 * 1024 * 1024 });
		expect(structured).toMatchObject({
			space: {
				kind: 'space',
				id: 'acme/painter',
				uri: 'hf://spaces/acme/painter',
				running: true,
				hardware: 'zero-a10g',
			},
			returnedCount: 1,
			truncated: false,
			tools: [{ name: 'painter_generate', fileInputs: ['image'], locallyValidated: true }],
		});
	});

	it('reports a sleeping Space without tools instead of failing', async () => {
		const fetch = hubFetchMock({ ...SPACE, runtime: { stage: 'SLEEPING' } });
		schemaMock.mockRejectedValue(new Error('connect failed'));
		const { structured } = await callPtcTool(tool('hf_space_tools'), { space: 'acme/painter' }, { fetch });
		expect(structured).toMatchObject({ tools: [], space: { running: false, stage: 'SLEEPING' } });
		expect(structured.note).toContain('not running');
	});

	it('reports 429 and 5xx from a running Space as retryable errors, not as "no tools"', async () => {
		const { SpaceHttpError } = await vi.importActual<typeof SpaceHttpModule>('../../space/utils/space-http.js');
		for (const status of [429, 502, 503]) {
			schemaMock.mockRejectedValueOnce(new SpaceHttpError(status, 'busy'));
			await expect(
				callPtcTool(tool('hf_space_tools'), { space: 'acme/painter' }, { fetch: hubFetchMock(SPACE) })
			).rejects.toMatchObject({ code: 'UPSTREAM_HTTP', retryable: true });
		}
		// A sleeping Space answering 503 still gets the explanatory note.
		schemaMock.mockRejectedValueOnce(new SpaceHttpError(503, 'asleep'));
		const { structured } = await callPtcTool(
			tool('hf_space_tools'),
			{ space: 'acme/painter' },
			{ fetch: hubFetchMock({ ...SPACE, runtime: { stage: 'SLEEPING' } }) }
		);
		expect(structured.note).toContain('not running');
		// 404 from a running Space (no MCP schema) is still an answer.
		schemaMock.mockRejectedValueOnce(new SpaceHttpError(404, 'nope'));
		const notMcp = await callPtcTool(tool('hf_space_tools'), { space: 'acme/painter' }, { fetch: hubFetchMock(SPACE) });
		expect(notMcp.structured.note).toContain('Gradio MCP schema');
	});

	it('fails clearly when the schema exceeds the streaming budget', async () => {
		const { ResponseTooLargeError } = await import('../../network/read-capped.js');
		schemaMock.mockRejectedValueOnce(new ResponseTooLargeError(2 * 1024 * 1024));
		await expect(
			callPtcTool(tool('hf_space_tools'), { space: 'acme/painter' }, { fetch: hubFetchMock(SPACE) })
		).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE' });
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
			isError: false,
			text: 'done',
			media: [
				{ type: 'image', mimeType: 'image/webp' },
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

	it('returns Space tool errors as isError results', async () => {
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
		expect(result.structured).toMatchObject({ isError: true, text: 'GPU quota exceeded' });
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
		expect(result.structured.textTruncated).toBe(true);
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

/** Recorded hf_space_invoke text output of Tongyi-MAI/Z-Image-Turbo (Z_Image_Turbo_generate), 2026-11-18. */
const Z_IMAGE_FILE_DATA =
	"[{'image': {'path': '/tmp/gradio/113d07490ab67022b3ad682005db3e288f6544033656eb3cf5961df671986fb4/image.png', 'url': 'https://tongyi-mai-z-image-turbo.hf.space/--replicas/r4p4x/gradio_api/file=/tmp/gradio/113d07490ab67022b3ad682005db3e288f6544033656eb3cf5961df671986fb4/image.png', 'size': None, 'orig_name': None, 'mime_type': None, 'is_stream': False, 'meta': {'_type': 'gradio.FileData'}}, 'caption': None}]";
const Z_IMAGE_URL =
	'https://tongyi-mai-z-image-turbo.hf.space/--replicas/r4p4x/gradio_api/file=/tmp/gradio/113d07490ab67022b3ad682005db3e288f6544033656eb3cf5961df671986fb4/image.png';
const Z_IMAGE_SPACE = { ...SPACE, id: 'Tongyi-MAI/Z-Image-Turbo', subdomain: 'tongyi-mai-z-image-turbo' };

describe('hf_space_invoke FileData outputs in text', () => {
	const invoke = (space = Z_IMAGE_SPACE) =>
		callPtcTool(
			tool('hf_space_invoke'),
			{ space: space.id, tool: 'painter_generate', arguments: { prompt: 'a small cat' } },
			{ fetch: hubFetchMock(space) }
		);

	it('links gradio.FileData URLs on the Space host as media, keeping the text', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		invokeWith([
			{ type: 'text', text: Z_IMAGE_FILE_DATA },
			{ type: 'text', text: '429959' },
			// The same file printed again (JSON form) is linked once.
			{ type: 'text', text: JSON.stringify({ url: Z_IMAGE_URL, meta: { _type: 'gradio.FileData' } }) },
		]);
		const { structured, content } = await invoke();
		expect(structured.media).toEqual([{ type: 'resource_link', mimeType: 'image/png', uri: Z_IMAGE_URL }]);
		expect(structured.text).toContain("'url': 'https://tongyi-mai-z-image-turbo.hf.space/");
		expect(content.map((block) => block.type)).toEqual(['text', 'resource_link', 'text', 'text']);
		expect(content[1]).toEqual({ type: 'resource_link', uri: Z_IMAGE_URL, name: 'image.png', mimeType: 'image/png' });
	});

	it('ignores URLs on other hosts, non-https URLs and text without FileData', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		const fileData = (url: string) => `{'url': '${url}', 'meta': {'_type': 'gradio.FileData'}}`;
		invokeWith([
			{ type: 'text', text: fileData('https://evil.example/gradio_api/file=/tmp/x.png') },
			{ type: 'text', text: fileData('https://other-space.hf.space/gradio_api/file=/tmp/x.png') },
			{ type: 'text', text: fileData('https://tongyi-mai-z-image-turbo.hf.space.evil.example/file=/tmp/x.png') },
			{ type: 'text', text: fileData('http://tongyi-mai-z-image-turbo.hf.space/gradio_api/file=/tmp/x.png') },
			{ type: 'text', text: fileData('https://user:pw@tongyi-mai-z-image-turbo.hf.space/gradio_api/file=/x.png') },
			{ type: 'text', text: `{'url': '${Z_IMAGE_URL}'}` },
		]);
		const { structured, content } = await invoke();
		expect(structured.media).toEqual([]);
		expect(content.every((block) => block.type === 'text')).toBe(true);
	});

	it('links only real FileData objects (url and meta on one dict), in Python repr and JSON', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		const host = 'https://tongyi-mai-z-image-turbo.hf.space';
		const file = `${host}/gradio_api/file=/tmp/gradio/abc/out.wav`;
		const page = `${host}/about`;
		// A same-host non-file url next to a real file; a FileData meta whose url sits on another dict.
		const repr = `({'audio': {'path': '/tmp/gradio/abc/out.wav', 'url': '${file}', 'is_stream': False, 'meta': {'_type': 'gradio.FileData'}}, 'docs': {'url': '${page}', 'meta': {'_type': 'other'}}, 'split': [{'url': '${page}?x'}, {'meta': {'_type': 'gradio.FileData'}}], 'score': -1.5e3, 'note': 'it\\'s \\u00e9'},)`;
		const json = JSON.stringify({
			audio: { url: file, meta: { _type: 'gradio.FileData' } },
			docs: { url: page, meta: { _type: 'other' } },
			nested: { url: `${page}?y`, inner: { meta: { _type: 'gradio.FileData' } } },
		});
		for (const text of [repr, json]) {
			invokeWith([{ type: 'text', text }]);
			const { structured, content } = await invoke();
			expect(structured.media, text).toEqual([{ type: 'resource_link', mimeType: 'audio/wav', uri: file }]);
			expect(content.map((block) => block.type)).toEqual(['text', 'resource_link']);
		}
	});

	it('ignores prose that merely mentions gradio.FileData', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		invokeWith([{ type: 'text', text: `Saved as gradio.FileData: {'url': '${Z_IMAGE_URL}'}` }]);
		const { structured } = await invoke();
		expect(structured.media).toEqual([]);
	});

	it('adds file links only in the slots left under the 32-block content cap, never displacing output', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		const urls = Array.from(
			{ length: 40 },
			(_, i) => `https://tongyi-mai-z-image-turbo.hf.space/gradio_api/file=/tmp/gradio/${String(i)}/out.bin`
		);
		const logs = Array.from({ length: 20 }, (_, i) => `log ${String(i)}`);
		const original = [
			...logs.map((text) => ({ type: 'text', text })),
			{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
			{ type: 'resource_link', uri: urls[0], name: 'first.bin' },
		];
		invokeWith([
			{ type: 'text', text: JSON.stringify(urls.map((url) => ({ url, meta: { _type: 'gradio.FileData' } }))) },
			...original,
		]);
		const { structured, content } = await invoke();
		expect(content).toHaveLength(32);
		// All 23 original blocks are kept; 9 links fill the rest, after their text block.
		expect(content[0]?.type).toBe('text');
		expect(content.slice(1, 10).every((block) => block.type === 'resource_link')).toBe(true);
		expect(content.slice(10, 30).map((block) => (block.type === 'text' ? block.text : ''))).toEqual(logs);
		expect(content.slice(30).map((block) => block.type)).toEqual(['audio', 'resource_link']);
		// urls[0] is linked by the Space itself, so derived links start at urls[1]; unknown extension, no mimeType.
		expect(content[1]).toEqual({ type: 'resource_link', uri: urls[1], name: 'out.bin' });
		const media = structured.media as { type: string; uri?: string }[];
		expect(media).toHaveLength(11);
		expect(media.slice(0, 9).map((entry) => entry.uri)).toEqual(urls.slice(1, 10));
		expect(media.slice(9)).toEqual([
			{ type: 'audio', mimeType: 'audio/wav' },
			{ type: 'resource_link', uri: urls[0] },
		]);
		expect((structured.warnings as string[]).some((w) => w.includes('32-block content cap'))).toBe(true);
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
		const tools = structured.tools as { name: string; schemaOmitted?: boolean; inputSchema: unknown }[];
		expect(tools[0]).toMatchObject({ name: 'huge', schemaOmitted: true, inputSchema: { type: 'object' } });
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

describe('hf_space_invoke deadline and cancellation', () => {
	it('passes the request signal and a total deadline to the Gradio client', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		callMock.mockResolvedValue({ result: { content: [{ type: 'text', text: 'ok' }] }, capturedHeaders: {} });
		const controller = new AbortController();
		await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch: hubFetchMock(SPACE), signal: controller.signal }
		);
		expect(callMock.mock.calls[0]?.[4]).toMatchObject({ maxTotalMs: 600_000, signal: controller.signal });
	});

	it('maps a timeout to a retryable UPSTREAM_UNAVAILABLE that warns the call may have run', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		callMock.mockRejectedValue(Object.assign(new Error('Maximum total timeout exceeded'), { name: 'SdkError' }));
		const error = await callPtcTool(
			tool('hf_space_invoke'),
			{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
			{ fetch: hubFetchMock(SPACE) }
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
		expect(String((error as Error).message)).toContain('may still have run');
	});

	it('reports a caller abort as CANCELLED', async () => {
		schemaMock.mockResolvedValue(TOOLS);
		const controller = new AbortController();
		callMock.mockImplementation(() => {
			controller.abort();
			return Promise.reject(new Error('Request was aborted'));
		});
		await expect(
			callPtcTool(
				tool('hf_space_invoke'),
				{ space: 'acme/painter', tool: 'painter_generate', arguments: { prompt: 'x' } },
				{ fetch: hubFetchMock(SPACE), signal: controller.signal }
			)
		).rejects.toMatchObject({ code: 'CANCELLED' });
	});
});
