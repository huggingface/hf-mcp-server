import type { ToolResult } from '../types/tool-result.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { spaceArgsSchema, OPERATION_NAMES, type OperationName, type SpaceArgs, type InvokeResult } from './types.js';
import { viewParameters } from './commands/view-parameters.js';
import { invokeSpace } from './commands/invoke.js';
import { discoverSpaces } from './commands/discover.js';

// Re-export types (including InvokeResult for external use)
export * from './types.js';

/**
 * Usage instructions when tool is called with no operation
 */
const USAGE_INSTRUCTIONS = `# Gradio Space Interaction

Dynamically interact with any Gradio MCP Space. View parameter schemas or invoke spaces with custom parameters.

## Supported Schema Types

✅ **Simple types** (supported):
- Strings, numbers, booleans
- Enums (predefined value sets)
- Arrays of primitives
- Shallow objects (one level deep)
- FileData (as URL strings)

❌ **Complex types** (not supported):
- Deeply nested objects (2+ levels)
- Arrays of objects
- Union types
- Recursive schemas

For spaces with complex schemas, direct the user to huggingface.co/settings/mcp to add the space via settings panel.

## Available Operations

### discover
Search for MCP-enabled Gradio Spaces suitable for invocation using task-focused queries.

**Example:**
\`\`\`json
{
  "operation": "discover",
  "search_query": "Image Generation",
  "limit": 10
}
\`\`\`

**Suggested task-focused queries:**
- "Video Generation"
- "Object Detection"
- "Image Generation"
- "Text Classification"
- "Speech Recognition"
- "Text to Speech"

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

1. **Discover spaces** - Use \`discover\` to find MCP-enabled spaces for your task
2. **View parameters** - Use \`view_parameters\` to see what a space accepts
3. **Invoke the space** - Use \`invoke\` with the required parameters
4. **Review results** - Get formatted output (text, images, resources)

## File Handling

For parameters that accept files (FileData types):
- Provide a publicly accessible URL (http:// or https://)
- Example: \`{"image": "https://example.com/photo.jpg"}\`
- Outputs from one tool may be used as inputs to another

## Tips

- The tool automatically applies default values for optional parameters
- Unknown parameters generate warnings but are still passed through (permissive inputs)
- Enum parameters show all allowed values in view_parameters
- Required parameters are clearly marked and validated
`;

/**
 * Space tool configuration
 */
export const DYNAMIC_SPACE_TOOL_CONFIG = {
	name: 'dynamic_space',
	description:
		'Discover, view parameters, and invoke Gradio MCP Spaces. ' +
		'Use "discover" to find MCP-enabled spaces for your task with task-focused queries (e.g., "Image Generation", "Object Detection"). ' +
		'Use "view_parameters" to inspect a space\'s parameters. ' +
		'Use "invoke" to execute a space with custom parameters. ' +
		'Supports simple parameter types (strings, numbers, booleans, arrays, enums, shallow objects). ' +
		'Call with no operation for full usage instructions.',
	schema: spaceArgsSchema,
	annotations: {
		title: 'Gradio Space Interaction',
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

		// If no operation provided, return usage instructions
		if (!requestedOperation) {
			return {
				formatted: USAGE_INSTRUCTIONS,
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
				case 'discover':
					return await this.handleDiscover(params);

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
	 * Handle discover operation
	 */
	private async handleDiscover(params: SpaceArgs): Promise<ToolResult> {
		if (!params.search_query) {
			return {
				formatted: `Error: Missing required parameter: "search_query"

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

		return await discoverSpaces(params.search_query, params.limit, this.hfToken);
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
