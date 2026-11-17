import { isPtcProfile } from '../ptc/profile.js';
import {
	PTC_TOOL_NAMES,
	ALL_BUILTIN_TOOL_IDS,
	DYNAMIC_SPACE_TOOL_ID,
	HF_FILES_FLAG,
	HF_FS_WRITE_TOOL_ID,
	TOOL_ID_GROUPS,
} from '@llmindset/hf-mcp';
import type { AppSettings } from '../../shared/settings.js';
import { getProxyToolsConfig, type ProxyToolDefinition } from './proxy-tools-config.js';
import { isGradioTool } from './gradio-utils.js';

const FIXED_DIRECT_TOOL_NAMES = new Set(['hf_whoami']);
const LOCAL_DIRECT_TOOL_NAMES = new Set<string>([...ALL_BUILTIN_TOOL_IDS, ...TOOL_ID_GROUPS.sandbox]);

interface ToolCallRequest {
	method?: unknown;
	params?: {
		name?: unknown;
		arguments?: unknown;
	};
}

function toolCallName(request: unknown): string | undefined {
	const body = request as ToolCallRequest | null;
	const name = body?.method === 'tools/call' ? body.params?.name : undefined;
	return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function isToolCallRequest(request: unknown): boolean {
	return (request as ToolCallRequest | null)?.method === 'tools/call';
}

function isDynamicSpaceInvoke(request: unknown): boolean {
	const body = request as ToolCallRequest | null;
	if (body?.method !== 'tools/call' || body.params?.name !== DYNAMIC_SPACE_TOOL_ID) {
		return false;
	}
	const args = body.params.arguments;
	return typeof args === 'object' && args !== null && 'operation' in args && args.operation === 'invoke';
}

function noImageContentRequested(headers?: Record<string, string>): boolean {
	return headers?.['x-mcp-no-image-content']?.trim().toLowerCase() === 'true';
}

function settingsFor(ids: string[]): AppSettings {
	return {
		builtInTools: ids,
		spaceTools: [],
	};
}

export function isConfiguredProxyToolName(
	toolName: string,
	proxyTools: readonly ProxyToolDefinition[] = getProxyToolsConfig()
): boolean {
	return proxyTools.some((tool) => tool.toolName === toolName);
}

export function withoutDiscoverySelectionHeaders(headers: Record<string, string>): Record<string, string> {
	// Unlike legacy bouquets, this is an execution boundary, not just discovery.
	if (isPtcProfile(headers)) return { ...headers };
	const directHeaders = { ...headers };
	delete directHeaders['x-mcp-bouquet'];
	delete directHeaders['x-mcp-mix'];
	return directHeaders;
}

/**
 * Returns request-local settings for direct calls whose execution contract is
 * known without consulting per-user discovery settings.
 *
 * `undefined` means that the normal settings path is still required. Generated
 * Gradio aliases need the user's Space mapping, while dynamic Space invocations
 * retain the settings-derived image filtering preference unless the request
 * explicitly opts out of image content.
 */
export function getDirectToolCallSettings(
	request: unknown,
	headers?: Record<string, string>,
	proxyTools: readonly ProxyToolDefinition[] = getProxyToolsConfig()
): AppSettings | undefined {
	if (isPtcProfile(headers)) {
		return isToolCallRequest(request) ? settingsFor([...PTC_TOOL_NAMES]) : undefined;
	}
	const name = toolCallName(request);
	if (!name) {
		return isToolCallRequest(request) ? settingsFor([]) : undefined;
	}

	if (isDynamicSpaceInvoke(request) && !noImageContentRequested(headers)) {
		return undefined;
	}

	if (FIXED_DIRECT_TOOL_NAMES.has(name)) {
		return settingsFor([]);
	}

	if (name === HF_FS_WRITE_TOOL_ID) {
		return settingsFor([HF_FILES_FLAG]);
	}

	if (LOCAL_DIRECT_TOOL_NAMES.has(name)) {
		return settingsFor([name]);
	}

	if (isConfiguredProxyToolName(name, proxyTools)) {
		return settingsFor([name]);
	}

	// Generated Gradio aliases are the only unknown names that can be resolved
	// through per-user discovery settings.
	if (isGradioTool(name)) {
		return undefined;
	}

	// A definitely unknown call should fail locally without consulting the
	// user's discovery settings.
	return settingsFor([]);
}
