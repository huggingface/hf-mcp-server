import { afterEach, describe, it, expect } from 'vitest';
import {
	definitionDigestsCacheHints,
	definitionDigestsPolicy,
	getDefinitionDigestsTestSalt,
	setDefinitionDigestsTestSalt,
	type PolicyEnvironment,
} from '../../src/server/definition-digests/policy.js';

const token = { authorization: 'Bearer hf_test' };
const env: PolicyEnvironment = {};

afterEach(() => setDefinitionDigestsTestSalt(''));

describe('definition digests eligibility', () => {
	it.each([
		['anonymous fallback / static defaults', {}],
		['anonymous + mix', { 'x-mcp-mix': 'jobs' }],
		['anonymous, named bouquet', { 'x-mcp-bouquet': 'search' }],
		['anonymous, bouquet=all', { 'x-mcp-bouquet': 'all' }],
		['authenticated, named bouquet', { ...token, 'x-mcp-bouquet': 'search' }],
		['named bouquet with gradio=none', { ...token, 'x-mcp-bouquet': 'search', 'x-mcp-gradio': 'none' }],
	] as const)('eligible: %s', (_name, headers) => {
		expect(definitionDigestsPolicy({ ...headers }, env)).toBeDefined();
	});

	it.each([
		['authenticated without bouquet (per-user settings fetch)', { ...token }],
		['authenticated, bouquet=all (settings Gradio)', { ...token, 'x-mcp-bouquet': 'all' }],
		['authenticated, unknown bouquet (falls back to settings)', { ...token, 'x-mcp-bouquet': 'nope' }],
		['prototype key is not a bouquet', { ...token, 'x-mcp-bouquet': 'constructor' }],
		['explicit gradio spaces (anonymous)', { 'x-mcp-gradio': 'a/b' }],
		['explicit gradio spaces (bouquet)', { 'x-mcp-bouquet': 'search', 'x-mcp-gradio': 'a/b' }],
	] as const)('ineligible: %s', (_name, headers) => {
		expect(definitionDigestsPolicy({ ...headers }, env)).toBeUndefined();
	});

	it('is disabled for stdio (no headers) and by the kill switch', () => {
		expect(definitionDigestsPolicy(null, env)).toBeUndefined();
		expect(definitionDigestsPolicy({}, { DEFINITION_DIGESTS: 'off' })).toBeUndefined();
	});

	it('parses TTL conservatively', () => {
		const ttl = (value?: string) => definitionDigestsPolicy({}, { DEFINITION_DIGESTS_TTL_MS: value })?.ttlMs;
		expect(ttl()).toBe(300_000);
		expect(ttl('0')).toBe(0);
		expect(ttl('60000')).toBe(60_000);
		for (const invalid of ['-1', '1.5', 'soon', '']) expect(ttl(invalid)).toBe(300_000);
	});

	it('keeps every cache hint private, even for anonymous callers', () => {
		const policy = definitionDigestsPolicy({}, env);
		expect(policy && definitionDigestsCacheHints(policy)).toEqual({
			'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
			'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
		});
	});
});

describe('definition digests salt', () => {
	it('is empty by default and includes the deploy-wide salt', () => {
		expect(definitionDigestsPolicy({}, env)?.salt).toBe('');
		expect(definitionDigestsPolicy({}, { DEFINITION_DIGESTS_SALT: 'deploy-7' })?.salt).toBe('deploy-7');
	});

	it('applies the runtime test salt only in test mode', () => {
		setDefinitionDigestsTestSalt('t1');
		expect(getDefinitionDigestsTestSalt()).toBe('t1');
		expect(definitionDigestsPolicy({}, env)?.salt).toBe('');
		expect(definitionDigestsPolicy({}, { DEFINITION_DIGESTS_TEST: 'true' })?.salt).toBe('t1');
		expect(definitionDigestsPolicy({}, { DEFINITION_DIGESTS_TEST: 'true', DEFINITION_DIGESTS_SALT: 'd' })?.salt).toBe(
			'd/t1'
		);
	});

	it('rejects unsafe test salts and keeps the previous value', () => {
		setDefinitionDigestsTestSalt('ok');
		for (const invalid of ['has space', 'x'.repeat(129), 'tab\t', 'é']) {
			expect(() => setDefinitionDigestsTestSalt(invalid)).toThrow(RangeError);
		}
		expect(getDefinitionDigestsTestSalt()).toBe('ok');
	});
});
