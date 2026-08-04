import type { ServerFactory, ServerFactoryResult, ServerRequestContext } from './transport/base-transport.js';
import { performance } from 'node:perf_hooks';
import type { McpApiClient } from './utils/mcp-api-client.js';
import type { AppSettings } from '../shared/settings.js';
import { logger } from './utils/logger.js';
import { convertJsonSchemaToZod, registerRemoteTools } from './gradio-endpoint-connector.js';
import { extractAuthBouquetAndMix } from './utils/auth-utils.js';
import { parseGradioSpaceIds } from './utils/gradio-utils.js';
import { getGradioSpaces } from './utils/gradio-discovery.js';
import { logToolQuery, type QueryLoggerOptions } from './utils/query-logger.js';
import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { callStreamableHttpTool } from './utils/streamable-http-tool-caller.js';
import type { ProxyToolDefinition, ProxyToolInputSchema } from './utils/proxy-tools-config.js';
import { getProxyToolsConfig } from './utils/proxy-tools-config.js';
import { registerProxyAppResource, rewriteProxyAppToolMeta } from './utils/proxy-apps.js';
import { parseDisabledTools } from './utils/disabled-tools.js';
import { createProgressRelay } from './utils/progress-relay.js';

function isDuplicateRegistrationError(error: unknown): boolean {
	return error instanceof Error && /already registered/i.test(error.message);
}

function registerProxyToolsFromConfig(
	server: McpServer,
	configs: ProxyToolDefinition[],
	hfToken: string | undefined,
	enabledToolIds?: string[],
	baseLoggingOptions?: QueryLoggerOptions
): void {
	if (configs.length === 0) {
		return;
	}

	const enabledSet = enabledToolIds ? new Set(enabledToolIds) : null;
	const disabledTools = parseDisabledTools();
	const registered = new Set<string>();
	const registeredResources = new Set<string>();

	const registerProxyTool = (config: ProxyToolDefinition): void => {
		if (!isProxyToolEnabled(config, enabledSet) || disabledTools.has(config.toolName)) {
			return;
		}
		if (registered.has(config.toolName)) {
			logger.warn({ toolName: config.toolName }, 'Skipping duplicate proxy tool registration');
			return;
		}
		registered.add(config.toolName);

		const description = config.description ?? `Streamable HTTP proxy tool for ${config.upstreamToolName}.`;
		const title = config.proxyId ? `${config.proxyId} - ${config.upstreamToolName}` : config.toolName;
		const schemaShape = buildProxyToolSchemaShape(config.inputSchema);
		const { meta, resourceMapping } = rewriteProxyAppToolMeta(config.meta, config.proxyId, config.upstreamToolName);
		const handler = async (params: Record<string, unknown>, extra: ServerContext) => {
			const start = performance.now();
			logger.trace(
				{
					toolName: config.toolName,
					serverUrl: config.url,
					upstreamToolName: config.upstreamToolName,
					paramKeys: Object.keys(params ?? {}),
				},
				'Streamable proxy tool call received'
			);

			try {
				const result = await callStreamableHttpTool(
					config.url,
					config.upstreamToolName,
					params,
					hfToken,
					createProgressRelay(extra)
				);

				logToolQuery(config.toolName, config.upstreamToolName, params, {
					...baseLoggingOptions,
					durationMs: Math.round(performance.now() - start),
					success: true,
					responseCharCount: getSerializedLength(result),
				});

				return result;
			} catch (error) {
				logToolQuery(config.toolName, config.upstreamToolName, params, {
					...baseLoggingOptions,
					durationMs: Math.round(performance.now() - start),
					success: false,
					error,
				});
				throw error;
			}
		};

		try {
			server.registerTool(
				config.toolName,
				{
					title,
					description,
					inputSchema: z.object(schemaShape),
					annotations: {
						openWorldHint: true,
						title,
					},
					_meta: meta,
				},
				handler
			);
		} catch (error) {
			if (isDuplicateRegistrationError(error)) {
				logger.warn(
					{
						toolName: config.toolName,
						proxyId: config.proxyId,
						upstreamToolName: config.upstreamToolName,
					},
					'Skipping proxy tool registration because a tool with the same name is already registered'
				);
				return;
			}
			throw error;
		}

		if (resourceMapping && !registeredResources.has(resourceMapping.localUri)) {
			registerProxyAppResource(
				server,
				resourceMapping,
				{
					name: `proxy-app:${config.toolName}`,
					title,
					description: `MCP App resource proxied from ${config.proxyId}.`,
					serverUrl: config.url,
					hfToken,
				},
				registeredResources
			);
		}
	};

	configs.forEach(registerProxyTool);
}

