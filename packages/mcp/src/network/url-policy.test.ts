import { describe, expect, it } from 'vitest';
import {
	createExactHostPolicy,
	createExternalHttpsPolicy,
	createGradioMcpHostPolicy,
	createGradioSchemaHostPolicy,
	createHuggingFaceHubPolicy,
	createLocalhostHttpPolicy,
	createGradioMcpPolicy,
	createHfDocsPolicy,
	isLocalhostHostname,
	parseAndValidateUrl,
} from './url-policy.js';

describe('url-policy', () => {
	describe('HF docs policy', () => {
		it('accepts valid Hugging Face docs and Gradio docs URLs', () => {
			expect(() => parseAndValidateUrl('https://huggingface.co/docs/transformers', createHfDocsPolicy())).not.toThrow();
			expect(() => parseAndValidateUrl('https://www.huggingface.co/docs/datasets', createHfDocsPolicy())).not.toThrow();
			expect(() => parseAndValidateUrl('https://www.gradio.app/guides', createHfDocsPolicy())).not.toThrow();
		});

		it('rejects non-https or non-allowlisted hosts', () => {
			expect(() => parseAndValidateUrl('http://huggingface.co/docs/transformers', createHfDocsPolicy())).toThrow(
				'URL protocol is not allowed'
			);
			expect(() => parseAndValidateUrl('https://example.com/docs/transformers', createHfDocsPolicy())).toThrow(
				'URL hostname is not allowed'
			);
		});

		it('rejects traversal and encoded traversal variants', () => {
			const variants = [
				'https://huggingface.co/docs/../x',
				'https://huggingface.co/docs/%2e%2e/x',
				'https://huggingface.co/docs/%2e%2e%2fx',
				'https://huggingface.co/docs/..%2fx',
				'https://huggingface.co/docs/%2e%2e%5cx',
				'https://huggingface.co/docs/%252e%252e%252fx',
			];

			for (const candidate of variants) {
				expect(() => parseAndValidateUrl(candidate, createHfDocsPolicy())).toThrow();
			}
		});

		it('enforces /docs/ prefix on HF hosts', () => {
			expect(() => parseAndValidateUrl('https://huggingface.co/models/some-model', createHfDocsPolicy())).toThrow(
				'Hugging Face docs URLs must remain under /docs/'
			);
		});
	});

	describe('Gradio MCP policy', () => {
		it('accepts mcp endpoint URLs over https', () => {
			expect(() =>
				parseAndValidateUrl('https://demo-space.hf.space/gradio_api/mcp/', createGradioMcpPolicy())
			).not.toThrow();
			expect(() =>
				parseAndValidateUrl('https://fake-mcp.local/gradio_api/mcp/', createGradioMcpPolicy())
			).not.toThrow();
		});

		it('rejects invalid paths', () => {
			expect(() => parseAndValidateUrl('https://demo-space.hf.space/not-mcp', createGradioMcpPolicy())).toThrow(
				'URL path must start with /gradio_api/mcp'
			);
		});
	});

	describe('external https policy', () => {
		it('rejects credentials in URL', () => {
			expect(() => parseAndValidateUrl('https://user:pass@example.com/file.wav', createExternalHttpsPolicy())).toThrow(
				'URL credentials are not allowed'
			);
		});
	});

	it('supports huggingface hub and localhost policy helpers', () => {
		expect(() => parseAndValidateUrl('https://huggingface.co/api/models', createHuggingFaceHubPolicy())).not.toThrow();
		expect(() => parseAndValidateUrl('http://localhost:7860/health', createLocalhostHttpPolicy())).not.toThrow();
		expect(() => parseAndValidateUrl('https://example.com/x', createExactHostPolicy('example.com', 'https:'))).not.toThrow();
		expect(() =>
			parseAndValidateUrl(
				'https://demo-space.hf.space/gradio_api/mcp/schema',
				createGradioSchemaHostPolicy('demo-space.hf.space')
			)
		).not.toThrow();
		expect(() =>
			parseAndValidateUrl(
				'https://demo-space.hf.space/gradio_api/mcp/',
				createGradioMcpHostPolicy('demo-space.hf.space', 'https:')
			)
		).not.toThrow();
		expect(isLocalhostHostname('localhost')).toBe(true);
		expect(isLocalhostHostname('127.0.0.1')).toBe(true);
		expect(isLocalhostHostname('[::1]')).toBe(true);
		expect(isLocalhostHostname('example.com')).toBe(false);
	});
});
