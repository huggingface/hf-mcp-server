import type {
	CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {
	type ServerNotification,
	type ServerRequest,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { logger } from './utils/logger.js';
import { logGradioEvent } from './utils/query-logger.js';
import { z } from 'zod';
import type { GradioEndpoint } from './utils/mcp-api-client.js';
import { spaceInfo } from '@huggingface/hub';
import { gradioMetrics, getMetricsSafeName } from './utils/gradio-metrics.js';
import { createGradioToolName } from './utils/gradio-utils.js';
import { createAudioPlayerUIResource } from './utils/ui/audio-player.js';
import { spaceMetadataCache, CACHE_CONFIG } from './utils/gradio-cache.js';
import { callGradioTool } from './utils/gradio-tool-caller.js';

// Define types for JSON Schema
interface JsonSchemaProperty {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	[key: string]: unknown;
}

interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	[key: string]: unknown;
}

// Define type for array format schema
interface ArrayFormatTool {
	name: string;
	description?: string;
	inputSchema: JsonSchema;
}

interface EndpointConnection {
	endpointId: string;
	originalIndex: number;
	tools: Tool[];
	name?: string;
	emoji?: string;
	sseUrl?: string; // Store the SSE URL for lazy connection during tool calls
	isPrivate?: boolean;
}

interface RegisterRemoteToolsOptions {
	stripImageContent?: boolean;
	gradioWidgetUri?: string;
}

interface ImageFilterOptions {
	enabled: boolean;
	toolName: string;
	outwardFacingName: string;
}

export function stripImageContentFromResult(
	callResult: typeof CallToolResultSchema._type,
	{ enabled, toolName, outwardFacingName }: ImageFilterOptions
): typeof CallToolResultSchema._type {
	if (!enabled) {
		return callResult;
	}

	const content = callResult.content;
	if (!Array.isArray(content) || content.length === 0) {
		return callResult;
	}

	const filteredContent = content.filter((item) => {
		if (!item || typeof item !== 'object') {
			return true;
		}

		const candidate = item as { type?: unknown };
		const typeValue = typeof candidate.type === 'string' ? candidate.type.toLowerCase() : undefined;
		return typeValue !== 'image';
	});

	if (filteredContent.length === content.length) {
		return callResult;
	}

	const removedCount = content.length - filteredContent.length;
	logger.debug({ tool: toolName, outwardFacingName, removedCount }, 'Stripped image content from remote tool response');

	if (filteredContent.length === 0) {
		filteredContent.push({
			type: 'text',
			text: 'Image content omitted due to client configuration (no_image_content=true).',
		});
	}

	return { ...callResult, content: filteredContent };
}

type EndpointConnectionResult =
	| {
			success: true;
			endpointId: string;
			connection: EndpointConnection;
	  }
	| {
			success: false;
			endpointId: string;
			error: Error;
	  };

const CONNECTION_TIMEOUT_MS = 12000;

/**
 * Creates a timeout promise that rejects after the specified milliseconds
 */
function createTimeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => {
			reject(new Error(`Connection timeout after ${ms.toString()}ms`));
		}, ms);
	});
}

/**
 * Parses schema response and extracts tools based on format (array or object)
 */
export function parseSchemaResponse(
	schemaResponse: unknown,
	endpointId: string,
	subdomain: string
): Array<{ name: string; description?: string; inputSchema: JsonSchema }> {
	// Handle both array and object schema formats
	let tools: Array<{ name: string; description?: string; inputSchema: JsonSchema }> = [];

	if (Array.isArray(schemaResponse)) {
		// NEW-- Array format: [{ name: "toolName", description: "...", inputSchema: {...} }, ...]
		tools = (schemaResponse as ArrayFormatTool[]).filter(
			(tool): tool is ArrayFormatTool =>
				typeof tool === 'object' &&
				tool !== null &&
				'name' in tool &&
				typeof tool.name === 'string' &&
				'inputSchema' in tool
		);
		logger.debug(
			{
				endpointId,
				toolCount: tools.length,
				tools: tools.map((t) => t.name),
			},
			'Retrieved schema (array format)'
		);
	} else if (typeof schemaResponse === 'object' && schemaResponse !== null) {
		// Object format: { "toolName": { properties: {...}, required: [...] }, ... }
		const schema = schemaResponse as Record<string, JsonSchema>;
		tools = Object.entries(schema).map(([name, toolSchema]) => ({
			name,
			description: typeof toolSchema.description === 'string' ? toolSchema.description : undefined,
			inputSchema: toolSchema,
		}));
		logger.debug(
			{
				endpointId,
				toolCount: tools.length,
				tools: tools.map((t) => t.name),
			},
			'Retrieved schema (object format)'
		);
	} else {
		logger.error({ endpointId, subdomain, schemaType: typeof schemaResponse }, 'Invalid schema format');
		throw new Error('Invalid schema format: expected array or object');
	}

	if (tools.length === 0) {
		logger.error({ endpointId, subdomain }, 'No tools found in schema');
		throw new Error('No tools found in schema');
	}

	return tools;
}

