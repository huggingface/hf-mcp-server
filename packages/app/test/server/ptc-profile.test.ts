import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
	ALL_BUILTIN_TOOL_IDS,
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
	it.each(['ptc', 'codemode'])('bypasses fetched and supplied user settings (%s)', async (bouquet) => {
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
		['ptc', 'ptc'],
		['search', 'ptc'],
		['all', 'proxy, codemode'],
		[undefined, 'codemode'],
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

	it.each(['ptc', 'codemode'])(
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
		expect(metrics.clients).toEqual([
			expect.objectContaining({ name: 'codex', version: '9.9', requests: 1, toolCalls: 1 }),
		]);
		expect(metrics.tools.find((t) => t.name === 'hf_models_search')).toMatchObject({ calls: 1, errors: 0 });
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
					strategy.selectTools({ headers: { ...headers, 'x-mcp-mix': 'ptc,codemode' }, hfToken })
				).rejects.toThrow('cannot be mixed');
				expect(base.enabledToolIds.some((id) => names.has(id))).toBe(false);
			}
		}
	});

	it('tags anonymous PTC discovery only (token permission changes the list) and separates memo keys', () => {
		const headers = { 'x-mcp-bouquet': 'ptc', 'x-mcp-gradio': 'owner/space' };
		expect(definitionTagsPolicy(headers, {})).toBeDefined();
		expect(definitionTagsPolicy({ ...headers, 'x-mcp-bouquet': 'codemode' }, {})).toBeDefined();
		expect(definitionTagsPolicy({ ...headers, authorization: 'Bearer hf_token' }, {})).toBeUndefined();
		const key = definitionTagsMemoKey({ headers, salt: '' });
		expect(key).not.toEqual(definitionTagsMemoKey({ headers: { ...headers, 'x-mcp-bouquet': 'all' }, salt: '' }));
	});
});
