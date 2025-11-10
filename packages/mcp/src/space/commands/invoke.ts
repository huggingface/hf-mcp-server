import type { ToolResult } from '../../types/tool-result.js';
import type { Tool, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { analyzeSchemaComplexity, validateParameters, applyDefaults } from '../utils/schema-validator.js';
import { formatComplexSchemaError, formatValidationError } from '../utils/parameter-formatter.js';
import { formatToolResult, formatWarnings } from '../utils/result-formatter.js';

/**
 * Invokes a Gradio space with provided parameters
 */
export async function invokeSpace(
	spaceName: string,
	parametersJson: string,
	hfToken?: string,
	extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<ToolResult> {
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

		// Step 8: Create SSE connection and invoke tool
		const sseUrl = `https://${metadata.subdomain}.hf.space/gradio_api/mcp/sse`;
		const client = await createLazyConnection(sseUrl, hfToken);

		try {
			// Check if the client is requesting progress notifications
			const progressToken = extra?._meta?.progressToken;
			const requestOptions: RequestOptions = {};

			if (progressToken !== undefined && extra) {
				// Set up progress relay from remote tool to our client
				requestOptions.onprogress = (progress) => {
					// Relay the progress notification to our client
					// Wrap in immediately-invoked async function to handle promise without returning it
					void (async () => {
						await extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken,
								progress: progress.progress,
								total: progress.total,
								message: progress.message,
							},
						});
					})();
				};
			}

			const result = await client.request(
				{
					method: 'tools/call',
					params: {
						name: tool.name,
						arguments: finalParameters,
						_meta: progressToken !== undefined ? { progressToken } : undefined,
					},
				},
				CallToolResultSchema,
				requestOptions
			);

			// Format result
			const warningsText = formatWarnings(warnings);
			const resultText = formatToolResult(result);

			return {
				formatted: `${warningsText}${resultText}`,
				totalResults: 1,
				resultsShared: 1,
				isError: result.isError,
			};
		} finally {
			// Clean up connection
			await client.close();
		}
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

/**
 * Fetches space metadata from HuggingFace API
 */
async function fetchSpaceMetadata(
	spaceName: string,
	hfToken?: string
): Promise<{ subdomain: string; private: boolean }> {
	const url = `https://huggingface.co/api/spaces/${spaceName}`;
	const headers: Record<string, string> = {};

	if (hfToken) {
		headers['Authorization'] = `Bearer ${hfToken}`;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		const response = await fetch(url, {
			headers,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const info = (await response.json()) as {
			subdomain?: string;
			private?: boolean;
		};

		if (!info.subdomain) {
			throw new Error('Space does not have a subdomain');
		}

		return {
			subdomain: info.subdomain,
			private: info.private || false,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Fetches schema from Gradio endpoint
 */
async function fetchGradioSchema(subdomain: string, isPrivate: boolean, hfToken?: string): Promise<Tool[]> {
	const schemaUrl = `https://${subdomain}.hf.space/gradio_api/mcp/schema`;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (isPrivate && hfToken) {
		headers['X-HF-Authorization'] = `Bearer ${hfToken}`;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		const response = await fetch(schemaUrl, {
			method: 'GET',
			headers,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const schemaResponse = (await response.json()) as unknown;

		// Parse schema response (handle both array and object formats)
		return parseSchemaResponse(schemaResponse);
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Parses schema response and extracts tools
 */
function parseSchemaResponse(schemaResponse: unknown): Tool[] {
	const tools: Tool[] = [];

	if (Array.isArray(schemaResponse)) {
		// Array format: [{ name: "toolName", description: "...", inputSchema: {...} }, ...]
		for (const item of schemaResponse) {
			if (
				typeof item === 'object' &&
				item !== null &&
				'name' in item &&
				'inputSchema' in item
			) {
				const itemRecord = item as Record<string, unknown>;
				if (typeof itemRecord.name === 'string') {
					const tool = itemRecord as { name: string; description?: string; inputSchema: unknown };
					tools.push({
						name: tool.name,
						description: tool.description || `${tool.name} tool`,
						inputSchema: {
							type: 'object',
							...(tool.inputSchema as Record<string, unknown>),
						},
					});
				}
			}
		}
	} else if (typeof schemaResponse === 'object' && schemaResponse !== null) {
		// Object format: { "toolName": { properties: {...}, required: [...] }, ... }
		for (const [name, toolSchema] of Object.entries(schemaResponse)) {
			if (typeof toolSchema === 'object' && toolSchema !== null) {
				const schema = toolSchema as { description?: string };
				tools.push({
					name,
					description: schema.description || `${name} tool`,
					inputSchema: {
						type: 'object',
						...(toolSchema as Record<string, unknown>),
					},
				});
			}
		}
	}

	return tools.filter((tool) => !tool.name.toLowerCase().includes('<lambda'));
}

/**
 * Creates SSE connection to endpoint for tool execution
 */
async function createLazyConnection(sseUrl: string, hfToken?: string): Promise<Client> {
	// Create MCP client
	const remoteClient = new Client(
		{
			name: 'hf-mcp-space-client',
			version: '1.0.0',
		},
		{
			capabilities: {},
		}
	);

	// Create SSE transport with HF token if available
	const transportOptions: SSEClientTransportOptions = {};
	if (hfToken) {
		const headerName = 'X-HF-Authorization';
		const customHeaders = {
			[headerName]: `Bearer ${hfToken}`,
		};

		// Headers for POST requests
		transportOptions.requestInit = {
			headers: customHeaders,
		};

		// Headers for SSE connection
		transportOptions.eventSourceInit = {
			fetch: (url, init) => {
				const headers = new Headers(init.headers);
				Object.entries(customHeaders).forEach(([key, value]) => {
					headers.set(key, value);
				});
				return fetch(url.toString(), { ...init, headers });
			},
		};
	}

	const transport = new SSEClientTransport(new URL(sseUrl), transportOptions);

	// Connect the client to the transport
	await remoteClient.connect(transport);

	return remoteClient;
}
