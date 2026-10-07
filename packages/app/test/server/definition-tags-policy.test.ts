import { afterEach, describe, it, expect } from 'vitest';
import {
	definitionTagsCacheHints,
	definitionTagsPolicy,
	getDefinitionTagsTestSalt,
	setDefinitionTagsTestSalt,
	type PolicyEnvironment,
} from '../../src/server/definition-tags/policy.js';

const token = { authorization: 'Bearer hf_test' };
const env: PolicyEnvironment = {};

afterEach(() => setDefinitionTagsTestSalt(''));

describe('definition tags eligibility', () => {
	it.each([
		['anonymous fallback / static defaults', {}],
		['anonymous + mix', { 'x-mcp-mix': 'jobs' }],
		['anonymous, named bouquet', { 'x-mcp-bouquet': 'search' }],
		['anonymous, bouquet=all', { 'x-mcp-bouquet': 'all' }],
		['authenticated, named bouquet', { ...token, 'x-mcp-bouquet': 'search' }],
		['named bouquet with gradio=none', { ...token, 'x-mcp-bouquet': 'search', 'x-mcp-gradio': 'none' }],
	] as const)('eligible: %s', (_name, headers) => {
		expect(definitionTagsPolicy({ ...headers }, env)).toBeDefined();
	});

	it.each([
		['authenticated without bouquet (per-user settings fetch)', { ...token }],
		['authenticated, bouquet=all (settings Gradio)', { ...token, 'x-mcp-bouquet': 'all' }],
		['authenticated, unknown bouquet (falls back to settings)', { ...token, 'x-mcp-bouquet': 'nope' }],
		['prototype key is not a bouquet', { ...token, 'x-mcp-bouquet': 'constructor' }],
		['explicit gradio spaces (anonymous)', { 'x-mcp-gradio': 'a/b' }],
		['explicit gradio spaces (bouquet)', { 'x-mcp-bouquet': 'search', 'x-mcp-gradio': 'a/b' }],
	] as const)('ineligible: %s', (_name, headers) => {
		expect(definitionTagsPolicy({ ...headers }, env)).toBeUndefined();
	});

	it('is disabled for stdio (no headers) and by the kill switch', () => {
		expect(definitionTagsPolicy(null, env)).toBeUndefined();
		expect(definitionTagsPolicy({}, { DEFINITION_TAGS: 'off' })).toBeUndefined();
	});

	it('parses TTL conservatively', () => {
		const ttl = (value?: string) => definitionTagsPolicy({}, { DEFINITION_TAGS_TTL_MS: value })?.ttlMs;
		expect(ttl()).toBe(300_000);
		expect(ttl('0')).toBe(0);
		expect(ttl('60000')).toBe(60_000);
		for (const invalid of ['-1', '1.5', 'soon', '']) expect(ttl(invalid)).toBe(300_000);
	});

	it('keeps every cache hint private, even for anonymous callers', () => {
		const policy = definitionTagsPolicy({}, env);
		expect(policy && definitionTagsCacheHints(policy)).toEqual({
			'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
			'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
		});
	});
});

describe('definition tags salt', () => {
	it('is empty by default and includes the deploy-wide salt', () => {
		expect(definitionTagsPolicy({}, env)?.salt).toBe('');
		expect(definitionTagsPolicy({}, { DEFINITION_TAGS_SALT: 'deploy-7' })?.salt).toBe('deploy-7');
	});

	it('applies the runtime test salt only in test mode', () => {
		setDefinitionTagsTestSalt('t1');
		expect(getDefinitionTagsTestSalt()).toBe('t1');
		expect(definitionTagsPolicy({}, env)?.salt).toBe('');
		expect(definitionTagsPolicy({}, { DEFINITION_TAGS_TEST: 'true' })?.salt).toBe('t1');
		expect(definitionTagsPolicy({}, { DEFINITION_TAGS_TEST: 'true', DEFINITION_TAGS_SALT: 'd' })?.salt).toBe('d/t1');
	});

	it('rejects unsafe test salts and keeps the previous value', () => {
		setDefinitionTagsTestSalt('ok');
		for (const invalid of ['has space', 'x'.repeat(129), 'tab\t', 'é']) {
			expect(() => setDefinitionTagsTestSalt(invalid)).toThrow(RangeError);
		}
		expect(getDefinitionTagsTestSalt()).toBe('ok');
	});
});
