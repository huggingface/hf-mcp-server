import type { ToolResult } from '../../types/tool-result.js';
import { HfFsTool, type HfFsEntry } from '../../hf-fs.js';
import { escapeMarkdown } from '../../utilities.js';
import { VIEW_PARAMETERS } from '../dynamic-space-tool.js';

// Default number of results to return
const DEFAULT_RESULTS_LIMIT = 10;

/**
 * Copy used by the find operation.
 */
const FIND_COPY = {
	// Task hints shown when called with blank query
	TASK_HINTS: `Here are some examples of tasks that dynamic spaces can perform:

- Image Generation
- Video Generation
- Text Generation
- Visual QA
- Language Translation
- Speech Synthesis
- 3D Modeling
- Object Detection
- Text Analysis
- Image Editing
- Code Generation
- Question Answering
- Data Visualization
- Voice Cloning
- Background Removal
- OCR
- Image Captioning
- Sentiment Analysis
- Music Generation
- Style Transfer

To find MCP-enabled Spaces for a specific task, call this operation with a search query:

**Example:**
\`\`\`json
{
  "operation": "find",
  "search_query": "image generation",
  "limit": 10
}
\`\`\``,

	// Header for search results
	RESULTS_HEADER: (query: string, showing: number, truncated: boolean) => {
		const showingText = truncated ? `Showing the first ${showing} results` : `${showing} results`;
		return `# MCP Space Find Results for "${query}" (${showingText})

These MCP-enabled Spaces can be invoked using the \`dynamic_space\` tool.
Use \`"operation": "${VIEW_PARAMETERS}"\` to inspect a space's parameters before invoking.

`;
	},

	// No results message
	NO_RESULTS: (query: string) =>
		`No MCP-enabled Spaces found for "${query}".

Try:
- Broader search terms (e.g., "image generation" instead of specific model names)
- Task-focused queries (e.g., "text generation", "object detection")
- Different task categories (e.g., "video generation", "image classification")`,
};

/**
 * Discovers MCP-enabled Spaces based on search criteria
 *
 * @param searchQuery - The search query or task category
 * @param limit - Maximum number of results to return
 * @param hfToken - Optional HuggingFace API token
 * @returns Formatted search results
 */
export async function findSpaces(
	searchQuery?: string,
	limit: number = DEFAULT_RESULTS_LIMIT,
	hfToken?: string
): Promise<ToolResult> {
	// Return task hints when called with blank query
	if (!searchQuery || searchQuery.trim() === '') {
		return {
			formatted: FIND_COPY.TASK_HINTS,
			totalResults: 0,
			resultsShared: 0,
		};
	}

	try {
		const result = await new HfFsTool(hfToken).run({
			op: 'search',
			uri: 'hf://spaces',
			query: searchQuery,
			space_kind: 'mcp',
			limit,
		});
		if (!('entries' in result)) {
			throw new Error('Space search returned an unexpected result');
		}

		return formatFindResults(searchQuery, result.entries, result.truncated === true);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			formatted: `Error discovering spaces: ${errorMessage}`,
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}
}

/**
 * Formats find results as a markdown table
 * Note: Author column is omitted as it's superfluous for invocation purposes
 */
function formatFindResults(query: string, results: HfFsEntry[], truncated: boolean): ToolResult {
	if (results.length === 0) {
		return {
			formatted: FIND_COPY.NO_RESULTS(query),
			totalResults: 0,
			resultsShared: 0,
		};
	}

	let markdown = FIND_COPY.RESULTS_HEADER(query, results.length, truncated);

	// Table header (without Author column)
	markdown += '| Space | Description | Space ID | Category | Likes | Trending | Relevance |\n';
	markdown += '|-------|-------------|----------|----------|-------|----------|----------|\n';

	// Table rows
	for (const result of results) {
		const title = result.title || 'Untitled';
		const description = result.description || 'No description';
		const id = result.path;
		const relevance =
			result.semantic_relevance === undefined ? 'N/A' : `${(result.semantic_relevance * 100).toFixed(1)}%`;

		markdown +=
			`| [${escapeMarkdown(title)}](https://hf.co/spaces/${id}) ` +
			`| ${escapeMarkdown(description)} ` +
			`| \`${escapeMarkdown(id)}\` ` +
			`| \`${escapeMarkdown(result.category ?? '-')}\` ` +
			`| ${escapeMarkdown(result.likes?.toString() ?? '-')} ` +
			`| ${escapeMarkdown(result.trending_score?.toString() ?? '-')} ` +
			`| ${relevance} |\n`;
	}

	return {
		formatted: markdown,
		totalResults: results.length,
		resultsShared: results.length,
	};
}
