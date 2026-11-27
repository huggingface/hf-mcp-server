import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
	ALL_BUILTIN_TOOL_IDS,
	JobsApiClient,
	PTC_INSTRUCTIONS,
	PTC_TOOL_NAMES,
	PtcError,
	callPtcTool,
	getPtcTool,
	ptcToolsForAccess,
} from '@llmindset/hf-mcp';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { createProxyServerFactory } from '../../src/server/mcp-proxy.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import { ToolSelectionStrategy } from '../../src/server/utils/tool-selection-strategy.js';
import {
	getDirectToolCallSettings,
	withoutDiscoverySelectionHeaders,
} from '../../src/server/utils/direct-tool-settings.js';
import { definitionTagsPolicy } from '../../src/server/definition-tags/policy.js';
import { definitionTagsMemoKey } from '../../src/server/definition-tags/memo.js';
import { getPtcMetrics, ptcAccess, resetPtcMetricsForTests } from '../../src/server/ptc/index.js';
import type { ServerRequestContext } from '../../src/server/transport/base-transport.js';
import { StatelessHttpTransport } from '../../src/server/transport/stateless-http-transport.js';
import * as hfWhoamiClient from '../../src/server/utils/hf-whoami-client.js';
import type { HfWhoamiResponse } from '../../src/server/utils/hf-whoami-client.js';
import { BOUQUETS } from '../../src/shared/bouquet-presets.js';
import { DEFAULT_SETTINGS, BOUQUET_FALLBACK } from '../../src/shared/settings.js';
import * as proxyConfig from '../../src/server/utils/proxy-tools-config.js';
import * as gradioDiscovery from '../../src/server/utils/gradio-discovery.js';
import * as queryLogger from '../../src/server/utils/query-logger.js';

vi.mock('@llmindset/hf-mcp', async (importOriginal) => ({
	...(await importOriginal<typeof import('@llmindset/hf-mcp')>()),
	callPtcTool: vi.fn(),
}));

const LEGACY = [
	'hf_fs',
	'hf_fs_write',
	'hub_repo_search',
	'hub_repo_details',
	'hf_sandbox',
	'hf_sandbox_exec',
	'hf_sandbox_fs',
	'dynamic_space',
	'gr1_owner_space',
	'proxy_upload',
];
const page = {
	items: [],
	nextCursor: null,
	returnedCount: 0,
	completeness: { hasMore: false },
};

function user(role: 'read' | 'write' | 'fineGrained'): HfWhoamiResponse {
	return {
		id: 'u1',
		type: 'user',
		name: 'alice',
		orgs: [],
		auth: { type: 'access_token', accessToken: { displayName: 't', role, createdAt: '2026-01-01T00:00:00.000Z' } },
	} as HfWhoamiResponse;
}

