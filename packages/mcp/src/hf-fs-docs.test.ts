import { afterEach, describe, expect, it, vi } from 'vitest';
import { HfFsDocsProvider, parseDocsUri } from './hf-fs-docs.js';

const manifests: Record<string, string> = {
	hub: `# Hub
- [Serve Models on Jobs](https://huggingface.co/docs/hub/jobs-serving.md)
- [Repository basics](https://huggingface.co/docs/hub/repositories-getting-started.md)`,
	transformers: `# Transformers
- [Quickstart](https://huggingface.co/docs/transformers/v5.13.1/quicktour.md)
- [Pipelines](https://huggingface.co/docs/transformers/v5.13.1/main_classes/pipelines.md)
- [Generation utilities](https://huggingface.co/docs/transformers/v5.13.1/internal/generation_utils.md)`,
	diffusers: `# Diffusers
- [Diffusers](https://huggingface.co/docs/diffusers/v0.39.0/index.md)
- [Quickstart](https://huggingface.co/docs/diffusers/v0.39.0/quicktour.md)
- [Chroma](https://huggingface.co/docs/diffusers/v0.39.0/api/pipelines/chroma.md)
- [Modular quickstart](https://huggingface.co/docs/diffusers/v0.39.0/modular_diffusers/quickstart.md)`,
	peft: `# PEFT
- [PEFT](https://huggingface.co/docs/peft/v0.19.0/index.md)
- [Quicktour](https://huggingface.co/docs/peft/v0.19.0/quicktour.md)
- [PEFT model](https://huggingface.co/docs/peft/v0.19.0/package_reference/peft_model.md)`,
	'text-generation-inference': `# TGI
- [TGI](https://huggingface.co/docs/text-generation-inference/index.md)
- [Quick Tour](https://huggingface.co/docs/text-generation-inference/quicktour.md)`,
	'text-embeddings-inference': `# TEI
- [TEI](https://huggingface.co/docs/text-embeddings-inference/main/index.md)`,
};

