import type { ToolResult } from '../../types/tool-result.js';
import type { InvokeResult } from '../types.js';
import type { Tool, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { analyzeSchemaComplexity, validateParameters, applyDefaults } from '../utils/schema-validator.js';
import { formatComplexSchemaError, formatValidationError } from '../utils/parameter-formatter.js';
import { callGradioToolWithHeaders } from '../utils/gradio-caller.js';
import { fetchGradioSchema, fetchSpaceMetadata } from '../utils/space-http.js';

/**
 * Invokes a Gradio space with provided parameters
 * Returns raw MCP content blocks for compatibility with proxied gr_* tools
 */
export async function invokeSpace(
	spaceName: string,
	parametersJson: string,
	hfToken?: string,
	extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<InvokeResult | ToolResult> {
	try {
		// Step 1: Parse parameters JSON
		let inputParameters: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(parametersJson);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('Parameters must be a JSON object');
			}
			inputParameters = parsed as Record<string, unknown>;
		} catch (error) {
			return {
				formatted: `Error: Invalid JSON in parameters.\n\nExpected format: {"param1": "value", "param2": 123}\nNote: Use double quotes, no trailing commas.\n\n${error instanceof Error ? error.message : String(error)}`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Step 2: Fetch space metadata to get subdomain
		const metadata = await fetchSpaceMetadata(spaceName, hfToken);

		// Step 3: Fetch schema from Gradio endpoint
		const tools = await fetchGradioSchema(metadata.subdomain, metadata.private, hfToken);

		if (tools.length === 0) {
			return {
				formatted: `Error: No tools found for space '${spaceName}'.`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		const tool = tools[0] as Tool;

		// Step 4: Analyze schema complexity
		const schemaResult = analyzeSchemaComplexity(tool);

		if (!schemaResult.isSimple) {
			return {
				formatted: formatComplexSchemaError(spaceName, schemaResult.reason || 'Unknown reason'),
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Step 5: Validate parameters
		const validation = validateParameters(inputParameters, schemaResult);
		if (!validation.valid) {
			return {
				formatted: formatValidationError(validation.errors, spaceName),
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Step 6: Check for unknown parameters (warnings)
		const warnings: string[] = [];
		const knownParamNames = new Set(schemaResult.parameters.map((p) => p.name));
		for (const key of Object.keys(inputParameters)) {
			if (!knownParamNames.has(key)) {
				warnings.push(`Unknown parameter: "${key}" (will be passed through)`);
			}
		}

		// Step 7: Apply default values for missing optional parameters
		const finalParameters = applyDefaults(inputParameters, schemaResult);

		// Step 8: Create Streamable HTTP connection and invoke tool (shared helper)
		const mcpUrl = `https://${metadata.subdomain}.hf.space/gradio_api/mcp/`;
		const { result } = await callGradioToolWithHeaders(mcpUrl, tool.name, finalParameters, hfToken, extra, {
			logProxiedReplica: true,
		});

		// Return raw MCP result with warnings if any
		// This ensures the space tool behaves identically to proxied gr_* tools
		return {
			result,
			warnings,
			totalResults: 1,
			resultsShared: 1,
			isError: result.isError,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			formatted: `Error invoking space '${spaceName}': ${errorMessage}`,
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}
}
