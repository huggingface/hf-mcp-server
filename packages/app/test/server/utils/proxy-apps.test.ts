import { describe, expect, it } from 'vitest';
import { createProxyAppResourceUri, rewriteProxyAppToolMeta } from '../../../src/server/utils/proxy-apps.js';
describe('proxy apps', () => {
	it('rewrites MCP App ui resource URIs and records the upstream mapping', () => {
		const result = rewriteProxyAppToolMeta(
			{
				ui: {
					resourceUri: 'ui://file-upload/app.html',
					csp: {
						connectSrc: ['https://huggingface.co'],
					},
				},
				visibility: ['model', 'app'],
			},
			'hf_bucket_upload',
			'upload_files'
		);

		expect(result.resourceMapping).toEqual({
			localUri: createProxyAppResourceUri('hf_bucket_upload', 'ui://file-upload/app.html'),
			upstreamUri: 'ui://file-upload/app.html',
			proxyId: 'hf_bucket_upload',
			upstreamToolName: 'upload_files',
		});
		expect(result.meta).toEqual({
			ui: {
				resourceUri: createProxyAppResourceUri('hf_bucket_upload', 'ui://file-upload/app.html'),
				csp: {
					connectSrc: ['https://huggingface.co'],
				},
			},
			visibility: ['model', 'app'],
		});
	});

	it('leaves non-app metadata unchanged', () => {
		const meta = { openai: { outputTemplate: 'ui://template' } };
		const result = rewriteProxyAppToolMeta(meta, 'proxy', 'tool');

		expect(result.meta).toBe(meta);
		expect(result.resourceMapping).toBeUndefined();
	});
});
