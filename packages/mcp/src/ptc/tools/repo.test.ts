import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { REPO_TOOLS } from './repo.js';

type Handler = (url: URL, init: RequestInit) => Response | undefined;

function mockFetch(handler: Handler) {
	return vi.fn<typeof globalThis.fetch>().mockImplementation((input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const res = handler(url, init ?? {});
		return Promise.resolve(res ?? new Response('nope', { status: 404 }));
	});
}

/** URLs a mockFetch was called with, in order. */
const requested = (fetch: ReturnType<typeof mockFetch>): URL[] =>
	fetch.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input));

function call(name: string, input: unknown, ctx: PtcContext) {
	const tool = REPO_TOOLS.find((t) => t.name === name);
	if (!tool) throw new Error(`missing ${name}`);
	return callPtcTool(tool, input, ctx);
}

describe('REPO_TOOLS registry', () => {
	it('defines the six v2 repo tools with bounded descriptions', () => {
		expect(REPO_TOOLS.map((t) => t.name)).toEqual([
			'hf_repo_info',
			'hf_repo_list_files',
			'hf_repo_paths_info',
			'hf_repo_read_text',
			'hf_repo_read_image',
			'hf_repo_history',
		]);
		for (const tool of REPO_TOOLS) {
			expect(tool.description.length).toBeGreaterThanOrEqual(150);
			expect(tool.description.length).toBeLessThanOrEqual(700);
			expect(tool.access).toBe('anonymous');
			expect(tool.annotations.readOnlyHint).toBe(true);
		}
	});
});

