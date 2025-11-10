import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { logger } from './logger.js';

/**
 * Creates SSE connection to Gradio endpoint
 */
async function createConnection(sseUrl: string, hfToken?: string): Promise<Client> {
	logger.debug({ url: sseUrl }, 'Creating SSE connection to Gradio endpoint');

	const remoteClient = new Client(
		{ name: 'hf-mcp-gradio-client', version: '1.0.0' },
		{ capabilities: {} }
	);

	const transportOptions: SSEClientTransportOptions = {};
	if (hfToken) {
		const headerName = 'X-HF-Authorization';
		const customHeaders = { [headerName]: `Bearer ${hfToken}` };

		logger.trace(`Connection to Gradio endpoint with ${headerName} header`);

		transportOptions.requestInit = { headers: customHeaders };
		transportOptions.eventSourceInit = {
			fetch: (url, init) => {
				const headers = new Headers(init.headers);
				Object.entries(customHeaders).forEach(([key, value]) => headers.set(key, value));
				return fetch(url.toString(), { ...init, headers });
			},
		};
	}

	logger.debug(`MCP Client connection contains token? (${undefined !== hfToken})`);
	const transport = new SSEClientTransport(new URL(sseUrl), transportOptions);
	await remoteClient.connect(transport);
	logger.debug('SSE connection established');

	return remoteClient;
}

/**
 * Calls a Gradio tool with SSE streaming support
 *
 * @param sseUrl - The SSE endpoint URL (e.g., https://subdomain.hf.space/gradio_api/mcp/sse)
 * @param toolName - Name of the tool to call
 * @param params - Tool parameters
 * @param hfToken - Optional HuggingFace token for authentication
 * @param extra - Optional MCP request handler extra for progress notifications
 * @returns The tool call result
 */
export async function callGradioTool(
	sseUrl: string,
	toolName: string,
	params: Record<string, unknown>,
	hfToken?: string,
	extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<typeof CallToolResultSchema._type> {
	const client = await createConnection(sseUrl, hfToken);

	try {
		const progressToken = extra?._meta?.progressToken;
		const requestOptions: RequestOptions = {};

		if (progressToken !== undefined && extra) {
			logger.debug({ tool: toolName, progressToken }, 'Progress notifications requested');

			requestOptions.onprogress = async (progress) => {
				logger.trace({ tool: toolName, progressToken, progress }, 'Relaying progress notification');
				await extra.sendNotification({
					method: 'notifications/progress',
					params: {
						progressToken,
						progress: progress.progress,
						total: progress.total,
						message: progress.message,
					},
				});
			};
		}

		return await client.request(
			{
				method: 'tools/call',
				params: {
					name: toolName,
					arguments: params,
					_meta: progressToken !== undefined ? { progressToken } : undefined,
				},
			},
			CallToolResultSchema,
			requestOptions
		);
	} finally {
		await client.close();
	}
}
