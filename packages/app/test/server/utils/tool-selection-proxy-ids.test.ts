import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ALL_BUILTIN_TOOL_IDS,
	CREATE_REPO_TOOL_ID,
	HF_FS_TOOL_ID,
	HF_FS_WRITE_TOOL_ID,
	PTC_TOOL_NAMES,
	TOOL_ID_GROUPS,
} from '@llmindset/hf-mcp';
import type { AppSettings } from '../../../src/shared/settings.js';
import { McpApiClient } from '../../../src/server/utils/mcp-api-client.js';
import {
	ANONYMOUS_BUILTIN_TOOL_IDS,
	ToolSelectionMode,
	ToolSelectionStrategy,
	type ToolSelectionContext,
} from '../../../src/server/utils/tool-selection-strategy.js';
import {
	getDirectToolCallSettings,
	withoutDiscoverySelectionHeaders,
} from '../../../src/server/utils/direct-tool-settings.js';
import { getProxyToolsConfig, type ProxyToolDefinition } from '../../../src/server/utils/proxy-tools-config.js';

vi.mock('../../../src/server/utils/proxy-tools-config.js', () => ({
	getProxyToolsConfig: vi.fn(),
}));

function proxyTool(toolName: string, overrides: Partial<ProxyToolDefinition> = {}): ProxyToolDefinition {
	return {
		proxyId: 'multi_tool_proxy',
		toolName,
		upstreamToolName: toolName,
		url: 'https://proxy.example/mcp',
		...overrides,
	};
}

function settingsFor(...builtInTools: string[]): AppSettings {
	return { builtInTools, spaceTools: [] };
}

interface SelectionCase {
	label: string;
	headers: Record<string, string>;
	userSettings?: AppSettings;
}

const PUBLIC_TOOL_NAMES = ['proxy_tool_one', 'proxy_tool_two'];
const PRIVATE_TOOL_NAMES = ['legacy_tool', 'private_tool'];
const ANONYMOUS_IDS: string[] = [...ANONYMOUS_BUILTIN_TOOL_IDS];

