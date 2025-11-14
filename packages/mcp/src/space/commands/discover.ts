import type { ToolResult } from '../../types/tool-result.js';
import { SpaceSearchTool, type SpaceSearchResult } from '../../space-search.js';
import { escapeMarkdown } from '../../utilities.js';

// Default number of results to return
const DEFAULT_RESULTS_LIMIT = 10;

/**
 * Discovers MCP-enabled Gradio Spaces suitable for invocation
 */
export async function discoverSpaces(
	searchQuery: string,
	limit: number = DEFAULT_RESULTS_LIMIT,
	hfToken?: string
): Promise<ToolResult> {
	try {
		// Validate search query
		if (!searchQuery || searchQuery.trim().length === 0) {
			return {
				formatted: `Error: Search query is required.

Example:
\`\`\`json
{
  "operation": "discover",
  "search_query": "Image Generation",
  "limit": 10
}
\`\`\`

Suggested task-focused queries:
- "Video Generation"
- "Object Detection"
- "Image Generation"
- "Text Classification"
- "Speech Recognition"
- "Text to Speech"`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Use the SpaceSearchTool with MCP filter enabled
		const searchTool = new SpaceSearchTool(hfToken);
		const { results, totalCount } = await searchTool.search(searchQuery, limit, true);

		// Format results without the author column
		return formatDiscoverResults(searchQuery, results, totalCount);
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
 * Formats discover results as a markdown table (without author column)
 */
function formatDiscoverResults(
	query: string,
	results: SpaceSearchResult[],
	totalCount: number
): ToolResult {
	if (results.length === 0) {
		return {
			formatted: `No MCP-enabled Spaces found for the query '${query}'.

Try a different task-focused query such as:
- "Video Generation"
- "Object Detection"
- "Image Generation"
- "Text Classification"
- "Speech Recognition"
- "Text to Speech"`,
			totalResults: 0,
			resultsShared: 0,
		};
	}

	const showingText =
		results.length < totalCount
			? `Showing ${results.length.toString()} of ${totalCount.toString()} results`
			: `All ${results.length.toString()} results`;

	let markdown = `# MCP Space Discovery Results for '${query}' (${showingText})\n\n`;
	markdown += 'These Spaces can be invoked using the dynamic_space tool.\n\n';
	markdown += '| Space | Description | ID | Category | Likes | Trending | Relevance |\n';
	markdown += '|-------|-------------|----|----|-------|----------|----------|\n';

	for (const result of results) {
		const title = result.title || 'Untitled';
		const description = result.shortDescription || result.ai_short_description || 'No description';
		const id = result.id || '';
		const emoji = result.emoji ? escapeMarkdown(result.emoji) + ' ' : '';
		const relevance = result.semanticRelevancyScore
			? (result.semanticRelevancyScore * 100).toFixed(1) + '%'
			: 'N/A';

		markdown +=
			`| ${emoji}[${escapeMarkdown(title)}](https://hf.co/spaces/${id}) ` +
			`| ${escapeMarkdown(description)} ` +
			`| \`${escapeMarkdown(id)}\` ` +
			`| \`${escapeMarkdown(result.ai_category ?? '-')}\` ` +
			`| ${escapeMarkdown(result.likes?.toString() ?? '-')} ` +
			`| ${escapeMarkdown(result.trendingScore?.toString() ?? '-')} ` +
			`| ${relevance} |\n`;
	}

	return {
		formatted: markdown,
		totalResults: totalCount,
		resultsShared: results.length,
	};
}