/**
 * Check if a space is private using cache first, then API if needed
 */
async function isSpacePrivate(spaceName: string, hfToken?: string): Promise<boolean> {
	try {
		if (!hfToken) return false; // anonymous requests don't have a token to forward

		// Check cache first
		const cached = spaceMetadataCache.get(spaceName);
		if (cached) {
			logger.trace({ spaceName, private: cached.private }, 'Using cached private status');
			return cached.private;
		}

		// Fall back to API call if not cached
		logger.debug({ spaceName }, 'Cache miss for private status, fetching from API');

		// Create abort controller for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), CACHE_CONFIG.SPACE_INFO_TIMEOUT);

		try {
			const info = await spaceInfo({
				name: spaceName,
				credentials: { accessToken: hfToken },
				// Note: We can't pass signal to spaceInfo, but this is a best-effort timeout
			});

			clearTimeout(timeoutId);

			// Only cache public spaces - private spaces should always be fetched fresh
			// This ensures auth-sensitive information is never stale
			if (!info.private) {
				const metadata = {
					_id: (info as { _id?: string })._id || `gradio_${spaceName.replace('/', '-')}`,
					name: spaceName,
					subdomain: (info as { subdomain?: string }).subdomain || '',
					emoji: '🔧',
					private: info.private,
					sdk: (info as { sdk?: string }).sdk || 'gradio',
					fetchedAt: Date.now(),
				};
				spaceMetadataCache.set(spaceName, metadata);
				logger.trace({ spaceName }, 'Public space metadata cached');
			} else {
				logger.trace({ spaceName }, 'Private space metadata not cached');
			}

			return info.private;
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		// If we can't fetch space info, assume it might be private to be safe
		logger.warn({ spaceName, error }, 'Failed to fetch space info, assuming private');
		return true;
	}
}

/**
 * Fetches schema from a single Gradio endpoint without establishing SSE connection
 */
async function fetchEndpointSchema(
	endpoint: GradioEndpoint,
	originalIndex: number,
	hfToken: string | undefined
): Promise<EndpointConnection> {
	const endpointId = `endpoint${(originalIndex + 1).toString()}`;
	const schemaUrl = `https://${endpoint.subdomain}.hf.space/gradio_api/mcp/schema`;

	// TODO -- leaving this commented out for now -- i may want this again very shortly
	const isPrivateSpace = await isSpacePrivate(endpoint.name, hfToken);
	logger.debug({ url: schemaUrl, endpointId }, 'Fetching schema from endpoint');

	// Prepare headers
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (isPrivateSpace && hfToken) {
		headers['X-HF-Authorization'] = `Bearer ${hfToken}`;
	}

	// Add timeout using AbortController (same pattern as HfApiCall)
	const apiTimeout = process.env.HF_API_TIMEOUT ? parseInt(process.env.HF_API_TIMEOUT, 10) : 12500;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), apiTimeout);

	// Fetch schema directly
	const response = await fetch(schemaUrl, {
		method: 'GET',
		headers,
		signal: controller.signal,
	});

	clearTimeout(timeoutId);

	if (!response.ok) {
		throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
	}

	const schemaResponse = (await response.json()) as unknown;

	// Parse the schema response
	const parsed = parseSchemaResponse(schemaResponse, endpointId, endpoint.subdomain);
	const tools: Tool[] = parsed
		.filter((parsedTool) => !parsedTool.name.toLowerCase().includes('<lambda'))
		.map((parsedTool) => ({
			name: parsedTool.name,
			description: parsedTool.description || `${parsedTool.name} tool`,
			inputSchema: {
				type: 'object',
				properties: parsedTool.inputSchema.properties || {},
				required: parsedTool.inputSchema.required || [],
				description: parsedTool.inputSchema.description,
			},
		}));

	return {
		endpointId,
		originalIndex,
		tools: tools,
		name: endpoint.name,
		emoji: endpoint.emoji,
		sseUrl: `https://${endpoint.subdomain}.hf.space/gradio_api/mcp/sse`, // Store SSE URL for later
		isPrivate: isPrivateSpace,
	};
}

