import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	ANONYMOUS_BUILTIN_TOOL_IDS,
	ToolSelectionStrategy,
	ToolSelectionMode,
	type ToolSelectionContext,
} from '../../../src/server/utils/tool-selection-strategy.js';
import { McpApiClient, type ApiClientConfig } from '../../../src/server/utils/mcp-api-client.js';
import type { AppSettings } from '../../../src/shared/settings.js';
import type { TransportInfo } from '../../../src/shared/transport-info.js';
import {
	ALL_BUILTIN_TOOL_IDS,
	CREATE_REPO_TOOL_ID,
	DYNAMIC_SPACE_TOOL_ID,
	HF_FILES_FLAG,
	HF_FS_TOOL_ID,
	HF_JOBS_TOOL_ID,
	HF_SANDBOX_EXEC_TOOL_ID,
	HF_SANDBOX_FS_TOOL_ID,
	HF_SANDBOX_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
	REPO_SEARCH_TOOL_ID,
	TOOL_ID_GROUPS,
} from '@llmindset/hf-mcp';
import { extractAuthBouquetAndMix } from '../../../src/server/utils/auth-utils.js';
import { BOUQUETS } from '../../../src/shared/bouquet-presets.js';
import { GRADIO_IMAGE_FILTER_FLAG, README_INCLUDE_FLAG } from '../../../src/shared/behavior-flags.js';

const BEHAVIOR_FLAG_IDS = new Set<string>([HF_FILES_FLAG, GRADIO_IMAGE_FILTER_FLAG, README_INCLUDE_FLAG]);
const normalizeBuiltInTools = (toolIds: readonly string[]): string[] => [
	...new Set(toolIds.filter((toolId) => !BEHAVIOR_FLAG_IDS.has(toolId))),
];
const withHfFs = (toolIds: readonly string[]): string[] => [...new Set([...toolIds, HF_FS_TOOL_ID])];

describe('extractBouquetAndMix', () => {
	const originalDefaultHfToken = process.env.DEFAULT_HF_TOKEN;

	afterEach(() => {
		if (originalDefaultHfToken === undefined) {
			delete process.env.DEFAULT_HF_TOKEN;
		} else {
			process.env.DEFAULT_HF_TOKEN = originalDefaultHfToken;
		}
	});

	it('should extract bouquet from headers', () => {
		const headers = { 'x-mcp-bouquet': 'search' };
		const { bouquet, mix } = extractAuthBouquetAndMix(headers);

		expect(bouquet).toBe('search');
		expect(mix).toBeUndefined();
	});

	it('should extract mix from headers', () => {
		const headers = { 'x-mcp-mix': 'hf_api' };
		const result = extractAuthBouquetAndMix(headers);

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toEqual(['hf_api']);
	});

	it('should extract both bouquet and mix from headers', () => {
		const headers = {
			'x-mcp-bouquet': 'search',
			'x-mcp-mix': 'hf_api',
		};
		const result = extractAuthBouquetAndMix(headers);

		expect(result.bouquet).toBe('search');
		expect(result.mix).toEqual(['hf_api']);
	});

	it('should handle null headers', () => {
		const result = extractAuthBouquetAndMix(null);

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toBeUndefined();
	});

	it('should handle empty headers', () => {
		const result = extractAuthBouquetAndMix({});

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toBeUndefined();
	});

	it('should parse comma-separated mix list', () => {
		const headers = { 'x-mcp-mix': 'hf_api, jobs ,hub_repo_details_readme' };
		const result = extractAuthBouquetAndMix(headers);

		expect(result.mix).toEqual(['hf_api', 'jobs', 'hub_repo_details_readme']);
	});

	it('should not use DEFAULT_HF_TOKEN unless explicitly allowed', () => {
		process.env.DEFAULT_HF_TOKEN = 'hf_default_token';

		expect(extractAuthBouquetAndMix({}).hfToken).toBeUndefined();
		expect(extractAuthBouquetAndMix({}, { allowDefaultHfToken: true }).hfToken).toBe('hf_default_token');
	});

	it('should prefer Authorization bearer over DEFAULT_HF_TOKEN', () => {
		process.env.DEFAULT_HF_TOKEN = 'hf_default_token';

		const result = extractAuthBouquetAndMix(
			{ authorization: 'Bearer hf_request_token' },
			{ allowDefaultHfToken: true }
		);

		expect(result.hfToken).toBe('hf_request_token');
	});

	it.each(['bearer', 'BEARER', 'BeArEr'])('should parse the %s authorization scheme case-insensitively', (scheme) => {
		const result = extractAuthBouquetAndMix({ authorization: `${scheme} hf_request_token` });

		expect(result.hfToken).toBe('hf_request_token');
	});

	it.each(['Bearer', 'Bearer ', 'Basic hf_request_token', 'Bearer token extra'])(
		'should ignore malformed authorization value %j',
		(authorization) => {
			expect(extractAuthBouquetAndMix({ authorization }).hfToken).toBeUndefined();
		}
	);
});

