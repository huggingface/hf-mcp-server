import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSpaces } from '../src/space/commands/dynamic-find.js';

describe('dynamic Space discovery', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses hf_fs semantic Space search with the MCP filter', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json([
				{
					id: 'org/python-mcp',
					title: 'Python MCP',
					ai_short_description: 'Run Python code',
					ai_category: 'Code Generation',
					likes: 42,
					trendingScore: 3,
					semanticRelevancyScore: 0.91,
					tags: ['mcp-server'],
				},
			])
		);

		const result = await findSpaces('python execution', 5, 'token');
		const fetchInput = vi.mocked(fetch).mock.calls[0]?.[0];
		if (typeof fetchInput !== 'string') throw new Error('Expected fetch to receive a URL string');
		const requestUrl = new URL(fetchInput);

		expect(requestUrl.pathname).toBe('/api/spaces/semantic-search');
		expect(requestUrl.searchParams.get('q')).toBe('python execution');
		expect(requestUrl.searchParams.getAll('filter')).toEqual(['mcp-server']);
		expect(result).toMatchObject({
			totalResults: 1,
			resultsShared: 1,
		});
		expect(result.isError).toBeUndefined();
		expect(result.formatted).toContain('[Python MCP](https://hf.co/spaces/org/python-mcp)');
		expect(result.formatted).toContain('Run Python code');
		expect(result.formatted).toContain('91.0%');
	});
});
