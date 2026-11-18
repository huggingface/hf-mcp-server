import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { createProxyServerFactory, registerProxyToolsFromConfig } from '../../src/server/mcp-proxy.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import { createProxyAppResourceUri } from '../../src/server/utils/proxy-apps.js';
import { getProxyToolsConfig, type ProxyToolDefinition } from '../../src/server/utils/proxy-tools-config.js';
import { logToolQuery } from '../../src/server/utils/query-logger.js';
import {
	callStreamableHttpTool,
	readStreamableHttpResource,
} from '../../src/server/utils/streamable-http-tool-caller.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import type { ServerFactory } from '../../src/server/transport/base-transport.js';

vi.mock('../../src/server/utils/streamable-http-tool-caller.js', () => ({
	callStreamableHttpTool: vi.fn(),
	readStreamableHttpResource: vi.fn(),
}));
vi.mock('../../src/server/utils/proxy-tools-config.js', () => ({
	getProxyToolsConfig: vi.fn(),
}));
vi.mock('../../src/server/utils/query-logger.js', () => ({
	logToolQuery: vi.fn(),
}));

const HF_TOKEN = 'hf_dummy_caller_token';
const UPSTREAM_URI = 'ui://remote/app.html';

function proxyConfig(overrides: Partial<ProxyToolDefinition> = {}): ProxyToolDefinition {
	return {
		proxyId: 'remote',
		toolName: 'remote_action',
		upstreamToolName: 'action',
		url: 'https://upstream.example/mcp',
		inputSchema: { type: 'object', properties: {} },
		meta: { ui: { resourceUri: UPSTREAM_URI }, hfProxy: { discoveredFrom: 'remote_discovery' } },
		...overrides,
	};
}

function createServer(): McpServer {
	return new McpServer({ name: 'proxy-policy-test', version: '1.0.0' });
}

async function withClient(server: McpServer, run: (client: Client) => Promise<void>): Promise<void> {
	const client = new Client({ name: 'policy-test-client', version: '1.0.0' });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(st), client.connect(ct)]);
		await run(client);
	} finally {
		await client.close();
		await server.close();
	}
}

async function invokeProxy(client: Client): Promise<void> {
	const tool = (await client.listTools()).tools.find((tool) => tool.name === 'remote_action');
	expect(tool).toBeDefined();
	const localUri = createProxyAppResourceUri('remote', UPSTREAM_URI);
	expect(tool?._meta?.ui).toEqual({ resourceUri: localUri });
	expect((await client.callTool({ name: 'remote_action', arguments: {} })).isError).not.toBe(true);
	expect((await client.readResource({ uri: localUri })).contents).toEqual([
		{ uri: localUri, mimeType: 'text/html;profile=mcp-app', text: '<html>dummy app</html>' },
	]);
}

function expectDownstreamToken(token: string | undefined): void {
	expect(callStreamableHttpTool).toHaveBeenLastCalledWith(
		'https://upstream.example/mcp',
		'action',
		{},
		token,
		undefined
	);
	expect(readStreamableHttpResource).toHaveBeenLastCalledWith('https://upstream.example/mcp', UPSTREAM_URI, token);
}

