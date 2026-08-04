import { afterEach, describe, expect, it } from 'vitest';
import { getProxyToken } from '../../../src/server/utils/proxy-tools-config.js';

describe('proxy tools authentication', () => {
	const originalProxyToken = process.env.PROXY_TOKEN;
	const originalDefaultHfToken = process.env.DEFAULT_HF_TOKEN;
	const originalHfToken = process.env.HF_TOKEN;
	const originalLoggingHfToken = process.env.LOGGING_HF_TOKEN;

	afterEach(() => {
		restoreEnv('PROXY_TOKEN', originalProxyToken);
		restoreEnv('DEFAULT_HF_TOKEN', originalDefaultHfToken);
		restoreEnv('HF_TOKEN', originalHfToken);
		restoreEnv('LOGGING_HF_TOKEN', originalLoggingHfToken);
	});

	it('uses only PROXY_TOKEN for proxy authentication', () => {
		process.env.PROXY_TOKEN = 'hf_proxy_token';
		process.env.DEFAULT_HF_TOKEN = 'hf_default_token';
		process.env.HF_TOKEN = 'hf_user_token';
		process.env.LOGGING_HF_TOKEN = 'hf_logging_token';

		expect(getProxyToken()).toBe('hf_proxy_token');
	});

	it('does not fall back to user, default, or logging tokens', () => {
		delete process.env.PROXY_TOKEN;
		process.env.DEFAULT_HF_TOKEN = 'hf_default_token';
		process.env.HF_TOKEN = 'hf_user_token';
		process.env.LOGGING_HF_TOKEN = 'hf_logging_token';

		expect(getProxyToken()).toBeUndefined();
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}
