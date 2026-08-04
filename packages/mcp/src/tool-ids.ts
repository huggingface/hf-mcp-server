/**
 * Canonical tool IDs exported from their respective tool configurations
 * This ensures single source of truth for all tool identifiers
 */

import {
	REPO_SEARCH_TOOL_CONFIG,
	CREATE_REPO_TOOL_CONFIG,
	HUB_REPO_DETAILS_TOOL_CONFIG,
	HF_FS_TOOL_CONFIG,
	HF_JOBS_TOOL_CONFIG,
	HF_SANDBOX_EXEC_TOOL_CONFIG,
	HF_SANDBOX_TOOL_CONFIG,
	HF_SANDBOX_FS_TOOL_CONFIG,
	DYNAMIC_SPACE_TOOL_CONFIG,
} from './index.js';

// Extract tool IDs from their configs (single source of truth)
export const REPO_SEARCH_TOOL_ID = REPO_SEARCH_TOOL_CONFIG.name;
export const CREATE_REPO_TOOL_ID = CREATE_REPO_TOOL_CONFIG.name;
export const HUB_REPO_DETAILS_TOOL_ID = HUB_REPO_DETAILS_TOOL_CONFIG.name;
export const HF_FS_TOOL_ID = HF_FS_TOOL_CONFIG.name;
export const HF_JOBS_TOOL_ID = HF_JOBS_TOOL_CONFIG.name;
export const HF_SANDBOX_TOOL_ID = HF_SANDBOX_TOOL_CONFIG.name;
export const HF_SANDBOX_EXEC_TOOL_ID = HF_SANDBOX_EXEC_TOOL_CONFIG.name;
export const HF_SANDBOX_FS_TOOL_ID = HF_SANDBOX_FS_TOOL_CONFIG.name;
export const DYNAMIC_SPACE_TOOL_ID = DYNAMIC_SPACE_TOOL_CONFIG.name;

// Complete list of all built-in tool IDs
export const ALL_BUILTIN_TOOL_IDS = [
	REPO_SEARCH_TOOL_ID,
	CREATE_REPO_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
	HF_FS_TOOL_ID,
	HF_JOBS_TOOL_ID,
	DYNAMIC_SPACE_TOOL_ID,
] as const;
// Grouped tool IDs for bouquet configurations
export const TOOL_ID_GROUPS = {
	search: [REPO_SEARCH_TOOL_ID] as const,
	spaces: [
		REPO_SEARCH_TOOL_ID,
		CREATE_REPO_TOOL_ID,
		HUB_REPO_DETAILS_TOOL_ID,
		HF_FS_TOOL_ID,
		DYNAMIC_SPACE_TOOL_ID,
	] as const,
	detail: [HUB_REPO_DETAILS_TOOL_ID] as const,
	docs: [HF_FS_TOOL_ID] as const,
	hf_api: [REPO_SEARCH_TOOL_ID, CREATE_REPO_TOOL_ID, HUB_REPO_DETAILS_TOOL_ID, HF_FS_TOOL_ID] as const,
	dynamic_space: [DYNAMIC_SPACE_TOOL_ID] as const,
	all: [...ALL_BUILTIN_TOOL_IDS] as const,
	sandbox: [HF_SANDBOX_TOOL_ID, HF_SANDBOX_EXEC_TOOL_ID, HF_SANDBOX_FS_TOOL_ID] as const,
} as const;

// TypeScript type for built-in tool IDs
export type BuiltinToolId = (typeof ALL_BUILTIN_TOOL_IDS)[number];

// Type guard function
export function isValidBuiltinToolId(toolId: string): toolId is BuiltinToolId {
	return (ALL_BUILTIN_TOOL_IDS as readonly string[]).includes(toolId);
}