describe('hf_repo_info', () => {
	it('reports a renamed repository under its current id', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/datasets/OldOrg/data')
				return new Response(null, { status: 307, headers: { location: `/api/datasets/NewOrg/data${url.search}` } });
			if (url.pathname === '/api/datasets/NewOrg/data') return Response.json({ id: 'NewOrg/data', likes: 3 });
			return undefined;
		});
		const r = await call('hf_repo_info', { repos: ['hf://datasets/OldOrg/data'], fields: ['likes'] }, { fetch });
		expect(r.structured.items).toMatchObject([{ id: 'NewOrg/data', uri: 'hf://datasets/NewOrg/data', likes: 3 }]);
	});

	it('follows a legacy single-segment id to its namespaced repository', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/gpt2')
				return new Response(null, {
					status: 307,
					headers: { location: `/api/models/openai-community/gpt2${url.search}` },
				});
			if (url.pathname === '/api/models/openai-community/gpt2') return Response.json({ id: 'openai-community/gpt2' });
			return undefined;
		});
		const r = await call('hf_repo_info', { repos: ['hf://models/gpt2'], fields: ['likes'] }, { fetch });
		expect(r.structured.items).toMatchObject([{ id: 'openai-community/gpt2' }]);
	});

	it.each([
		{
			path: 'models/org/m',
			fields: ['libraryName', 'pipelineTag'],
			expand: ['cardData', 'library_name', 'pipeline_tag'],
			wire: { library_name: 'transformers', pipeline_tag: 'text-generation' },
			projected: { libraryName: 'transformers', pipelineTag: 'text-generation' },
		},
		{
			path: 'datasets/org/d',
			fields: ['paperswithcodeId'],
			expand: ['paperswithcode_id'],
			wire: { paperswithcode_id: 'squad' },
			projected: { paperswithcodeId: 'squad' },
		},
	])('requests and projects Hub expansion keys for $path', async ({ path, fields, expand, wire, projected }) => {
		const fetch = mockFetch((url) => {
			if (url.pathname !== `/api/${path}`) return undefined;
			const keys = url.searchParams.getAll('expand');
			return Response.json(Object.fromEntries(Object.entries(wire).filter(([key]) => keys.includes(key))));
		});
		const result = await call('hf_repo_info', { repos: [`hf://${path}`], fields }, { fetch });
		expect(requested(fetch)[0]?.searchParams.getAll('expand')).toEqual(expand);
		expect(result.structured.items).toMatchObject([projected]);
	});

	it('returns the chat template from tokenizer_config (named list) and caps long templates', async () => {
		const long = 'x'.repeat(20_000);
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/org/named')
				return Response.json({
					id: 'org/named',
					config: {
						model_type: 'llama',
						tokenizer_config: {
							chat_template: [
								{ name: 'tool_use', template: 'T' },
								{ name: 'default', template: 'D' },
							],
						},
					},
				});
			if (url.pathname === '/api/models/org/long')
				return Response.json({ id: 'org/long', gguf: { chat_template: long } });
			return undefined;
		});
		const result = await call(
			'hf_repo_info',
			{ repos: ['org/named', 'org/long'], kind: 'model', fields: ['chatTemplate', 'chatTemplateTruncated'] },
			{ fetch }
		);
		const items = result.structured.items as Record<string, unknown>[];
		expect(items[0]).toEqual({
			kind: 'model',
			id: 'org/named',
			uri: 'hf://models/org/named',
			url: 'https://huggingface.co/org/named',
			chatTemplate: 'D',
		});
		expect(requested(fetch).map((u) => u.searchParams.getAll('expand'))).toEqual([
			['config', 'gguf'],
			['config', 'gguf'],
		]);
		expect(items[0]).not.toHaveProperty('chatTemplateTruncated');
		expect((items[1]?.chatTemplate as string).length).toBe(16_000);
		expect(items[1]?.chatTemplateTruncated).toBe(true);
	});

	it('keeps chat_template_truncated when only chat_template is requested (R5)', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/org/long'
				? Response.json({ id: 'org/long', gguf: { chat_template: 'x'.repeat(20_000) } })
				: undefined
		);
		const result = await call('hf_repo_info', { repos: ['org/long'], fields: ['chatTemplate'] }, { fetch });
		const items = result.structured.items as Record<string, unknown>[];
		expect((items[0]?.chatTemplate as string).length).toBe(16_000);
		expect(items[0]?.chatTemplateTruncated).toBe(true);
	});

	it('auto-detects kind, projects reviewed fields and reports per-item errors', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/org/model') {
				// Default: GGUF/config summaries yes; the Space list is not expanded.
				expect(url.searchParams.getAll('expand')).toEqual(expect.arrayContaining(['gguf', 'config', 'cardData']));
				expect(url.searchParams.getAll('expand')).not.toContain('spaces');
				return Response.json({
					id: 'org/model',
					downloads: 10,
					likes: 2,
					gated: 'manual',
					private: false,
					usedStorage: 1234,
					childrenModelCount: 7,
					cardData: { license: 'apache-2.0', base_model: 'base/model', datasets: ['d/one'], language: ['en'] },
					safetensors: { total: 1000, parameters: { BF16: 1000 } },
					gguf: {
						total: 1000,
						architecture: 'llama',
						context_length: 4096,
						chat_template: '{{x}}',
						eos_token: '<|eot|>',
					},
					config: { model_type: 'llama', architectures: ['LlamaForCausalLM'], secret: 'drop' },
					spaces: ['a/s1', 'a/s2'],
					inferenceProviderMapping: { together: { status: 'live', providerId: 'x/y', task: 'conversational' } },
					unknownField: 'ignored',
				});
			}
			if (url.pathname === '/api/models/org/space-only') return new Response('', { status: 401 });
			if (url.pathname === '/api/datasets/org/space-only') return new Response('', { status: 404 });
			if (url.pathname === '/api/spaces/org/space-only') {
				return Response.json({
					id: 'org/space-only',
					sdk: 'gradio',
					runtime: { stage: 'RUNNING', hardware: { current: 'zero-a10g', requested: 'zero-a10g' } },
					models: ['m/one'],
					cardData: { title: 'Demo', emoji: '🚀' },
				});
			}
			if (url.pathname === '/api/buckets/org/bk') return Response.json({ id: 'org/bk', size: 99, totalFiles: 3 });
			return undefined;
		});
		const result = await call(
			'hf_repo_info',
			{ repos: ['org/model', 'org/space-only', 'hf://buckets/org/bk', 'nobody/missing'] },
			{ fetch }
		);
		const items = result.structured.items as Record<string, unknown>[];
		expect(items[0]).toMatchObject({
			kind: 'model',
			id: 'org/model',
			uri: 'hf://models/org/model',
			license: 'apache-2.0',
			gated: 'manual',
			usedStorage: 1234,
			numChildModels: 7,
			safetensors: { total: 1000, parameters: { BF16: 1000 } },
			gguf: { architecture: 'llama', contextLength: 4096, eosToken: '<|eot|>' },
			config: { model_type: 'llama', architectures: ['LlamaForCausalLM'] },
			inferenceProviders: [{ provider: 'together', status: 'live', providerId: 'x/y' }],
		});
		// Default excludes the chat template and the Space list.
		for (const key of ['chatTemplate', 'chatTemplateTruncated', 'spaces', 'numSpaces'])
			expect(items[0]).not.toHaveProperty(key);
		// One metadata request per candidate; never a tokenizer_config.json / GGUF file fetch.
		const paths = requested(fetch).map((u) => u.pathname);
		expect(paths.every((p) => p.startsWith('/api/'))).toBe(true);
		expect(paths.filter((p) => p === '/api/models/org/model')).toHaveLength(1);
		expect(items[0]?.baseModels).toEqual([
			{ kind: 'model', id: 'base/model', uri: 'hf://models/base/model', url: 'https://huggingface.co/base/model' },
		]);
		expect(items[1]).toMatchObject({
			kind: 'space',
			sdk: 'gradio',
			title: 'Demo',
			runtime: { stage: 'RUNNING', hardware: { current: 'zero-a10g', requested: 'zero-a10g' } },
			models: [{ kind: 'model', id: 'm/one' }],
		});
		expect(items[2]).toMatchObject({ kind: 'bucket', uri: 'hf://buckets/org/bk', size: 99, numFiles: 3 });
		expect(items[3]).toMatchObject({ ref: 'nobody/missing', error: { code: 'not_found' } });
		expect(result.structured.errorCount).toBe(1);
	});

	it('returns chat_template and spaces only when requested in fields', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/org/model'
				? Response.json({
						id: 'org/model',
						likes: 1,
						gguf: { architecture: 'llama', chat_template: '{{x}}', bos_token: '<s>', eos_token: '</s>' },
						config: { tokenizer_config: { chat_template: 'ignored: gguf wins' } },
						spaces: ['a/s1', 'a/s2'],
					})
				: undefined
		);
		const result = await call(
			'hf_repo_info',
			{ repos: ['org/model'], fields: ['chatTemplate', 'gguf', 'spaces', 'numSpaces'] },
			{ fetch }
		);
		expect(result.structured.items).toEqual([
			{
				kind: 'model',
				id: 'org/model',
				uri: 'hf://models/org/model',
				url: 'https://huggingface.co/org/model',
				chatTemplate: '{{x}}',
				gguf: { architecture: 'llama', bosToken: '<s>', eosToken: '</s>' },
				spaces: [
					{ kind: 'space', id: 'a/s1', uri: 'hf://spaces/a/s1', url: 'https://huggingface.co/spaces/a/s1' },
					{ kind: 'space', id: 'a/s2', uri: 'hf://spaces/a/s2', url: 'https://huggingface.co/spaces/a/s2' },
				],
				numSpaces: 2,
			},
		]);
		const expand = requested(fetch)[0]?.searchParams.getAll('expand');
		expect(expand).toEqual(['config', 'gguf', 'spaces']);
	});

	it('honours fields and revision', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/datasets/o/d/revision/v1'
				? Response.json({ id: 'o/d', likes: 4, downloads: 9 })
				: undefined
		);
		const result = await call(
			'hf_repo_info',
			{ repos: ['hf://datasets/o/d'], revision: 'v1', fields: ['likes'] },
			{ fetch }
		);
		expect(result.structured.items).toEqual([
			// A7: the record identity keeps the requested revision.
			{
				kind: 'dataset',
				id: 'o/d',
				uri: 'hf://datasets/o/d@v1',
				url: 'https://huggingface.co/datasets/o/d/tree/v1',
				likes: 4,
			},
		]);
	});

	it('keeps a ref @revision in uri/url and exposes config.vocab_size (A7)', async () => {
		const sha = '11c5a3d5811f50298f278a704980280950aedb10';
		const fetch = mockFetch((url) =>
			url.pathname === `/api/models/openai-community/gpt2/revision/${sha}`
				? Response.json({ id: 'openai-community/gpt2', sha, config: { model_type: 'gpt2', vocab_size: 50257 } })
				: undefined
		);
		const result = await call('hf_repo_info', { repos: [`hf://models/openai-community/gpt2@${sha}`] }, { fetch });
		expect(result.structured.items).toEqual([
			expect.objectContaining({
				uri: `hf://models/openai-community/gpt2@${sha}`,
				url: `https://huggingface.co/openai-community/gpt2/tree/${sha}`,
				revision: sha,
				config: { model_type: 'gpt2', vocab_size: 50257 },
			}),
		]);
	});
});

