import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { createProxyServerFactory } from '../../src/server/mcp-proxy.js';
import { StatelessHttpTransport } from '../../src/server/transport/stateless-http-transport.js';
import { StdioTransport } from '../../src/server/transport/stdio-transport.js';
import { fetchHfWhoami, HfWhoamiRequestError, type HfWhoamiResponse } from '../../src/server/utils/hf-whoami-client.js';
import { verifyMcpAuthorization } from '../../src/server/utils/mcp-authorization.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';

vi.mock('../../src/server/utils/hf-whoami-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/server/utils/hf-whoami-client.js')>();
	return { ...actual, fetchHfWhoami: vi.fn() };
});

function identity(authType = 'oauth'): HfWhoamiResponse {
	return { id: 'user-id', type: 'user', name: 'alice', orgs: [], auth: { type: authType } };
}

function oauthToken(scope: unknown): string {
	return `hf_oauth_header.${Buffer.from(JSON.stringify({ scope })).toString('base64url')}.signature`;
}

function apiClient() {
	return new McpApiClient(
		{ type: 'static' },
		{
			transport: 'streamableHttpJson',
			port: 3000,
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		}
	);
}

beforeEach(() => {
	vi.mocked(fetchHfWhoami).mockReset();
	vi.mocked(fetchHfWhoami).mockImplementation(async () => identity());
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const deniedScopes = [
	undefined,
	null,
	1,
	{},
	[],
	'',
	['openid'],
	['read-mcp-extra'],
	['write-mcp'],
	['READ-MCP'],
	['read-mcp', 1],
	['read-mcp', ''],
	[' read-mcp '],
	{ 'read-mcp': true },
	'openid\tread-mcp',
];

describe('validated MCP OAuth authorization', () => {
	it.each(deniedScopes.map((scope) => [scope]))('rejects missing, malformed or non-exact scope %j', async (scope) => {
		const token = oauthToken(scope);
		await expect(verifyMcpAuthorization(token)).rejects.toMatchObject({ statusCode: 403 });
		expect(fetchHfWhoami).toHaveBeenCalledWith(token);
	});

	it.each([['read-mcp'], ['openid', 'read-mcp'], 'openid read-mcp'].map((scope) => [scope]))(
		'accepts exact scope %j only after verification',
		async (scope) => {
			await expect(verifyMcpAuthorization(oauthToken(scope))).resolves.toMatchObject({ name: 'alice' });
			expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		}
	);

	it.each(['hf_oauth_not-a-jwt', 'hf_oauth__refresh_token', 'hf_opaque-oauth'])(
		'does not bypass OAuth policy with %s',
		async (token) => {
			await expect(verifyMcpAuthorization(token)).rejects.toMatchObject({ statusCode: 403 });
		}
	);

	it.each(['access_token', 'app_token'])('uses the OAuth token prefix even when identity reports %s', async (type) => {
		vi.mocked(fetchHfWhoami).mockResolvedValue(identity(type));
		await expect(verifyMcpAuthorization(oauthToken(['write-repos']))).rejects.toMatchObject({ statusCode: 403 });
	});

	it.each(['read', 'write', 'fineGrained'])('preserves verified %s PAT compatibility', async (role) => {
		const user = identity('access_token');
		user.auth.accessToken = { displayName: 'test', role, createdAt: '2026-01-01T00:00:00.000Z' };
		vi.mocked(fetchHfWhoami).mockResolvedValue(user);
		await expect(verifyMcpAuthorization('hf_pat')).resolves.toBe(user);
	});

	it('preserves verified app-token compatibility using the whoami fixture shape', async () => {
		const app: HfWhoamiResponse = {
			id: 'app-id',
			type: 'app',
			name: 'automation-app',
			scope: { role: 'contributor', entities: [{ type: 'bucket', name: 'org/bucket' }] },
			auth: { type: 'app_token' },
		};
		vi.mocked(fetchHfWhoami).mockResolvedValue(app);
		await expect(verifyMcpAuthorization('hf_app-token')).resolves.toBe(app);
	});

	it.each(['alternate_authentication_method', 'unknown', 'ACCESS_TOKEN', 'app-token', ''])(
		'rejects unsupported credential type %j even with an OAuth scope claim',
		async (authType) => {
			const user = identity(authType);
			// Backing PAT metadata must not grant PAT policy to an unknown auth type.
			user.auth.accessToken = { displayName: 'Backing token', role: 'read', createdAt: '2026-01-01T00:00:00.000Z' };
			vi.mocked(fetchHfWhoami).mockResolvedValue(user);
			for (const token of ['hf_opaque', oauthToken(['read-mcp']), oauthToken([])]) {
				await expect(verifyMcpAuthorization(token)).rejects.toMatchObject({
					statusCode: 401,
					message: 'Unsupported Hugging Face credential type.',
				});
			}
		}
	);

	it.each([
		[new HfWhoamiRequestError('http', 401), 401],
		[new HfWhoamiRequestError('http', 500), 503],
		[new HfWhoamiRequestError('invalid_response'), 503],
		[new Error('network unavailable'), 503],
	])('never treats a locally decoded claim as validation (%j)', async (error, statusCode) => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(error);
		await expect(verifyMcpAuthorization(oauthToken(['read-mcp']))).rejects.toMatchObject({ statusCode });
	});
});

describe('bounded verification handoff', () => {
	it('always validates fresh when no context identity is supplied (HTTP entry)', async () => {
		const token = oauthToken(['read-mcp']);
		await verifyMcpAuthorization(token);
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));
		await expect(verifyMcpAuthorization(token)).rejects.toMatchObject({ statusCode: 401 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it('allows only two reuses, then requires fresh Hub validation', async () => {
		const token = oauthToken(['read-mcp']);
		const user = await verifyMcpAuthorization(token);
		await expect(verifyMcpAuthorization(token, user)).resolves.toBe(user);
		await expect(verifyMcpAuthorization(token, user)).resolves.toBe(user);
		expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));
		await expect(verifyMcpAuthorization(token, user)).rejects.toMatchObject({ statusCode: 401 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it('expires after 30 seconds without extending the window on reuse', async () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
		const token = oauthToken(['read-mcp']);
		const user = await verifyMcpAuthorization(token);
		clock.mockReturnValue(30_999);
		await expect(verifyMcpAuthorization(token, user)).resolves.toBe(user);
		expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(31_000);
		vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
		await expect(verifyMcpAuthorization(token, user)).rejects.toMatchObject({ statusCode: 503 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it('does not transfer provenance to a copied identity', async () => {
		const token = oauthToken(['read-mcp']);
		const user = await verifyMcpAuthorization(token);
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));
		await expect(verifyMcpAuthorization(token, structuredClone(user))).rejects.toMatchObject({ statusCode: 401 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it.each(['principal', 'auth type', 'nested permissions'] as const)(
		'revalidates rather than trusting a mutated %s',
		async (mutation) => {
			const user = identity('access_token');
			user.auth.accessToken = { displayName: 'test', role: 'read', createdAt: '2026-01-01T00:00:00.000Z' };
			vi.mocked(fetchHfWhoami).mockResolvedValueOnce(user);
			await verifyMcpAuthorization('hf_pat');
			if (mutation === 'principal') user.name = 'mallory';
			if (mutation === 'auth type') user.auth.type = 'app_token';
			if (mutation === 'nested permissions') user.auth.accessToken.role = 'write';
			const freshUser = identity('access_token');
			vi.mocked(fetchHfWhoami).mockResolvedValueOnce(freshUser);
			await expect(verifyMcpAuthorization('hf_pat', user)).resolves.toBe(freshUser);
			expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
			expect(fetchHfWhoami).toHaveBeenLastCalledWith('hf_pat');
		}
	);
});

describe('factory and STDIO fail-closed boundary', () => {
	it.each(['direct', 'stdio'] as const)('rejects unavailable auth before any %s tool/settings setup', async (mode) => {
		const token = oauthToken(['read-mcp']);
		vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
		const api = apiClient();
		const settings = vi.spyOn(api, 'getSettings');
		const factory = createServerFactory(api);
		vi.stubEnv('DEFAULT_HF_TOKEN', token);
		const stdio = new StdioTransport(factory, express());
		const result =
			mode === 'stdio'
				? stdio.initialize()
				: factory({ authorization: `Bearer ${token}` }, undefined, false, {
						isAuthenticated: true,
						authenticatedUser: identity(),
					});
		await expect(result).rejects.toMatchObject({ statusCode: 503 });
		expect(settings).not.toHaveBeenCalled();
		expect(stdio.getSession()).toBeUndefined();
	});

	it.each([undefined, ['write-repos'], ['read-mcp-extra'], ['read-mcp', null]])(
		'fails STDIO startup on scope %j',
		async (scope) => {
			vi.stubEnv('DEFAULT_HF_TOKEN', oauthToken(scope));
			const stdio = new StdioTransport(createServerFactory(apiClient()), express());
			await expect(stdio.initialize()).rejects.toMatchObject({ statusCode: 403 });
			expect(stdio.getSession()).toBeUndefined();
		}
	);

	it('fails STDIO startup for an invalid PAT', async () => {
		vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_invalid');
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));
		await expect(new StdioTransport(createServerFactory(apiClient()), express()).initialize()).rejects.toMatchObject({
			statusCode: 401,
		});
	});

	it.each(['hf_pat', oauthToken(['read-mcp'])])('constructs a verified STDIO factory with %s', async (token) => {
		vi.stubEnv('DEFAULT_HF_TOKEN', token);
		vi.mocked(fetchHfWhoami).mockResolvedValue(identity(token === 'hf_pat' ? 'access_token' : 'oauth'));
		const result = await createServerFactory(apiClient())(null, { builtInTools: [], spaceTools: [] }, true);
		expect(result.isAuthenticated).toBe(true);
		expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		await result.server.close();
	});

	it('reuses verified HTTP identity without duplicate whoami but rechecks its scope', async () => {
		const token = oauthToken(['read-mcp']);
		const user = await verifyMcpAuthorization(token);
		const factory = createServerFactory(apiClient());
		const result = await factory({ authorization: `Bearer ${token}` }, { builtInTools: [], spaceTools: [] }, true, {
			authenticatedUser: user,
			isAuthenticated: false,
		});
		expect(result.isAuthenticated).toBe(true);
		expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		await result.server.close();

		// A different bearer cannot reuse provenance of the previous identity.
		await expect(
			factory({ authorization: `Bearer ${oauthToken(['write-repos'])}` }, undefined, true, {
				authenticatedUser: user,
				isAuthenticated: true,
			})
		).rejects.toMatchObject({ statusCode: 403 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it('revalidates a mutated context identity and still enforces OAuth scope', async () => {
		const user = identity('access_token');
		vi.mocked(fetchHfWhoami).mockResolvedValue(user);
		await verifyMcpAuthorization('hf_opaque');
		user.auth.type = 'oauth';
		await expect(
			createServerFactory(apiClient())({ authorization: 'Bearer hf_opaque' }, undefined, true, {
				authenticatedUser: user,
			})
		).rejects.toMatchObject({ statusCode: 403 });
		expect(fetchHfWhoami).toHaveBeenCalledTimes(2);
	});

	it('rejects direct proxy construction before fetching settings or constructing the inner server', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
		const api = apiClient();
		const settings = vi.spyOn(api, 'getSettings');
		const inner = vi.fn(createServerFactory(api));
		await expect(createProxyServerFactory(api, inner)({ authorization: 'Bearer hf_pat' })).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(settings).not.toHaveBeenCalled();
		expect(inner).not.toHaveBeenCalled();
	});

	it('does not treat anonymous context flags or server default credentials as HTTP authentication', async () => {
		vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_server-secret');
		const result = await createServerFactory(apiClient())({}, { builtInTools: [], spaceTools: [] }, true, {
			isAuthenticated: true,
			authenticatedUser: identity(),
		});
		expect(result.isAuthenticated).toBe(false);
		expect(fetchHfWhoami).not.toHaveBeenCalled();
		await result.server.close();
	});
});

describe.each(['2026-07-28', '2025-03-26'])('HTTP auth rejection (%s)', (version) => {
	it.each(['hf_pat', oauthToken(['read-mcp'])])('accepts verified %s without duplicate HTTP whoami', async (token) => {
		vi.mocked(fetchHfWhoami).mockResolvedValue(identity(token === 'hf_pat' ? 'access_token' : 'oauth'));
		const api = apiClient();
		const factory = vi.fn(createProxyServerFactory(api, createServerFactory(api)));
		const app = express();
		app.use(express.json());
		const transport = new StatelessHttpTransport(factory, app);
		await transport.initialize();
		const httpServer = app.listen(0);
		await once(httpServer, 'listening');
		try {
			const address = httpServer.address();
			if (!address || typeof address === 'string') throw new Error('Expected TCP address');
			const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
				method: 'POST',
				headers: {
					accept: 'application/json, text/event-stream',
					'content-type': 'application/json',
					'mcp-protocol-version': version,
					'mcp-method': 'tools/call',
					'mcp-name': 'hf_whoami',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'hf_whoami',
						arguments: {},
						...(version === '2026-07-28'
							? {
									_meta: {
										'io.modelcontextprotocol/protocolVersion': version,
										'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1.0.0' },
										'io.modelcontextprotocol/clientCapabilities': {},
									},
								}
							: {}),
					},
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('authenticated');
			expect(factory).toHaveBeenCalledTimes(1);
			expect(fetchHfWhoami).toHaveBeenCalledTimes(1);
		} finally {
			await transport.cleanup();
			await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it.each([
		['unavailable', 503],
		['invalid', 401],
		['unsupported', 401],
		['scope', 403],
		['malformed-bearer', 401],
	] as const)('rejects %s before server/proxy/sensitive tool dispatch', async (failure, status) => {
		if (failure === 'unsupported') vi.mocked(fetchHfWhoami).mockResolvedValue(identity('unknown'));
		if (failure === 'unavailable') vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
		if (failure === 'invalid') vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));
		const factory = vi.fn(createServerFactory(apiClient()));
		const app = express();
		app.use(express.json());
		const transport = new StatelessHttpTransport(factory, app);
		await transport.initialize();
		const httpServer = app.listen(0);
		await once(httpServer, 'listening');
		try {
			const address = httpServer.address();
			if (!address || typeof address === 'string') throw new Error('Expected TCP address');
			for (const name of [
				'hf_jobs',
				'hf_sandbox',
				'hf_sandbox_exec',
				'hf_sandbox_fs',
				'hf_fs_write',
				'create_repo',
				'remote_proxy',
			]) {
				const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-protocol-version': version,
						'mcp-method': 'tools/call',
						'mcp-name': name,
						authorization:
							failure === 'malformed-bearer'
								? 'Bearer'
								: `Bearer ${oauthToken(failure === 'scope' ? [] : ['read-mcp'])}`,
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
				});
				expect(response.status).toBe(status);
				const challenge = response.headers.get('www-authenticate');
				if (status === 503) expect(challenge).toBeNull();
				else expect(challenge).toContain('Bearer resource_metadata=');
				if (status === 403) expect(challenge).toContain('error="insufficient_scope", scope="read-mcp"');
				const body = await response.text();
				if (failure === 'unsupported') {
					expect(challenge).not.toContain('insufficient_scope');
					// HTTP deliberately maps all 401s to a generic response.
					expect(body).toBe('Unauthorized');
				}
			}
			for (const method of ['GET', 'DELETE']) {
				const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method,
					headers: {
						authorization:
							failure === 'malformed-bearer'
								? 'Bearer'
								: `Bearer ${oauthToken(failure === 'scope' ? [] : ['read-mcp'])}`,
					},
				});
				expect(response.status).toBe(status);
				await response.text();
			}
			expect(factory).not.toHaveBeenCalled();
		} finally {
			await transport.cleanup();
			await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
