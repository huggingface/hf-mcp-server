import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { BOUQUETS } from '../../src/shared/bouquet-presets.js';
import { extractQueryParamsToHeaders } from '../../src/server/utils/query-params.js';
import { MCP_URL_BASE, MCP_URL_OPTIONS, MCP_URL_PRESETS } from '../../src/web/lib/mcp-url-options.js';

describe('welcome page URL reference', () => {
	it('provides working example URLs that preserve the sign-in request', () => {
		const expectedHeaders = [
			{ 'x-mcp-bouquet': 'files' },
			{ 'x-mcp-mix': 'jobs,sandbox' },
			{ 'x-mcp-gradio': 'victor/websearch' },
			{ 'x-mcp-no-image-content': 'true' },
		];

		expect(MCP_URL_OPTIONS).toHaveLength(expectedHeaders.length);
		MCP_URL_OPTIONS.forEach((option, index) => {
			const url = new URL(`${MCP_URL_BASE}&${option.query}`);
			expect(url.origin + url.pathname).toBe('https://huggingface.co/mcp');
			const headers: Record<string, string> = {};
			extractQueryParamsToHeaders({ query: Object.fromEntries(url.searchParams) } as Request, headers);
			expect(headers).toEqual({ 'x-mcp-force-auth': 'true', ...expectedHeaders[index] });
		});
	});

	it('keeps the curated preset descriptions aligned with the server tool groups', () => {
		// Deliberately explicit: changes to these tool groups should prompt a copy review.
		const advertisedTools: Record<string, string[]> = {
			files: ['hf_fs'],
			jobs: ['hf_jobs'],
			sandbox: ['hf_sandbox', 'hf_sandbox_exec', 'hf_sandbox_fs'],
			intern: [
				'hf_files',
				'hf_sandbox',
				'hf_sandbox_exec',
				'hf_sandbox_fs',
				'create_repo',
				'hub_repo_details',
				'hf_jobs',
			],
		};
		expect(MCP_URL_PRESETS.map(({ key }) => key).sort()).toEqual(Object.keys(advertisedTools).sort());
		for (const { key } of MCP_URL_PRESETS) {
			expect(BOUQUETS[key]?.builtInTools).toEqual(advertisedTools[key]);
		}
	});
});