describe('BOUQUETS configuration', () => {
	it('should have correct hf_api bouquet', () => {
		const bouquet = BOUQUETS.hf_api;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.hf_api);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct spaces bouquet', () => {
		const bouquet = BOUQUETS.spaces;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.spaces);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct search bouquet', () => {
		const bouquet = BOUQUETS.search;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.search);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct all bouquet', () => {
		const bouquet = BOUQUETS.all;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(ALL_BUILTIN_TOOL_IDS);
			expect(bouquet.spaceTools).toEqual([]);
			expect(bouquet.builtInTools).not.toContain(HF_SANDBOX_TOOL_ID);
			expect(bouquet.builtInTools).not.toContain(HF_SANDBOX_EXEC_TOOL_ID);
		}
	});

	it('should expose sandbox only through its explicit bouquet', () => {
		const bouquet = BOUQUETS.sandbox;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual([...TOOL_ID_GROUPS.sandbox]);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should expose file navigation tools through files bouquet', () => {
		const bouquet = BOUQUETS.files;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual([HF_FS_TOOL_ID]);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should expose the research toolkit through research bouquet', () => {
		const bouquet = BOUQUETS.research;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual([
				HF_FILES_FLAG,
				...TOOL_ID_GROUPS.sandbox,
				CREATE_REPO_TOOL_ID,
				HUB_REPO_DETAILS_TOOL_ID,
			]);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});
});