beforeEach(() => {
	vi.stubEnv('DISABLE_TOOLS', '');
	resetPtcMetricsForTests();
	vi.mocked(callPtcTool).mockResolvedValue({
		structured: page,
		content: [{ type: 'text', text: JSON.stringify(page) }],
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

async function withProfile(
	headers: Record<string, string>,
	run: (client: Client, api: McpApiClient) => Promise<void>,
	options: { directName?: string; session?: ServerRequestContext } = {}
): Promise<void> {
	const api = new McpApiClient({ type: 'external', externalUrl: 'https://settings.example/private' });
	vi.spyOn(api, 'getSettings').mockRejectedValue(new Error('Settings must not be fetched'));
	const factory = createProxyServerFactory(api, createServerFactory(api));
	const direct = options.directName
		? getDirectToolCallSettings({ method: 'tools/call', params: { name: options.directName } }, headers)
		: undefined;
	const { server } = await factory(
		direct ? withoutDiscoverySelectionHeaders(headers) : headers,
		direct,
		undefined,
		options.session
	);
	const client = new Client({ name: 'ptc-test', version: '1' });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		await run(client, api);
	} finally {
		await client.close();
		await server.close();
	}
}

describe('PTC bouquet registration', () => {
	it.each(['ptc', 'codemode', 'openaiptc'])('bypasses fetched and supplied user settings (%s)', async (bouquet) => {
		const api = new McpApiClient({ type: 'external', externalUrl: 'https://settings.example/private' });
		const getSettings = vi.spyOn(api, 'getSettings').mockRejectedValue(new Error('Must not fetch'));
		const strategy = new ToolSelectionStrategy(api);
		for (const userSettings of [undefined, { builtInTools: ['hub_repo_search'], spaceTools: [] }]) {
			const result = await strategy.selectTools({
				headers: { 'x-mcp-bouquet': bouquet, 'x-mcp-mix': ' , ' },
				hfToken: 'hf_request_token',
				userSettings,
			});
			expect(result.enabledToolIds).toEqual(PTC_TOOL_NAMES);
		}
		expect(getSettings).not.toHaveBeenCalled();
	});

	it.each([
		['ptc', 'search'],
		['codemode', 'all,proxy,research'],
		['openaiptc', 'search'],
		['ptc', 'ptc'],
		['search', 'ptc'],
		['search', 'openaiptc'],
		['all', 'proxy, codemode'],
		[undefined, 'codemode'],
		[undefined, 'openaiptc'],
	])('rejects mixing before settings or proxy resolution (%s + %s)', async (bouquet, mix) => {
		const api = new McpApiClient({ type: 'external', externalUrl: 'https://settings.example/private' });
		const getSettings = vi.spyOn(api, 'getSettings');
		const getProxy = vi.spyOn(proxyConfig, 'getProxyToolsConfig');
		const headers = { ...(bouquet ? { 'x-mcp-bouquet': bouquet } : {}), 'x-mcp-mix': mix };
		await expect(new ToolSelectionStrategy(api).selectTools({ headers })).rejects.toThrow('cannot be mixed');
		await expect(createProxyServerFactory(api, createServerFactory(api))(headers)).rejects.toThrow('cannot be mixed');
		expect(getSettings).not.toHaveBeenCalled();
		expect(getProxy).not.toHaveBeenCalled();
	});

	it('derives access from token permission only', () => {
		expect(ptcAccess(undefined, undefined)).toBe('anonymous');
		expect(ptcAccess('hf_x', undefined)).toBe('authenticated');
		expect(ptcAccess('hf_x', user('read'))).toBe('authenticated');
		expect(ptcAccess('hf_x', user('write'))).toBe('write');
		expect(ptcAccess('hf_x', user('fineGrained'))).toBe('write');
	});

	it.each(['ptc', 'codemode', 'openaiptc'])(
		'lists every tool the token can use, never legacy/proxy/Gradio tools (%s)',
		async (bouquet) => {
			const getProxy = vi.spyOn(proxyConfig, 'getProxyToolsConfig').mockReturnValue([
				{
					proxyId: 'collision',
					toolName: 'hf_models_search',
					upstreamToolName: 'evil',
					url: 'https://proxy.example/mcp',
				},
			]);
			const getGradio = vi.spyOn(gradioDiscovery, 'getGradioSpaces');
			const cases: Array<
				[string | undefined, ServerRequestContext | undefined, 'anonymous' | 'authenticated' | 'write']
			> = [
				[undefined, undefined, 'anonymous'],
				['Bearer hf_request_token', undefined, 'authenticated'],
				['Bearer hf_request_token', { authenticatedUser: user('read') }, 'authenticated'],
				['Bearer hf_request_token', { authenticatedUser: user('write') }, 'write'],
			];
			for (const [authorization, session, access] of cases) {
				const headers: Record<string, string> = {
					'x-mcp-bouquet': bouquet,
					'x-mcp-gradio': 'owner/space',
					...(authorization ? { authorization } : {}),
				};
				await withProfile(
					headers,
					async (client, api) => {
						const tools = (await client.listTools()).tools;
						expect(tools.map((tool) => tool.name)).toEqual(ptcToolsForAccess(access).map((tool) => tool.name));
						for (const tool of tools) {
							expect(tool.inputSchema).toMatchObject({ type: 'object' });
							expect(tool.outputSchema).toMatchObject({ type: 'object' });
							expect(tool.annotations).toMatchObject(getPtcTool(tool.name)?.annotations ?? {});
						}
						expect(client.getInstructions()).toBe(PTC_INSTRUCTIONS);
						expect(api.getSettings).not.toHaveBeenCalled();
					},
					{ session }
				);
			}
			expect(getProxy).not.toHaveBeenCalled();
			expect(getGradio).not.toHaveBeenCalled();
		}
	);

	it('preserves the boundary through every direct-call shortcut, including Gradio and fixed tools', async () => {
		const headers = { 'x-mcp-bouquet': 'ptc', authorization: 'Bearer hf_request_token' };
		for (const name of [...PTC_TOOL_NAMES, ...LEGACY]) {
			const direct = getDirectToolCallSettings({ method: 'tools/call', params: { name } }, headers);
			expect(direct).toEqual({ builtInTools: [...PTC_TOOL_NAMES], spaceTools: [] });
		}
		expect(withoutDiscoverySelectionHeaders(headers)).toEqual(headers);
		await withProfile(
			headers,
			async (client) => {
				for (const name of LEGACY) {
					await expect(client.callTool({ name, arguments: { operation: 'invoke' } })).rejects.toThrow();
				}
				expect(callPtcTool).not.toHaveBeenCalled();
			},
			{ directName: 'hf_fs' }
		);
	});

	it('returns structured data, forwards request auth/signal/user, logs safely and records metrics', async () => {
		vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_not_for_http');
		const logs = vi.spyOn(queryLogger, 'logToolQuery');
		const session: ServerRequestContext = {
			clientInfo: { name: 'codex', version: '9.9' },
			authenticatedUser: user('write'),
		};
		await withProfile(
			{ 'x-mcp-bouquet': 'ptc', authorization: 'Bearer hf_request_token' },
			async (client) => {
				const result = await client.callTool({ name: 'hf_models_search', arguments: { query: 'tiny' } });
				expect(result).toMatchObject({
					structuredContent: page,
					content: [{ type: 'text', text: JSON.stringify(page) }],
				});
				const [tool, input, ctx] = vi.mocked(callPtcTool).mock.calls.at(-1) ?? [];
				expect(tool?.name).toBe('hf_models_search');
				expect(input).toMatchObject({ query: 'tiny' });
				expect(ctx).toMatchObject({ hfToken: 'hf_request_token', username: 'alice', signal: expect.any(AbortSignal) });
				expect(logs).toHaveBeenLastCalledWith(
					'ptc:hf_models_search',
					'tiny',
					{},
					expect.objectContaining({ resultsShared: 0, durationMs: expect.any(Number), success: true })
				);
			},
			{ session }
		);
		const metrics = getPtcMetrics();
		expect(metrics.access.write).toBe(1);
		expect(metrics.bouquets.ptc).toMatchObject({
			requests: 1,
			toolCalls: 1,
			toolErrors: 0,
			access: { anonymous: 0, authenticated: 0, write: 1 },
		});
		expect(metrics.bouquets.openaiptc.requests).toBe(0);
		expect(metrics.clients).toEqual([
			expect.objectContaining({ name: 'codex', version: '9.9', bouquet: 'ptc', requests: 1, toolCalls: 1 }),
		]);
		expect(metrics.tools.find((t) => t.name === 'hf_models_search')).toMatchObject({ calls: 1, errors: 0 });
	});

	it('tracks openaiptc and codemode aliases separately from ptc in metrics and query logs', async () => {
		const logs = vi.spyOn(queryLogger, 'logToolQuery');
		const sameClient: ServerRequestContext = {
			clientInfo: { name: 'openai-mcp', version: '1.0' },
		};
		await withProfile(
			{ 'x-mcp-bouquet': 'ptc' },
			async (client) => {
				await client.callTool({ name: 'hf_models_search', arguments: { query: 'llama' } });
			},
			{ session: sameClient }
		);
		vi.mocked(callPtcTool).mockRejectedValueOnce(new PtcError('INVALID_CURSOR', 'bad cursor'));
		await withProfile(
			{ 'x-mcp-bouquet': 'openaiptc', authorization: 'Bearer hf_request_token' },
			async (client) => {
				await client.callTool({ name: 'hf_models_search', arguments: { query: 'qwen' } });
				await client.callTool({ name: 'hf_datasets_search', arguments: { query: 'fineweb' } });
			},
			{ session: { ...sameClient, authenticatedUser: user('read') } }
		);
		await withProfile(
			{ 'x-mcp-bouquet': 'codemode' },
			async (client) => {
				await client.listTools();
			},
			{ session: sameClient }
		);

		const metrics = getPtcMetrics();
		expect(metrics.requests).toBe(3);
		expect(metrics.toolCalls).toBe(3);
		expect(metrics.toolErrors).toBe(1);
		expect(metrics.bouquets.ptc).toMatchObject({
			requests: 1,
			toolCalls: 1,
			toolErrors: 0,
			access: { anonymous: 1, authenticated: 0, write: 0 },
			lastSeen: expect.any(String),
		});
		expect(metrics.bouquets.openaiptc).toMatchObject({
			requests: 1,
			toolCalls: 2,
			toolErrors: 1,
			access: { anonymous: 0, authenticated: 1, write: 0 },
			lastSeen: expect.any(String),
		});
		expect(metrics.bouquets.codemode).toMatchObject({
			requests: 1,
			toolCalls: 0,
			toolErrors: 0,
			access: { anonymous: 1, authenticated: 0, write: 0 },
			lastSeen: expect.any(String),
		});
		expect(metrics.clients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'openai-mcp',
					version: '1.0',
					bouquet: 'ptc',
					requests: 1,
					toolCalls: 1,
					toolErrors: 0,
					anonymousRequests: 1,
				}),
				expect.objectContaining({
					name: 'openai-mcp',
					version: '1.0',
					bouquet: 'openaiptc',
					requests: 1,
					toolCalls: 2,
					toolErrors: 1,
					anonymousRequests: 0,
				}),
				expect.objectContaining({
					name: 'openai-mcp',
					version: '1.0',
					bouquet: 'codemode',
					requests: 1,
					toolCalls: 0,
					toolErrors: 0,
					anonymousRequests: 1,
				}),
			])
		);
		expect(logs).toHaveBeenLastCalledWith(
			'ptc:hf_datasets_search',
			'fineweb',
			{ bouquet: 'openaiptc' },
			expect.objectContaining({ success: true })
		);
	});

	it('never surfaces raw failures, and keeps sanitized PtcError codes for programmatic callers', async () => {
		const logs = vi.spyOn(queryLogger, 'logToolQuery');
		vi.mocked(callPtcTool).mockRejectedValueOnce(new Error('secret hf_private_token https://private.example'));
		await withProfile({ 'x-mcp-bouquet': 'ptc' }, async (client) => {
			const result = await client.callTool({ name: 'hf_models_search', arguments: {} });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).not.toMatch(/hf_private_token|private.example/);
			expect(JSON.stringify(logs.mock.calls)).not.toMatch(/hf_private_token|private.example/);
		});
		vi.mocked(callPtcTool).mockRejectedValueOnce(new PtcError('INVALID_CURSOR', 'cursor does not match this query.'));
		await withProfile({ 'x-mcp-bouquet': 'ptc' }, async (client) => {
			const result = await client.callTool({ name: 'hf_models_search', arguments: {} });
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: 'text', text: 'cursor does not match this query.' }]);
			expect(result._meta?.['huggingface.co/ptc-error']).toEqual({ code: 'INVALID_CURSOR', retryable: false });
		});
		expect(getPtcMetrics().errorCodes).toMatchObject({ INVALID_CURSOR: 1, UPSTREAM_UNAVAILABLE: 1 });
	});

	it('marks remote tool failures (e.g. a Space error) as MCP isError and counts them', async () => {
		vi.mocked(callPtcTool).mockResolvedValueOnce({
			structured: page,
			content: [{ type: 'text', text: 'space failed' }],
			isError: true,
		});
		await withProfile({ 'x-mcp-bouquet': 'ptc' }, async (client) => {
			const result = await client.callTool({ name: 'hf_models_search', arguments: {} });
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: 'text', text: 'space failed' }]);
		});
		expect(getPtcMetrics().errorCodes).toMatchObject({ TOOL_ERROR: 1 });
	});

	it('executes the real listing contracts end to end with HF-only credentials', async () => {
		const library = await vi.importActual<typeof import('@llmindset/hf-mcp')>('@llmindset/hf-mcp');
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://huggingface.co');
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hf_request_token');
			expect(init?.redirect).toBe('manual');
			return Response.json([{ id: 'owner/repo', sdk: 'gradio', runtime: { stage: 'RUNNING' } }]);
		});
		vi.mocked(callPtcTool).mockImplementation((tool, input, ctx) =>
			library.callPtcTool(tool, input, { ...ctx, fetch })
		);
		await withProfile({ 'x-mcp-bouquet': 'ptc', authorization: 'Bearer hf_request_token' }, async (client) => {
			for (const name of ['hf_models_search', 'hf_datasets_search', 'hf_spaces_list', 'hf_spaces_search']) {
				const result = await client.callTool({ name, arguments: { query: 'image generation' } });
				expect(result.isError).not.toBe(true);
				expect(result.structuredContent).toMatchObject({
					items: [{ id: 'owner/repo', uri: expect.any(String), url: expect.any(String) }],
					returnedCount: 1,
				});
			}
			const invalid = await client.callTool({ name: 'hf_datasets_search', arguments: { limit: -1 } });
			expect(invalid.isError).toBe(true);
		});
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it('honors DISABLE_TOOLS', async () => {
		vi.stubEnv('DISABLE_TOOLS', 'hf_models_search,hf_spaces_search');
		await withProfile({ 'x-mcp-bouquet': 'codemode' }, async (client) => {
			const names = (await client.listTools()).tools.map((tool) => tool.name);
			expect(names).not.toContain('hf_models_search');
			expect(names).not.toContain('hf_spaces_search');
			expect(names).toContain('hf_datasets_search');
			await expect(client.callTool({ name: 'hf_models_search', arguments: {} })).rejects.toThrow();
		});
	});

	it('keeps defaults/all/fallback/UI unions free of PTC tools and rejects PTC additive mixes', async () => {
		// Same operation, same name in both worlds; bouquets never mix, and PTC logs use a ptc: prefix.
		const SHARED = new Set(['hf_sandbox_exec', 'hf_whoami']);
		const names = new Set<string>(PTC_TOOL_NAMES.filter((name) => !SHARED.has(name)));
		for (const ids of [
			ALL_BUILTIN_TOOL_IDS,
			DEFAULT_SETTINGS.builtInTools,
			BOUQUET_FALLBACK.builtInTools,
			...Object.values(BOUQUETS).map((b) => b.builtInTools),
		]) {
			expect(ids.some((id) => names.has(id))).toBe(false);
		}
		const api = new McpApiClient({ type: 'static' });
		const strategy = new ToolSelectionStrategy(api);
		for (const hfToken of [undefined, 'hf_request_token']) {
			for (const bouquet of [undefined, 'all', 'search']) {
				const headers: Record<string, string> = bouquet ? { 'x-mcp-bouquet': bouquet } : {};
				const base = await strategy.selectTools({ headers, hfToken });
				await expect(
					strategy.selectTools({ headers: { ...headers, 'x-mcp-mix': 'ptc,codemode,openaiptc' }, hfToken })
				).rejects.toThrow('cannot be mixed');
				expect(base.enabledToolIds.some((id) => names.has(id))).toBe(false);
			}
		}
	});

	it('tags anonymous PTC discovery only (token permission changes the list) and separates memo keys', () => {
		const headers = { 'x-mcp-bouquet': 'ptc', 'x-mcp-gradio': 'owner/space' };
		expect(definitionTagsPolicy(headers, {})).toBeDefined();
		expect(definitionTagsPolicy({ ...headers, 'x-mcp-bouquet': 'codemode' }, {})).toBeDefined();
		expect(definitionTagsPolicy({ ...headers, 'x-mcp-bouquet': 'openaiptc' }, {})).toBeDefined();
		expect(
			definitionTagsPolicy({ ...headers, 'x-mcp-bouquet': 'openaiptc', authorization: 'Bearer hf_token' }, {})
		).toBeUndefined();
		expect(definitionTagsPolicy({ ...headers, authorization: 'Bearer hf_token' }, {})).toBeUndefined();
		const key = definitionTagsMemoKey({ headers, salt: '' });
		expect(key).not.toEqual(definitionTagsMemoKey({ headers: { ...headers, 'x-mcp-bouquet': 'all' }, salt: '' }));
		expect(key).not.toEqual(definitionTagsMemoKey({ headers: { ...headers, 'x-mcp-bouquet': 'openaiptc' }, salt: '' }));
	});

	it.each(['legacy', 'ptc'] as const)(
		'registers and serves SEP-3415 job events over modern HTTP for %s profile when authenticated',
		async (profile) => {
			vi.stubEnv('MCP_EVENTS_ENABLED', 'true');
			vi.spyOn(hfWhoamiClient, 'fetchHfWhoami').mockResolvedValue(user('write'));
			const getJobSpy = vi.spyOn(JobsApiClient.prototype, 'getJob').mockResolvedValue({
				id: 'job-42',
				createdAt: '2026-11-12T09:50:00Z',
				startedAt: '2026-11-12T09:51:00Z',
				finishedAt: '2026-11-12T09:55:00Z',
				environment: {},
				flavor: 'cpu-basic',
				status: { stage: 'COMPLETED' },
				owner: { id: 'u1', name: 'alice', type: 'user' },
				url: 'https://huggingface.co/jobs/alice/job-42',
			});

			const api = new McpApiClient({ type: 'static' });
			const factory = createServerFactory(api);
			const app = express();
			app.use(express.json());
			const transport = new StatelessHttpTransport(factory, app, vi.fn());
			await transport.initialize();

			const httpServer = app.listen(0);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected test server to bind a TCP port');
				}
				const suffix = profile === 'ptc' ? '?bouquet=ptc' : '';
				const mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp${suffix}`);

				const eventsFetch: typeof fetch = async (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('Authorization', 'Bearer hf_valid_token');
					if (headers.get('mcp-method') === 'events/poll' && typeof init?.body === 'string') {
						const parsed = JSON.parse(init.body) as { params?: { name?: string } };
						if (typeof parsed.params?.name === 'string') {
							headers.set('Mcp-Name', parsed.params.name);
						}
					}
					return fetch(input, { ...init, headers });
				};

				const client = new Client(
					{ name: 'events-profile-test', version: '1.0.0' },
					{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
				);
				await client.connect(new StreamableHTTPClientTransport(mcpUrl, { fetch: eventsFetch }));

				expect(client.getServerCapabilities()?.extensions).toMatchObject({
					'io.modelcontextprotocol/events': { listChanged: false },
				});

				const listed = await client.request(
					{ method: 'events/list', params: {} },
					z.looseObject({ events: z.array(z.looseObject({ name: z.string() })) })
				);
				expect(listed.events).toEqual([expect.objectContaining({ name: 'job.status_changed' })]);

				const polled = await client.request(
					{
						method: 'events/poll',
						params: { name: 'job.status_changed', arguments: { job_id: 'job-42' }, cursor: 'RUNNING' },
					},
					z.looseObject({
						events: z.array(z.looseObject({ eventId: z.string(), timestamp: z.string() })),
						cursor: z.string(),
					})
				);
				expect(polled.events).toEqual([
					expect.objectContaining({ eventId: 'job-42:COMPLETED', timestamp: '2026-11-12T09:55:00Z' }),
				]);
				expect(polled.cursor).toBe('COMPLETED');
				expect(getJobSpy).toHaveBeenCalledWith('job-42', undefined);

				await client.close();
			} finally {
				await new Promise<void>((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
				await transport.cleanup();
			}
		}
	);

	it('does not advertise SEP-3415 events on legacy protocol era or unknown version', async () => {
		vi.stubEnv('MCP_EVENTS_ENABLED', 'true');
		const api = new McpApiClient({ type: 'static' });
		const factory = createServerFactory(api);
		for (const session of [
			{ protocolEra: 'legacy' as const, protocolVersion: 'unknown', authenticatedUser: user('write') },
			{ protocolEra: 'legacy' as const, protocolVersion: '2026-07-28', authenticatedUser: user('write') },
		]) {
			const { server } = await factory({ authorization: 'Bearer hf_valid_token' }, undefined, true, session);
			const caps = server.server.getCapabilities();
			expect(caps.extensions?.['io.modelcontextprotocol/events']).toBeUndefined();
		}
	});
});
