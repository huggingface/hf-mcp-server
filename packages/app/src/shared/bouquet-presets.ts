import {
	ALL_BUILTIN_TOOL_IDS,
	TOOL_ID_GROUPS,
	HUB_REPO_DETAILS_TOOL_ID,
	HF_FS_TOOL_ID,
	HF_JOBS_TOOL_ID,
	DYNAMIC_SPACE_TOOL_ID,
	REPO_SEARCH_TOOL_ID,
	CREATE_REPO_TOOL_ID,
	HF_FILES_FLAG,
} from '@llmindset/hf-mcp';
import type { AppSettings } from './settings.js';
import { README_INCLUDE_FLAG, GRADIO_IMAGE_FILTER_FLAG } from './behavior-flags.js';

export const BOUQUETS: Record<string, AppSettings> = {
	hf_api: {
		builtInTools: [...TOOL_ID_GROUPS.hf_api],
		spaceTools: [],
	},
	spaces: {
		builtInTools: [...TOOL_ID_GROUPS.spaces],
		spaceTools: [],
	},
	search: {
		builtInTools: [...TOOL_ID_GROUPS.search],
		spaceTools: [],
	},
	docs: {
		builtInTools: [...TOOL_ID_GROUPS.docs],
		spaceTools: [],
	},
	files: {
		builtInTools: [HF_FS_TOOL_ID],
		spaceTools: [],
	},
	skills: {
		builtInTools: [HUB_REPO_DETAILS_TOOL_ID, README_INCLUDE_FLAG, REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID, HF_JOBS_TOOL_ID],
		spaceTools: [],
	},
	research: {
		builtInTools: [HF_FILES_FLAG, ...TOOL_ID_GROUPS.sandbox, CREATE_REPO_TOOL_ID, HUB_REPO_DETAILS_TOOL_ID],
		spaceTools: [],
	},
	all: {
		builtInTools: [...ALL_BUILTIN_TOOL_IDS],
		spaceTools: [],
	},
	// Test bouquets for README inclusion behavior
	hub_repo_details_readme: {
		builtInTools: [HUB_REPO_DETAILS_TOOL_ID, README_INCLUDE_FLAG],
		spaceTools: [],
	},
	hub_repo_details: {
		builtInTools: [HUB_REPO_DETAILS_TOOL_ID],
		spaceTools: [],
	},
	no_gradio_images: {
		builtInTools: [GRADIO_IMAGE_FILTER_FLAG],
		spaceTools: [],
	},
	jobs: {
		builtInTools: [HF_JOBS_TOOL_ID],
		spaceTools: [],
	},
	sandbox: {
		builtInTools: [...TOOL_ID_GROUPS.sandbox],
		spaceTools: [],
	},
	write: {
		builtInTools: [CREATE_REPO_TOOL_ID],
		spaceTools: [],
	},
	dynamic_space: {
		builtInTools: [DYNAMIC_SPACE_TOOL_ID],
		spaceTools: [],
	},
	proxy: {
		builtInTools: [],
		spaceTools: [],
	},
};
