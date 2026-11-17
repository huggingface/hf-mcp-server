import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { PAPERS_TOOLS } from './papers.js';

function tool(name: string) {
	const found = PAPERS_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(name);
	return found;
}

interface Route {
	body: unknown;
	status?: number;
	headers?: Record<string, string>;
}
function mockCtx(routes: Record<string, Route>) {
	const urls: URL[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>((input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		urls.push(url);
		const route = routes[url.pathname];
		if (!route) return Promise.resolve(new Response('missing', { status: 404 }));
		const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
		return Promise.resolve(new Response(body, { status: route.status ?? 200, headers: route.headers }));
	});
	const ctx: PtcContext = { fetch };
	return { ctx, urls };
}

const paper = {
	id: '2106.09685',
	title: 'LoRA: Low-Rank\n Adaptation',
	summary: 'An important paradigm...',
	ai_summary: 'LoRA reduces trainable parameters.',
	ai_keywords: ['LoRA'],
	authors: [{ name: 'Edward Hu' }, { name: 'Hidden', hidden: true }],
	publishedAt: '2021-06-17T00:00:00.000Z',
	upvotes: 50,
	githubRepo: 'https://github.com/microsoft/LoRA',
	linkedModels: [{ id: 'org/lora-model', likes: 3, pipeline_tag: 'text-generation' }],
	numTotalModels: 520,
	linkedDatasets: [],
	numTotalDatasets: 0,
	linkedSpaces: [{ id: 'org/space', shortDescription: 'Demo' }],
	numTotalSpaces: 1,
};

describe('papers tools', () => {
	it('exports four read-only anonymous tools', () => {
		expect(PAPERS_TOOLS.map((t) => t.name)).toEqual([
			'hf_papers_search',
			'hf_daily_papers',
			'hf_paper_get',
			'hf_paper_read',
		]);
		for (const t of PAPERS_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
			expect(t.access).toBe('anonymous');
		}
	});

	it('hf_papers_search projects wrapped results without continuation', async () => {
		const { ctx, urls } = mockCtx({ '/api/papers/search': { body: [{ paper }, { paper: { id: 'bad' } }] } });
		const { structured } = await callPtcTool(tool('hf_papers_search'), { query: 'low rank', limit: 5 }, ctx);
		expect(urls[0]?.search).toBe('?q=low+rank&limit=5');
		expect(structured).toMatchObject({
			returned_count: 1,
			next_cursor: null,
			completeness: { scope: 'search_candidates', global_complete: false },
			items: [
				{
					kind: 'paper',
					id: '2106.09685',
					uri: 'hf://papers/2106.09685',
					url: 'https://huggingface.co/papers/2106.09685',
					title: 'LoRA: Low-Rank Adaptation',
					authors: ['Edward Hu'],
					arxiv_url: 'https://arxiv.org/abs/2106.09685',
				},
			],
		});
		await expect(callPtcTool(tool('hf_papers_search'), { query: 'x', limit: 121 }, ctx)).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('hf_daily_papers wraps p pages in an opaque cursor', async () => {
		const row = (id: string) => ({
			paper: { ...paper, id, submittedOnDailyAt: '2026-11-16T00:00:00.000Z' },
			numComments: 2,
			submittedBy: { name: 'akhaliq' },
		});
		const { ctx, urls } = mockCtx({
			'/api/daily_papers': {
				body: [row('2611.00001'), row('2611.00002')],
				headers: { link: '<https://huggingface.co/api/daily_papers?p=1&limit=2>; rel="next"' },
			},
		});
		const args = { week: '2026-W46', sort: 'trending', submitter: 'akhaliq', limit: 2 };
		const first = await callPtcTool(tool('hf_daily_papers'), args, ctx);
		expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toEqual({
			p: '0',
			limit: '2',
			sort: 'trending',
			week: '2026-W46',
			submitter: 'akhaliq',
		});
		expect(first.structured).toMatchObject({
			returned_count: 2,
			items: [
				{
					id: '2611.00001',
					submitted_by: 'akhaliq',
					num_comments: 2,
					submitted_on_daily_at: '2026-11-16T00:00:00.000Z',
				},
				{},
			],
		});
		const cursor = first.structured.next_cursor as string;
		await callPtcTool(tool('hf_daily_papers'), { ...args, cursor }, ctx);
		expect(urls[1]?.searchParams.get('p')).toBe('1');
		await expect(callPtcTool(tool('hf_daily_papers'), { ...args, limit: 3, cursor }, ctx)).rejects.toMatchObject({
			code: 'INVALID_CURSOR',
		});
		await expect(
			callPtcTool(tool('hf_daily_papers'), { date: '2026-11-01', month: '2026-11' }, ctx)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	});

	it('hf_daily_papers ends when there is no next link', async () => {
		const { ctx } = mockCtx({ '/api/daily_papers': { body: [{ paper }] } });
		const { structured } = await callPtcTool(tool('hf_daily_papers'), { limit: 1 }, ctx);
		expect(structured.next_cursor).toBeNull();
	});

	it('hf_paper_get returns details with linked repos and inline per-item errors', async () => {
		const { ctx, urls } = mockCtx({ '/api/papers/2106.09685': { body: paper } });
		const { structured } = await callPtcTool(
			tool('hf_paper_get'),
			{ paper_ids: ['https://arxiv.org/abs/2106.09685v2', '2401.00001', 'not-a-paper'] },
			ctx
		);
		expect(urls.map((u) => u.pathname)).toEqual(['/api/papers/2106.09685', '/api/papers/2401.00001']);
		expect(urls.some((u) => u.pathname.includes('/api/arxiv/'))).toBe(false);
		expect(structured.items).toMatchObject([
			{
				kind: 'paper',
				id: '2106.09685',
				abstract: 'An important paradigm...',
				ai_keywords: ['LoRA'],
				github_repo: 'https://github.com/microsoft/LoRA',
				linked: {
					models: {
						total: 520,
						items: [{ kind: 'model', id: 'org/lora-model', uri: 'hf://models/org/lora-model', likes: 3 }],
					},
					datasets: { total: 0, items: [] },
					spaces: { total: 1, items: [{ kind: 'space', uri: 'hf://spaces/org/space', description: 'Demo' }] },
				},
			},
			{ ref: '2401.00001', error: 'not_found' },
			{ ref: 'not-a-paper', error: 'invalid' },
		]);
	});

	it('hf_paper_read reads markdown ranges with next_offset', async () => {
		const text = `# Title\n\n${'é'.repeat(30)}`;
		const { ctx } = mockCtx({ '/papers/2106.09685.md': { body: text } });
		const first = await callPtcTool(tool('hf_paper_read'), { paper_id: 'hf://papers/2106.09685', max_bytes: 20 }, ctx);
		expect(first.structured).toMatchObject({
			kind: 'paper',
			id: '2106.09685',
			source: 'full_text',
			offset: 0,
			total_bytes: new TextEncoder().encode(text).byteLength,
		});
		const next = first.structured.next_offset as number;
		expect(next).toBeGreaterThan(0);
		const second = await callPtcTool(
			tool('hf_paper_read'),
			{ paper_id: '2106.09685', offset: next, max_bytes: 1000 },
			ctx
		);
		expect(`${String(first.structured.content)}${String(second.structured.content)}`).toBe(text);
		expect(second.structured.next_offset).toBeNull();
	});

	it('hf_paper_read falls back to the abstract when no markdown exists', async () => {
		const { ctx } = mockCtx({ '/api/papers/2106.09685': { body: paper } });
		const { structured } = await callPtcTool(tool('hf_paper_read'), { paper_id: '2106.09685' }, ctx);
		expect(structured.source).toBe('abstract_only');
		expect(structured.content).toContain('## Abstract');
		expect(structured.content).toContain('Edward Hu');
	});
});