export function isProxyToolEnabled(
	config: Pick<ProxyToolDefinition, 'proxyId' | 'toolName' | 'meta'>,
	enabledSet: ReadonlySet<string> | null
): boolean {
	if (!enabledSet || enabledSet.has(config.toolName) || enabledSet.has(config.proxyId)) {
		return true;
	}

	const discoveredFrom = getDiscoveredFromToolName(config);
	return Boolean(discoveredFrom && enabledSet.has(discoveredFrom));
}

function getDiscoveredFromToolName(config: Pick<ProxyToolDefinition, 'meta'>): string | undefined {
	const hfProxy = config.meta?.hfProxy;
	if (typeof hfProxy !== 'object' || hfProxy === null || !('discoveredFrom' in hfProxy)) {
		return undefined;
	}

	const discoveredFrom = (hfProxy as Record<string, unknown>).discoveredFrom;
	return typeof discoveredFrom === 'string' ? discoveredFrom : undefined;
}

function getSerializedLength(value: unknown): number | undefined {
	try {
		return JSON.stringify(value).length;
	} catch {
		return undefined;
	}
}

function buildProxyToolSchemaShape(inputSchema?: ProxyToolInputSchema): Record<string, z.ZodTypeAny> {
	const schemaShape: Record<string, z.ZodTypeAny> = {};
	if (!inputSchema || !inputSchema.properties) {
		return schemaShape;
	}

	const required = inputSchema.required ?? [];
	for (const [key, jsonSchemaProperty] of Object.entries(inputSchema.properties)) {
		const isRequired = required.includes(key);
		let zodSchema = convertJsonSchemaToZod(jsonSchemaProperty, isRequired);
		if (!isRequired) {
			zodSchema = zodSchema.optional();
		}
		schemaShape[key] = zodSchema;
	}

	return schemaShape;
}

/**
 * Creates a proxy ServerFactory that adds remote tools to the original server.
 */