describe('hf_repo_list_files', () => {
	const tree = Array.from({ length: 5 }, (_, i) => ({
		type: 'file',
		path: `dir/f${String(i)}.${i % 2 ? 'gguf' : 'txt'}`,
		size: i,
		oid: `o${String(i)}`,
		...(i % 2 ? { lfs: { size: i, oid: 'x' }, xetHash: 'h' } : {}),
	}));

	it('filters by glob at any depth and continues with an opaque cursor', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/o/m/tree/main') {
				expect(url.searchParams.get('recursive')).toBe('true');
				return Response.json([{ type: 'directory', path: 'dir', size: 0, oid: 'd' }, ...tree]);
			}
			return undefined;
		});
		const first = await call(
			'hf_repo_list_files',
			{ repo: 'o/m', recursive: true, glob: '*.gguf', limit: 1 },
			{ fetch }
		);
		const items = first.structured.items as Record<string, unknown>[];
		expect(items).toEqual([
			{
				kind: 'file',
				id: 'dir/f1.gguf',
				uri: 'hf://models/o/m/dir/f1.gguf',
				url: 'https://huggingface.co/o/m/blob/main/dir/f1.gguf',
				path: 'dir/f1.gguf',
				size: 1,
				lfs: true,
				xet: true,
				oid: 'o1',
			},
		]);
		expect(first.structured.nextCursor).toEqual(expect.any(String));
		const second = await call(
			'hf_repo_list_files',
			{ repo: 'o/m', recursive: true, glob: '*.gguf', limit: 1, cursor: first.structured.nextCursor },
			{ fetch }
		);
		expect((second.structured.items as { path: string }[]).map((i) => i.path)).toEqual(['dir/f3.gguf']);
		const third = await call(
			'hf_repo_list_files',
			{ repo: 'o/m', recursive: true, glob: '*.gguf', limit: 1, cursor: second.structured.nextCursor },
			{ fetch }
		);
		expect(third.structured.items).toEqual([]);
		expect(third.structured.nextCursor).toBeNull();
		await expect(
			call(
				'hf_repo_list_files',
				{ repo: 'o/m', glob: '*.txt', limit: 1, cursor: first.structured.nextCursor },
				{ fetch }
			)
		).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
	});

	it('matches slash globs relative to path and basename globs at any depth, scanning recursively (R1)', async () => {
		const onnxTree = [
			{ type: 'file', path: 'config.json', size: 1, oid: 'c' },
			{ type: 'directory', path: 'onnx', size: 0, oid: 'd' },
			{ type: 'file', path: 'onnx/model.onnx', size: 2, oid: 'm', lfs: { size: 2, oid: 'l' } },
			{ type: 'directory', path: 'onnx/sub', size: 0, oid: 'e' },
			{ type: 'file', path: 'onnx/sub/deep.onnx', size: 3, oid: 'n' },
		];
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/o/m/tree/main') {
				// A glob always needs every depth: never a root-only listing.
				expect(url.searchParams.get('recursive')).toBe('true');
				return Response.json(onnxTree);
			}
			if (url.pathname === '/api/models/o/m/tree/main/onnx') {
				expect(url.searchParams.get('recursive')).toBe('true');
				return Response.json(onnxTree.filter((e) => e.path.startsWith('onnx/')));
			}
			return undefined;
		});
		const paths = async (input: Record<string, unknown>) => {
			const r = await call('hf_repo_list_files', { repo: 'o/m', ...input }, { fetch });
			expect(r.structured.completeness).toMatchObject({ hasMore: false });
			return (r.structured.items as { path: string }[]).map((i) => i.path);
		};
		const all = ['onnx/model.onnx', 'onnx/sub/deep.onnx'];
		expect(await paths({ glob: '*.onnx' })).toEqual(all);
		expect(await paths({ glob: 'onnx/**/*.onnx' })).toEqual(all);
		expect(await paths({ glob: 'onnx/*.onnx' })).toEqual(['onnx/model.onnx']);
		expect(await paths({ glob: 'onnx/*.onnx', recursive: true })).toEqual(['onnx/model.onnx']);
		expect(await paths({ glob: '**/*.onnx' })).toEqual(all);
		expect(await paths({ glob: 'sub/*.onnx', path: 'onnx' })).toEqual(['onnx/sub/deep.onnx']);
		expect(await paths({ glob: 'onnx/*.onnx', path: 'onnx' })).toEqual([]);
	});

	it('does not claim the end of the listing when the glob scan hits the page cap (R1)', async () => {
		let calls = 0;
		const fetch = mockFetch((url) => {
			if (url.pathname !== '/api/models/o/m/tree/main') return undefined;
			calls++;
			const next = new URL(url);
			next.searchParams.set('cursor', `c${String(calls)}`);
			return Response.json([{ type: 'file', path: `f${String(calls)}.txt`, size: 1, oid: 'x' }], {
				headers: { link: `<${next.toString()}>; rel="next"` },
			});
		});
		const r = await call('hf_repo_list_files', { repo: 'o/m', glob: '*.onnx' }, { fetch });
		expect(r.structured.items).toEqual([]);
		expect(r.structured.completeness).toMatchObject({ hasMore: true });
		expect(r.structured.nextCursor).toEqual(expect.any(String));
	});

	it('pages nested subfolders when the Hub percent-encodes slashes in the Link header', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname !== '/api/datasets/o/d/tree/main/sessions/2026-11-25') return undefined;
			if (!url.searchParams.get('cursor')) {
				return Response.json([{ type: 'file', path: 'sessions/2026-11-25/logs-1.jsonl', size: 10, oid: 'o1' }], {
					headers: {
						link: '<https://huggingface.co/api/datasets/o/d/tree/main/sessions%2F2026-11-25?expand=false&recursive=false&limit=1&cursor=c2>; rel="next"',
					},
				});
			}
			return Response.json([{ type: 'file', path: 'sessions/2026-11-25/logs-2.jsonl', size: 20, oid: 'o2' }]);
		});
		const p1 = await call(
			'hf_repo_list_files',
			{ repo: 'hf://datasets/o/d', path: 'sessions/2026-11-25', limit: 1 },
			{ fetch }
		);
		expect((p1.structured.items as { path: string }[]).map((i) => i.path)).toEqual([
			'sessions/2026-11-25/logs-1.jsonl',
		]);
		expect(p1.structured.nextCursor).toEqual(expect.any(String));
		const p2 = await call(
			'hf_repo_list_files',
			{ repo: 'hf://datasets/o/d', path: 'sessions/2026-11-25', limit: 1, cursor: p1.structured.nextCursor },
			{ fetch }
		);
		expect((p2.structured.items as { path: string }[]).map((i) => i.path)).toEqual([
			'sessions/2026-11-25/logs-2.jsonl',
		]);
		expect(p2.structured.nextCursor).toBeNull();
	});

	it('omits lfs for path-index matches (the index has no LFS info) (R2)', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/o/m/paths-search/main'
				? Response.json({ entries: [{ path: 'onnx/model.onnx', type: 'file' }], totalMatches: 1 })
				: undefined
		);
		const r = await call('hf_repo_list_files', { repo: 'o/m', pathContains: 'onnx' }, { fetch });
		const items = r.structured.items as Record<string, unknown>[];
		expect(items).toHaveLength(1);
		expect(items[0]).not.toHaveProperty('lfs');
	});

	it('fills path-index file sizes from paths-info (folders keep no size)', async () => {
		const fetch = mockFetch((url, init) => {
			if (url.pathname === '/api/models/o/m/paths-search/main')
				return Response.json({
					entries: [
						{ path: 'Q4_K_M', type: 'directory' },
						{ path: 'Q4_K_M/m-00001-of-00002.gguf', type: 'file' },
						{ path: 'Q4_K_M/m-00002-of-00002.gguf', type: 'file' },
					],
					totalMatches: 3,
				});
			if (url.pathname === '/api/models/o/m/paths-info/main') {
				const body = JSON.parse(init.body as string) as { paths: string[] };
				expect(body.paths).toEqual(['Q4_K_M/m-00001-of-00002.gguf', 'Q4_K_M/m-00002-of-00002.gguf']);
				return Response.json(body.paths.map((path, i) => ({ type: 'file', path, size: 100 + i, oid: 'x' })));
			}
			return undefined;
		});
		const r = await call('hf_repo_list_files', { repo: 'o/m', pathContains: 'Q4_K_M' }, { fetch });
		expect((r.structured.items as { path: string; size?: number }[]).map((i) => [i.path, i.size])).toEqual([
			['Q4_K_M', undefined],
			['Q4_K_M/m-00001-of-00002.gguf', 100],
			['Q4_K_M/m-00002-of-00002.gguf', 101],
		]);
	});

	it('keeps path-index matches without sizes when paths-info fails', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/o/m/paths-search/main'
				? Response.json({ entries: [{ path: 'a.gguf', type: 'file' }], totalMatches: 1 })
				: new Response('', { status: 500 })
		);
		const r = await call('hf_repo_list_files', { repo: 'o/m', pathContains: 'gguf' }, { fetch });
		expect(r.structured.items).toMatchObject([{ path: 'a.gguf' }]);
	});

	it('names the new id when a renamed repository is listed', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/datasets/OldOrg/data/tree/main'
				? new Response(null, {
						status: 307,
						headers: { location: '/api/datasets/NewOrg/data/tree/main?recursive=false&expand=false&limit=200' },
					})
				: undefined
		);
		await expect(call('hf_repo_list_files', { repo: 'hf://datasets/OldOrg/data' }, { fetch })).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: 'dataset OldOrg/data has moved to NewOrg/data; use hf://datasets/NewOrg/data.',
		});
	});

	it('uses the path index for pathContains and falls back to the tree on 503', async () => {
		const indexed = mockFetch((url) =>
			url.pathname === '/api/models/o/m/paths-search/main'
				? Response.json({ entries: [{ path: 'onnx/model.onnx', type: 'file' }], totalMatches: 1 })
				: undefined
		);
		const a = await call('hf_repo_list_files', { repo: 'o/m', pathContains: 'ONNX' }, { fetch: indexed });
		expect(a.structured.completeness).toMatchObject({ hasMore: false, total: 1 });
		expect(a.structured.nextCursor).toBeNull();

		const fallback = mockFetch((url) => {
			if (url.pathname.endsWith('/paths-search/main')) return new Response('', { status: 503 });
			if (url.pathname === '/api/models/o/m/tree/main') return Response.json(tree);
			return undefined;
		});
		const b = await call('hf_repo_list_files', { repo: 'o/m', pathContains: 'F2' }, { fetch: fallback });
		expect((b.structured.items as { path: string }[]).map((i) => i.path)).toEqual(['dir/f2.txt']);
		expect(b.structured.completeness).toMatchObject({ hasMore: false });
	});

	it('follows bucket tree Link pagination (echoes sort=path&direction=asc, no expand)', async () => {
		const rows = [
			{ type: 'directory', path: 'A', uploadedAt: '2026-06-05T13:02:17.572Z' },
			{ type: 'directory', path: 'B', uploadedAt: '2026-06-05T13:02:17.572Z' },
			{ type: 'directory', path: 'C', uploadedAt: '2026-06-05T13:02:17.572Z' },
		];
		const seen: string[] = [];
		const fetch = mockFetch((url) => {
			if (url.pathname !== '/api/buckets/Datack/Datack2/tree') return undefined;
			seen.push(url.search);
			// Mirrors the live upstream: expand is dropped and sort/direction are echoed (cursor first).
			const limit = Number(url.searchParams.get('limit'));
			const start = url.searchParams.has('cursor') ? 2 : 0;
			const page = rows.slice(start, start + limit);
			const headers =
				start + limit < rows.length
					? {
							link: `<https://huggingface.co/api/buckets/Datack/Datack2/tree?cursor=eyJwIjoiQiJ9%3D&limit=${String(limit)}&recursive=false&sort=path&direction=asc>; rel="next"`,
						}
					: undefined;
			return Response.json(page, { headers });
		});
		const ref = 'hf://buckets/Datack/Datack2';
		const first = await call('hf_repo_list_files', { repo: ref, limit: 2 }, { fetch });
		expect((first.structured.items as { path: string }[]).map((i) => i.path)).toEqual(['A', 'B']);
		expect(first.structured.nextCursor).toEqual(expect.any(String));
		expect(first.structured.completeness).toMatchObject({ hasMore: true });
		const second = await call(
			'hf_repo_list_files',
			{ repo: ref, limit: 2, cursor: first.structured.nextCursor },
			{ fetch }
		);
		expect(second.structured.items).toMatchObject([{ kind: 'dir', path: 'C', uri: 'hf://buckets/Datack/Datack2/C' }]);
		expect(second.structured.nextCursor).toBeNull();
		expect(seen).toEqual([
			'?recursive=false&limit=2&sort=path&direction=asc',
			'?recursive=false&limit=2&sort=path&direction=asc&cursor=eyJwIjoiQiJ9%3D',
		]);
	});

	it('lists buckets via the bucket tree and maps 404 to NOT_FOUND', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/buckets/o/b/tree/sub'
				? Response.json([{ type: 'file', path: 'sub/a.bin', size: 3, mtime: '2026-01-01', uploadedAt: '2026-01-02' }])
				: undefined
		);
		const r = await call('hf_repo_list_files', { repo: 'hf://buckets/o/b/sub' }, { fetch });
		expect(r.structured.items).toEqual([
			{
				kind: 'file',
				id: 'sub/a.bin',
				uri: 'hf://buckets/o/b/sub/a.bin',
				url: 'https://huggingface.co/buckets/o/b/resolve/sub/a.bin',
				path: 'sub/a.bin',
				size: 3,
				lastModified: '2026-01-01',
				uploadedAt: '2026-01-02',
			},
		]);
		await expect(call('hf_repo_list_files', { repo: 'hf://buckets/o/other' }, { fetch })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	it('passes through the status codes requestPage maps (A16)', async () => {
		const fetch = mockFetch((url) =>
			url.pathname.startsWith('/api/models/o/private/') ? new Response('', { status: 403 }) : undefined
		);
		await expect(call('hf_repo_list_files', { repo: 'o/private' }, { fetch })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		});
		await expect(call('hf_repo_list_files', { repo: 'o/missing' }, { fetch })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});

describe('hf_repo_paths_info', () => {
	it('reports missing paths and folder sizes', async () => {
		const fetch = mockFetch((url, init) => {
			if (url.pathname === '/api/models/o/m/paths-info/main') {
				expect(JSON.parse(init.body as string)).toEqual({ paths: ['config.json', 'onnx', 'nope.txt'], expand: false });
				return Response.json([
					{ type: 'file', path: 'config.json', size: 10, oid: 'a' },
					{ type: 'directory', path: 'onnx', size: 0, oid: 'b' },
				]);
			}
			if (url.pathname === '/api/models/o/m/treesize/main/onnx') return Response.json({ path: '/onnx', size: 5000 });
			return undefined;
		});
		const r = await call(
			'hf_repo_paths_info',
			{ repo: 'o/m', paths: ['config.json', '/onnx/', 'nope.txt'], includeFolderSize: true },
			{ fetch }
		);
		expect(r.structured.missing).toEqual(['nope.txt']);
		expect(r.structured.items).toMatchObject([
			{ kind: 'file', path: 'config.json', size: 10 },
			{ kind: 'dir', path: 'onnx', size: 5000, url: 'https://huggingface.co/o/m/tree/main/onnx' },
		]);
	});
	it('sizes the root folder without a trailing slash (R4: /treesize/main/ answers 302)', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname === '/api/models/o/m/tree/main') return Response.json([]);
			if (url.pathname === '/api/models/o/m/treesize/main') return Response.json({ path: '/', size: 9000 });
			if (url.pathname === '/api/models/o/m/treesize/main/') return new Response('', { status: 302 });
			return undefined;
		});
		const r = await call('hf_repo_paths_info', { repo: 'o/m', paths: [''], includeFolderSize: true }, { fetch });
		expect(r.structured.items).toMatchObject([{ kind: 'dir', path: '', size: 9000 }]);
	});
});

