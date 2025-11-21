import type { ToolResult } from '../types/tool-result.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
	spaceArgsSchema,
	OPERATION_NAMES,
	type OperationName,
	type SpaceArgs,
	type InvokeResult,
	isDynamicSpaceMode,
} from './types.js';
import { findSpaces } from './commands/dynamic-find.js';
import { discoverSpaces } from './commands/discover.js';
import { viewParameters } from './commands/view-parameters.js';
import { invokeSpace } from './commands/invoke.js';

// Re-export types (including InvokeResult for external use)
export * from './types.js';

/**
 * Usage instructions when tool is called with no operation
 */
const USAGE_INSTRUCTIONS = `# Gradio Space Interaction

Dynamically interact with any Gradio MCP Space. Find spaces, view space parameter schemas, and invoke spaces.

## Supported Schema Types

✅ **Simple types** (supported):
- Strings, numbers, booleans
- Enums (predefined value sets)
- Arrays of primitives
- Shallow objects (one level deep)
- FileData (as URL strings)

To use spaces with complex schemas, add them from huggingface.co/settings/mcp.

## Available Operations

### Find
Find MCP-enabled Spaces for available for invocation based on task-focused or semantic searches.

**Example:**
\`\`\`json
{
  "operation": "find",
  "search_query": "image generation",
  "limit": 10
}
\`\`\`

### view_parameters
Display the parameter schema for a space's first tool.

**Example:**
\`\`\`json
{
  "operation": "view_parameters",
  "space_name": "evalstate/FLUX1_schnell"
}
\`\`\`

### invoke
Execute a space's first tool with provided parameters.

**Example:**
\`\`\`json
{
  "operation": "invoke",
  "space_name": "evalstate/FLUX1_schnell",
  "parameters": "{\\"prompt\\": \\"a cute cat\\", \\"num_steps\\": 4}"
}
\`\`\`

## Workflow

1. **Find Spaces** - Use \`find\` to find MCP-enabled spaces for your task
2. **Inspect Parameters** - Use \`view_parameters\` to see what a space accepts
3. **Invoke the Space** - Use \`invoke\` with the required parameters

## File Handling

For parameters that accept files (FileData types):
- Provide a publicly accessible URL (http:// or https://)
- Example: \`{"image": "https://example.com/photo.jpg"}\`
- Outputs from one tool may be used as inputs to another

## Tips

- Focus searches on specific tasks (e.g., "video generation", "object detection")
- The tool automatically applies default values for optional parameters
- Unknown parameters generate warnings but are still passed through (permissive inputs)
- Enum parameters show all allowed values in view_parameters
- Required parameters are clearly marked and validated
`;

/**
 * Usage instructions for dynamic space mode (when DYNAMIC_SPACE_DATA is set)
 * Easy to edit for prompt optimization
 */
const DYNAMIC_USAGE_INSTRUCTIONS = `# Gradio Space Interaction

Dynamically interact with Gradio MCP Spaces. Discover available spaces, view parameter schemas, and invoke spaces.

## Available Operations

### Discover
List all available MCP-enabled Spaces from the configured source.

**Example:**
\`\`\`json
{
  "operation": "discover"
}
\`\`\`

### view_parameters
Display the parameter schema for a space's first tool.

**Example:**
\`\`\`json
{
  "operation": "view_parameters",
  "space_name": "evalstate/FLUX1_schnell"
}
\`\`\`

### invoke
Execute a space's first tool with provided parameters.

**Example:**
\`\`\`json
{
  "operation": "invoke",
  "space_name": "evalstate/FLUX1_schnell",
  "parameters": "{\\"prompt\\": \\"a cute cat\\", \\"num_steps\\": 4}"
}
\`\`\`

## Workflow

1. **Discover Spaces** - Use \`discover\` to list available MCP-enabled spaces
2. **Inspect Parameters** - Use \`view_parameters\` to see what a space accepts
3. **Invoke the Space** - Use \`invoke\` with the required parameters

## File Handling

For parameters that accept files (FileData types):
- Provide a publicly accessible URL (http:// or https://)
- Example: \`{"image": "https://example.com/photo.jpg"}\`
- Outputs from one tool may be used as inputs to another
`;

/**
 * Space tool configuration
 * Returns appropriate config based on whether dynamic space mode is enabled
 */
