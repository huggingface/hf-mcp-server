import { logger } from './logger.js';
import type { AppSettings } from '../../shared/settings.js';
import {
	ALL_BUILTIN_TOOL_IDS,
	HF_FILES_FLAG,
	HF_FS_TOOL_ID,
	HF_SANDBOX_EXEC_TOOL_ID,
	HF_SANDBOX_FS_TOOL_ID,
	HF_SANDBOX_TOOL_ID,
	TOOL_ID_GROUPS,
} from '@llmindset/hf-mcp';
import type { McpApiClient } from './mcp-api-client.js';
import { extractAuthBouquetAndMix } from '../utils/auth-utils.js';
import { BOUQUETS } from '../../shared/bouquet-presets.js';
import { getProxyToolsConfig } from './proxy-tools-config.js';
import { GRADIO_IMAGE_FILTER_FLAG, README_INCLUDE_FLAG, type ToolBehaviorFlags } from '../../shared/behavior-flags.js';
import { ANONYMOUS_BUILTIN_TOOL_IDS } from '../../shared/settings.js';

export { ANONYMOUS_BUILTIN_TOOL_IDS } from '../../shared/settings.js';

export enum ToolSelectionMode {
	BOUQUET_OVERRIDE = 'bouquet_override',
	MIX = 'mix',
	EXTERNAL_API = 'external_api',
	INTERNAL_API = 'internal_api',
	FALLBACK = 'fallback',
}

export interface ToolSelectionContext {
	headers: Record<string, string> | null;
	userSettings?: AppSettings;
	hfToken?: string;
}

const ANONYMOUS_BUILTIN_TOOLS = new Set<string>(ANONYMOUS_BUILTIN_TOOL_IDS);

function isBuiltInToolVisibleAnonymously(toolId: string): boolean {
	return ANONYMOUS_BUILTIN_TOOLS.has(toolId);
}

interface ToolSelectionResult {
	mode: ToolSelectionMode;
	enabledToolIds: string[];
	behaviorFlags: ToolBehaviorFlags;
	reason: string;
	baseSettings?: AppSettings;
	mixedBouquet?: string[];
}

/**
 * Tool Selection Strategy - implements clear precedence rules for tool selection
 *
 * ## Precedence for Built-in Tools
 *
 * 1. BOUQUET_OVERRIDE (highest) - Completely replaces tool selection
 * 2. MIX - Adds mix bouquet tools to user settings
 * 3. USER_SETTINGS - Uses external or internal API settings
 * 4. FALLBACK (lowest) - All tools enabled when no config available
 *
 */
export class ToolSelectionStrategy {
	private apiClient: McpApiClient;

	constructor(apiClient: McpApiClient) {
		this.apiClient = apiClient;
	}

	/**
	 * Always ensure sandbox exec and fs are enabled when sandbox management is enabled.
	 */
	private applySandboxEnablesExec(enabledToolIds: string[]): string[] {
		if (!enabledToolIds.includes(HF_SANDBOX_TOOL_ID)) {
			return enabledToolIds;
		}
		const missing = [HF_SANDBOX_EXEC_TOOL_ID, HF_SANDBOX_FS_TOOL_ID].filter(
			(toolId) => !enabledToolIds.includes(toolId)
		);
		if (missing.length === 0) {
			return enabledToolIds;
		}
		logger.debug(`Auto-enabling ${missing.join(', ')} because hf_sandbox is enabled`);
		return [...enabledToolIds, ...missing];
	}

	/**
	 * Applies built-in tool dependency rules.
	 */
	private applyToolDependencies(enabledToolIds: string[]): string[] {
		const requiredTools = enabledToolIds.includes(HF_FS_TOOL_ID) ? enabledToolIds : [...enabledToolIds, HF_FS_TOOL_ID];
		return this.applySandboxEnablesExec(requiredTools);
	}

	private getProxyToolNames(): string[] {
		return getProxyToolsConfig().map((tool) => tool.toolName);
	}

	private getProxyConfigIds(): string[] {
		return getProxyToolsConfig().flatMap((tool) => [tool.proxyId, tool.toolName]);
	}

	private appendProxyTools(enabledToolIds: string[]): string[] {
		const proxyToolNames = this.getProxyToolNames();
		if (proxyToolNames.length === 0) {
			return enabledToolIds;
		}
		return [...new Set([...enabledToolIds, ...proxyToolNames])];
	}

