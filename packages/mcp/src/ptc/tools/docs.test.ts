import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPtcTool } from '../core/tool.js';
import { DOCS_TOOLS } from './docs.js';

// The docs tools reuse the legacy HfFsDocsProvider, which fetches through the global fetch.
const page = `# Quicktour

Intro text.

## Train[[train]]

Training steps.

## Save

Saving steps.
`;
const routes: Record<string, { body: string; type: string }> = {
	'/api/docs': {
		body: JSON.stringify([
			{ id: 'ptcdocs', url: '/docs/ptcdocs', category: 'Core ML Libraries' },
			{ id: 'external', url: 'https://www.gradio.app/docs/', category: 'Extras' },
		]),
		type: 'application/json',
	},
	'/docs/ptcdocs/llms.txt': {
		body: `# PTC docs
- [Quicktour](https://huggingface.co/docs/ptcdocs/v1.0.0/quicktour.md)
- [LoRA guide](https://huggingface.co/docs/ptcdocs/v1.0.0/guides/lora.md)
- [Reference](https://huggingface.co/docs/ptcdocs/v1.0.0/reference/api.md)`,
		type: 'text/plain',
	},
	'/docs/ptcdocs/v1.0.0/quicktour.md': { body: page, type: 'text/markdown' },
	// Older/other-language builds are published as Markdown but are not in llms.txt.
	'/docs/ptcdocs/v0.9.0/en/quicktour.md': { body: '# Quicktour (v0.9)\n\nOld API.\n', type: 'text/markdown' },
	'/docs/ptcdocs/fr/quicktour.md': { body: '# Visite rapide\n\nBonjour.\n', type: 'text/markdown' },
	'/api/docs/search': {
		body: JSON.stringify([
			{
				text: '## Train[[train]]\n\nTraining steps.',
				product: 'ptcdocs',
				heading1: 'Quicktour',
				heading2: 'Train',
				source_page_url: 'https://huggingface.co/docs/ptcdocs/quicktour#train',
				source_page_title: 'Quicktour',
			},
			{
				text: 'unrelated',
				product: 'unknown-product',
				heading1: 'X',
				source_page_url: 'https://huggingface.co/docs/unknown-product/x',
				source_page_title: 'X',
			},
		]),
		type: 'application/json',
	},
};

