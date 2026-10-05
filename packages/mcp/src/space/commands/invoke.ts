import { formatSpaceFailure } from '../utils/space-error.js';
import { selectTool } from '../utils/tool-selection.js';
import type { DynamicSpaceErrorMetadata, ToolResult } from '../../types/tool-result.js';
import type { InvokeResult } from '../types.js';
import type { Progress } from '@modelcontextprotocol/client';
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
	parametersJson: string | Record<string, unknown>,
	hfToken?: string,
	onProgress?: (progress: Progress) => void | Promise<void>,
	toolName?: string
): Promise<InvokeResult | ToolResult> {
	let failure: DynamicSpaceErrorMetadata = { stage: 'metadata', code: 'metadata_fetch_failed' };
	try {
		// Step 1: Parse parameters JSON
		let inputParameters: Record<string, unknown>;
		try {
			const parsed: unknown = typeof parametersJson === 'string' ? JSON.parse(parametersJson) : parametersJson;
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
				errorMetadata: { stage: 'request', code: 'invalid_parameters_json' },
			};
		}

		// Step 2: Fetch space metadata to get subdomain
		const metadata = await fetchSpaceMetadata(spaceName, hfToken);

		// Step 3: Fetch schema from Gradio endpoint
		failure = { stage: 'schema', code: 'schema_fetch_failed' };
		const tools = await fetchGradioSchema(metadata.subdomain, metadata.private, hfToken);

		const tool = selectTool(tools, spaceName, toolName);
		if ('formatted' in tool) return tool;
		failure = { stage: 'schema', code: 'unsupported_schema' };

		// Step 4: Analyze schema complexity
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

		// Step 5: Validate parameters
		failure = { stage: 'validation', code: 'invalid_parameters' };
		const validation = validateParameters(inputParameters, schemaResult);
		if (!validation.valid) {
			return {
				formatted: formatValidationError(validation.errors, spaceName),
				errorMetadata: failure,
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
		failure = { stage: 'invocation', code: 'invocation_failed' };
		const { result } = await callGradioToolWithHeaders(mcpUrl, tool.name, finalParameters, hfToken, {
			logProxiedReplica: true,
			onProgress,
		});

		// Return raw MCP result with warnings if any
		// This ensures the space tool behaves identically to proxied gr_* tools
		return {
			result,
			warnings,
			totalResults: 1,
			resultsShared: 1,
			isError: result.isError,
			...(result.isError ? { errorMetadata: { stage: 'invocation', code: 'upstream_tool_error' } as const } : {}),
		};
	} catch (error) {
		return formatSpaceFailure(error, failure, `Error invoking space '${spaceName}'`);
	}
}
