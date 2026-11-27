import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PTC_INSTRUCTIONS, callPtcTool, ptcToolsForAccess } from '@llmindset/hf-mcp';
import { StatelessHttpTransport } from '../../../src/server/transport/stateless-http-transport.js';
import { createServerFactory } from '../../../src/server/mcp-server.js';
import { createProxyServerFactory } from '../../../src/server/mcp-proxy.js';
import { McpApiClient } from '../../../src/server/utils/mcp-api-client.js';
import {
	TAG,
	KNOWN_TAGS,
	TAG_MISMATCH,
	resetDefinitionTagsMemo,
	toolsTag,
} from '../../../src/server/definition-tags/index.js';
import * as whoami from '../../../src/server/utils/hf-whoami-client.js';
import * as proxyConfig from '../../../src/server/utils/proxy-tools-config.js';
import * as gradioDiscovery from '../../../src/server/utils/gradio-discovery.js';

vi.mock('@llmindset/hf-mcp', async (importOriginal) => ({
	...(await importOriginal<typeof import('@llmindset/hf-mcp')>()),
	callPtcTool: vi.fn(),
}));

// Anonymous lists public tools; the mocked whoami (oauth, no read-only role) lists write tools.
const names = (authenticated: boolean) => ptcToolsForAccess(authenticated ? 'write' : 'anonymous').map((t) => t.name);
const ERAS = ['2026-07-28', '2025-11-25'] as const;
const page = {
	items: [],
	nextCursor: null,
	returnedCount: 0,
	completeness: { hasMore: false },
};

