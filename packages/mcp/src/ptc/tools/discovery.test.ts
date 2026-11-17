import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { DISCOVERY_TOOLS } from './discovery.js';

function tool(name: string) {
	const found = DISCOVERY_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(name);
	return found;
}

/** ctx with a fetch mock answering by pathname; records requested URLs. */
function mockCtx(routes: Record<string, unknown>, extra: Record<string, Record<string, string>> = {}) {
	const urls: URL[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>((input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		urls.push(url);
		if (!(url.pathname in routes)) return Promise.resolve(new Response('missing', { status: 404 }));
		return Promise.resolve(
			new Response(JSON.stringify(routes[url.pathname]), {
				status: 200,
				headers: { 'content-type': 'application/json', ...extra[url.pathname] },
			})
		);
	});
	const ctx: PtcContext = { fetch };
	return { ctx, urls };
}

describe('discovery tools', () => {
	it('exports the six tools with descriptions in budget', () => {
		expect(DISCOVERY_TOOLS.map((t) => t.name)).toEqual([
			'hf_trending',
			'hf_repo_fulltext_search',
			'hf_hub_lookup',
			'hf_filter_values',
			'hf_hardware_flavors',
			'hf_buckets_list',
		]);
		for (const t of DISCOVERY_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
			expect(t.access).toBe('anonymous');
			expect(t.annotations.readOnlyHint).toBe(true);
		}
	});

	it('hf_trending maps the curated feed to repo records', async () => {
		const { ctx, urls } = mockCtx({
			'/api/trending': {
				recentlyTrending: [
					{ repoType: 'model', repoData: { id: 'org/m', likes: 5, pipeline_tag: 'text-generation', gated: false } },
					{ repoType: 'space', repoData: { id: 'org/s', title: 'Demo', sdk: 'gradio' } },
					{ repoType: 'kernel', repoData: { id: 'org/k' } },
				],
			},
		});
		const { structured } = await callPtcTool(tool('hf_trending'), { kind: 'all', limit: 5 }, ctx);
		expect(urls[0]?.search).toBe('?type=all&limit=5');
		expect(structured).toMatchObject({
			returnedCount: 2,
			nextCursor: null,
			completeness: { hasMore: false },
			items: [
				{ kind: 'model', id: 'org/m', uri: 'hf://models/org/m', url: 'https://huggingface.co/org/m', likes: 5 },
				{ kind: 'space', id: 'org/s', uri: 'hf://spaces/org/s', title: 'Demo', sdk: 'gradio' },
			],
		});
	});

	it('hf_trending rejects limit above 20', async () => {
		await expect(callPtcTool(tool('hf_trending'), { limit: 21 }, mockCtx({}).ctx)).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('hf_repo_fulltext_search compiles filters and pages with an opaque skip cursor', async () => {
		const hit = (name: string) => ({
			name,
			type: 'model',
			fileName: 'README.md',
			likes: 1,
			tags: 'asr, en',
			updatedAt: 1788746681958,
			formatted: {
				fileContent: [
					{ text: 'intro text ', type: 'text' },
					{ text: 'LibriSpeech', type: 'highlight' },
					{ text: ' WER 3.1', type: 'text' },
				],
			},
		});
		const { ctx, urls } = mockCtx({
			'/api/search/full-text': { hits: [hit('a/one'), hit('b/two')], estimatedTotalHits: 10 },
		});
		const args = {
			query: 'LibriSpeech WER',
			kindsAny: ['model'],
			authorsAny: ['openai'],
			idsAny: ['facebook/w2v'],
			limit: 2,
		};
		const first = await callPtcTool(tool('hf_repo_fulltext_search'), args, ctx);
		expect(urls[0]?.searchParams.get('filter')).toBe('openai,facebook/w2v');
		expect(urls[0]?.searchParams.getAll('type')).toEqual(['model']);
		expect(urls[0]?.searchParams.has('skip')).toBe(false);
		expect(first.structured).toMatchObject({
			returnedCount: 2,
			completeness: { publicOnly: true, estimatedTotal: 10 },
			items: [
				{
					kind: 'model',
					id: 'a/one',
					uri: 'hf://models/a/one',
					fileUri: 'hf://models/a/one/README.md',
					excerpt: 'intro text LibriSpeech WER 3.1',
					tags: ['asr', 'en'],
				},
				{ id: 'b/two' },
			],
		});
		const cursor = first.structured.nextCursor as string;
		expect(cursor).toMatch(/^[\w-]+$/);
		await callPtcTool(tool('hf_repo_fulltext_search'), { ...args, cursor }, ctx);
		expect(urls[1]?.searchParams.get('skip')).toBe('2');
		await expect(
			callPtcTool(tool('hf_repo_fulltext_search'), { ...args, query: 'other', cursor }, ctx)
		).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
	});

	it('hf_repo_fulltext_search keeps the kind of an idsAny uri (R3)', async () => {
		const hits = [
			{ name: 'openai/whisper-tiny', type: 'model' },
			{ name: 'openai/whisper-tiny', type: 'dataset' },
			{ name: 'a/b', type: 'model' },
		];
		const { ctx, urls } = mockCtx({ '/api/search/full-text': { hits } });
		const search = async (args: Record<string, unknown>) => {
			const r = await callPtcTool(tool('hf_repo_fulltext_search'), { query: 'whisper', ...args }, ctx);
			return (r.structured.items as { kind: string; id: string }[]).map((i) => `${i.kind}:${i.id}`);
		};
		// Kinded uri: upstream type filter derived, and same-id hits of other kinds dropped.
		expect(await search({ idsAny: ['hf://datasets/openai/whisper-tiny'] })).toEqual([
			'dataset:openai/whisper-tiny',
			'model:a/b',
		]);
		expect(urls.at(-1)?.searchParams.get('filter')).toBe('openai/whisper-tiny');
		expect(urls.at(-1)?.searchParams.getAll('type')).toEqual(['dataset']);
		// Bare owner/name stays kind-less.
		expect(await search({ idsAny: ['openai/whisper-tiny'] })).toHaveLength(3);
		expect(urls.at(-1)?.searchParams.getAll('type')).toEqual([]);
		// A URL keeps its kind; an owner selector still admits that owner's repositories of any kind.
		expect(
			await search({ idsAny: ['https://huggingface.co/datasets/openai/whisper-tiny'], kindsAny: ['model'] })
		).toEqual(['dataset:openai/whisper-tiny', 'model:a/b']);
		expect(await search({ idsAny: ['hf://datasets/openai/whisper-tiny'], authorsAny: ['openai'] })).toHaveLength(3);
		expect(urls.at(-1)?.searchParams.get('filter')).toBe('openai,openai/whisper-tiny');
		expect(urls.at(-1)?.searchParams.getAll('type')).toEqual([]);
	});

	it('hf_repo_fulltext_search caps the combined owner/repo filter at 10 values', async () => {
		const owners = Array.from({ length: 6 }, (_, i) => `o${String(i)}`);
		const repo_ids = Array.from({ length: 5 }, (_, i) => `o/r${String(i)}`);
		await expect(
			callPtcTool(
				tool('hf_repo_fulltext_search'),
				{ query: 'x', authorsAny: owners, idsAny: repo_ids },
				mockCtx({}).ctx
			)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	});

	it('hf_hub_lookup maps every result type to items', async () => {
		const { ctx, urls } = mockCtx({
			'/api/quicksearch': {
				models: [{ id: 'Qwen/Qwen3-8B', private: false }],
				modelsCount: 3,
				users: [{ user: 'alice', fullname: 'Alice' }],
				orgs: [{ name: 'Qwen', fullname: 'Qwen' }],
				papers: [{ _id: '2501.08313', id: 'MiniMax-01:\n Scaling' }],
				collections: [{ _id: 'MiniMaxAI/minimax-m1-6850', title: 'MiniMax-M1' }],
				buckets: [{ id: 'org/bucket' }],
			},
		});
		const { structured } = await callPtcTool(
			tool('hf_hub_lookup'),
			{ query: 'qwen', kindsAny: ['model', 'user', 'org', 'paper', 'collection', 'bucket'], limit: 3 },
			ctx
		);
		expect(urls[0]?.searchParams.getAll('type')).toEqual(['model', 'user', 'org', 'paper', 'collection', 'bucket']);
		expect(structured).toEqual({
			items: [
				{
					kind: 'model',
					id: 'Qwen/Qwen3-8B',
					uri: 'hf://models/Qwen/Qwen3-8B',
					url: 'https://huggingface.co/Qwen/Qwen3-8B',
					private: false,
				},
				{
					kind: 'user',
					id: 'alice',
					uri: 'https://huggingface.co/alice',
					url: 'https://huggingface.co/alice',
					title: 'Alice',
				},
				{
					kind: 'org',
					id: 'Qwen',
					uri: 'https://huggingface.co/Qwen',
					url: 'https://huggingface.co/Qwen',
					title: 'Qwen',
				},
				{
					kind: 'paper',
					id: '2501.08313',
					uri: 'hf://papers/2501.08313',
					url: 'https://huggingface.co/papers/2501.08313',
					title: 'MiniMax-01: Scaling',
				},
				{
					kind: 'collection',
					id: 'MiniMaxAI/minimax-m1-6850',
					uri: 'hf://collections/MiniMaxAI/minimax-m1-6850',
					url: 'https://huggingface.co/collections/MiniMaxAI/minimax-m1-6850',
					title: 'MiniMax-M1',
				},
				{
					kind: 'bucket',
					id: 'org/bucket',
					uri: 'hf://buckets/org/bucket',
					url: 'https://huggingface.co/buckets/org/bucket',
				},
			],
			returnedCount: 6,
			numByKind: { model: 3 },
		});
	});

	it('hf_filter_values passes the group upstream and bounds values', async () => {
		const { ctx, urls } = mockCtx({
			'/api/models-tags-by-type': {
				license: [
					{ id: 'license:mit', label: 'mit', type: 'license' },
					{ id: 'license:apache-2.0', label: 'apache-2.0', type: 'license' },
					{ id: 'license:other', label: 'other', type: 'license' },
				],
			},
		});
		const { structured } = await callPtcTool(
			tool('hf_filter_values'),
			{ catalog: 'model_tags', group: 'license', query: 'A', limit: 1 },
			ctx
		);
		expect(urls[0]?.searchParams.get('type')).toBe('license');
		expect(structured).toEqual({
			catalog: 'model_tags',
			groups: [
				{
					group: 'license',
					values: [{ id: 'license:apache-2.0', label: 'apache-2.0' }],
					returnedCount: 1,
					numValues: 3,
					truncated: false,
				},
			],
		});
	});

	it('hf_filter_values lists tasks with libraries', async () => {
		const { ctx } = mockCtx({
			'/api/tasks': {
				'text-to-speech': { id: 'text-to-speech', label: 'Text-to-Speech', libraries: ['transformers'], demo: {} },
			},
		});
		const { structured } = await callPtcTool(tool('hf_filter_values'), { catalog: 'tasks' }, ctx);
		expect(structured.groups).toEqual([
			{
				group: 'tasks',
				values: [{ id: 'text-to-speech', label: 'Text-to-Speech', libraries: ['transformers'] }],
				returnedCount: 1,
				numValues: 1,
				truncated: false,
			},
		]);
		await expect(callPtcTool(tool('hf_filter_values'), { catalog: 'tasks', group: 'x' }, ctx)).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('hf_hardware_flavors normalizes both catalogs', async () => {
		const { ctx, urls } = mockCtx({
			'/api/jobs/hardware': [
				{
					name: 'a10g-small',
					prettyName: 'Nvidia A10G - small',
					cpu: '4 vCPU',
					ram: '15 GB',
					ephemeralStorage: '50 GB',
					accelerator: { type: 'gpu', model: 'A10G', quantity: '1', vram: '24 GB', manufacturer: 'Nvidia' },
					unitCostMicroUSD: 16667,
					unitCostUSD: 0.016667,
					unitLabel: 'minute',
				},
				{ name: 'cpu-basic', accelerator: null },
			],
		});
		const { structured } = await callPtcTool(tool('hf_hardware_flavors'), {}, ctx);
		expect(urls[0]?.pathname).toBe('/api/jobs/hardware');
		expect(structured).toEqual({
			scope: 'jobs',
			returnedCount: 2,
			items: [
				{
					id: 'a10g-small',
					prettyName: 'Nvidia A10G - small',
					cpu: '4 vCPU',
					ram: '15 GB',
					ephemeralStorage: '50 GB',
					accelerator: { type: 'gpu', model: 'A10G', manufacturer: 'Nvidia', quantity: '1', vram: '24 GB' },
					unitCostUsd: 0.016667,
					unitLabel: 'minute',
				},
				{ id: 'cpu-basic', accelerator: null },
			],
		});
	});

	it('hf_buckets_list escapes the search and truncates locally', async () => {
		const { ctx, urls } = mockCtx({
			'/api/buckets/acme': [
				{ id: 'acme/a.b', private: false, size: 8, totalFiles: 1, createdAt: '2026-01-01T00:00:00Z' },
				{ id: 'acme/c.d', private: true },
			],
		});
		const { structured } = await callPtcTool(tool('hf_buckets_list'), { owner: 'acme', query: 'a.b', limit: 1 }, ctx);
		expect(urls[0]?.searchParams.get('search')).toBe('a\\.b');
		expect(structured).toMatchObject({
			returnedCount: 1,
			nextCursor: null,
			items: [{ kind: 'bucket', id: 'acme/a.b', uri: 'hf://buckets/acme/a.b', size: 8, numFiles: 1 }],
			completeness: { hasMore: true, reason: 'items_cap' },
		});
		expect((structured.completeness as { hint?: string }).hint).toContain('narrow with query');
	});

	it('maps upstream failures to sanitized errors', async () => {
		await expect(callPtcTool(tool('hf_buckets_list'), { owner: 'nobody' }, mockCtx({}).ctx)).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});