	private filterSupportedConfigIds(ids: string[]): string[] {
		const supportedIds = new Set<string>([
			...ALL_BUILTIN_TOOL_IDS,
			...TOOL_ID_GROUPS.sandbox,
			HF_FILES_FLAG,
			README_INCLUDE_FLAG,
			GRADIO_IMAGE_FILTER_FLAG,
			...this.getProxyConfigIds(),
		]);
		const unsupportedIds = ids.filter((id) => !supportedIds.has(id));
		if (unsupportedIds.length > 0) {
			logger.warn({ unsupportedIds: [...new Set(unsupportedIds)] }, 'Ignoring unsupported tool configuration IDs');
		}
		return ids.filter((id) => supportedIds.has(id));
	}

	private resolveToolIds(ids: readonly string[]): string[] {
		const supportedIds = this.filterSupportedConfigIds([...new Set(ids)]);
		const toolIds = supportedIds.filter(
			(id) => id !== HF_FILES_FLAG && id !== README_INCLUDE_FLAG && id !== GRADIO_IMAGE_FILTER_FLAG
		);
		return [...new Set(this.applyToolDependencies(toolIds))];
	}

	private getBehaviorFlags(ids: readonly string[], hfToken?: string): ToolBehaviorFlags {
		if (!hfToken) {
			return {
				allowReadmeInclude: false,
				stripGradioImages: false,
				enableHfFsWrite: false,
			};
		}
		return {
			allowReadmeInclude: ids.includes(README_INCLUDE_FLAG),
			stripGradioImages: ids.includes(GRADIO_IMAGE_FILTER_FLAG),
			enableHfFsWrite: ids.includes(HF_FILES_FLAG),
		};
	}

	private applyAuthVisibility(enabledToolIds: string[], hfToken?: string): string[] {
		if (hfToken) {
			return enabledToolIds;
		}

		return enabledToolIds.filter(isBuiltInToolVisibleAnonymously);
	}