describe('HfFsDocsProvider', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('browses, reads, finds, stats, and searches current production-shaped manifests', async () => {
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>((input) => Promise.resolve(simulateFetch(input, requests)))
		);

		const provider = new HfFsDocsProvider();
		const root = await provider.run({ op: 'ls', uri: 'hf://docs' });
		expect(root).toMatchObject({
			op: 'ls',
			entries: [
				{ path: 'hub', type: 'dir' },
				{ path: 'transformers', type: 'dir' },
				{ path: 'diffusers', type: 'dir' },
				{ path: 'peft', type: 'dir' },
				{ path: 'tgi', type: 'dir' },
				{ path: 'tei', type: 'dir' },
			],
		});
		expect(requests.some((url) => url.endsWith('/docs/text-generation-inference/llms.txt'))).toBe(true);
		expect(requests.some((url) => url.endsWith('/docs/text-embeddings-inference/llms.txt'))).toBe(true);
		await expect(
			provider.run({ op: 'ls', uri: 'hf://docs', recursive: true, glob: 'transformers/**/*.md' })
		).resolves.toMatchObject({
			op: 'find',
			entries: [
				expect.objectContaining({ path: 'transformers/v5.13.1/internal/generation_utils.md' }),
				expect.objectContaining({ path: 'transformers/v5.13.1/main_classes/pipelines.md' }),
				expect.objectContaining({ path: 'transformers/v5.13.1/quicktour.md' }),
			],
		});
		await expect(provider.run({ op: 'ls', uri: 'hf://docs/tgi' })).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'index.md',
					uri: 'hf://docs/tgi/index.md',
					url: 'https://huggingface.co/docs/text-generation-inference/index.md',
				}),
				expect.objectContaining({ path: 'quicktour.md', uri: 'hf://docs/tgi/quicktour.md' }),
			],
		});

		await expect(provider.run({ op: 'ls', uri: 'hf://docs/diffusers' })).resolves.toMatchObject({
			entries: [{ path: 'v0.39.0', type: 'dir' }],
		});
		const listing = await provider.run({ op: 'ls', uri: 'hf://docs/diffusers/v0.39.0' });
		if (!('entries' in listing)) throw new Error('Expected listing result');
		expect(listing.entries.map(({ path, title, type }) => ({ path, title, type }))).toEqual([
			{ path: 'v0.39.0/api', title: undefined, type: 'dir' },
			{ path: 'v0.39.0/modular_diffusers', title: undefined, type: 'dir' },
			{ path: 'v0.39.0/index.md', title: 'Diffusers', type: 'file' },
			{ path: 'v0.39.0/quicktour.md', title: 'Quickstart', type: 'file' },
		]);

		await expect(provider.run({ op: 'cat', uri: 'hf://docs/diffusers/v0.39.0/quicktour.md' })).resolves.toMatchObject({
			content: '# Quickstart\nLoad a diffusion pipeline.',
			content_type: 'text/markdown',
			truncated: false,
		});
		const sectionRead = await provider.run({
			op: 'cat',
			uri: 'hf://docs/transformers/v5.13.1/internal/generation_utils.md#transformers.TextIteratorStreamer',
		});
		expect(sectionRead).toMatchObject({ section: 'Streamers' });
		if (!('content' in sectionRead)) throw new Error('Expected cat result');
		expect(sectionRead.content).toContain('TextIteratorStreamer');
		await expect(
			provider.run({
				op: 'find',
				uri: 'hf://docs/transformers',
				entry_type: 'file',
				path: 'v5.13.1/main_classes/*.md',
			})
		).resolves.toMatchObject({
			entries: [expect.objectContaining({ path: 'v5.13.1/main_classes/pipelines.md' })],
		});
		await expect(
			provider.run({
				op: 'find',
				uri: 'hf://docs/diffusers/v0.39.0/quicktour.md',
				entry_type: 'file',
				name: 'quicktour.md',
				path: 'quicktour.md',
			})
		).resolves.toMatchObject({
			entries: [expect.objectContaining({ path: 'v0.39.0/quicktour.md' })],
		});
		await expect(provider.run({ op: 'stat', uri: 'hf://docs/hub/jobs-serving.md' })).resolves.toMatchObject({
			exists: true,
			type: 'file',
			url: 'https://huggingface.co/docs/hub/jobs-serving.md',
		});
		await expect(
			provider.run({ op: 'search', uri: 'hf://docs/diffusers', query: 'getting started guide' })
		).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'v0.39.0/quicktour.md',
					uri: 'hf://docs/diffusers/v0.39.0/quicktour.md#quickstart',
					title: 'Quickstart',
					anchor: 'quickstart',
				}),
			],
		});
		await expect(
			provider.run({ op: 'search', uri: 'hf://docs/transformers', query: 'pipeline loading' })
		).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'v5.13.1/main_classes/pipelines.md',
					uri: 'hf://docs/transformers/v5.13.1/main_classes/pipelines.md#pipeline',
					title: 'Pipelines',
				}),
			],
		});
		await expect(provider.run({ op: 'search', uri: 'hf://docs', query: 'pipeline loading' })).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'transformers/v5.13.1/main_classes/pipelines.md',
					uri: 'hf://docs/transformers/v5.13.1/main_classes/pipelines.md#pipeline',
				}),
			],
		});
		await expect(
			provider.run({ op: 'search', uri: 'hf://docs/diffusers', query: 'ChromaPipeline' })
		).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					uri: 'hf://docs/diffusers/v0.39.0/api/pipelines/chroma.md#diffusers.ChromaPipeline',
					title: 'ChromaPipeline',
				}),
			],
		});
		await expect(
			provider.run({
				op: 'search',
				uri: 'hf://docs/transformers/v5.13.1/main_classes',
				query: 'pipeline loading',
			})
		).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'pipelines.md',
					uri: 'hf://docs/transformers/v5.13.1/main_classes/pipelines.md#pipeline',
				}),
			],
		});
		await expect(
			provider.run({
				op: 'search',
				uri: 'hf://docs/transformers/v5.13.1/main_classes/pipelines.md',
				query: 'pipeline loading',
			})
		).resolves.toMatchObject({
			entries: [expect.objectContaining({ path: 'pipelines.md' })],
		});
		await expect(
			provider.run({
				op: 'search',
				uri: 'hf://docs/diffusers/v0.39.0/modular_diffusers',
				query: 'scoped fallback',
			})
		).resolves.toMatchObject({
			entries: [
				expect.objectContaining({
					path: 'quickstart.md',
					uri: 'hf://docs/diffusers/v0.39.0/modular_diffusers/quickstart.md#modular-quickstart',
				}),
			],
		});
		await expect(
			provider.run({
				op: 'search',
				uri: 'hf://docs/transformers',
				query: 'pipeline loading',
				entry_type: 'dir',
			})
		).resolves.toMatchObject({ entries: [] });
		const longExcerptSearch = await provider.run({
			op: 'search',
			uri: 'hf://docs/transformers',
			query: 'long excerpt',
		});
		if (!('entries' in longExcerptSearch)) throw new Error('Expected search result');
		expect(longExcerptSearch.entries[0]?.description).toHaveLength(1200);
		expect(longExcerptSearch.entries[0]?.description).toMatch(/…$/);
		const multipleExcerptSearch = await provider.run({
			op: 'search',
			uri: 'hf://docs/transformers',
			query: 'multiple excerpts',
		});
		if (!('entries' in multipleExcerptSearch)) throw new Error('Expected search result');
		expect(multipleExcerptSearch.entries.map((entry) => entry.description?.length)).toEqual([1200, 400]);

		expect(requests.filter((url) => url.endsWith('/docs/diffusers/llms.txt'))).toHaveLength(1);
		expect(requests.some((url) => url.includes('/api/docs/search/full-text'))).toBe(true);
	}, 15_000);

	it('rejects versionless, missing or doubled scopes, oversized queries, and traversal', async () => {
		const provider = new HfFsDocsProvider();
		await expect(provider.run({ op: 'cat', uri: 'hf://docs/diffusers/quicktour.md' })).rejects.toThrow(
			'current llms.txt manifest'
		);
		await expect(
			provider.run({ op: 'search', uri: 'hf://docs/diffusers/v0.39.0/missing', query: 'pipeline' })
		).rejects.toThrow('not present in the current llms.txt manifest');
		await expect(
			provider.run({ op: 'search', uri: 'hf://docs/diffusers/diffusers/v0.39.0', query: 'pipeline' })
		).rejects.toThrow('Use: hf://docs/diffusers/v0.39.0');
		await expect(
			provider.run({ op: 'cat', uri: 'hf://docs/diffusers/diffusers/v0.39.0/quicktour.md' })
		).rejects.toThrow('Use: hf://docs/diffusers/v0.39.0/quicktour.md');
		await expect(provider.run({ op: 'cat', uri: 'hf://docs/diffusers/diffusers/v0.39.0' })).rejects.toThrow(
			'Use: hf://docs/diffusers/v0.39.0'
		);
		await expect(
			provider.run({
				op: 'cat',
				uri: 'hf://docs/transformers/v5.13.1/internal/generation_utils.md#missing',
			})
		).rejects.toThrow('documentation section');
		await expect(provider.run({ op: 'stat', uri: 'hf://docs#section' })).rejects.toThrow(
			'section anchors apply only to documentation file reads, not stat'
		);
		await expect(provider.run({ op: 'stat', uri: 'hf://docs/diffusers/v0.39.0/quicktour.md#missing' })).rejects.toThrow(
			'section anchors apply only to documentation file reads, not stat'
		);
		await expect(provider.run({ op: 'search', uri: 'hf://docs/diffusers', query: 'x'.repeat(251) })).rejects.toThrow(
			'query is too long'
		);
		await expect(provider.run({ op: 'search', uri: 'hf://docs/diffusers', query: ' ' })).rejects.toThrow(
			'search requires query'
		);
		await expect(provider.run({ op: 'search', uri: 'hf://docs/diffusers', query: 'guide', limit: 26 })).rejects.toThrow(
			'search limit must be between 1 and 25'
		);
		expect(() => parseDocsUri('hf://docs/diffusers/%2e%2e/quicktour.md')).toThrow('invalid path segment');
		expect(() => parseDocsUri('hf://docs/diffusers/a//b.md')).toThrow('empty segments');
	});
});