export function getDynamicSpaceToolConfig() {
	const dynamicMode = isDynamicSpaceMode();

	return {
		name: 'dynamic_space',
		description: dynamicMode
			? 'Discover available spaces, inspect (view parameter schema) and dynamically invoke Gradio MCP Spaces to perform various ML Tasks. ' +
				'Call with no operation for full usage instructions.'
			: 'Find (semantic/task search), inspect (view parameter schema) and dynamically invoke Gradio MCP Spaces to perform various ML Tasks. ' +
				'Call with no operation for full usage instructions.',
		schema: spaceArgsSchema,
		annotations: {
			title: 'Dynamically use Gradio Applications',
			readOnlyHint: false,
			openWorldHint: true,
		},
	};
}

/**
 * Space tool configuration (static export for backward compatibility)
 */
export const DYNAMIC_SPACE_TOOL_CONFIG = {
	name: 'dynamic_space',
	description:
		'Find (semantic/task search), inspect (view parameter schema) and dynamically invoke Gradio MCP Spaces to perform various ML Tasks. ' +
		'Call with no operation for full usage instructions.',
	schema: spaceArgsSchema,
	annotations: {
		title: 'Dynamically use Gradio Applications',
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

/**
 * Space tool implementation
 */
export class SpaceTool {
	private hfToken?: string;

	constructor(hfToken?: string) {
		this.hfToken = hfToken;
	}

	/**
	 * Execute a space operation
	 * Returns InvokeResult (with raw MCP content) for invoke operation,
	 * or ToolResult (with formatted text) for other operations
	 */
	async execute(
		params: SpaceArgs,
		extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
	): Promise<InvokeResult | ToolResult> {
		const requestedOperation = params.operation;
		const dynamicMode = isDynamicSpaceMode();

		// If no operation provided, return usage instructions
		if (!requestedOperation) {
			return {
				formatted: dynamicMode ? DYNAMIC_USAGE_INSTRUCTIONS : USAGE_INSTRUCTIONS,
				totalResults: 1,
				resultsShared: 1,
			};
		}

		// Validate operation
		const normalizedOperation = requestedOperation.toLowerCase();
		if (!isOperationName(normalizedOperation)) {
			return {
				formatted: `Unknown operation: "${requestedOperation}"
Available operations: ${OPERATION_NAMES.join(', ')}

Call this tool with no operation for full usage instructions.`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		// Execute operation
		try {
			switch (normalizedOperation) {
				case 'find':
					return await this.handleFind(params);

				case 'discover':
					return await this.handleDiscover();

				case 'view_parameters':
					return await this.handleViewParameters(params);

				case 'invoke':
					return await this.handleInvoke(params, extra);

				default:
					return {
						formatted: `Unknown operation: "${requestedOperation}"`,
						totalResults: 0,
						resultsShared: 0,
						isError: true,
					};
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				formatted: `Error executing ${requestedOperation}: ${errorMessage}`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}
	}

	/**
	 * Handle find operation
	 */
	private async handleFind(params: SpaceArgs): Promise<ToolResult> {
		return await findSpaces(params.search_query, params.limit, this.hfToken);
	}

	/**
	 * Handle discover operation (for dynamic space mode)
	 */
	private async handleDiscover(): Promise<ToolResult> {
		return await discoverSpaces();
	}

	/**
	 * Handle view_parameters operation
	 */
	private async handleViewParameters(params: SpaceArgs): Promise<ToolResult> {
		if (!params.space_name) {
			return {
				formatted: `Error: Missing required parameter: "space_name"

Example:
\`\`\`json
{
  "operation": "view_parameters",
  "space_name": "username/space-name"
}
\`\`\``,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		return await viewParameters(params.space_name, this.hfToken);
	}

	/**
	 * Handle invoke operation
	 * Returns either InvokeResult (with raw MCP content) or ToolResult (error messages)
	 */
	private async handleInvoke(
		params: SpaceArgs,
		extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
	): Promise<InvokeResult | ToolResult> {
		// Validate required parameters
		if (!params.space_name) {
			return {
				formatted: `Error: Missing required parameter: "space_name"

Example:
\`\`\`json
{
  "operation": "invoke",
  "space_name": "username/space-name",
  "parameters": "{\\"param1\\": \\"value1\\"}"
}
\`\`\``,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		if (!params.parameters) {
			return {
				formatted: `Error: Missing required parameter: "parameters"

The "parameters" field must be a JSON object string containing the space parameters.

Example:
\`\`\`json
{
  "operation": "invoke",
  "space_name": "${params.space_name}",
  "parameters": "{\\"param1\\": \\"value1\\", \\"param2\\": 42}"
}
\`\`\`

Use "view_parameters" to see what parameters this space accepts.`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		return await invokeSpace(params.space_name, params.parameters, this.hfToken, extra);
	}
}

/**
 * Type guard for operation names
 */
function isOperationName(value: string): value is OperationName {
	return (OPERATION_NAMES as readonly string[]).includes(value);
}
