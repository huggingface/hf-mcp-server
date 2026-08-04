import { describe, expect, it } from 'vitest';
import { normalizeParsedTools, parseGradioSchemaResponse } from './gradio-schema.js';

describe('Gradio schema metadata', () => {
	it('preserves array-form MCP App metadata through normalization', () => {
		const parsed = parseGradioSchemaResponse([
			{
				name: 'app_tool',
				description: 'Tool with an app',
				inputSchema: { type: 'object', properties: {} },
				_meta: {
					ui: {
						resourceUri: 'ui://upstream/app.html',
						csp: { connectSrc: ['https://huggingface.co'] },
					},
				},
			},
		]);

		expect(normalizeParsedTools(parsed)[0]?._meta).toEqual({
			ui: {
				resourceUri: 'ui://upstream/app.html',
				csp: { connectSrc: ['https://huggingface.co'] },
			},
		});
	});

	it('does not treat object-form input schema metadata as tool metadata', () => {
		const parsed = parseGradioSchemaResponse({
			plain_tool: {
				type: 'object',
				properties: {},
				_meta: { ui: { resourceUri: 'ui://not-tool-metadata/app.html' } },
			},
		});

		expect(normalizeParsedTools(parsed)[0]?._meta).toBeUndefined();
	});
});
