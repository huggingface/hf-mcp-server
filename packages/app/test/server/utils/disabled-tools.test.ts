import { afterEach, describe, expect, it } from 'vitest';
import {
	DISABLE_TOOLS_ENV,
	disabledToolCallName,
	disabledToolMessage,
	parseDisabledTools,
} from '../../../src/server/utils/disabled-tools.js';

const original = process.env[DISABLE_TOOLS_ENV];

afterEach(() => {
	if (original === undefined) delete process.env[DISABLE_TOOLS_ENV];
	else process.env[DISABLE_TOOLS_ENV] = original;
});

describe('disabled tools', () => {
	it('parses a comma-delimited list and ignores whitespace and empty names', () => {
		expect([...parseDisabledTools(' hub_repo_search, hub_repo_details ,,hf_fs ')]).toEqual([
			'hub_repo_search',
			'hub_repo_details',
			'hf_fs',
		]);
	});

	it('reads DISABLE_TOOLS by default', () => {
		process.env[DISABLE_TOOLS_ENV] = 'hub_repo_search';
		expect(parseDisabledTools()).toEqual(new Set(['hub_repo_search']));
	});

	it('recognizes only disabled tools/call requests', () => {
		const disabled = new Set(['hub_repo_search']);
		expect(disabledToolCallName({ method: 'tools/call', params: { name: 'hub_repo_search' } }, disabled)).toBe(
			'hub_repo_search'
		);
		expect(disabledToolCallName({ method: 'tools/call', params: { name: 'hf_fs' } }, disabled)).toBeUndefined();
		expect(disabledToolCallName({ method: 'tools/list' }, disabled)).toBeUndefined();
	});

	it('returns a stable call error message', () => {
		expect(disabledToolMessage('hub_repo_search')).toBe('Tool hub_repo_search is disabled by server configuration');
	});
});