/**
 * Fetches schemas from multiple Gradio endpoints in parallel with timeout
 * Uses efficient /mcp/schema endpoint instead of SSE connections
 */
export async function connectToGradioEndpoints(
	gradioEndpoints: GradioEndpoint[],
	hfToken: string | undefined
): Promise<EndpointConnectionResult[]> {
	// Filter and map valid endpoints with their indices
	const validWithIndex = gradioEndpoints
		.map((ep, index) => ({ endpoint: ep, originalIndex: index }))
		.filter((item) => item.endpoint.subdomain && item.endpoint.subdomain.trim() !== '');

	if (validWithIndex.length === 0) {
		logger.debug('No valid Gradio endpoints to fetch schemas from');
		return [];
	}

	// Create schema fetch tasks with timeout
	const schemaFetchTasks = validWithIndex.map(({ endpoint, originalIndex }) => {
		const endpointId = `endpoint${(originalIndex + 1).toString()}`;

		return Promise.race([fetchEndpointSchema(endpoint, originalIndex, hfToken), createTimeout(CONNECTION_TIMEOUT_MS)])
			.then(
				(connection): EndpointConnectionResult => ({
					success: true,
					endpointId,
					connection,
				})
			)
			.catch((error: unknown): EndpointConnectionResult => {
				const isFirstError = gradioMetrics.schemaFetchError(endpoint.name);
				const logLevel = isFirstError ? 'warn' : 'trace';

				logger[logLevel](
					{
						endpointId,
						subdomain: endpoint.subdomain,
						error: error instanceof Error ? error.message : String(error),
					},
					'Failed to fetch schema from endpoint'
				);

				return {
					success: false,
					endpointId,
					error: error instanceof Error ? error : new Error(String(error)),
				};
			});
	});

	// Execute all schema fetches in parallel
	const results = await Promise.all(schemaFetchTasks);

	// Log results
	const successful = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	logger.debug(
		{
			total: results.length,
			successful: successful.length,
			failed: failed.length,
		},
		'Gradio endpoint schema fetch results'
	);

	return results;
}

/**
 * Creates the display information for a tool
 */
function createToolDisplayInfo(connection: EndpointConnection, tool: Tool): { title: string; description: string } {
	const displayName = connection.name || 'Unknown Space';
	const title = `${displayName} - ${tool.name}${connection.emoji ? ` ${connection.emoji}` : ''}`;
	const description = tool.description
		? `${tool.description} (from ${displayName})`
		: `${tool.name} tool from ${displayName}`;
	return { title, description };
}

/**
 * Extracts a URL from the result content if present
 */
function extractUrlFromContent(content: unknown[]): string | undefined {
	if (!Array.isArray(content) || content.length === 0) {
		return undefined;
	}

	// Check each content item for a URL-like string
	for (const item of content) {
		if (!item || typeof item !== 'object') {
			continue;
		}

		const candidate = item as { type?: string; text?: string; url?: string };

		// Check for explicit url field
		if (typeof candidate.url === 'string' && /^https?:\/\//i.test(candidate.url.trim())) {
			return candidate.url.trim();
		}

		// Check for text field that looks like a URL
		if (typeof candidate.text === 'string') {
			let text = candidate.text.trim();

			// Remove "Image URL:" or "Image URL :" prefix if present (case insensitive)
			text = text.replace(/^image\s+url\s*:\s*/i, '');

			if (/^https?:\/\//i.test(text)) {
				return text;
			}
		}
	}

	return undefined;
}

/**
 * Creates the tool handler function
 */