export const createProxyServerFactory = (
	sharedApiClient: McpApiClient,
	originalServerFactory: ServerFactory
): ServerFactory => {
	return async (
		headers: Record<string, string> | null,
		userSettings?: AppSettings,
		skipGradio?: boolean,
		sessionInfo?: ServerRequestContext
	): Promise<ServerFactoryResult> => {
		logger.debug({ skipGradio }, '=== PROXY FACTORY CALLED ===');

		// Extract auth, bouquet, and gradio using shared utility
		const { hfToken, bouquet, gradio } = extractAuthBouquetAndMix(headers, { allowDefaultHfToken: headers === null });
		const rawNoImageHeader = headers ? headers['x-mcp-no-image-content'] : undefined;
		const noImageFromHeader = typeof rawNoImageHeader === 'string' && rawNoImageHeader.toLowerCase() === 'true';

		// Skip expensive operations for requests that skip Gradio
		let settings = userSettings;
		if (!skipGradio && !settings && !bouquet) {
			settings = await sharedApiClient.getSettings(hfToken);
			logger.debug({ hasSettings: !!settings }, 'Fetched user settings for proxy');
		}

		// Create the original server instance with user settings
		const result = await originalServerFactory(headers, settings, skipGradio, sessionInfo);
		const { server, enabledToolIds, behaviorFlags } = result;
		const proxyTools = getProxyToolsConfig();

		// Register Streamable HTTP MCP tools regardless of Gradio skipping
		registerProxyToolsFromConfig(server, proxyTools, hfToken, enabledToolIds, {
			clientSessionId: sessionInfo?.clientSessionId,
			requestId: sessionInfo?.requestId,
			protocolEra: sessionInfo?.protocolEra,
			protocolVersion: sessionInfo?.protocolVersion,
			clientCapabilities: sessionInfo?.clientCapabilities,
			userHash: sessionInfo?.userHash,
			isAuthenticated: sessionInfo?.isAuthenticated ?? Boolean(hfToken),
			clientName: sessionInfo?.clientInfo?.name,
			clientVersion: sessionInfo?.clientInfo?.version,
		});

		// Skip Gradio endpoint connection for requests that skip Gradio
		if (skipGradio) {
			logger.debug('Skipping Gradio endpoints (initialize or non-Gradio tool call)');
			return result;
		}

		const stripImageContent = noImageFromHeader || behaviorFlags?.stripGradioImages === true;

		// Skip Gradio endpoints if explicitly disabled
		if (gradio === 'none') {
			logger.debug('Gradio endpoints explicitly disabled via gradio="none"');
			return result;
		}

		// Skip Gradio endpoints from settings if bouquet is specified (not "all") and no explicit gradio param
		// This allows: bouquet=search&gradio=foo/bar to work as expected
		if (bouquet && bouquet !== 'all' && !gradio) {
			logger.debug(
				{ bouquet },
				'Bouquet specified (not "all") and no explicit gradio param, skipping Gradio endpoints from settings'
			);
			return result;
		}

		// Collect all space names from gradio param and settings
		const gradioSpaceNames = gradio ? parseGradioSpaceIds(gradio).map((s) => s.name) : [];
		const settingsSpaceNames = settings?.spaceTools?.map((s) => s.name) || [];
		const allSpaceNames = [...new Set([...gradioSpaceNames, ...settingsSpaceNames])]; // Deduplicate

		logger.debug(
			{
				gradioCount: gradioSpaceNames.length,
				settingsCount: settingsSpaceNames.length,
				totalUnique: allSpaceNames.length,
				gradioParam: gradio,
			},
			'Collected Gradio space names'
		);

		if (allSpaceNames.length === 0) {
			logger.debug('No Gradio spaces configured, using local tools only');
			return result;
		}

		// Use optimized discovery API with caching
		const gradioSpaces = await getGradioSpaces(allSpaceNames, hfToken);

		logger.debug(
			{
				requested: allSpaceNames.length,
				successful: gradioSpaces.length,
				failed: allSpaceNames.length - gradioSpaces.length,
			},
			'Gradio space discovery complete'
		);

		if (gradioSpaces.length === 0) {
			logger.debug('No valid Gradio spaces discovered, using local tools only');
			return result;
		}

		// Merge emoji from settings if available
		const settingsSpaceMap = new Map(settings?.spaceTools?.map((s) => [s.name, s]) || []);
		for (const space of gradioSpaces) {
			const settingsTool = settingsSpaceMap.get(space.name);
			if (settingsTool?.emoji) {
				space.emoji = settingsTool.emoji;
			}
		}

		// Convert to connection format and register tools
		for (const space of gradioSpaces) {
			// Create connection object in the format expected by registerRemoteTools
			const connection = {
				endpointId: space._id,
				originalIndex: gradioSpaces.indexOf(space),
				client: null, // No client connection yet (lazy connection)
				tools: space.tools,
				name: space.name,
				emoji: space.emoji,
				mcpUrl: `https://${space.subdomain}.hf.space/gradio_api/mcp/`,
				isPrivate: space.private,
			};

			registerRemoteTools(server, connection, hfToken, sessionInfo, {
				stripImageContent,
			});
		}

		logger.debug('Server ready with local and remote tools');
		return result;
	};
};
