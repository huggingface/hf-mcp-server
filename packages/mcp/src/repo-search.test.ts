import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoSearchTool } from './repo-search.js';

interface MockFetchCall {
	input: string;
	init?: RequestInit;
}

describe('RepoSearchTool', () => {
	const originalFetch = globalThis.fetch;
	let calls: MockFetchCall[] = [];

	beforeEach(() => {
		calls = [];
		vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const inputString = stringifyRequestInput(input);
			calls.push({ input: inputString, init });

			if (inputString.includes('/api/models')) {
				return Promise.resolve(jsonResponse([
					{
						id: 'meta-llama/Llama-3.1-8B-Instruct',
						pipeline_tag: 'text-generation',
						library_name: 'transformers',
						downloads: 123,
						likes: 10,
						tags: ['text-generation'],
					},
				]));
			}

			if (inputString.includes('/api/datasets')) {
				return Promise.resolve(jsonResponse([
					{
						id: 'openbmb/UltraData-Math',
						description: 'Large-scale mathematical dataset',
						downloads: 50,
						likes: 3,
						tags: ['math'],
					},
				]));
			}

			if (inputString.includes('/api/spaces')) {
				return Promise.resolve(jsonResponse([
					{
						id: 'mrfakename/Z-Image-Turbo',
						title: 'Z Image Turbo',
						sdk: 'gradio',
						likes: 20,
					},
				]));
			}

			return Promise.resolve(jsonResponse([]));
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		globalThis.fetch = originalFetch;
	});

	it('aggregates model and dataset results in one response', async () => {
		const tool = new RepoSearchTool('token');
		const result = await tool.searchWithParams({
			query: 'llama',
			repo_types: ['model', 'dataset'],
			limit: 5,
		});

		expect(calls).toHaveLength(2);
		const callInputs = calls.map((call) => call.input);
		expect(callInputs.some((input) => input.includes('/api/models'))).toBe(true);
		expect(callInputs.some((input) => input.includes('/api/datasets'))).toBe(true);
		expect(result.totalResults).toBe(2);
		expect(result.formatted).toContain('## Models (1)');
		expect(result.formatted).toContain('## Datasets (1)');
		expect(result.formatted).toContain('[https://hf.co/meta-llama/Llama-3.1-8B-Instruct]');
		expect(result.formatted).toContain('[https://hf.co/datasets/openbmb/UltraData-Math]');
	});

	it('supports searching spaces through the same interface', async () => {
		const tool = new RepoSearchTool('token');
		const result = await tool.searchWithParams({
			query: 'image generation',
			repo_types: ['space'],
			limit: 3,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toContain('/api/spaces');
		expect(result.totalResults).toBe(1);
		expect(result.formatted).toContain('## Spaces (1)');
		expect(result.formatted).toContain('[https://hf.co/spaces/mrfakename/Z-Image-Turbo]');
	});

	it('applies an overall output length guard with truncation notice', async () => {
		vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const inputString = stringifyRequestInput(input);
			calls.push({ input: inputString, init });

			if (inputString.includes('/api/models')) {
				const longTag = 'very-long-tag-name-for-output-growth';
				const models = Array.from({ length: 100 }, (_, index) => ({
					id: `org/super-long-model-name-${index.toString().padStart(3, '0')}-with-extra-context`,
					pipeline_tag: 'text-generation',
					library_name: 'transformers',
					downloads: 100000 - index,
					likes: 1000 - index,
					tags: Array.from({ length: 30 }, (_unused, tagIndex) => `${longTag}-${tagIndex.toString()}`),
				}));
				return Promise.resolve(jsonResponse(models));
			}

			return Promise.resolve(jsonResponse([]));
		});

		const tool = new RepoSearchTool('token');
		const result = await tool.searchWithParams({
			repo_types: ['model'],
			limit: 100,
		});

		expect(result.totalResults).toBe(100);
		expect(result.resultsShared).toBeLessThan(result.totalResults);
		expect(result.formatted.length).toBeLessThanOrEqual(12_500 * 3);
		expect(result.formatted).toContain('Results truncated at approximately 12,500 tokens');
		expect(result.formatted).toContain('Included');
	});
});

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			'content-type': 'application/json',
		},
	});
}

function stringifyRequestInput(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	if (input instanceof Request) {
		return input.url;
	}

	return input;
}