beforeEach(() => {
	vi.stubEnv('DISABLE_TOOLS', '');
	vi.stubEnv('DEFINITION_TAGS', 'on');
	vi.stubEnv('MCP_STRICT_TOKEN', 'false');
	vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_server_default_must_not_leak');
	resetDefinitionTagsMemo();
	vi.mocked(callPtcTool).mockResolvedValue({
		structured: page,
		content: [{ type: 'text', text: JSON.stringify(page) }],
	});
	vi.spyOn(whoami, 'fetchHfWhoami').mockResolvedValue({
		id: 'alice-id',
		type: 'user',
		name: 'alice',
		orgs: [],
		auth: { type: 'oauth' },
	});
	vi.spyOn(proxyConfig, 'getProxyToolsConfig').mockReturnValue([
		{ proxyId: 'proxy', toolName: 'hf_models_search', upstreamToolName: 'collision', url: 'https://proxy.example/mcp' },
		{ proxyId: 'proxy', toolName: 'proxy_upload', upstreamToolName: 'upload', url: 'https://proxy.example/mcp' },
	]);
	vi.spyOn(gradioDiscovery, 'getGradioSpaces');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

async function withHttp(
	version: (typeof ERAS)[number],
	bouquet: string,
	authenticated: boolean,
	run: (client: Client, factory: ReturnType<typeof vi.fn<ReturnType<typeof createServerFactory>>>) => Promise<void>,
	extraQuery = ''
): Promise<void> {
	const api = new McpApiClient({ type: 'external', externalUrl: 'https://settings.example/private' });
	const settings = vi.spyOn(api, 'getSettings').mockRejectedValue(new Error('No settings request permitted'));
	const factory = vi.fn(createProxyServerFactory(api, createServerFactory(api)));
	const app = express();
	app.use(express.json());
	const transport = new StatelessHttpTransport(factory, app);
	await transport.initialize();
	const http = app.listen(0);
	await new Promise<void>((resolve) => http.once('listening', resolve));
	const address = http.address();
	if (!address || typeof address === 'string') throw new Error('Missing port');
	const client = new Client(
		{ name: 'ptc-http-test', version: '1' },
		{ versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } }
	);
	try {
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${address.port}/mcp?bouquet=${bouquet}&gradio=owner/space${extraQuery}`),
				{ requestInit: authenticated ? { headers: { authorization: 'Bearer hf_request_token' } } : undefined }
			)
		);
		await run(client, factory);
		expect(settings).not.toHaveBeenCalled();
		expect(gradioDiscovery.getGradioSpaces).not.toHaveBeenCalled();
	} finally {
		await client.close();
		await transport.cleanup();
		await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
	}
}

describe.each(ERAS)('PTC HTTP execution boundary (%s)', (version) => {
	it.each([
		'bouquet=ptc&mix=search',
		'bouquet=codemode&mix=all,proxy',
		'bouquet=openaiptc&mix=search',
		'bouquet=search&mix=ptc',
		'mix=codemode',
		'mix=openaiptc',
		'bouquet=ptc&mix=search&mix=proxy',
		'bouquet=search&mix=proxy&mix=codemode',
	])('rejects mixing with HTTP 400 before creating a server: %s', async (query) => {
		const factory = vi.fn<ReturnType<typeof createServerFactory>>();
		const app = express();
		app.use(express.json());
		const transport = new StatelessHttpTransport(factory, app);
		await transport.initialize();
		const http = app.listen(0);
		await new Promise<void>((resolve) => http.once('listening', resolve));
		const address = http.address();
		if (!address || typeof address === 'string') throw new Error('Missing port');
		try {
			for (const method of ['initialize', 'server/discover', 'tools/list', 'tools/call']) {
				for (const useHeaders of [false, true]) {
					const selectionHeaders: Record<string, string> = {};
					if (useHeaders) {
						const params = new URLSearchParams(query);
						const bouquet = params.get('bouquet');
						if (bouquet) selectionHeaders['x-mcp-bouquet'] = bouquet;
						selectionHeaders['x-mcp-mix'] = params.getAll('mix').join(',');
					}
					const response = await fetch(`http://127.0.0.1:${address.port}/mcp${useHeaders ? '' : '?' + query}`, {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
							'mcp-protocol-version': version,
							...selectionHeaders,
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 1,
							method,
							params:
								method === 'initialize'
									? { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }
									: method === 'tools/call'
										? { name: 'hf_models_search', arguments: {} }
										: {},
						}),
					});
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({
						id: 1,
						error: { code: -32600, message: expect.stringContaining('cannot be mixed') },
					});
				}
			}
			expect(factory).not.toHaveBeenCalled();
		} finally {
			await transport.cleanup();
			await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it.each([
		['ptc', false],
		['ptc', true],
		['codemode', false],
		['codemode', true],
		['openaiptc', false],
		['openaiptc', true],
	] as const)(
		'lists only PTC tools and keeps direct/tagged calls isolated: %s auth=%s',
		async (bouquet, authenticated) => {
			await withHttp(version, bouquet, authenticated, async (client, factory) => {
				const listing = await client.listTools();
				expect(listing.tools.map((tool) => tool.name)).toEqual(names(authenticated));
				// Token permission changes the list, so only anonymous PTC requests are tagged.
				expect(listing[TAG]).toBe(authenticated ? undefined : toolsTag(listing.tools));
				const tags: Record<string, string> = authenticated ? {} : { 'tools/list': listing[TAG] as string };
				if (version === '2026-07-28') {
					const discovery = await client.request({ method: 'server/discover' });
					expect(discovery.instructions).toBe(PTC_INSTRUCTIONS);
					if (!authenticated) tags['server/discover'] = discovery[TAG] as string;
				}
				// Unchecked, warm-memo and cold-memo calls must use the same boundary.
				for (const path of authenticated ? ['direct'] : ['direct', 'warm', 'cold']) {
					const checked = path !== 'direct';
					if (path === 'cold') resetDefinitionTagsMemo();
					const result = await client.callTool({
						name: 'hf_models_search',
						arguments: {},
						...(checked ? { _meta: { [KNOWN_TAGS]: tags } } : {}),
					});
					expect(result.structuredContent).toEqual(page);
					expect(factory.mock.calls.at(-1)?.[0]?.['x-mcp-bouquet']).toBe(bouquet);
					expect(factory.mock.calls.at(-1)?.[2]).toBe(true);
					expect(vi.mocked(callPtcTool).mock.calls.at(-1)?.[2]).toMatchObject({
						hfToken: authenticated ? 'hf_request_token' : undefined,
						signal: expect.any(AbortSignal),
					});
				}
				for (const name of [
					'hf_fs',
					'hub_repo_search',
					'hub_repo_details',
					'hf_sandbox',
					'dynamic_space',
					'gr1_owner_space',
					'proxy_upload',
				]) {
					for (const checked of authenticated ? [false] : [false, true]) {
						await expect(
							client.callTool({
								name,
								arguments: { operation: 'invoke' },
								...(checked ? { _meta: { [KNOWN_TAGS]: tags } } : {}),
							})
						).rejects.toThrow();
						expect(factory.mock.calls.at(-1)?.[0]?.['x-mcp-bouquet']).toBe(bouquet);
					}
				}
				expect(callPtcTool).toHaveBeenCalledTimes(authenticated ? 1 : 3);
				if (authenticated) expect(whoami.fetchHfWhoami).toHaveBeenCalledWith('hf_request_token');
				else expect(whoami.fetchHfWhoami).not.toHaveBeenCalled();

				// Disabled selection invalidates memo; unchecked calls remain disabled too.
				vi.stubEnv('DISABLE_TOOLS', 'hf_models_search');
				if (!authenticated) {
					await expect(
						client.callTool({ name: 'hf_models_search', arguments: {}, _meta: { [KNOWN_TAGS]: tags } })
					).rejects.toMatchObject({ code: TAG_MISMATCH });
				}
				await expect(client.callTool({ name: 'hf_models_search', arguments: {} })).rejects.toThrow();
				expect((await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((tool) => tool.name)).toEqual(
					names(authenticated).filter((name) => name !== 'hf_models_search')
				);
			});
		}
	);

	it('retains profile selection when tags are off, including discovery fallback', async () => {
		vi.stubEnv('DEFINITION_TAGS', 'off');
		await withHttp(version, 'ptc', false, async (client) => {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names(false));
			if (version === '2026-07-28') {
				const discovery = await client.request({ method: 'server/discover' });
				expect(discovery.instructions).toBe(PTC_INSTRUCTIONS);
			}
			await expect(client.callTool({ name: 'hub_repo_search', arguments: {} })).rejects.toThrow();
			expect((await client.callTool({ name: 'hf_models_search', arguments: {} })).structuredContent).toEqual(page);
		});
	});

	it('honors anon on an authenticated client without inheriting the server token', async () => {
		await withHttp(
			version,
			'codemode',
			true,
			async (client) => {
				await client.callTool({ name: 'hf_models_search', arguments: {} });
				expect(vi.mocked(callPtcTool).mock.calls.at(-1)?.[2]?.hfToken).toBeUndefined();
				expect(whoami.fetchHfWhoami).not.toHaveBeenCalled();
			},
			'&anon'
		);
	});
});
