const KNOWLEDGE_DATE = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'long',
	year: 'numeric',
	timeZone: 'UTC',
}).format(new Date());

interface BrowserToolConfig {
	name: string;
	description: string;
	annotations: {
		title: string;
		destructiveHint: boolean;
		readOnlyHint: boolean;
		openWorldHint: boolean;
	};
}

export const SEMANTIC_SEARCH_TOOL_CONFIG: BrowserToolConfig = {
	name: 'space_search',
	description:
		'Find Hugging Face Spaces using semantic search. IMPORTANT Only MCP Servers can be used with the dynamic_space tool' +
		'Include links to the Space when presenting the results.',
	annotations: {
		title: 'Hugging Face Space Search',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const REPO_SEARCH_TOOL_CONFIG: BrowserToolConfig = {
	name: 'hub_repo_search',
	description:
		'Search Hugging Face repositories with a shared query interface. ' +
		'You can target models, datasets, spaces, or aggregate across multiple repo types in one call. ' +
		'Use space_search for semantic-first discovery of Spaces. ' +
		'Include links to repositories in your response.',
	annotations: {
		title: 'Repo Search',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const PAPER_SEARCH_TOOL_CONFIG: BrowserToolConfig = {
	name: 'paper_search',
	description:
		'Find Machine Learning research papers on the Hugging Face hub. ' +
		"Include 'Link to paper' When presenting the results. " +
		'Consider whether tabulating results matches user intent.',
	annotations: {
		title: 'Paper Search',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const HUB_REPO_DETAILS_TOOL_CONFIG: BrowserToolConfig = {
	name: 'hub_repo_details',
	description:
		'Get details for one or more Hugging Face repos (model, dataset, or space). ' +
		'Auto-detects type unless specified.',
	annotations: {
		title: 'Hub Repo Details',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: false,
	},
};

export const DUPLICATE_SPACE_TOOL_CONFIG: BrowserToolConfig = {
	name: 'duplicate_space',
	description: '',
	annotations: {
		title: 'Duplicate Hugging Face Space',
		destructiveHint: false,
		readOnlyHint: false,
		openWorldHint: true,
	},
};

export const SPACE_FILES_TOOL_CONFIG: BrowserToolConfig = {
	name: 'space_files',
	description: '',
	annotations: {
		title: 'Space Files List',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const DOCS_SEMANTIC_SEARCH_CONFIG: BrowserToolConfig = {
	name: 'hf_doc_search',
	description:
		'Search and Discover Hugging Face Product and Library documentation. Send an empty query to discover structure and navigation instructions. ' +
		`Knowledge up-to-date as at ${KNOWLEDGE_DATE}. Combine with the Product filter to focus results.`,
	annotations: {
		title: 'Hugging Face Documentation Search',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const DOC_FETCH_CONFIG: BrowserToolConfig = {
	name: 'hf_doc_fetch',
	description:
		'Fetch a document from the Hugging Face or Gradio documentation library. For large documents, use offset to get subsequent chunks.',
	annotations: {
		title: 'Fetch a document from the Hugging Face documentation library',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
};

export const SPACE_SEARCH_TOOL_ID = SEMANTIC_SEARCH_TOOL_CONFIG.name;
export const MODEL_SEARCH_TOOL_ID = 'model_search';
export const REPO_SEARCH_TOOL_ID = REPO_SEARCH_TOOL_CONFIG.name;
export const MODEL_DETAIL_TOOL_ID = 'model_details';
export const PAPER_SEARCH_TOOL_ID = PAPER_SEARCH_TOOL_CONFIG.name;
export const DATASET_SEARCH_TOOL_ID = 'dataset_search';
export const DATASET_DETAIL_TOOL_ID = 'dataset_details';
export const HUB_REPO_DETAILS_TOOL_ID = HUB_REPO_DETAILS_TOOL_CONFIG.name;
export const DUPLICATE_SPACE_TOOL_ID = DUPLICATE_SPACE_TOOL_CONFIG.name;
export const SPACE_INFO_TOOL_ID = 'space_info';
export const SPACE_FILES_TOOL_ID = SPACE_FILES_TOOL_CONFIG.name;
export const USE_SPACE_TOOL_ID = 'use_space';
export const DOCS_SEMANTIC_SEARCH_TOOL_ID = DOCS_SEMANTIC_SEARCH_CONFIG.name;
export const DOC_FETCH_TOOL_ID = DOC_FETCH_CONFIG.name;
export const HF_JOBS_TOOL_ID = 'hf_jobs';
export const DYNAMIC_SPACE_TOOL_ID = 'dynamic_space';

export const ALL_BUILTIN_TOOL_IDS = [
	SPACE_SEARCH_TOOL_ID,
	MODEL_SEARCH_TOOL_ID,
	REPO_SEARCH_TOOL_ID,
	MODEL_DETAIL_TOOL_ID,
	PAPER_SEARCH_TOOL_ID,
	DATASET_SEARCH_TOOL_ID,
	DATASET_DETAIL_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
	DUPLICATE_SPACE_TOOL_ID,
	SPACE_INFO_TOOL_ID,
	SPACE_FILES_TOOL_ID,
	DOCS_SEMANTIC_SEARCH_TOOL_ID,
	DOC_FETCH_TOOL_ID,
	USE_SPACE_TOOL_ID,
	HF_JOBS_TOOL_ID,
	DYNAMIC_SPACE_TOOL_ID,
] as const;

export const TOOL_ID_GROUPS = {
	search: [SPACE_SEARCH_TOOL_ID, REPO_SEARCH_TOOL_ID, PAPER_SEARCH_TOOL_ID, DOCS_SEMANTIC_SEARCH_TOOL_ID] as const,
	spaces: [
		SPACE_SEARCH_TOOL_ID,
		DUPLICATE_SPACE_TOOL_ID,
		SPACE_INFO_TOOL_ID,
		SPACE_FILES_TOOL_ID,
		USE_SPACE_TOOL_ID,
	] as const,
	detail: [MODEL_DETAIL_TOOL_ID, DATASET_DETAIL_TOOL_ID, HUB_REPO_DETAILS_TOOL_ID] as const,
	docs: [DOCS_SEMANTIC_SEARCH_TOOL_ID, DOC_FETCH_TOOL_ID] as const,
	hf_api: [
		SPACE_SEARCH_TOOL_ID,
		REPO_SEARCH_TOOL_ID,
		PAPER_SEARCH_TOOL_ID,
		HUB_REPO_DETAILS_TOOL_ID,
		DOCS_SEMANTIC_SEARCH_TOOL_ID,
	] as const,
	dynamic_space: [DYNAMIC_SPACE_TOOL_ID] as const,
	all: [...ALL_BUILTIN_TOOL_IDS] as const,
} as const;

export type BuiltinToolId = (typeof ALL_BUILTIN_TOOL_IDS)[number];

export function isValidBuiltinToolId(toolId: string): toolId is BuiltinToolId {
	return (ALL_BUILTIN_TOOL_IDS as readonly string[]).includes(toolId);
}
