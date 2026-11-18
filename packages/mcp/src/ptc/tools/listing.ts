import { definePtcTool, READ_ONLY, type PtcTool } from '../core/tool.js';
import {
	modelsInputSchema,
	datasetsInputSchema,
	spacesListInputSchema,
	spacesSearchInputSchema,
} from '../listing/schemas.js';
import {
	modelsOutputSchema,
	datasetsOutputSchema,
	spacesListOutputSchema,
	spacesSearchOutputSchema,
} from '../listing/records.js';
import { listModels, listDatasets, listSpaces, searchSpaces } from '../listing/run.js';

/** The four Hub listing/search tools (shipped first in the PTC slice). */
export const LISTING_TOOLS: readonly PtcTool[] = [
	definePtcTool({
		name: 'hf_models_search',
		family: 'discovery',
		title: 'Search Hugging Face models',
		description:
			'Search Hugging Face model repositories (weights, checkpoints, LLMs) by name, or browse. Find fine-tune, adapter, GGUF and quantized builds using name prefixes and filters for owner, task, library, language, license, parameter size or base-model lineage. Sort by downloads, likes, trending, date or parameter count. Returns repository IDs and hf:// URIs. See hf_repo_fulltext_search, hf_trending.',
		input: modelsInputSchema,
		output: modelsOutputSchema,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (input, ctx) => listModels(input, ctx),
	}),
	definePtcTool({
		name: 'hf_datasets_search',
		family: 'discovery',
		title: 'Search Hugging Face datasets',
		description:
			'Search Hugging Face dataset repositories (training data, benchmarks, eval sets) by name, or browse. Filter by owner, task category, modality, format, language, license, library or size bucket, including benchmark and agent-trace tags. Sort by downloads, likes, trending, date or stored size. For bulk row counts, use sort="numRows" (first page only); batch known IDs with idsAny and set limit to the batch size. Missing numRows means unknown, not zero. Returns repository IDs and hf:// URIs.',
		input: datasetsInputSchema,
		output: datasetsOutputSchema,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (input, ctx) => listDatasets(input, ctx),
	}),
	definePtcTool({
		name: 'hf_spaces_list',
		family: 'discovery',
		title: 'List Hugging Face Spaces',
		description:
			'List Hugging Face Spaces (apps, demos) by owner or organization, or browse repository names. Filter by SDK such as Gradio, Docker or static, running state, concrete hardware flavor, MCP server tag, exact tags or linked models and datasets. Sort by likes, trending or recency. Returns IDs and links, with optional SDK and runtime hardware details; listings support cursor paging. See hf_spaces_search.',
		input: spacesListInputSchema,
		output: spacesListOutputSchema,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (input, ctx) => listSpaces(input, ctx),
	}),
	definePtcTool({
		name: 'hf_spaces_search',
		family: 'discovery',
		title: 'Find Spaces by what they do',
		description:
			'Find Hugging Face Spaces (apps, Gradio demos) by use case, such as image generation. Multiword queries use hybrid semantic search; one-word queries match names and tags. Select a category or filter by SDK, tags, running state or MCP server tag. Returns relevance-ranked repository IDs and links from a bounded candidate set without paging. See hf_spaces_list.',
		input: spacesSearchInputSchema,
		output: spacesSearchOutputSchema,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (input, ctx) => searchSpaces(input, ctx),
	}),
];