describe('hf_repo_paths_info root (A4)', () => {
	it('checks repository and revision visibility before reporting the root', async () => {
		const seen: string[] = [];
		const fetch = mockFetch((url) => {
			seen.push(`${url.pathname}?${url.searchParams.toString()}`);
			if (url.pathname === '/api/models/org/model/tree/main') return Response.json([]);
			if (url.pathname === '/api/buckets/org/bk/tree') return Response.json([]);
			if (url.pathname.startsWith('/api/models/ptc-review-nonexistent-987654321/'))
				return new Response('{}', { status: 401 });
			return undefined; // 404 (e.g. unknown revision)
		});
		const ok = await call('hf_repo_paths_info', { repo: 'hf://models/org/model', paths: [''] }, { fetch });
		expect(ok.structured).toMatchObject({ items: [{ kind: 'dir', path: '' }], missing: [] });
		expect(seen[0]).toBe('/api/models/org/model/tree/main?limit=1');
		const bucket = await call('hf_repo_paths_info', { repo: 'hf://buckets/org/bk', paths: ['/'] }, { fetch });
		expect(bucket.structured).toMatchObject({ items: [{ kind: 'dir', path: '' }] });

		await expect(
			call(
				'hf_repo_paths_info',
				{ repo: 'hf://models/ptc-review-nonexistent-987654321/missing', paths: [''] },
				{ fetch }
			)
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			call(
				'hf_repo_paths_info',
				{ repo: 'hf://models/ptc-review-nonexistent-987654321/missing', paths: [''] },
				{ fetch, hfToken: 'hf_x' }
			)
		).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
		await expect(
			call('hf_repo_paths_info', { repo: 'hf://models/org/model@nope', paths: [''] }, { fetch })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			call('hf_repo_paths_info', { repo: 'hf://buckets/org/gone', paths: [''] }, { fetch })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('does not need a separate check when paths-info already proved the repository exists', async () => {
		const seen: string[] = [];
		const fetch = mockFetch((url) => {
			seen.push(url.pathname);
			return url.pathname === '/api/models/org/model/paths-info/main'
				? Response.json([{ type: 'file', path: 'a.txt', size: 1, oid: 'x' }])
				: undefined;
		});
		const r = await call('hf_repo_paths_info', { repo: 'org/model', paths: ['', 'a.txt'] }, { fetch });
		expect(r.structured).toMatchObject({ items: [{ path: '' }, { path: 'a.txt' }], missing: [] });
		expect(seen).toEqual(['/api/models/org/model/paths-info/main']);
	});
});

describe('hf_repo_read_text', () => {
	const text = 'héllo world\n'.repeat(10);
	const bytes = new TextEncoder().encode(text);
	const fetch = mockFetch((url, init) => {
		if (url.pathname !== '/o/m/resolve/main/README.md') return undefined;
		const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('range') ?? '');
		const start = Number(range?.[1]);
		if (start >= bytes.length) {
			return new Response(null, { status: 416, headers: { 'content-range': `bytes */${String(bytes.length)}` } });
		}
		const end = Math.min(Number(range?.[2]), bytes.length - 1);
		return new Response(bytes.slice(start, end + 1), {
			status: 206,
			headers: { 'content-range': `bytes ${String(start)}-${String(end)}/${String(bytes.length)}` },
		});
	});

	it('reads windows on UTF-8 boundaries and continues with nextOffset', async () => {
		const first = await call('hf_repo_read_text', { uri: 'hf://models/o/m/README.md', maxBytes: 2 }, { fetch });
		// 'h' + 'é' (2 bytes) — the window is extended to the end of the character.
		expect(first.structured).toMatchObject({ content: 'hé', offset: 0, bytes: 3, truncated: true, nextOffset: 3 });
		let offset = 0;
		let content = '';
		for (let i = 0; i < 10; i++) {
			const r = await call('hf_repo_read_text', { uri: 'o/m/README.md', offset, maxBytes: 50 }, { fetch });
			content += r.structured.content as string;
			if (r.structured.nextOffset === null) break;
			offset = r.structured.nextOffset as number;
		}
		expect(content).toBe(text);
		const past = await call('hf_repo_read_text', { uri: 'o/m/README.md', offset: 10_000 }, { fetch });
		expect(past.structured).toMatchObject({ content: '', truncated: false, nextOffset: null });
	});

	it('rejects binary files without fetching', async () => {
		const spy = mockFetch(() => undefined);
		await expect(call('hf_repo_read_text', { uri: 'o/m/model.safetensors' }, { fetch: spy })).rejects.toMatchObject({
			code: 'UNSUPPORTED',
		});
		await expect(call('hf_repo_read_text', { uri: 'o/m/fig.png' }, { fetch: spy })).rejects.toThrow(
			/hf_repo_read_image/
		);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('hf_repo_read_image', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const fetch = mockFetch((url) =>
		url.pathname === '/datasets/o/d/resolve/main/img/a.png' ? new Response(png) : undefined
	);

	it('returns an image content block with metadata', async () => {
		const r = await call('hf_repo_read_image', { uri: 'hf://datasets/o/d/img/a.png' }, { fetch });
		expect(r.structured).toMatchObject({
			mimeType: 'image/png',
			bytes: png.length,
			uri: 'hf://datasets/o/d/img/a.png',
		});
		expect(r.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
	});

	it('rejects oversize images and non-images', async () => {
		await expect(
			call('hf_repo_read_image', { uri: 'hf://datasets/o/d/img/a.png', maxBytes: 4 }, { fetch })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(call('hf_repo_read_image', { uri: 'o/m/README.md' }, { fetch })).rejects.toMatchObject({
			code: 'UNSUPPORTED',
		});
	});
});

describe('hf_repo_history', () => {
	it('pages commits with a sealed cursor', async () => {
		const fetch = mockFetch((url) => {
			if (url.pathname !== '/api/spaces/o/s/commits/main') return undefined;
			const p = Number(url.searchParams.get('p'));
			return Response.json(
				[{ id: `sha${String(p)}`, title: `t${String(p)}`, authors: [{ user: 'alice' }], date: '2026-01-01' }],
				{ headers: { 'x-total-count': '2' } }
			);
		});
		const first = await call('hf_repo_history', { repo: 'hf://spaces/o/s', limit: 1 }, { fetch });
		expect(first.structured.items).toEqual([
			{
				kind: 'commit',
				id: 'sha0',
				uri: 'hf://spaces/o/s@sha0',
				url: 'https://huggingface.co/spaces/o/s/commit/sha0',
				title: 't0',
				authors: ['alice'],
				createdAt: '2026-01-01',
			},
		]);
		expect(first.structured.completeness).toMatchObject({ total: 2 });
		const second = await call(
			'hf_repo_history',
			{ repo: 'hf://spaces/o/s', limit: 1, cursor: first.structured.nextCursor },
			{ fetch }
		);
		expect((second.structured.items as { id: string }[])[0]?.id).toBe('sha1');
		expect(second.structured.nextCursor).toBeNull();
	});

	it('lists refs', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/o/m/refs'
				? Response.json({
						branches: [{ name: 'main', ref: 'refs/heads/main', targetCommit: 'abc' }],
						tags: [],
						converts: [{ name: 'parquet', ref: 'refs/convert/parquet', targetCommit: 'def' }],
						pullRequests: [{ name: '3', ref: 'refs/pr/3', targetCommit: 'ghi' }],
					})
				: undefined
		);
		const r = await call('hf_repo_history', { repo: 'o/m', mode: 'refs', includePrs: true }, { fetch });
		expect(r.structured.items).toMatchObject([
			{ kind: 'branch', id: 'main', uri: 'hf://models/o/m@main' },
			{ kind: 'convert', id: 'parquet', uri: 'hf://models/o/m@refs%2Fconvert%2Fparquet' },
			{ kind: 'pull_request', id: '3', ref: 'refs/pr/3' },
		]);
		expect(fetch.mock.calls[0]?.[0]).toContain('include_prs=1');
	});

	it('encodes commit URLs segment by segment', async () => {
		const fetch = mockFetch((url) =>
			url.pathname === '/api/models/o/m/commits/main'
				? Response.json([{ id: 'abc#?/x', title: 't' }], { headers: { 'x-total-count': '1' } })
				: undefined
		);
		const r = await call('hf_repo_history', { repo: 'o/m' }, { fetch });
		expect((r.structured.items as { url: string }[])[0]?.url).toBe('https://huggingface.co/o/m/commit/abc%23%3F%2Fx');
	});

	it('directs hf://docs and huggingface.co/docs URIs to hf_docs_read', async () => {
		await expect(call('hf_repo_read_text', { uri: 'hf://docs/hub/api.md' }, {})).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('hf_docs_read') as unknown,
		});
		await expect(
			call('hf_repo_read_text', { uri: 'https://huggingface.co/.well-known/openapi.md' }, {})
		).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('hf_docs_read') as unknown,
		});
	});
});
