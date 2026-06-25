import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_DENIED_CLIENTS,
	RESOURCES_CLIENT_DENYLIST_ENV,
	getDeniedClients,
	isClientDenied,
} from '../../src/shared/client-denylist.js';

const ENV = RESOURCES_CLIENT_DENYLIST_ENV;
const original = process.env[ENV];

afterEach(() => {
	if (original === undefined) delete process.env[ENV];
	else process.env[ENV] = original;
});

describe('client-denylist', () => {
	it('denies cursor-vscode by default', () => {
		delete process.env[ENV];
		expect(DEFAULT_DENIED_CLIENTS).toContain('cursor-vscode');
		expect(getDeniedClients()).toEqual(['cursor-vscode']);
		expect(isClientDenied('cursor-vscode')).toBe(true);
	});

	it('matches case-insensitively and as a substring on clientInfo.name', () => {
		delete process.env[ENV];
		expect(isClientDenied('Cursor-VSCode')).toBe(true);
		expect(isClientDenied('cursor-vscode (via mcp-remote 0.1.37)')).toBe(true);
	});

	it('matches on the user-agent when clientInfo.name is absent', () => {
		delete process.env[ENV];
		expect(isClientDenied(undefined, 'cursor-vscode (via mcp-remote 0.1.37)')).toBe(true);
		expect(isClientDenied(undefined, 'node-fetch')).toBe(false);
	});

	it('does not deny other clients', () => {
		delete process.env[ENV];
		expect(isClientDenied('fast-agent-mcp')).toBe(false);
		expect(isClientDenied('claude-ai', 'some-agent/1.0')).toBe(false);
		expect(isClientDenied()).toBe(false);
	});

	it('env var replaces the default list (extend with more clients)', () => {
		process.env[ENV] = 'cursor-vscode, foo-client';
		expect(getDeniedClients()).toEqual(['cursor-vscode', 'foo-client']);
		expect(isClientDenied('cursor-vscode')).toBe(true);
		expect(isClientDenied('foo-client')).toBe(true);
	});

	it('empty env var disables the denylist entirely', () => {
		process.env[ENV] = '';
		expect(getDeniedClients()).toEqual([]);
		expect(isClientDenied('cursor-vscode')).toBe(false);
	});

	it('env var can drop cursor and target only another client', () => {
		process.env[ENV] = 'only-this';
		expect(isClientDenied('cursor-vscode')).toBe(false);
		expect(isClientDenied('only-this')).toBe(true);
	});
});
