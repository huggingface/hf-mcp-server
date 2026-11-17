import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { COLLECTIONS_TOOLS } from './collections.js';

function tool(name: string) {
	const found = COLLECTIONS_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(name);
	return found;
}

interface Route {
	body: unknown;
	headers?: Record<string, string>;
}
function mockCtx(routes: Record<string, Route | ((url: URL) => Route)>) {
	const urls: URL[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>((input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		urls.push(url);
		const entry = routes[url.pathname];
		if (!entry) return Promise.resolve(new Response('missing', { status: 404 }));
		const route = typeof entry === 'function' ? entry(url) : entry;
		return Promise.resolve(new Response(JSON.stringify(route.body), { status: 200, headers: route.headers }));
	});
	const ctx: PtcContext = { fetch };
	return { ctx, urls };
}

const items = [
	{ type: 'paper', id: '2506.13585', title: 'MiniMax-M1', position: 1, upvotes: 279 },
	{ type: 'space', id: 'MiniMaxAI/MiniMax-M1', title: 'MiniMax M1', position: 0, likes: 354 },
	{ type: 'model', id: 'MiniMaxAI/MiniMax-M1-80k', position: 2, note: { text: 'Main checkpoint\n', html: '' } },
	{ type: 'collection', slug: 'MiniMaxAI/other-123', title: 'Other', position: 3 },
	{ type: 'kernel', id: 'x/y', position: 4 },
];
const collection = {
	slug: 'MiniMaxAI/minimax-m1-6850',
	title: 'MiniMax-M1',
	description: 'Hybrid attention',
	owner: { name: 'MiniMaxAI' },
	upvotes: 119,
	private: false,
	gating: false,
	lastUpdated: '2026-04-15T14:19:49.790Z',
	items,
};

describe('collections tools', () => {
	it('exports two read-only tools', () => {
		expect(COLLECTIONS_TOOLS.map((t) => t.name)).toEqual(['hf_collections_search', 'hf_collection_get']);
		for (const t of COLLECTIONS_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});

	it('hf_collections_search builds the query, previews items and seals the Link cursor', async () => {
		const { ctx, urls } = mockCtx({
			'/api/collections': (url): Route => ({
				body: [collection],
				headers: url.searchParams.has('cursor')
					? {}
					: {
							link: `<https://huggingface.co/api/collections?${url.searchParams.toString()}&cursor=abc>; rel="next"`,
						},
			}),
		});
		const args = { query: 'minimax', owners: ['MiniMaxAI', 'Qwen'], contains: 'hf://papers/2506.13585', limit: 1 };
		const first = await callPtcTool(tool('hf_collections_search'), args, ctx);
		expect(urls[0]?.searchParams.getAll('owner')).toEqual(['MiniMaxAI', 'Qwen']);
		expect(urls[0]?.searchParams.get('item')).toBe('papers/2506.13585');
		expect(urls[0]?.searchParams.get('sort')).toBe('trending');
		expect(first.structured).toMatchObject({
			returnedCount: 1,
			completeness: { hasMore: true },
			items: [
				{
					kind: 'collection',
					id: 'MiniMaxAI/minimax-m1-6850',
					uri: 'hf://collections/MiniMaxAI/minimax-m1-6850',
					url: 'https://huggingface.co/collections/MiniMaxAI/minimax-m1-6850',
					owner: 'MiniMaxAI',
					gated: false,
					items_preview: [{ kind: 'space' }, { kind: 'paper' }, { kind: 'model' }, { kind: 'collection' }],
				},
			],
		});
		const cursor = first.structured.nextCursor as string;
		expect(cursor).toMatch(/^[\w-]+$/);
		const second = await callPtcTool(tool('hf_collections_search'), { ...args, cursor }, ctx);
		expect(urls[1]?.searchParams.get('cursor')).toBe('abc');
		expect(second.structured.nextCursor).toBeNull();
	});

	it('hf_collections_search maps repo refs to the item filter', async () => {
		const { ctx, urls } = mockCtx({ '/api/collections': { body: [] } });
		await callPtcTool(tool('hf_collections_search'), { contains: 'hf://datasets/org/data' }, ctx);
		await callPtcTool(tool('hf_collections_search'), { contains: 'org/model' }, ctx);
		expect(urls.map((u) => u.searchParams.get('item'))).toEqual(['datasets/org/data', 'models/org/model']);
		await expect(
			callPtcTool(tool('hf_collections_search'), { contains: 'hf://buckets/org/b' }, ctx)
		).rejects.toMatchObject({ code: 'UNSUPPORTED' });
	});

	it('hf_collections_search anchors paper refs in contains', async () => {
		const { ctx, urls } = mockCtx({ '/api/collections': { body: [] } });
		for (const contains of ['2106.09685v2', 'arxiv:2106.09685', 'https://arxiv.org/pdf/2106.09685']) {
			await callPtcTool(tool('hf_collections_search'), { contains }, ctx);
		}
		expect(urls.map((u) => u.searchParams.get('item'))).toEqual(Array(3).fill('papers/2106.09685'));
		for (const contains of ['https://huggingface.co/papers/2106.09685oops', 'https://evil.example/2106.09685oops']) {
			await expect(callPtcTool(tool('hf_collections_search'), { contains }, ctx)).rejects.toMatchObject({
				code: 'INVALID_ARGUMENT',
			});
		}
		expect(urls).toHaveLength(3);
	});

	it('hf_collections_search lowercases q so the Hub Link (which echoes q lowercased) continues', async () => {
		const { ctx, urls } = mockCtx({
			'/api/collections': (url): Route => {
				const echoed = new URLSearchParams(url.searchParams);
				echoed.set('q', (echoed.get('q') ?? '').toLowerCase());
				echoed.set('cursor', 'abc');
				return {
					body: [collection],
					headers: url.searchParams.has('cursor')
						? {}
						: { link: `<https://huggingface.co/api/collections?${echoed.toString()}>; rel="next"` },
				};
			},
		});
		const first = await callPtcTool(tool('hf_collections_search'), { query: 'LoRA', limit: 1 }, ctx);
		expect(urls[0]?.searchParams.get('q')).toBe('lora');
		const cursor = first.structured.nextCursor as string;
		expect(cursor).toMatch(/^[\w-]+$/);
		await callPtcTool(tool('hf_collections_search'), { query: 'LoRA', limit: 1, cursor }, ctx);
		expect(urls[1]?.searchParams.get('cursor')).toBe('abc');
	});

	it('hf_collection_get returns ordered typed items with notes and optional history', async () => {
		const { ctx, urls } = mockCtx({
			'/api/collections/MiniMaxAI/minimax-m1-6850': { body: collection },
			'/api/collections/MiniMaxAI/minimax-m1-6850/history': {
				body: [
					{
						type: 'add',
						repo: { name: 'MiniMaxAI/MiniMax-M1-80k', type: 'model' },
						date: '2025-07-03T10:12:15.000Z',
						author: { name: 'MiniMax-AI' },
					},
				],
			},
		});
		const plain = await callPtcTool(
			tool('hf_collection_get'),
			{ collection: 'https://huggingface.co/collections/MiniMaxAI/minimax-m1-6850' },
			ctx
		);
		expect(urls).toHaveLength(1);
		expect(plain.structured).toMatchObject({
			kind: 'collection',
			id: 'MiniMaxAI/minimax-m1-6850',
			title: 'MiniMax-M1',
			returnedCount: 4,
			items: [
				{ kind: 'space', id: 'MiniMaxAI/MiniMax-M1', uri: 'hf://spaces/MiniMaxAI/MiniMax-M1', position: 0 },
				{ kind: 'paper', id: '2506.13585', uri: 'hf://papers/2506.13585' },
				{ kind: 'model', note: 'Main checkpoint' },
				{ kind: 'collection', id: 'MiniMaxAI/other-123', uri: 'hf://collections/MiniMaxAI/other-123' },
			],
		});
		expect(plain.structured.history).toBeUndefined();
		expect(plain.structured.completeness).toEqual({
			hasMore: false,
			total: 5,
			skippedItems: 1,
		});
		const withHistory = await callPtcTool(
			tool('hf_collection_get'),
			{ collection: 'hf://collections/MiniMaxAI/minimax-m1-6850', include_history: true },
			ctx
		);
		expect(withHistory.structured.history).toEqual([
			{
				action: 'add',
				item: {
					kind: 'model',
					id: 'MiniMaxAI/MiniMax-M1-80k',
					uri: 'hf://models/MiniMaxAI/MiniMax-M1-80k',
					url: 'https://huggingface.co/MiniMaxAI/MiniMax-M1-80k',
				},
				date: '2025-07-03T10:12:15.000Z',
				author: 'MiniMax-AI',
			},
		]);
	});

	it('hf_collection_get flags truncated items and history with a hint (A10)', async () => {
		const many = Array.from({ length: 1005 }, (_, i) => ({ type: 'model', id: `o/m${String(i)}`, position: i }));
		const history = Array.from({ length: 120 }, (_, i) => ({
			type: 'add',
			repo: { name: `o/m${String(i)}`, type: 'model' },
		}));
		const { ctx } = mockCtx({
			'/api/collections/o/big-1': { body: { ...collection, slug: 'o/big-1', items: many } },
			'/api/collections/o/big-1/history': { body: history },
		});
		const r = await callPtcTool(tool('hf_collection_get'), { collection: 'o/big-1', include_history: true }, ctx);
		expect(r.structured.returnedCount).toBe(1000);
		expect(r.structured.history).toHaveLength(100);
		expect(r.structured.completeness).toEqual({
			hasMore: true,
			truncated: true,
			reason: 'items_cap',
			total: 1005,
			numHistory: 120,
			hint: 'Only part of this collection is returned; browse the rest at https://huggingface.co/collections/o/big-1.',
		});
	});

	it('hf_collection_get reports missing collections as NOT_FOUND', async () => {
		await expect(
			callPtcTool(tool('hf_collection_get'), { collection: 'a/b-1' }, mockCtx({}).ctx)
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});
