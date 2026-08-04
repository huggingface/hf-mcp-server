import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from './logger.js';
import { readStreamableHttpResource } from './streamable-http-tool-caller.js';

const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export interface ProxyAppResourceMapping {
	localUri: string;
	upstreamUri: string;
	proxyId: string;
	upstreamToolName: string;
}

type UnknownRecord = Record<string, unknown>;

interface RegisterProxyAppResourceOptions {
	name: string;
	title: string;
	description: string;
	serverUrl: string;
	hfToken?: string;
}

export function rewriteProxyAppToolMeta(
	meta: UnknownRecord | undefined,
	proxyId: string,
	upstreamToolName: string
): { meta?: UnknownRecord; resourceMapping?: ProxyAppResourceMapping } {
	if (!meta) {
		return {};
	}

	const ui = meta.ui;
	if (!isRecord(ui) || typeof ui.resourceUri !== 'string' || !ui.resourceUri.startsWith('ui://')) {
		return { meta };
	}

	const localUri = createProxyAppResourceUri(proxyId, ui.resourceUri);
	const rewrittenMeta = {
		...meta,
		ui: {
			...ui,
			resourceUri: localUri,
		},
	};

	return {
		meta: rewrittenMeta,
		resourceMapping: {
			localUri,
			upstreamUri: ui.resourceUri,
			proxyId,
			upstreamToolName,
		},
	};
}

export function createProxyAppResourceUri(proxyId: string, upstreamUri: string): string {
	const safeProxyId = proxyId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'proxy';
	const encodedUri = Buffer.from(upstreamUri, 'utf8').toString('base64url');
	return `ui://hf-mcp-proxy/${safeProxyId}/${encodedUri}`;
}

export function registerProxyAppResource(
	server: McpServer,
	mapping: ProxyAppResourceMapping,
	options: RegisterProxyAppResourceOptions,
	registeredResources: Set<string>
): void {
	if (registeredResources.has(mapping.localUri)) {
		return;
	}
	registeredResources.add(mapping.localUri);

	server.registerResource(
		options.name,
		mapping.localUri,
		{
			title: options.title,
			description: options.description,
			mimeType: MCP_APP_RESOURCE_MIME_TYPE,
		},
		async () => {
			logger.trace(
				{
					toolName: mapping.upstreamToolName,
					serverUrl: options.serverUrl,
					localUri: mapping.localUri,
					upstreamUri: mapping.upstreamUri,
				},
				'Streamable proxy resource read received'
			);

			const result = await readStreamableHttpResource(options.serverUrl, mapping.upstreamUri, options.hfToken);
			return {
				...result,
				contents: result.contents.map((content) => ({
					...content,
					uri: mapping.localUri,
				})),
			};
		}
	);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