let requests: URL[] = [];
let fetchSignals: AbortSignal[] = [];
beforeEach(() => {
	requests = [];
	fetchSignals = [];
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>((input, init) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			requests.push(url);
			if (url.pathname === '/docs/ptcdocs/v0.8.0/en/slow.md') {
				if (init?.signal) fetchSignals.push(init.signal);
				return new Promise<Response>(() => undefined);
			}
			const route = routes[url.pathname];
			return Promise.resolve(
				route
					? new Response(route.body, { status: 200, headers: { 'content-type': route.type } })
					: new Response('missing', { status: 404 })
			);
		})
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function tool(name: string) {
	const found = DOCS_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(name);
	return found;
}

describe('docs tools', () => {
	it('exports two read-only tools', () => {
		expect(DOCS_TOOLS.map((t) => t.name)).toEqual(['hf_docs_search', 'hf_docs_read']);
		for (const t of DOCS_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});

	it('hf_docs_read without uri lists products with llms.txt manifests', async () => {
		const { structured } = await callPtcTool(tool('hf_docs_read'), {}, {});
		expect(structured).toMatchObject({
			mode: 'products',
			uri: 'hf://docs',
			items: [
				{
					kind: 'doc',
					id: 'ptcdocs',
					uri: 'hf://docs/ptcdocs',
					url: 'https://huggingface.co/docs/ptcdocs',
					category: 'Core ML Libraries',
				},
			],
			returnedCount: 1,
		});
	});

	it('hf_docs_read with a product returns the manifest index, glob-filtered and paged', async () => {
		const filtered = await callPtcTool(tool('hf_docs_read'), { uri: 'ptcdocs', glob: '**/lora*' }, {});
		expect(filtered.structured).toMatchObject({
			mode: 'index',
			items: [
				{
					kind: 'doc',
					id: 'ptcdocs/v1.0.0/guides/lora.md',
					uri: 'hf://docs/ptcdocs/v1.0.0/guides/lora.md',
					url: 'https://huggingface.co/docs/ptcdocs/v1.0.0/guides/lora.md',
					title: 'LoRA guide',
				},
			],
			nextCursor: null,
		});
		const first = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs', limit: 2 }, {});
		expect(first.structured.returnedCount).toBe(2);
		const cursor = first.structured.nextCursor as string;
		const second = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs', limit: 2, cursor }, {});
		expect(second.structured.returnedCount).toBe(1);
		expect(second.structured.nextCursor).toBeNull();
		const folder = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/v1.0.0/guides' }, {});
		expect(folder.structured).toMatchObject({ mode: 'index', returnedCount: 1 });
	});

	it('hf_docs_read reads a page range and an anchored section', async () => {
		const first = await callPtcTool(
			tool('hf_docs_read'),
			{ uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md', max_bytes: 12 },
			{}
		);
		expect(first.structured).toMatchObject({
			mode: 'page',
			kind: 'doc',
			id: 'ptcdocs/v1.0.0/quicktour.md',
			uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md',
			url: 'https://huggingface.co/docs/ptcdocs/v1.0.0/quicktour',
			content: '# Quicktour\n',
			nextOffset: 12,
		});
		const section = await callPtcTool(
			tool('hf_docs_read'),
			{ uri: 'https://huggingface.co/docs/ptcdocs/v1.0.0/quicktour#train' },
			{}
		);
		expect(section.structured).toMatchObject({
			mode: 'page',
			uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md#train',
			section: 'Train',
			nextOffset: null,
		});
		expect(section.structured.content).toContain('Training steps.');
		expect(section.structured.content).not.toContain('Saving steps.');
	});

	it('hf_docs_read maps missing pages to NOT_FOUND', async () => {
		await expect(
			callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/v1.0.0/missing.md' }, {})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('hf_docs_search returns doc items with section anchors', async () => {
		const { structured } = await callPtcTool(
			tool('hf_docs_search'),
			{ query: 'train', product: 'ptcdocs', limit: 5 },
			{}
		);
		const search = requests.find((url) => url.pathname === '/api/docs/search');
		expect(search?.searchParams.get('product')).toBe('ptcdocs');
		expect(structured).toEqual({
			items: [
				{
					kind: 'doc',
					id: 'ptcdocs/v1.0.0/quicktour.md',
					uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md#train',
					url: 'https://huggingface.co/docs/ptcdocs/quicktour#train',
					title: 'Train',
					anchor: 'train',
					excerpt: '## Train[[train]] Training steps.',
				},
			],
			returnedCount: 1,
			nextCursor: null,
			completeness: { hasMore: false },
		});
	});

	it('hf_docs_read reads the unversioned url returned by hf_docs_search', async () => {
		const { structured: search } = await callPtcTool(
			tool('hf_docs_search'),
			{ query: 'train', product: 'ptcdocs' },
			{}
		);
		const url = (search.items as { url: string }[])[0]?.url;
		expect(url).toBe('https://huggingface.co/docs/ptcdocs/quicktour#train');
		const { structured } = await callPtcTool(tool('hf_docs_read'), { uri: url }, {});
		expect(structured).toMatchObject({
			mode: 'page',
			id: 'ptcdocs/v1.0.0/quicktour.md',
			uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md#train',
			section: 'Train',
		});
		const unversioned = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/quicktour.md' }, {});
		expect(unversioned.structured).toMatchObject({ uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md' });
	});

	it('hf_docs_read reads an explicitly pinned version or language instead of the current page', async () => {
		for (const uri of [
			'https://huggingface.co/docs/ptcdocs/v0.9.0/en/quicktour',
			'hf://docs/ptcdocs/v0.9.0/en/quicktour.md',
		]) {
			const { structured } = await callPtcTool(tool('hf_docs_read'), { uri }, {});
			expect(structured).toMatchObject({
				mode: 'page',
				id: 'ptcdocs/v0.9.0/en/quicktour.md',
				uri: 'hf://docs/ptcdocs/v0.9.0/en/quicktour.md',
				url: 'https://huggingface.co/docs/ptcdocs/v0.9.0/en/quicktour',
				content: '# Quicktour (v0.9)\n\nOld API.\n',
			});
		}
		const french = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/fr/quicktour.md' }, {});
		expect(french.structured).toMatchObject({
			uri: 'hf://docs/ptcdocs/fr/quicktour.md',
			content: '# Visite rapide\n\nBonjour.\n',
		});
		// The current version (with or without the default language) still resolves to the indexed page.
		const current = await callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/v1.0.0/en/quicktour.md' }, {});
		expect(current.structured).toMatchObject({ uri: 'hf://docs/ptcdocs/v1.0.0/quicktour.md' });
		expect(requests.some((url) => url.pathname === '/docs/ptcdocs/v1.0.0/en/quicktour.md')).toBe(false);
	});

	it('hf_docs_read fails with the current uri when a pinned version is not published', async () => {
		const error: unknown = await callPtcTool(
			tool('hf_docs_read'),
			{ uri: 'https://huggingface.co/docs/ptcdocs/v0.1.0/en/quicktour#train' },
			{}
		).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: 'NOT_FOUND' });
		expect((error as Error).message).toContain('only the current docs version v1.0.0');
		expect((error as Error).message).toContain('hf://docs/ptcdocs/v1.0.0/quicktour.md#train');
		await expect(
			callPtcTool(tool('hf_docs_read'), { uri: 'hf://docs/ptcdocs/v0.1.0/en/nothing.md' }, {})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('hf_docs_read cancels an in-flight page fetch with the request signal', async () => {
		const controller = new AbortController();
		const pending = callPtcTool(
			tool('hf_docs_read'),
			{ uri: 'hf://docs/ptcdocs/v0.8.0/en/slow.md' },
			{ signal: controller.signal }
		);
		await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
		expect(fetchSignals[0]?.aborted).toBe(true);
	});
});