function createToolHandler(
	connection: EndpointConnection,
	tool: Tool,
	outwardFacingName: string,
	hfToken?: string,
	sessionInfo?: {
		clientSessionId?: string;
		isAuthenticated?: boolean;
		clientInfo?: { name: string; version: string };
	},
	options: RegisterRemoteToolsOptions = {}
): (
	params: Record<string, unknown>,
	extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => Promise<typeof CallToolResultSchema._type> {
	return async (params: Record<string, unknown>, extra) => {
		logger.info({ tool: tool.name, params }, 'Calling remote tool');

		// Track metrics for logging
		const startTime = Date.now();
		let success = false;
		let error: string | undefined;
		let responseSizeBytes: number | undefined;
		let notificationCount = 0;

		try {
			// Since we use schema fetch, we always need to create SSE connection for tool execution
			if (!connection.sseUrl) {
				throw new Error('No SSE URL available for tool execution');
			}
			logger.debug({ tool: tool.name }, 'Calling Gradio tool');

			// Track notification count by wrapping the extra parameter
			const wrappedExtra = extra._meta?.progressToken !== undefined ? {
				...extra,
				sendNotification: async (notification: ServerNotification) => {
					notificationCount++;
					return extra.sendNotification(notification);
				},
			} : undefined;

			try {
				const result = await callGradioTool(connection.sseUrl, tool.name, params, hfToken, wrappedExtra || extra);

				// Calculate response size (rough estimate based on JSON serialization)
				try {
					responseSizeBytes = JSON.stringify(result).length;
				} catch {
					// If serialization fails, don't worry about size
				}

				success = !result.isError;
				if (result.isError) {
					// Extract a meaningful error message from MCP content items
					const first =
						Array.isArray(result.content) && result.content.length > 0 ? (result.content[0] as unknown) : undefined;
					let message: string | undefined;
					if (typeof first === 'string') {
						message = first;
					} else if (first && typeof first === 'object') {
						const obj = first as Record<string, unknown>;
						if (typeof obj.text === 'string') {
							message = obj.text;
						} else if (typeof obj.message === 'string') {
							message = obj.message;
						} else if (typeof obj.error === 'string') {
							message = obj.error;
						} else {
							try {
								message = JSON.stringify(obj);
							} catch {
								message = String(obj);
							}
						}
					} else if (first !== undefined) {
						// Fallback for other primitive types
						message = String(first);
					}

					error = message || 'Unknown error';

					// Bubble up the error so upstream callers and metrics can track failures
					throw new Error(error);
				}

				// Record success in gradio metrics when no error and no exception thrown
				if (success) {
					const metricsName = getMetricsSafeName(outwardFacingName);
					gradioMetrics.recordSuccess(metricsName);
				}

				// Special handling: if the tool name contains "_mcpui" and it returns a single text URL,
				// wrap it as an embedded audio player UI resource.
				try {
					const hasUiSuffix = tool.name.includes('_mcpui');
					if (!result.isError && hasUiSuffix && Array.isArray(result.content) && result.content.length === 1) {
						const item = result.content[0] as unknown as { type?: string; text?: string };
						const text = typeof item?.text === 'string' ? item.text.trim() : '';
						const looksLikeUrl = /^https?:\/\//i.test(text);

						if ((item.type === 'text' || !item.type) && looksLikeUrl) {
							let base64Audio: string | undefined;
							const url = text;

							try {
								const resp = await fetch(url);
								if (resp.ok) {
									const buf = Buffer.from(await resp.arrayBuffer());
									base64Audio = buf.toString('base64');
								}
							} catch (e) {
								logger.debug(
									{ tool: tool.name, url, error: e instanceof Error ? e.message : String(e) },
									'Failed to inline audio; falling back to URL source'
								);
							}

							const title = `${connection.name || 'MCP UI tool'}`;
							const uriSafeName = (connection.name || 'audio').replace(/[^a-z0-9-_]+/gi, '-');
							const uiUri: `ui://${string}` = `ui://huggingface-mcp/${uriSafeName}/${Date.now().toString()}`;

							const uiResource = createAudioPlayerUIResource(uiUri, {
								title,
								base64Audio,
								srcUrl: base64Audio ? undefined : url,
								mimeType: `audio/wav`,
							});

							const decoratedResult = {
								isError: false,
								content: [result.content[0], uiResource],
							} as typeof CallToolResultSchema._type;

							const mcpuiResult = stripImageContentFromResult(decoratedResult, {
								enabled: !!options.stripImageContent,
								toolName: tool.name,
								outwardFacingName,
							});

							// For openai-mcp client, check if result contains a URL and set structuredContent
							if (sessionInfo?.clientInfo?.name == 'openai-mcp') {
								const extractedUrl = extractUrlFromContent(mcpuiResult.content);
								if (extractedUrl) {
									logger.debug({ tool: tool.name, url: extractedUrl }, 'Setting structuredContent for _mcpui tool');
									(
										mcpuiResult as typeof CallToolResultSchema._type & {
											structuredContent?: { url: string; spaceName?: string };
										}
									).structuredContent = {
										url: extractedUrl,
										spaceName: connection.name,
									};
								}
							}

							return mcpuiResult;
						}
					}
				} catch (e) {
					logger.debug(
						{ tool: tool.name, error: e instanceof Error ? e.message : String(e) },
						'MCP UI transform skipped'
					);
				}

				// Strip image content first
				const finalResult = stripImageContentFromResult(result, {
					enabled: !!options.stripImageContent,
					toolName: tool.name,
					outwardFacingName,
				});

				// For openai-mcp client, check if result contains a URL and set structuredContent
				if (sessionInfo?.clientInfo?.name == 'openai-mcp') {
					const extractedUrl = extractUrlFromContent(finalResult.content);
					if (extractedUrl) {
						logger.debug({ tool: tool.name, url: extractedUrl }, 'Setting structuredContent with extracted URL');
						(
							finalResult as typeof CallToolResultSchema._type & {
								structuredContent?: { url: string; spaceName?: string };
							}
						).structuredContent = {
							url: extractedUrl,
							spaceName: connection.name,
						};
					}
				}

				return finalResult;
			} catch (callError) {
				// Handle request errors
				success = false;
				error = callError instanceof Error ? callError.message : String(callError);
				throw callError;
			}
		} catch (err) {
			// Ensure meaningful error output instead of [object Object]
			const errObj =
				err instanceof Error
					? err
					: new Error(
							typeof err === 'string'
								? err
								: (() => {
										try {
											return JSON.stringify(err);
										} catch {
											return String(err);
										}
									})()
						);
			logger.error({ tool: tool.name, err: errObj, errMessage: errObj.message }, 'Remote tool call failed');
			const metricsName = getMetricsSafeName(outwardFacingName);
			gradioMetrics.recordFailure(metricsName);
			// Set error if not already set
			if (!error) {
				error = errObj.message;
			}
			throw errObj;
		} finally {
			// Always log the Gradio event, even if there was a crash
			const endTime = Date.now();
			logGradioEvent(connection.name || connection.endpointId, sessionInfo?.clientSessionId || 'unknown', {
				durationMs: endTime - startTime,
				isAuthenticated: !!hfToken,
				clientName: sessionInfo?.clientInfo?.name,
				clientVersion: sessionInfo?.clientInfo?.version,
				success,
				error,
				responseSizeBytes,
				notificationCount,
			});
		}
	};
}

/**
 * Registers multiple remote tools from a Gradio endpoint
 */
export function registerRemoteTools(
	server: McpServer,
	connection: EndpointConnection,
	hfToken?: string,
	sessionInfo?: {
		clientSessionId?: string;
		isAuthenticated?: boolean;
		clientInfo?: { name: string; version: string };
	},
	options: RegisterRemoteToolsOptions = {}
): void {
	connection.tools.forEach((tool, toolIndex) => {
		// Generate tool name
		const outwardFacingName = createGradioToolName(
			tool.name,
			connection.originalIndex,
			connection.isPrivate,
			toolIndex
		);

		// Create display info
		const { title, description } = createToolDisplayInfo(connection, tool);

		// Convert schema
		const schemaShape = convertToolSchemaToZod(tool);

		// Create handler
		const handler = createToolHandler(connection, tool, outwardFacingName, hfToken, sessionInfo, options);

		// Log registration
		logger.trace(
			{
				endpointId: connection.endpointId,
				originalName: tool.name,
				outwardFacingName: outwardFacingName,
				description: tool.description,
			},
			'Registering remote tool'
		);

		// Log the exact structure we're getting
		logger.trace(
			{
				toolName: tool.name,
				inputSchema: tool.inputSchema,
			},
			'Remote tool inputSchema structure'
		);

		// Register the tool
		const theTool = server.tool(
			outwardFacingName,
			description,
			schemaShape,
			{
				openWorldHint: true,
				title: title,
			},
			handler
		);

		if (sessionInfo?.clientInfo?.name == 'openai-mcp') {
			theTool._meta = {
				'openai/outputTemplate': options.gradioWidgetUri || '',
				'openai/toolInvocation/invoking': `Calling the Hugging Face Space ${connection.name || connection.endpointId}`,
				'openai/toolInvocation/invoked': `Your content is being generated`,
			};
		}
	});
}

function convertToolSchemaToZod(tool: Tool): Record<string, z.ZodTypeAny> {
	const schemaShape: Record<string, z.ZodTypeAny> = {};

	if (typeof tool.inputSchema === 'object' && 'properties' in tool.inputSchema) {
		const jsonSchema = tool.inputSchema as JsonSchema;
		const props = jsonSchema.properties || {};
		const required = jsonSchema.required || [];

		for (const [key, jsonSchemaProperty] of Object.entries(props)) {
			const isRequired = required.includes(key);

			// Convert to Zod schema, skipping defaults for required fields
			let zodSchema = convertJsonSchemaToZod(jsonSchemaProperty, isRequired);

			// Make optional if not in required array
			if (!isRequired) {
				zodSchema = zodSchema.optional();
			}

			schemaShape[key] = zodSchema;
		}
	}

	return schemaShape;
}

/**
 * Converts a JSON Schema property to a Zod schema
 * @param jsonSchemaProperty - The JSON schema property to convert
 * @param skipDefault - If true, won't apply default values (useful for required fields)
 */
export function convertJsonSchemaToZod(jsonSchemaProperty: JsonSchemaProperty, skipDefault = false): z.ZodTypeAny {
	let zodSchema: z.ZodTypeAny;

	// Special handling for FileData types
	if (
		jsonSchemaProperty.title === 'FileData' ||
		(jsonSchemaProperty.format === 'a http or https url to a file' &&
			typeof jsonSchemaProperty.default === 'object' &&
			jsonSchemaProperty.default !== null)
	) {
		// Create FileData object schema
		zodSchema = z.object({
			path: z.string(),
			url: z.string().optional(),
			size: z.number().nullable().optional(),
			orig_name: z.string().optional(),
			mime_type: z.string().nullable().optional(),
			is_stream: z.boolean().optional(),
			meta: z
				.object({
					_type: z.string().optional(),
				})
				.optional(),
		});
	} else if (jsonSchemaProperty.enum && Array.isArray(jsonSchemaProperty.enum) && jsonSchemaProperty.enum.length > 0) {
		// Handle enum types
		if (jsonSchemaProperty.enum.every((v): v is string => typeof v === 'string')) {
			const enumValues = jsonSchemaProperty.enum as [string, ...string[]];
			zodSchema = z.enum(enumValues);
		} else {
			// Fallback for non-string enums - create a union of literals
			const literals: z.ZodTypeAny[] = jsonSchemaProperty.enum.map((v) => {
				if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
					return z.literal(v);
				}
				// For other types, convert to string
				return z.literal(String(v));
			});

			if (literals.length === 1) {
				// We know literals[0] exists because we checked length === 1
				zodSchema = literals[0] ?? z.any();
			} else if (literals.length >= 2) {
				// Ensure we have at least 2 elements for union
				zodSchema = z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
			} else {
				// This shouldn't happen due to our length check, but handle it anyway
				zodSchema = z.any();
			}
		}
	} else {
		// Convert based on type
		switch (jsonSchemaProperty.type) {
			case 'string':
				zodSchema = z.string();
				break;
			case 'number':
				zodSchema = z.number();
				break;
			case 'boolean':
				zodSchema = z.boolean();
				break;
			case 'array':
				zodSchema = z.array(z.any()); // Simplified for now
				break;
			case 'object':
				zodSchema = z.object({}); // Simplified for now
				break;
			default:
				zodSchema = z.any();
		}
	}

	// Enhance description for file inputs
	let description = jsonSchemaProperty.description || '';
	if (jsonSchemaProperty.format === 'a http or https url to a file' || jsonSchemaProperty.title === 'FileData') {
		description = description
			? `${description} (File input: provide URL or file path)`
			: 'a http or https url to a file';
	}

	if (description) {
		zodSchema = zodSchema.describe(description);
	}

	// Apply default value from the Schema
	if (!skipDefault && 'default' in jsonSchemaProperty && jsonSchemaProperty.default !== undefined) {
		let defaultValue = jsonSchemaProperty.default;

		// For FileData types, keep the full object as default
		// For other string types with object defaults, extract URL
		if (
			jsonSchemaProperty.type === 'string' &&
			typeof defaultValue === 'object' &&
			defaultValue !== null &&
			'url' in defaultValue &&
			jsonSchemaProperty.title !== 'FileData'
		) {
			const urlValue = (defaultValue as Record<string, unknown>).url;
			if (typeof urlValue === 'string') {
				defaultValue = urlValue;
			}
		}

		zodSchema = zodSchema.default(defaultValue);
	}

	return zodSchema;
}
