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
import { GRADIO_IMAGE_FILTER_FLAG } from './behavior-flags.js';

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
		builtInTools: [HUB_REPO_DETAILS_TOOL_ID, REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID, HF_JOBS_TOOL_ID],
		spaceTools: [],
	},
	research: {
		builtInTools: [HF_FILES_FLAG, ...TOOL_ID_GROUPS.sandbox, CREATE_REPO_TOOL_ID, HUB_REPO_DETAILS_TOOL_ID],
		spaceTools: [],
	},
	intern: {
		builtInTools: [
			HF_FILES_FLAG,
			...TOOL_ID_GROUPS.sandbox,
			CREATE_REPO_TOOL_ID,
			HUB_REPO_DETAILS_TOOL_ID,
			HF_JOBS_TOOL_ID,
		],
		spaceTools: [],
	},
	openai: {
		builtInTools: [
			HF_FS_TOOL_ID,
			HUB_REPO_DETAILS_TOOL_ID,
			REPO_SEARCH_TOOL_ID,
			DYNAMIC_SPACE_TOOL_ID,
			HF_JOBS_TOOL_ID,
			...TOOL_ID_GROUPS.sandbox,
		],
		spaceTools: [],
	},
	all: {
		builtInTools: [...ALL_BUILTIN_TOOL_IDS],
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
