import type { ToolResult } from '../../types/tool-result.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { analyzeSchemaComplexity } from '../utils/schema-validator.js';
import { formatParameters, formatComplexSchemaError } from '../utils/parameter-formatter.js';
import { fetchGradioSchema, fetchSpaceMetadata } from '../utils/space-http.js';

/**
 * Fetches space metadata and schema to discover parameters
 */
export async function viewParameters(spaceName: string, hfToken?: string): Promise<ToolResult> {
	try {
		// Step 1: Fetch space metadata to get subdomain
		const metadata = await fetchSpaceMetadata(spaceName, hfToken);

		// Step 2: Fetch schema from Gradio endpoint
		const tools = await fetchGradioSchema(metadata.subdomain, metadata.private, hfToken);

		// For simplicity, we'll work with the first tool
		// (most Gradio spaces expose a single primary tool)
		if (tools.length === 0) {
			return {
				formatted: `Error: No tools found for space '${spaceName}'.`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		const tool = tools[0] as Tool;

		// Step 3: Analyze schema complexity
		const schemaResult = analyzeSchemaComplexity(tool);

		if (!schemaResult.isSimple) {
			return {
				formatted: formatComplexSchemaError(spaceName, schemaResult.reason || 'Unknown reason'),
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Step 4: Format parameters for display
		const formatted = formatParameters(schemaResult, spaceName);

		return {
			formatted,
			totalResults: schemaResult.parameters.length,
			resultsShared: schemaResult.parameters.length,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Check if this is a 404 error (space not found)
		const is404 = errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found');

		let formattedError = `Error fetching parameters for space '${spaceName}': ${errorMessage}`;

		if (is404) {
			formattedError +=
				'\n\nNote: The space MUST be an MCP enabled space. Use the `space_search` tool to find MCP enabled spaces.';
		}

		return {
			formatted: formattedError,
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}
}