function simulateFetch(input: string | URL | Request, requests: string[]): Response {
	const url = new URL(input instanceof Request ? input.url : input.toString());
	requests.push(url.toString());
	if (url.pathname === '/api/docs') {
		return Response.json([
			{ id: 'hub', url: '/docs/hub', category: 'Hub & Client Libraries' },
			{ id: 'transformers', url: '/docs/transformers', category: 'Core ML Libraries' },
			{ id: 'diffusers', url: '/docs/diffusers', category: 'Core ML Libraries' },
			{ id: 'peft', url: '/docs/peft', category: 'Training & Optimization' },
			{ id: 'tgi', url: '/docs/text-generation-inference', category: 'Deployment & Inference' },
			{ id: 'tei', url: '/docs/text-embeddings-inference', category: 'Deployment & Inference' },
			{ id: 'evaluate', url: '/docs/evaluate' },
			{ id: 'gradio', url: 'https://www.gradio.app/docs/' },
		]);
	}
	const manifestMatch = url.pathname.match(/^\/docs\/([^/]+)\/llms\.txt$/);
	if (manifestMatch) {
		const manifest = manifests[manifestMatch[1] ?? ''];
		return manifest
			? new Response(manifest, { headers: { 'content-type': 'text/plain' } })
			: new Response('not found', { status: 404 });
	}
	if (url.pathname === '/api/docs/search') {
		if (url.searchParams.get('q') === 'getting started guide') {
			return new Response('semantic unavailable', { status: 500 });
		}
		if (url.searchParams.get('q') === 'ChromaPipeline') {
			return Response.json([]);
		}
		if (url.searchParams.get('q') === 'multiple excerpts') {
			const text = `<p>${'long documentation excerpt '.repeat(60)}</p>`;
			return Response.json([
				{
					text,
					product: 'transformers',
					heading1: 'Pipelines',
					source_page_url: 'https://huggingface.co/docs/transformers/main/en/main_classes/pipelines#pipeline',
					source_page_title: 'Pipelines',
				},
				{
					text,
					product: 'transformers',
					heading1: 'Utilities for Generation',
					heading2: 'Streamers[[transformers.TextStreamer]]',
					source_page_url:
						'https://huggingface.co/docs/transformers/main/en/internal/generation_utils#streamerstransformerstextstreamer',
					source_page_title: 'Utilities for Generation',
				},
			]);
		}
		const text =
			url.searchParams.get('q') === 'long excerpt'
				? `<p>${'long documentation excerpt '.repeat(60)}</p>`
				: 'The pipeline API loads pretrained models for inference.';
		return Response.json([
			{
				text,
				product: 'transformers',
				heading1: 'Pipelines',
				source_page_url: 'https://huggingface.co/docs/transformers/main/en/main_classes/pipelines#pipeline',
				source_page_title: 'Pipelines',
			},
		]);
	}
	if (url.pathname === '/api/docs/search/full-text') {
		if (url.searchParams.get('q') === 'ChromaPipeline') {
			return Response.json({
				hits: [
					{
						url: '/docs/diffusers/main/en/api/pipelines/chroma#diffusers.ChromaPipeline',
						hierarchy_lvl1: 'Chroma',
						hierarchy_lvl2: 'ChromaPipeline',
					},
				],
			});
		}
		if (url.searchParams.get('q') === 'scoped fallback') {
			return Response.json({
				hits: [
					{
						url: '/docs/diffusers/main/en/modular_diffusers/quickstart#modular-quickstart',
						hierarchy_lvl1: 'Modular quickstart',
						content: 'Build a modular Diffusers pipeline.',
					},
				],
			});
		}
		return Response.json({
			hits: [
				{
					url: '/docs/diffusers/main/en/quicktour#quickstart',
					hierarchy_lvl0: 'Diffusers',
					hierarchy_lvl1: 'Quickstart',
					content: 'Diffusers provides pretrained diffusion pipelines.',
				},
			],
		});
	}
	if (url.pathname === '/docs/diffusers/v0.39.0/quicktour.md') {
		return new Response('# Quickstart\nLoad a diffusion pipeline.', {
			headers: { 'content-type': 'text/markdown' },
		});
	}
	if (url.pathname === '/docs/transformers/v5.13.1/internal/generation_utils.md') {
		return new Response(
			`# Utilities for Generation

## Streamers[[transformers.TextStreamer]]

TextStreamer prints generated text.

TextIteratorStreamer stores text in a queue for iteration.

## Caches[[transformers.Cache]]

Cache utilities.`,
			{ headers: { 'content-type': 'text/markdown' } }
		);
	}
	throw new Error(`Unexpected request: ${url.toString()}`);
}