	/**
	 * Selects tools based on clear precedence rules:
	 * 1. Bouquet override (highest precedence)
	 * 2. Mix + user settings (additive)
	 * 3. User settings (external/internal API)
	 * 4. Fallback (all tools)
	 *
	 */
	async selectTools(context: ToolSelectionContext): Promise<ToolSelectionResult> {
		const { bouquet, mix } = extractAuthBouquetAndMix(context.headers);
		const mixList = mix ?? [];

		const proxyToolNames = this.getProxyToolNames();
		const hasProxyBouquet = bouquet === 'proxy';
		const includesProxyMix = mixList.includes('proxy');

		// 1. Bouquet override (highest precedence)
		if (bouquet && BOUQUETS[bouquet]) {
			const configuredIds = BOUQUETS[bouquet].builtInTools;
			let enabledToolIds = this.resolveToolIds(configuredIds);
			const wantsProxyTools = hasProxyBouquet || includesProxyMix;
			if (wantsProxyTools && proxyToolNames.length > 0) {
				enabledToolIds = this.appendProxyTools(enabledToolIds);
			} else if (wantsProxyTools && proxyToolNames.length === 0) {
				logger.warn('Proxy tools requested but no proxy tools are configured');
			}
			enabledToolIds = this.applyAuthVisibility(enabledToolIds, context.hfToken);
			logger.debug({ bouquet, mix: includesProxyMix ? ['proxy'] : [], enabledToolIds }, 'Using bouquet override');
			return {
				mode: ToolSelectionMode.BOUQUET_OVERRIDE,
				enabledToolIds,
				behaviorFlags: this.getBehaviorFlags(configuredIds, context.hfToken),
				reason: `Bouquet override: ${bouquet}${includesProxyMix ? ' + proxy mix' : ''}`,
			};
		}

		// 2. Get base user settings
		const rawBaseSettings = await this.getUserSettings(context);
		const baseSettings = rawBaseSettings;

		// 3. Apply mix if specified and we have base settings
		if (mixList.length > 0 && baseSettings) {
			const validMixes = mixList.filter((mixName) => {
				const isValid = Boolean(BOUQUETS[mixName]);
				if (!isValid) {
					logger.warn({ mixName }, 'Ignoring invalid mix bouquet name');
				}
				return isValid;
			});

			if (validMixes.length > 0) {
				const includesProxyMix = validMixes.includes('proxy');
				const mixedTools = validMixes.flatMap((mixName) => BOUQUETS[mixName]?.builtInTools ?? []);
				const combinedTools = [...new Set([...baseSettings.builtInTools, ...mixedTools])];
				let enabledToolIds = this.resolveToolIds(combinedTools);
				if (includesProxyMix && proxyToolNames.length > 0) {
					enabledToolIds = this.appendProxyTools(enabledToolIds);
				} else if (includesProxyMix && proxyToolNames.length === 0) {
					logger.warn('Proxy mix requested but no proxy tools are configured');
				}
				enabledToolIds = this.applyAuthVisibility(enabledToolIds, context.hfToken);

				logger.debug(
					{
						mix: validMixes,
						baseToolCount: baseSettings.builtInTools.length,
						mixToolCount: mixedTools.length,
						finalToolCount: enabledToolIds.length,
					},
					'Applying mix to user settings'
				);

				return {
					mode: ToolSelectionMode.MIX,
					enabledToolIds,
					behaviorFlags: this.getBehaviorFlags(combinedTools, context.hfToken),
					reason: `User settings + mix(${validMixes.join(',')})`,
					baseSettings,
					mixedBouquet: validMixes,
				};
			}
		}

		// 4. Use base settings if available
		if (baseSettings) {
			const mode = this.apiClient.getTransportInfo()?.externalApiMode
				? ToolSelectionMode.EXTERNAL_API
				: ToolSelectionMode.INTERNAL_API;

			const enabledToolIds = this.resolveToolIds(baseSettings.builtInTools);
			const visibleToolIds = this.applyAuthVisibility(enabledToolIds, context.hfToken);

			logger.debug(
				{
					mode,
					enabledToolIds: visibleToolIds,
				},
				'Using user settings'
			);

			return {
				mode,
				enabledToolIds: visibleToolIds,
				behaviorFlags: this.getBehaviorFlags(baseSettings.builtInTools, context.hfToken),
				reason: mode === ToolSelectionMode.EXTERNAL_API ? `External API user settings` : `Internal API user settings`,
				baseSettings,
			};
		}

		// 5. Fallback
		logger.warn('No settings available, using fallback');
		const fallbackMixes = mixList.filter((mixName) => {
			const isValid = Boolean(BOUQUETS[mixName]);
			if (!isValid) {
				logger.warn({ mixName }, 'Ignoring invalid mix bouquet name');
			}
			return isValid;
		});
		const fallbackMixTools = fallbackMixes.flatMap((mixName) => BOUQUETS[mixName]?.builtInTools ?? []);
		const configuredIds = [...ALL_BUILTIN_TOOL_IDS, ...fallbackMixTools];
		let enabledToolIds = this.resolveToolIds(configuredIds);
		if (includesProxyMix && proxyToolNames.length > 0) {
			enabledToolIds = this.appendProxyTools(enabledToolIds);
		} else if (includesProxyMix && proxyToolNames.length === 0) {
			logger.warn('Proxy mix requested but no proxy tools are configured');
		}
		enabledToolIds = this.applyAuthVisibility(enabledToolIds, context.hfToken);
		return {
			mode: ToolSelectionMode.FALLBACK,
			enabledToolIds,
			behaviorFlags: this.getBehaviorFlags(configuredIds, context.hfToken),
			reason: `Fallback - no settings available${fallbackMixes.length > 0 ? ` + mix(${fallbackMixes.join(',')})` : ''}`,
			mixedBouquet: fallbackMixes.length > 0 ? fallbackMixes : undefined,
		};
	}

	/**
	 * Gets user settings from provided context or API client
	 */
	private async getUserSettings(context: ToolSelectionContext): Promise<AppSettings | null> {
		// Use provided user settings (from proxy mode)
		if (context.userSettings) {
			logger.debug('Using provided user settings');
			return {
				...context.userSettings,
				builtInTools: this.filterSupportedConfigIds([...new Set(context.userSettings.builtInTools)]),
			};
		}

		// Fetch from API client (skip in test environment)
		if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
			logger.debug('Skipping API client fetch in test environment');
			return null;
		}

		try {
			const settings = await this.apiClient.getSettings(context.hfToken);
			return {
				...settings,
				builtInTools: this.filterSupportedConfigIds([...new Set(settings.builtInTools)]),
			};
		} catch (error) {
			logger.warn({ error }, 'Failed to fetch user settings from API client');
		}

		return null;
	}
}
