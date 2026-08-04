import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, Progress, ReadResourceResult, RequestOptions } from '@modelcontextprotocol/client';
import { fetchWithProfile, NETWORK_FETCH_PROFILES, parseAndValidateUrl } from '@llmindset/hf-mcp/network';
import { logger } from './logger.js';

const PROXY_STREAMABLE_PROFILE = NETWORK_FETCH_PROFILES.streamableProxy();

function buildAuthHeaders(hfToken?: string): Record<string, string> | undefined {
	if (!hfToken) {
		return undefined;
	}

	return {
		Authorization: `Bearer ${hfToken}`,
		'X-HF-Authorization': `Bearer ${hfToken}`,
	};
}

/**
 * Calls a remote Streamable HTTP MCP server tool.
 */
export async function callStreamableHttpTool(
	serverUrl: string,
	toolName: string,
	parameters: Record<string, unknown>,
	hfToken: string | undefined,
	onProgress?: (progress: Progress) => void | Promise<void>
): Promise<CallToolResult> {
	logger.trace(
		{
			serverUrl,
			toolName,
			hasToken: Boolean(hfToken),
			paramKeys: Object.keys(parameters ?? {}),
		},
		'Streamable proxy calling upstream tool'
	);
	logger.info({ serverUrl, toolName, params: parameters }, 'Calling Streamable HTTP tool');

	const validatedServerUrl = parseAndValidateUrl(serverUrl, PROXY_STREAMABLE_PROFILE.urlPolicy);

	const client = new Client(
		{
			name: 'hf-mcp-streamable-client',
			version: '1.0.0',
		},
		{
			capabilities: {},
		}
	);

	const headers = buildAuthHeaders(hfToken);
	const transport = new StreamableHTTPClientTransport(validatedServerUrl, {
		requestInit: headers ? { headers } : undefined,
		fetch: async (url, init) => {
			const { response } = await fetchWithProfile(url.toString(), PROXY_STREAMABLE_PROFILE, {
				requestInit: init,
			});
			return response;
		},
	});

	await client.connect(transport);
	logger.trace({ serverUrl }, 'Streamable proxy connected upstream');

	try {
		const requestOptions: RequestOptions = {
			onprogress: (progress) => {
				logger.trace({ serverUrl, toolName, progress }, 'Streamable proxy upstream progress event');
				if (onProgress) {
					void Promise.resolve(onProgress(progress)).catch((error: unknown) => {
						logger.warn({ error, serverUrl, toolName }, 'Failed to relay Streamable proxy progress');
					});
				}
			},
			resetTimeoutOnProgress: true,
		};

		const result = await client.request(
			{
				method: 'tools/call',
				params: {
					name: toolName,
					arguments: parameters,
				},
			},
			requestOptions
		);

		logger.trace(
			{
				serverUrl,
				toolName,
			},
			'Streamable proxy upstream tool result received'
		);

		return result;
	} finally {
		await client.close();
	}
}

export async function readStreamableHttpResource(
	serverUrl: string,
	resourceUri: string,
	hfToken: string | undefined
): Promise<ReadResourceResult> {
	logger.trace(
		{
			serverUrl,
			resourceUri,
			hasToken: Boolean(hfToken),
		},
		'Streamable proxy reading upstream resource'
	);

	const validatedServerUrl = parseAndValidateUrl(serverUrl, PROXY_STREAMABLE_PROFILE.urlPolicy);

	const client = new Client(
		{
			name: 'hf-mcp-streamable-client',
			version: '1.0.0',
		},
		{
			capabilities: {},
		}
	);

	const headers = buildAuthHeaders(hfToken);
	const transport = new StreamableHTTPClientTransport(validatedServerUrl, {
		requestInit: headers ? { headers } : undefined,
		fetch: async (url, init) => {
			const { response } = await fetchWithProfile(url.toString(), PROXY_STREAMABLE_PROFILE, {
				requestInit: init,
			});
			return response;
		},
	});

	await client.connect(transport);
	logger.trace({ serverUrl, resourceUri }, 'Streamable proxy connected upstream for resource read');

	try {
		return await client.request({
			method: 'resources/read',
			params: {
				uri: resourceUri,
			},
		});
	} finally {
		await client.close();
	}
}
