import { formatSpaceFailure } from '../utils/space-error.js';
import { selectTool } from '../utils/tool-selection.js';
import type { DynamicSpaceErrorMetadata, ToolResult } from '../../types/tool-result.js';
import { analyzeSchemaComplexity } from '../utils/schema-validator.js';
import { formatParameters, formatComplexSchemaError } from '../utils/parameter-formatter.js';
import { fetchGradioSchema, fetchSpaceMetadata } from '../utils/space-http.js';

/**
 * Fetches space metadata and schema to discover parameters
 */
export async function viewParameters(spaceName: string, hfToken?: string, toolName?: string): Promise<ToolResult> {
	let failure: DynamicSpaceErrorMetadata = { stage: 'metadata', code: 'metadata_fetch_failed' };
	try {
		// Step 1: Fetch space metadata to get subdomain
		const metadata = await fetchSpaceMetadata(spaceName, hfToken);

		// Step 2: Fetch schema from Gradio endpoint
		failure = { stage: 'schema', code: 'schema_fetch_failed' };
		const tools = await fetchGradioSchema(metadata.subdomain, metadata.private, hfToken);

		const tool = selectTool(tools, spaceName, toolName);
		if ('formatted' in tool) return tool;
		failure = { stage: 'schema', code: 'unsupported_schema' };

		// Step 3: Analyze schema complexity
		const schemaResult = analyzeSchemaComplexity(tool);

		if (!schemaResult.isSimple) {
			return {
				formatted: formatComplexSchemaError(spaceName, schemaResult.reason || 'Unknown reason'),
				totalResults: 0,
				resultsShared: 0,
				isError: true,
				errorMetadata: { stage: 'schema', code: 'unsupported_schema' },
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
		return formatSpaceFailure(error, failure, `Error fetching parameters for space '${spaceName}'`);
	}
}