describe('ToolSelectionStrategy proxy source IDs and anonymous discovery', () => {
	let strategy: ToolSelectionStrategy;
	let apiClient: McpApiClient;

	beforeEach(() => {
		vi.mocked(getProxyToolsConfig).mockReturnValue([
			proxyTool('proxy_tool_one', { allowAnonymous: true, forwardHfToken: false }),
			proxyTool('proxy_tool_two', { allowAnonymous: true, forwardHfToken: true }),
			proxyTool('legacy_tool', { proxyId: 'legacy_proxy' }),
			proxyTool('private_tool', { proxyId: 'private_proxy', allowAnonymous: false, forwardHfToken: false }),
		]);
		apiClient = new McpApiClient({ type: 'static' });
		strategy = new ToolSelectionStrategy(apiClient);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('preserves a multi-tool proxy source ID returned by external settings', async () => {
		const result = await strategy.selectTools({
			headers: {},
			hfToken: 'hf_test_token',
			userSettings: settingsFor('multi_tool_proxy'),
		});

		expect(result.enabledToolIds).toEqual(['multi_tool_proxy', HF_FS_TOOL_ID]);
	});

	it.each<SelectionCase>([
		{ label: 'proxy bouquet', headers: { 'x-mcp-bouquet': 'proxy' } },
		{ label: 'proxy mix with fallback', headers: { 'x-mcp-mix': 'proxy' } },
		{ label: 'proxy mix with bouquet', headers: { 'x-mcp-bouquet': 'all', 'x-mcp-mix': 'proxy' } },
		{
			label: 'proxy mix with settings',
			headers: { 'x-mcp-mix': 'proxy' },
			userSettings: settingsFor(...ALL_BUILTIN_TOOL_IDS),
		},
	])('retains only opted-in proxy tools for anonymous $label', async ({ headers, ...context }) => {
		const result = await strategy.selectTools({ headers, ...context });

		expect(result.enabledToolIds).toEqual(expect.arrayContaining(PUBLIC_TOOL_NAMES));
		expect(result.enabledToolIds.filter((id) => !PUBLIC_TOOL_NAMES.includes(id))).toEqual(
			headers['x-mcp-bouquet'] === 'proxy' ? [HF_FS_TOOL_ID] : ANONYMOUS_IDS
		);
		expect(result.behaviorFlags).toEqual({ stripGradioImages: false, enableHfFsWrite: false });
	});

	it.each(['supplied settings', 'external settings API'] as const)(
		'uses server policies for group and individual IDs from %s',
		async (source) => {
			// Exercise the actual settings-fetch branch without making network calls.
			if (source === 'external settings API') {
				vi.stubEnv('NODE_ENV', 'production');
				vi.stubEnv('VITEST', '');
				vi.spyOn(apiClient, 'getTransportInfo').mockReturnValue({
					transport: 'streamableHttpJson',
					defaultHfTokenSet: false,
					externalApiMode: true,
				});
			}
			const getSettings = vi.spyOn(apiClient, 'getSettings');
			for (const selectedId of [
				'multi_tool_proxy',
				...PUBLIC_TOOL_NAMES,
				'legacy_proxy',
				'private_proxy',
				...PRIVATE_TOOL_NAMES,
			]) {
				const settings = settingsFor(selectedId, ...ALL_BUILTIN_TOOL_IDS, ...TOOL_ID_GROUPS.sandbox);
				getSettings.mockResolvedValue(settings);
				const result = await strategy.selectTools({
					headers: {},
					...(source === 'supplied settings' ? { userSettings: settings } : {}),
				});
				const isPublic = ['multi_tool_proxy', ...PUBLIC_TOOL_NAMES].includes(selectedId);
				expect(result.enabledToolIds).toEqual(isPublic ? [selectedId, ...ANONYMOUS_IDS] : ANONYMOUS_IDS);
				expect(result.mode).toBe(
					source === 'external settings API' ? ToolSelectionMode.EXTERNAL_API : ToolSelectionMode.INTERNAL_API
				);
			}
			if (source === 'external settings API') {
				expect(getSettings).toHaveBeenCalledTimes(7);
				expect(getSettings).toHaveBeenCalledWith(undefined);
			} else {
				expect(getSettings).not.toHaveBeenCalled();
			}
		}
	);

	it('keeps the source group ID for multiple tools without expanding an individual selection', async () => {
		const group = await strategy.selectTools({ headers: {}, userSettings: settingsFor('multi_tool_proxy') });
		expect(group.enabledToolIds).toEqual(['multi_tool_proxy', HF_FS_TOOL_ID]);
		for (const toolName of PUBLIC_TOOL_NAMES) {
			const individual = await strategy.selectTools({ headers: {}, userSettings: settingsFor(toolName) });
			expect(individual.enabledToolIds).toEqual([toolName, HF_FS_TOOL_ID]);
			expect(individual.enabledToolIds).not.toContain('multi_tool_proxy');
			expect(individual.enabledToolIds).not.toContain(PUBLIC_TOOL_NAMES.find((name) => name !== toolName));
		}
	});

	it.each<SelectionCase>([
		{ label: 'fallback', headers: {} },
		{ label: 'all bouquet', headers: { 'x-mcp-bouquet': 'all' } },
		{ label: 'empty settings', headers: {}, userSettings: settingsFor() },
		{ label: 'built-in settings', headers: {}, userSettings: settingsFor(CREATE_REPO_TOOL_ID) },
		{ label: 'non-proxy mix', headers: { 'x-mcp-mix': 'jobs' }, userSettings: settingsFor() },
	])('does not add public proxies to $label by default', async ({ label: _label, headers, ...context }) => {
		const result = await strategy.selectTools({ headers, ...context });
		expect(result.enabledToolIds).not.toEqual(expect.arrayContaining(PUBLIC_TOOL_NAMES));
		expect(result.enabledToolIds.every((id) => ANONYMOUS_IDS.includes(id))).toBe(true);
	});

	it.each([undefined, false])(
		'keeps legacy allowAnonymous=%s proxies private by name and source ID',
		async (allowAnonymous) => {
			vi.mocked(getProxyToolsConfig).mockReturnValue([
				proxyTool('proxy_tool_one', { allowAnonymous, forwardHfToken: false }),
				proxyTool('proxy_tool_two', { allowAnonymous, forwardHfToken: true }),
			]);
			for (const userSettings of [settingsFor('multi_tool_proxy'), settingsFor(...PUBLIC_TOOL_NAMES)]) {
				const anonymous = await strategy.selectTools({ headers: {}, userSettings });
				expect(anonymous.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
				const authenticated = await strategy.selectTools({ headers: {}, userSettings, hfToken: 'hf_test_token' });
				expect(authenticated.enabledToolIds).toEqual([...userSettings.builtInTools, HF_FS_TOOL_ID]);
			}
		}
	);

	it.each(['proxy', 'mix', 'settings', 'fallback'] as const)(
		'preserves authenticated legacy selection for %s',
		async (selection) => {
			const result = await strategy.selectTools({
				hfToken: 'hf_test_token',
				headers:
					selection === 'proxy' ? { 'x-mcp-bouquet': 'proxy' } : selection === 'mix' ? { 'x-mcp-mix': 'proxy' } : {},
				...(selection === 'settings'
					? { userSettings: settingsFor('multi_tool_proxy', 'legacy_proxy', 'private_proxy', CREATE_REPO_TOOL_ID) }
					: {}),
			});
			const expected =
				selection === 'proxy'
					? [HF_FS_TOOL_ID, ...PUBLIC_TOOL_NAMES, ...PRIVATE_TOOL_NAMES]
					: selection === 'mix'
						? [...ALL_BUILTIN_TOOL_IDS, ...PUBLIC_TOOL_NAMES, ...PRIVATE_TOOL_NAMES]
						: selection === 'settings'
							? ['multi_tool_proxy', 'legacy_proxy', 'private_proxy', CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID]
							: [...ALL_BUILTIN_TOOL_IDS];
			expect(result.enabledToolIds).toEqual(expected);
		}
	);

	it.each([...PUBLIC_TOOL_NAMES, ...PRIVATE_TOOL_NAMES])(
		'applies catalog visibility to transport direct-tool settings for %s',
		async (toolName) => {
			const headers = withoutDiscoverySelectionHeaders({ 'x-mcp-bouquet': 'all', 'x-mcp-mix': 'proxy' });
			const userSettings = getDirectToolCallSettings({ method: 'tools/call', params: { name: toolName } }, headers);
			expect(userSettings).toEqual(settingsFor(toolName));
			const result = await strategy.selectTools({ headers, userSettings });
			expect(result.enabledToolIds).toEqual(
				PUBLIC_TOOL_NAMES.includes(toolName) ? [toolName, HF_FS_TOOL_ID] : [HF_FS_TOOL_ID]
			);
		}
	);

	it('does not trust policy fields injected into supplied or external AppSettings', async () => {
		const settings = {
			...settingsFor(
				'unconfigured_tool',
				'unconfigured_proxy',
				'legacy_tool',
				'legacy_proxy',
				'private_tool',
				'private_proxy'
			),
			allowAnonymous: true,
			forwardHfToken: false,
			proxyTools: [
				proxyTool('unconfigured_tool', { proxyId: 'unconfigured_proxy', allowAnonymous: true }),
				proxyTool('legacy_tool', { proxyId: 'legacy_proxy', allowAnonymous: true }),
				proxyTool('private_tool', { proxyId: 'private_proxy', allowAnonymous: true }),
			],
		};
		const supplied = await strategy.selectTools({ headers: {}, userSettings: settings });
		expect(supplied.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
		vi.stubEnv('NODE_ENV', 'production');
		vi.stubEnv('VITEST', '');
		vi.spyOn(apiClient, 'getSettings').mockResolvedValue(settings);
		const external = await strategy.selectTools({ headers: {} });
		expect(external.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
	});

	it.each([
		...ALL_BUILTIN_TOOL_IDS.filter((id) => !(ANONYMOUS_BUILTIN_TOOL_IDS as readonly string[]).includes(id)),
		...TOOL_ID_GROUPS.sandbox,
		...PTC_TOOL_NAMES,
		HF_FS_WRITE_TOOL_ID,
		'hf_whoami',
	])('does not authorize built-in %s through an opted-in proxy alias or source ID', async (builtInId) => {
		for (const proxy of [
			proxyTool(builtInId, { allowAnonymous: true }),
			proxyTool('safe_proxy_name', { proxyId: builtInId, allowAnonymous: true }),
		]) {
			vi.mocked(getProxyToolsConfig).mockReturnValue([proxy]);
			const contexts: ToolSelectionContext[] = [
				{ headers: { 'x-mcp-bouquet': 'proxy' } },
				{ headers: {}, userSettings: settingsFor(builtInId) },
			];
			for (const context of contexts) {
				const result = await strategy.selectTools(context);
				expect(result.enabledToolIds).not.toContain(builtInId);
			}
		}
	});

	it('keeps anonymous built-ins visible even when a non-opted-in proxy collides', async () => {
		vi.mocked(getProxyToolsConfig).mockReturnValue(
			ANONYMOUS_IDS.map((id) => proxyTool(id, { proxyId: id, allowAnonymous: false }))
		);
		const result = await strategy.selectTools({ headers: {}, userSettings: settingsFor(...ANONYMOUS_IDS) });
		expect(result.enabledToolIds).toEqual(ANONYMOUS_IDS);
	});

	it.each(['ptc', 'codemode', 'openaiptc'])(
		'preserves the isolated %s profile despite proxy selections and collisions',
		async (bouquet) => {
			vi.mocked(getProxyToolsConfig).mockReturnValue([
				proxyTool(PTC_TOOL_NAMES[0], { allowAnonymous: true }),
				proxyTool('proxy_tool_one', { allowAnonymous: true }),
			]);
			const result = await strategy.selectTools({
				headers: { 'x-mcp-bouquet': bouquet },
				userSettings: settingsFor('multi_tool_proxy', ...ALL_BUILTIN_TOOL_IDS),
			});
			expect(result.enabledToolIds).toEqual([...PTC_TOOL_NAMES]);
		}
	);
});