beforeEach(() => {
	vi.stubEnv('DISABLE_TOOLS', '');
	vi.stubEnv('PROXY_TOKEN', 'hf_dummy_startup_token');
	vi.mocked(callStreamableHttpTool).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
	vi.mocked(readStreamableHttpResource).mockResolvedValue({
		contents: [{ uri: UPSTREAM_URI, mimeType: 'text/html;profile=mcp-app', text: '<html>dummy app</html>' }],
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('runtime proxy access policy', () => {
	const selections = [undefined, ['remote'], ['remote_action'], ['remote_discovery']];
	for (const allowAnonymous of [undefined, false]) {
		it.each(selections.map((enabledToolIds) => ({ enabledToolIds })))(
			`rejects anonymous direct calls regardless of selection when allowAnonymous=${String(allowAnonymous)} (%j)`,
			async ({ enabledToolIds }) => {
				const server = createServer();
				// Keep list methods available so we can verify proxy tools AND resources are absent.
				server.registerTool('local', { inputSchema: {} }, async () => ({ content: [] }));
				server.registerResource('local', 'test://local', {}, async () => ({ contents: [] }));
				registerProxyToolsFromConfig(server, [proxyConfig({ allowAnonymous })], undefined, enabledToolIds, {
					isAuthenticated: true, // Logging context is not an authentication credential.
				});

				await withClient(server, async (client) => {
					expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['local']);
					expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(['test://local']);
					await expect(client.callTool({ name: 'remote_action', arguments: {} })).rejects.toThrow();
					await expect(
						client.readResource({ uri: createProxyAppResourceUri('remote', UPSTREAM_URI) })
					).rejects.toThrow();
				});
				expect(callStreamableHttpTool).not.toHaveBeenCalled();
				expect(readStreamableHttpResource).not.toHaveBeenCalled();
			}
		);
	}

	it.each([undefined, true, false])(
		'allows explicit public access without credentials (forward=%s)',
		async (forwardHfToken) => {
			const server = createServer();
			registerProxyToolsFromConfig(server, [proxyConfig({ allowAnonymous: true, forwardHfToken })], undefined);
			await withClient(server, invokeProxy);
			expectDownstreamToken(undefined);
		}
	);

	it('still honors disabled tools and empty selections for authenticated callers', async () => {
		vi.stubEnv('DISABLE_TOOLS', 'remote_action');
		for (const enabledToolIds of [undefined, []]) {
			const server = createServer();
			const registerTool = vi.spyOn(server, 'registerTool');
			const registerResource = vi.spyOn(server, 'registerResource');
			registerProxyToolsFromConfig(server, [proxyConfig()], HF_TOKEN, enabledToolIds);
			expect(registerTool).not.toHaveBeenCalled();
			expect(registerResource).not.toHaveBeenCalled();
			await server.close();
		}
		vi.stubEnv('DISABLE_TOOLS', '');
		const server = createServer();
		const registerTool = vi.spyOn(server, 'registerTool');
		registerProxyToolsFromConfig(server, [proxyConfig()], HF_TOKEN, []);
		expect(registerTool).not.toHaveBeenCalled();
		await server.close();
	});
});

describe('runtime proxy credential forwarding', () => {
	for (const allowAnonymous of [undefined, false, true]) {
		it.each([undefined, true, false])(
			`allows authenticated access with allowAnonymous=${String(allowAnonymous)}, forwarding=%s`,
			async (forwardHfToken) => {
				const server = createServer();
				registerProxyToolsFromConfig(server, [proxyConfig({ allowAnonymous, forwardHfToken })], HF_TOKEN, ['remote']);
				await withClient(server, invokeProxy);
				expectDownstreamToken(forwardHfToken === false ? undefined : HF_TOKEN);
			}
		);
	}

	it('keeps authenticated discovery/settings and logging context when downstream forwarding is disabled', async () => {
		const config = proxyConfig({ allowAnonymous: false, forwardHfToken: false });
		vi.mocked(getProxyToolsConfig).mockReturnValue([config]);
		const api = new McpApiClient({ type: 'external', externalUrl: 'https://settings.example' });
		const getSettings = vi.spyOn(api, 'getSettings').mockResolvedValue(DEFAULT_SETTINGS);
		const originalFactory = vi.fn<ServerFactory>(async () => ({
			server: createServer(),
			enabledToolIds: ['remote'],
		}));
		const headers = { authorization: `Bearer ${HF_TOKEN}`, 'x-mcp-gradio': 'none' };
		const context = { isAuthenticated: true, userHash: 'dummy-user', requestId: 'dummy-request' };
		const { server } = await createProxyServerFactory(api, originalFactory)(headers, undefined, false, context);

		expect(getSettings).toHaveBeenCalledWith(HF_TOKEN);
		expect(originalFactory).toHaveBeenCalledWith(headers, DEFAULT_SETTINGS, false, context);
		await withClient(server, invokeProxy);
		expectDownstreamToken(undefined);
		expect(logToolQuery).toHaveBeenCalledWith(
			'remote_action',
			'action',
			{},
			expect.objectContaining({ ...context, success: true })
		);
		expect(headers.authorization).toBe(`Bearer ${HF_TOKEN}`);
	});

	it('does not mutate shared configuration or leak credentials between request registrations', async () => {
		const config = Object.freeze(proxyConfig({ allowAnonymous: true, forwardHfToken: true }));
		const snapshot = JSON.stringify(config);
		const first = createServer();
		const second = createServer();
		const anonymous = createServer();
		registerProxyToolsFromConfig(first, [config], HF_TOKEN);
		registerProxyToolsFromConfig(second, [config], 'hf_dummy_second_caller');
		registerProxyToolsFromConfig(anonymous, [config], undefined);
		await withClient(first, invokeProxy);
		expectDownstreamToken(HF_TOKEN);
		await withClient(second, invokeProxy);
		expectDownstreamToken('hf_dummy_second_caller');
		await withClient(anonymous, invokeProxy);
		expectDownstreamToken(undefined);
		expect(JSON.stringify(config)).toBe(snapshot);
	});

	it('keeps the first duplicate registration and its resource forwarding policy', async () => {
		const server = createServer();
		registerProxyToolsFromConfig(
			server,
			[proxyConfig({ forwardHfToken: false }), proxyConfig({ forwardHfToken: true })],
			HF_TOKEN
		);
		// Exercise the existing-server duplicate guard as well as duplicates within one config list.
		registerProxyToolsFromConfig(server, [proxyConfig({ forwardHfToken: true })], HF_TOKEN);
		await withClient(server, async (client) => {
			expect((await client.listTools()).tools).toHaveLength(1);
			expect((await client.listResources()).resources).toHaveLength(1);
			await invokeProxy(client);
		});
		expectDownstreamToken(undefined);
	});
});