describe('ToolSelectionStrategy', () => {
	let strategy: ToolSelectionStrategy;
	let mockApiClient: McpApiClient;

	// Create a real API client with minimal config for testing
	beforeEach(() => {
		const config: ApiClientConfig = {
			type: 'static',
		};

		const transportInfo: TransportInfo = {
			transport: 'streamableHttpJson',
			port: 3000,
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		};

		mockApiClient = new McpApiClient(config, transportInfo);
		strategy = new ToolSelectionStrategy(mockApiClient);
	});

	describe('Bouquet Override (Highest Precedence)', () => {
		it('always enables hf_fs for every bouquet', async () => {
			for (const bouquet of Object.keys(BOUQUETS)) {
				const result = await strategy.selectTools({
					headers: { 'x-mcp-bouquet': bouquet },
					hfToken: 'test-token',
				});

				expect(result.enabledToolIds, bouquet).toContain(HF_FS_TOOL_ID);
			}
		});

		it('should restrict anonymous bouquet users to the anonymous allowlist', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'all' },
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual([...ANONYMOUS_BUILTIN_TOOL_IDS]);
			expect(result.enabledToolIds).toContain(HF_FS_TOOL_ID);
		});

		it('should use bouquet override for search bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'search' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(withHfFs(TOOL_ID_GROUPS.search));
			expect(result.reason).toBe('Bouquet override: search');
			expect(result.baseSettings).toBeUndefined();
			expect(result.mixedBouquet).toBeUndefined();
		});

		it('should use bouquet override for hf_api bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'hf_api' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(withHfFs(TOOL_ID_GROUPS.hf_api));
			expect(result.reason).toBe('Bouquet override: hf_api');
		});

		it('should use bouquet override for spaces bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'spaces' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(withHfFs(TOOL_ID_GROUPS.spaces));
			expect(result.reason).toBe('Bouquet override: spaces');
		});

		it('should use bouquet override for all bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'all' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(ALL_BUILTIN_TOOL_IDS));
			expect(result.reason).toBe('Bouquet override: all');
		});

		it('should use bouquet override for sandbox bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'sandbox' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual([
				HF_SANDBOX_TOOL_ID,
				HF_SANDBOX_EXEC_TOOL_ID,
				HF_SANDBOX_FS_TOOL_ID,
				HF_FS_TOOL_ID,
			]);
			expect(result.reason).toBe('Bouquet override: sandbox');
		});

		it('should use bouquet override for files bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'files' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
			expect(result.reason).toBe('Bouquet override: files');
		});

		it('should ignore invalid bouquet names', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'invalid_bouquet' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should fall through to fallback since no valid bouquet or user settings
			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(ALL_BUILTIN_TOOL_IDS));
		});

		it('should prefer bouquet over mix when both are present', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {
					'x-mcp-bouquet': 'search',
					'x-mcp-mix': 'hf_api',
				},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(withHfFs(TOOL_ID_GROUPS.search));
			expect(result.reason).toBe('Bouquet override: search');
		});
	});

	describe('Mix Mode (Second Precedence)', () => {
		it('should mix hf_api tools with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID, DYNAMIC_SPACE_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'hf_api' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(hf_api)');
			expect(result.baseSettings).toEqual(userSettings);
			expect(result.mixedBouquet).toEqual(['hf_api']);

			// Should contain user tools + hf_api tools (deduplicated)
			const expectedTools = normalizeBuiltInTools([
				...new Set([...userSettings.builtInTools, ...TOOL_ID_GROUPS.hf_api]),
			]);
			expect(result.enabledToolIds).toEqual(withHfFs(expectedTools));
		});

		it('should mix sandbox tool with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [REPO_SEARCH_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'sandbox' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.enabledToolIds).toEqual([
				REPO_SEARCH_TOOL_ID,
				HF_SANDBOX_TOOL_ID,
				HF_SANDBOX_EXEC_TOOL_ID,
				HF_SANDBOX_FS_TOOL_ID,
				HF_FS_TOOL_ID,
			]);
		});

		it('should mix search tools with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID, DYNAMIC_SPACE_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(search)');

			const expectedTools = [...new Set([...userSettings.builtInTools, ...TOOL_ID_GROUPS.search])];
			expect(result.enabledToolIds).toEqual(withHfFs(expectedTools));
		});

		it('should mix files tool with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [REPO_SEARCH_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'files' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(files)');
			expect(result.mixedBouquet).toEqual(['files']);
			expect(result.enabledToolIds).toEqual([REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID]);
		});

		it('should deduplicate tools when mixing', async () => {
			const userSettings: AppSettings = {
				builtInTools: [REPO_SEARCH_TOOL_ID, REPO_SEARCH_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);

			// Should not have duplicates
			const uniqueTools = [...new Set(result.enabledToolIds)];
			expect(result.enabledToolIds).toEqual(uniqueTools);
			expect(result.enabledToolIds.length).toBe(uniqueTools.length);
		});

		it('should mix multiple bouquets when comma separated', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'hf_api,search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(hf_api,search)');
			expect(result.mixedBouquet).toEqual(['hf_api', 'search']);

			const expectedTools = normalizeBuiltInTools([
				...new Set([...userSettings.builtInTools, ...TOOL_ID_GROUPS.hf_api, ...TOOL_ID_GROUPS.search]),
			]);
			expect(result.enabledToolIds).toEqual(withHfFs(expectedTools));
		});

		it('should ignore mix when no user settings available', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'hf_api' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should fall through to fallback since no user settings to mix with
			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools([...ALL_BUILTIN_TOOL_IDS, ...TOOL_ID_GROUPS.hf_api]));
		});

		it('should ignore invalid mix bouquet names', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'invalid_mix' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should use user settings without mixing
			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual(withHfFs(normalizeBuiltInTools(userSettings.builtInTools)));
		});
	});

	describe('User Settings Mode (Third Precedence)', () => {
		it('accepts the upstream create_repo configuration ID', async () => {
			const result = await strategy.selectTools({
				headers: {},
				userSettings: {
					builtInTools: ['create_repo'],
					spaceTools: [],
				},
				hfToken: 'test-token',
			});

			expect(CREATE_REPO_TOOL_ID).toBe('create_repo');
			expect(result.enabledToolIds).toEqual([CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID]);
		});

		it('ignores retired and unknown configuration IDs', async () => {
			const result = await strategy.selectTools({
				headers: {},
				userSettings: {
					builtInTools: ['model_search', 'unknown_tool', REPO_SEARCH_TOOL_ID],
					spaceTools: [],
				},
				hfToken: 'test-token',
			});

			expect(result.enabledToolIds).toEqual([REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID]);
		});

		it('should restrict anonymous user settings to the anonymous allowlist', async () => {
			const userSettings: AppSettings = {
				builtInTools: [CREATE_REPO_TOOL_ID, REPO_SEARCH_TOOL_ID, HF_SANDBOX_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual([REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID]);
		});

		it('should auto-enable sandbox exec when sandbox is enabled in user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_SANDBOX_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual([
				HF_SANDBOX_TOOL_ID,
				HF_FS_TOOL_ID,
				HF_SANDBOX_EXEC_TOOL_ID,
				HF_SANDBOX_FS_TOOL_ID,
			]);
		});

		it('should use provided user settings in internal API mode', async () => {
			const userSettings: AppSettings = {
				builtInTools: [REPO_SEARCH_TOOL_ID, HF_JOBS_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual(withHfFs(normalizeBuiltInTools(userSettings.builtInTools)));
			expect(result.reason).toBe('Internal API user settings');
			expect(result.baseSettings).toEqual(userSettings);
		});

		it('should use provided user settings in external API mode', async () => {
			// Create external API mode client
			const externalConfig: ApiClientConfig = {
				type: 'external',
				externalUrl: 'https://api.example.com/settings',
				hfToken: 'test-token',
			};

			const externalTransportInfo: TransportInfo = {
				transport: 'streamableHttpJson',
				port: 3000,
				defaultHfTokenSet: false,
				externalApiMode: true,
				stdioClient: null,
			};

			const externalApiClient = new McpApiClient(externalConfig, externalTransportInfo);
			const externalStrategy = new ToolSelectionStrategy(externalApiClient);

			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await externalStrategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.EXTERNAL_API);
			expect(result.enabledToolIds).toEqual(withHfFs(normalizeBuiltInTools(userSettings.builtInTools)));
			expect(result.reason).toBe('External API user settings');
		});

		it('should separate the hf_files write flag while enabling hf_fs', async () => {
			const externalConfig: ApiClientConfig = {
				type: 'external',
				externalUrl: 'https://api.example.com/settings',
				hfToken: 'test-token',
			};

			const externalTransportInfo: TransportInfo = {
				transport: 'streamableHttpJson',
				port: 3000,
				defaultHfTokenSet: false,
				externalApiMode: true,
				stdioClient: null,
			};

			const externalApiClient = new McpApiClient(externalConfig, externalTransportInfo);
			const externalStrategy = new ToolSelectionStrategy(externalApiClient);

			const userSettings: AppSettings = {
				builtInTools: ['hf_files'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await externalStrategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.EXTERNAL_API);
			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
			expect(result.behaviorFlags.enableHfFsWrite).toBe(true);
			expect(result.reason).toBe('External API user settings');
		});

		it('should auto-enable sandbox exec in external API mode user settings', async () => {
			const externalConfig: ApiClientConfig = {
				type: 'external',
				externalUrl: 'https://api.example.com/settings',
				hfToken: 'test-token',
			};

			const externalTransportInfo: TransportInfo = {
				transport: 'streamableHttpJson',
				port: 3000,
				defaultHfTokenSet: false,
				externalApiMode: true,
				stdioClient: null,
			};

			const externalApiClient = new McpApiClient(externalConfig, externalTransportInfo);
			const externalStrategy = new ToolSelectionStrategy(externalApiClient);

			const userSettings: AppSettings = {
				builtInTools: [HF_SANDBOX_TOOL_ID],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await externalStrategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.EXTERNAL_API);
			expect(result.enabledToolIds).toEqual([
				HF_SANDBOX_TOOL_ID,
				HF_FS_TOOL_ID,
				HF_SANDBOX_EXEC_TOOL_ID,
				HF_SANDBOX_FS_TOOL_ID,
			]);
			expect(result.reason).toBe('External API user settings');
		});
	});

	describe('Fallback Mode (Lowest Precedence)', () => {
		it('should use fallback when no configuration is available', async () => {
			const context: ToolSelectionContext = {
				headers: {},
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(ALL_BUILTIN_TOOL_IDS));
			expect(result.reason).toBe('Fallback - no settings available');
			expect(result.baseSettings).toBeUndefined();
		});

		it('should use fallback when headers are null', async () => {
			const context: ToolSelectionContext = {
				headers: null,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(ALL_BUILTIN_TOOL_IDS));
		});

		it('should restrict anonymous fallback to the anonymous allowlist', async () => {
			const result = await strategy.selectTools({ headers: null });

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual([...ANONYMOUS_BUILTIN_TOOL_IDS]);
			expect(result.enabledToolIds).toContain(HF_FS_TOOL_ID);
		});

		it('should apply sandbox mix in fallback mode', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'sandbox' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(
				normalizeBuiltInTools([
					...ALL_BUILTIN_TOOL_IDS,
					HF_SANDBOX_TOOL_ID,
					HF_SANDBOX_EXEC_TOOL_ID,
					HF_SANDBOX_FS_TOOL_ID,
				])
			);
			expect(result.mixedBouquet).toEqual(['sandbox']);
		});
	});

	describe('Behavior flags', () => {
		const flaggedSettings: AppSettings = {
			builtInTools: [HF_FILES_FLAG, README_INCLUDE_FLAG, GRADIO_IMAGE_FILTER_FLAG],
			spaceTools: [],
		};

		it('separates authenticated behavior flags from registered tool IDs', async () => {
			const result = await strategy.selectTools({
				headers: {},
				userSettings: flaggedSettings,
				hfToken: 'test-token',
			});

			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
			expect(result.behaviorFlags).toEqual({
				allowReadmeInclude: true,
				stripGradioImages: true,
				enableHfFsWrite: true,
			});
		});

		it('does not grant behavior flags to anonymous requests', async () => {
			const result = await strategy.selectTools({
				headers: {},
				userSettings: flaggedSettings,
			});

			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
			expect(result.behaviorFlags).toEqual({
				allowReadmeInclude: false,
				stripGradioImages: false,
				enableHfFsWrite: false,
			});
		});
	});

	describe('Complex Scenarios', () => {
		it('should handle empty user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
			expect(result.baseSettings).toEqual(userSettings);
		});

		it('should handle mix with empty user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.enabledToolIds).toEqual(withHfFs(TOOL_ID_GROUPS.search));
			expect(result.mixedBouquet).toEqual(['search']);
		});

		it('should handle all possible tool types in mix', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID], // Start with one tool
				spaceTools: [],
			};

			// Test mixing with each bouquet type
			for (const [bouquetName, bouquetConfig] of Object.entries(BOUQUETS)) {
				const context: ToolSelectionContext = {
					headers: { 'x-mcp-mix': bouquetName },
					userSettings,
					hfToken: 'test-token',
				};

				const result = await strategy.selectTools(context);

				expect(result.mode).toBe(ToolSelectionMode.MIX);
				expect(result.mixedBouquet).toEqual([bouquetName]);

				const expectedTools = [...new Set([...userSettings.builtInTools, ...bouquetConfig.builtInTools])];
				const expectedWithDependencies =
					bouquetName === 'sandbox'
						? [...expectedTools, HF_FS_TOOL_ID, HF_SANDBOX_EXEC_TOOL_ID, HF_SANDBOX_FS_TOOL_ID]
						: withHfFs(expectedTools);
				expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(expectedWithDependencies));
			}
		});

		it('should preserve gradio endpoints when mixing with all bouquet in internal API mode', async () => {
			const userSettings: AppSettings = {
				builtInTools: [HF_JOBS_TOOL_ID], // Start from a minimal per-user configuration
				spaceTools: [
					{
						name: 'My Custom GPT',
						subdomain: 'user123-my-custom-gpt',
						_id: 'custom-1',
						emoji: '🤖',
					},
					{
						name: 'Company Analytics',
						subdomain: 'corp-analytics-tool',
						_id: 'custom-2',
						emoji: '📊',
					},
				],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'all' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.mixedBouquet).toEqual(['all']);
			expect(result.reason).toBe('User settings + mix(all)');

			// Should get user's minimal tools + ALL built-in tools (deduplicated)
			const expectedBuiltInTools = [...new Set([...userSettings.builtInTools, ...ALL_BUILTIN_TOOL_IDS])];
			expect(result.enabledToolIds).toEqual(normalizeBuiltInTools(expectedBuiltInTools));

			// Should preserve base settings including gradio endpoints
			expect(result.baseSettings).toEqual(userSettings);
			expect(result.baseSettings?.spaceTools).toHaveLength(2);
			expect(result.baseSettings?.spaceTools).toEqual([
				{
					name: 'My Custom GPT',
					subdomain: 'user123-my-custom-gpt',
					_id: 'custom-1',
					emoji: '🤖',
				},
				{
					name: 'Company Analytics',
					subdomain: 'corp-analytics-tool',
					_id: 'custom-2',
					emoji: '📊',
				},
			]);
		});
	});
});
