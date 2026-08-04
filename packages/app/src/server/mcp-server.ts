import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { whoAmI } from '@huggingface/hub';
import {
	RepoSearchTool,
	REPO_SEARCH_TOOL_CONFIG,
	type RepoSearchParams,
	CreateRepoTool,
	formatCreateRepoResult,
	type CreateRepoParams,
	HUB_REPO_DETAILS_TOOL_CONFIG,
	HubInspectTool,
	type HubInspectParams,
	HF_FS_TOOL_CONFIG,
	HF_FS_TOOL_ID,
	HfFsTool,
	formatHfFsMarkdown,
	type HfFsRequest,
	HfFsWriteTool,
	formatHfFsWriteMarkdown,
	type HfFsWriteRequest,
	CONFIG_GUIDANCE,
	HF_JOBS_TOOL_CONFIG,
	HfJobsTool,
	HfSandboxExecTool,
	HfSandboxTool,
	HfSandboxFsTool,
	formatSandboxMarkdown,
	formatSandboxExecMarkdown,
	formatSandboxFsMarkdown,
	type HfSandboxParams,
	type HfSandboxExecParams,
	type HfSandboxFsParams,
	getDynamicSpaceToolConfig,
	SpaceTool,
	type SpaceArgs,
	type InvokeResult,
	type ToolResult,
	VIEW_PARAMETERS,
} from '@llmindset/hf-mcp';

import type { ServerFactory, ServerFactoryResult, ServerRequestContext } from './transport/base-transport.js';
import type { McpApiClient } from './utils/mcp-api-client.js';
import { logger } from './utils/logger.js';
import { logToolQuery, logGradioEvent, type QueryLoggerOptions } from './utils/query-logger.js';
import type { AppSettings } from '../shared/settings.js';
import { extractAuthBouquetAndMix } from './utils/auth-utils.js';
import { ToolSelectionStrategy, type ToolSelectionContext } from './utils/tool-selection-strategy.js';
import { registerCapabilities } from './utils/capability-utils.js';
import { applyResultPostProcessing, type GradioToolCallOptions } from './utils/gradio-tool-caller.js';
import { registerSkillResources } from './skills/skill-resources.js';
import { isClientDenied } from '../shared/client-denylist.js';
import { getSkillCatalog, getSkillCatalogRemainingTtlMs } from './skills/skill-catalog-cache.js';
import { SERVER_VERSION } from './server-build-info.js';
import { parseDisabledTools } from './utils/disabled-tools.js';
import { createProgressRelay } from './utils/progress-relay.js';
import { getToolResultErrorMessage } from './utils/observability.js';

// Bouquet configurations moved to tool-selection-strategy.ts

/**
 * Creates request-scoped MCP servers containing only the tools selected for that request.
 */
export const createServerFactory = (sharedApiClient: McpApiClient): ServerFactory => {
	return async (
		headers: Record<string, string> | null,
		userSettings?: AppSettings,
		skipGradio?: boolean,
		sessionInfo?: ServerRequestContext
	): Promise<ServerFactoryResult> => {
		const debugRequestContext = sessionInfo
			? {
					clientSessionId: sessionInfo.clientSessionId,
					requestId: sessionInfo.requestId,
					protocolEra: sessionInfo.protocolEra,
					protocolVersion: sessionInfo.protocolVersion,
					clientCapabilities: sessionInfo.clientCapabilities,
					userHash: sessionInfo.userHash,
					isAuthenticated: sessionInfo.isAuthenticated,
					clientInfo: sessionInfo.clientInfo,
					hasAuthenticatedUser: sessionInfo.authenticatedUser !== undefined,
				}
			: undefined;
		logger.debug({ skipGradio, requestContext: debugRequestContext }, '=== CREATING NEW MCP SERVER INSTANCE ===');
		// Extract auth using shared utility
		const { hfToken } = extractAuthBouquetAndMix(headers, { allowDefaultHfToken: headers === null });

		// Create tool selection strategy
		const toolSelectionStrategy = new ToolSelectionStrategy(sharedApiClient);

		let userInfo: string =
			'The Hugging Face tools are being used anonymously and rate limits apply. ' +
			'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
			'create an account at https://hf.co/join for higher limits.';
		let username: string | undefined;
		let userDetails = sessionInfo?.authenticatedUser;

		if (userDetails) {
			username = userDetails.name;
			userInfo = `Hugging Face tools are being used by authenticated user '${userDetails.name}'`;
		} else if (hfToken && headers === null) {
			try {
				userDetails = await whoAmI({ credentials: { accessToken: hfToken } });
				username = userDetails.name;
				userInfo = `Hugging Face tools are being used by authenticated user '${userDetails.name}'`;
			} catch (error) {
				// unexpected - this should have been caught upstream so severity is warn
				logger.warn({ error: (error as Error).message }, `Failed to authenticate with Hugging Face API`);
			}
		}

		// Helper function to build logging options
		const clientCorrelationId = sessionInfo?.clientSessionId ?? sessionInfo?.requestId;
		const getLoggingOptions = () => {
			const options = {
				clientSessionId: sessionInfo?.clientSessionId,
				requestId: sessionInfo?.requestId,
				protocolEra: sessionInfo?.protocolEra,
				protocolVersion: sessionInfo?.protocolVersion,
				clientCapabilities: sessionInfo?.clientCapabilities,
				userHash: sessionInfo?.userHash,
				isAuthenticated: sessionInfo?.isAuthenticated ?? !!hfToken,
				clientName: sessionInfo?.clientInfo?.name,
				clientVersion: sessionInfo?.clientInfo?.version,
			};
			logger.debug({ requestContext: debugRequestContext, options }, 'Query logging options:');
			return options;
		};

		type QueryLoggerFn = (
			methodName: string,
			query: string,
			parameters: Record<string, unknown>,
			options?: QueryLoggerOptions
		) => void;

		type BaseQueryLoggerOptions = Omit<QueryLoggerOptions, 'durationMs' | 'error'>;

		interface QueryLoggingConfig<T> {
			methodName: string;
			query: string;
			parameters: Record<string, unknown>;
			baseOptions?: BaseQueryLoggerOptions;
			successOptions?: (result: T) => BaseQueryLoggerOptions | void;
		}

		const runWithQueryLogging = async <T>(
			logFn: QueryLoggerFn,
			config: QueryLoggingConfig<T>,
			work: () => Promise<T>
		): Promise<T> => {
			const start = performance.now();
			try {
				const result = await work();
				const durationMs = Math.round(performance.now() - start);
				const successOptions = config.successOptions?.(result) ?? {};
				const { success: successOverride, ...restSuccessOptions } = successOptions;
				const resultErrorMessage = getToolResultErrorMessage(result);
				const resultHasError = resultErrorMessage !== undefined;
				const successFlag = successOverride ?? !resultHasError;
				logFn(config.methodName, config.query, config.parameters, {
					...config.baseOptions,
					...restSuccessOptions,
					durationMs,
					success: successFlag,
					...(resultErrorMessage ? { error: resultErrorMessage } : {}),
				});
				return result;
			} catch (error) {
				const durationMs = Math.round(performance.now() - start);
				logFn(config.methodName, config.query, config.parameters, {
					...config.baseOptions,
					durationMs,
					success: false,
					error,
				});
				throw error;
			}
		};

		// Skills-over-MCP is served only on HTTP transports. STDIO creates one
		// long-lived server and cannot atomically replace its registered resource
		// namespace when a bucket snapshot refreshes.
		const skillCatalog = headers === null ? null : await getSkillCatalog();
		// Some clients (e.g. cursor-vscode) flood the resource surface; deny them the
		// Skills resources entirely — not registered and not advertised.
		const clientDenied = isClientDenied(sessionInfo?.clientInfo?.name, headers?.['user-agent']);
		const hasSkills = !!skillCatalog?.entries.length && !clientDenied;

		// Get tool selection before creating the server so instructions can match advertised tools.
		const toolSelectionContext: ToolSelectionContext = {
			headers,
			userSettings,
			hfToken,
		};
		const toolSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);
		const hfFsInstruction = toolSelection.enabledToolIds.includes(HF_FS_TOOL_ID)
			? '\nhf:// URIs can be converted to browser URLs by replacing hf://buckets/OWNER/NAME/PATH with https://huggingface.co/buckets/OWNER/NAME/resolve/PATH; for models, datasets, and spaces, use https://huggingface.co[/datasets|/spaces]/OWNER/NAME/resolve/main/PATH. URL-encode each path segment.'
			: '';

		const server = new McpServer(
			{
				name: '@huggingface/mcp-services',
				version: SERVER_VERSION,
				title: 'Hugging Face',
				websiteUrl: 'https://huggingface.co/mcp',
				icons: [
					{
						src: 'https://huggingface.co/favicon.ico',
					},
				],
			},
			{
				instructions:
					'You have tools for using the Hugging Face Hub. ' +
					userInfo +
					hfFsInstruction +
					" arXiv paper id's are often " +
					'used as references between datasets, models and papers. There are over 100 tags in use, ' +
					"common tags include 'Text Generation', 'Transformers', 'Image Classification' and so on.\n",
			}
		);

		const disabledTools = parseDisabledTools();
		const selectedToolIds = new Set(toolSelection.enabledToolIds);
		const shouldRegisterSelectedTool = (toolName: string) =>
			selectedToolIds.has(toolName) && !disabledTools.has(toolName);
		const shouldRegisterFixedTool = (toolName: string) => !disabledTools.has(toolName);

		const rawNoImageHeader = headers?.['x-mcp-no-image-content'];
		const noImageContentHeaderEnabled =
			typeof rawNoImageHeader === 'string' && rawNoImageHeader.trim().toLowerCase() === 'true';

		const whoDescription = userDetails
			? `Hugging Face tools are being used by authenticated user '${username}'`
			: 'Hugging Face tools are being used anonymously and may be rate limited. Call this tool for instructions on joining and authenticating.';

		const response = userDetails ? `You are authenticated as ${username ?? 'unknown'}.` : CONFIG_GUIDANCE;
		if (shouldRegisterFixedTool('hf_whoami')) {
			server.registerTool(
				'hf_whoami',
				{
					title: 'Hugging Face User Info',
					description: whoDescription,
					inputSchema: z.object({}),
					annotations: { readOnlyHint: true, openWorldHint: false, title: 'Hugging Face User Info' },
				},
				() => {
					return { content: [{ type: 'text', text: response }] };
				}
			);
		}

		if (shouldRegisterSelectedTool(REPO_SEARCH_TOOL_CONFIG.name)) {
			server.registerTool(
				REPO_SEARCH_TOOL_CONFIG.name,
				{
					title: REPO_SEARCH_TOOL_CONFIG.annotations.title,
					description: REPO_SEARCH_TOOL_CONFIG.description,
					inputSchema: REPO_SEARCH_TOOL_CONFIG.schema,
					annotations: REPO_SEARCH_TOOL_CONFIG.annotations,
				},
				async (params: RepoSearchParams) => {
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: REPO_SEARCH_TOOL_CONFIG.name,
							query: params.query || `sort:${params.sort || 'trendingScore'}`,
							parameters: params,
							baseOptions: getLoggingOptions(),
							successOptions: (formatted) => ({
								totalResults: formatted.totalResults,
								resultsShared: formatted.resultsShared,
								responseCharCount: formatted.formatted.length,
							}),
						},
						async () => {
							const repoSearch = new RepoSearchTool(hfToken);
							return repoSearch.searchWithParams(params);
						}
					);
					return {
						content: [{ type: 'text', text: result.formatted }],
					};
				}
			);
		}

		const createRepoToolConfig = CreateRepoTool.createToolConfig();
		if (shouldRegisterSelectedTool(createRepoToolConfig.name)) {
			server.registerTool(
				createRepoToolConfig.name,
				{
					title: createRepoToolConfig.annotations.title,
					description: createRepoToolConfig.description,
					inputSchema: createRepoToolConfig.schema,
					outputSchema: createRepoToolConfig.outputSchema,
					annotations: createRepoToolConfig.annotations,
				},
				async (params: CreateRepoParams) => {
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: createRepoToolConfig.name,
							query: params.source_uri ? `duplicate:${params.source_uri}->${params.uri}` : `create:${params.uri}`,
							parameters: params,
							baseOptions: getLoggingOptions(),
							successOptions: (created) => ({
								resultsShared: 1,
								responseCharCount: formatCreateRepoResult(created).length,
							}),
						},
						async () => {
							const createRepoTool = new CreateRepoTool(hfToken);
							return createRepoTool.create(params);
						}
					);
					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatCreateRepoResult(result) }],
					};
				}
			);
		}

		// Compute README availability; adjust description and schema accordingly
		const hubInspectReadmeAllowed = toolSelection.behaviorFlags.allowReadmeInclude;
		const hubInspectDescription = hubInspectReadmeAllowed
			? `${HUB_REPO_DETAILS_TOOL_CONFIG.description} README file may be requested from the external repository.`
			: HUB_REPO_DETAILS_TOOL_CONFIG.description;
		const hubInspectBaseShape = HUB_REPO_DETAILS_TOOL_CONFIG.schema.shape as z.ZodRawShape;
		const hubInspectSchemaShape: z.ZodRawShape = hubInspectReadmeAllowed
			? hubInspectBaseShape
			: (() => {
					const { include_readme: _omit, ...rest } = hubInspectBaseShape as unknown as Record<string, unknown>;
					return rest as unknown as z.ZodRawShape;
				})();

		if (shouldRegisterSelectedTool(HUB_REPO_DETAILS_TOOL_CONFIG.name)) {
			server.registerTool(
				HUB_REPO_DETAILS_TOOL_CONFIG.name,
				{
					description: hubInspectDescription,
					inputSchema: z.object(hubInspectSchemaShape),
					annotations: HUB_REPO_DETAILS_TOOL_CONFIG.annotations,
				},
				async (params: Record<string, unknown>) => {
					const wantReadme = (params as { include_readme?: boolean }).include_readme === true; // explicit opt-in required
					const includeReadme = hubInspectReadmeAllowed && wantReadme;

					// Prepare safe logging parameters without relying on strong typing
					const repoIdsParam = (params as { repo_ids?: unknown }).repo_ids;
					const repoIds = Array.isArray(repoIdsParam)
						? repoIdsParam.filter((repoId): repoId is string => typeof repoId === 'string')
						: [];
					const joinedRepoIds = repoIds.join(', ');
					const loggedRepoIds = joinedRepoIds.length > 500 ? `${joinedRepoIds.slice(0, 497)}...` : joinedRepoIds;
					const repoType = (params as { repo_type?: unknown }).repo_type as unknown;
					const repoTypeSafe =
						repoType === 'model' || repoType === 'dataset' || repoType === 'space' ? repoType : undefined;
					const operationsParam = (params as { operations?: unknown }).operations;
					const operations = Array.isArray(operationsParam)
						? operationsParam.filter((operation): operation is string => typeof operation === 'string')
						: undefined;
					const config = (params as { config?: unknown }).config;
					const split = (params as { split?: unknown }).split;
					const offset = (params as { offset?: unknown }).offset;
					const limit = (params as { limit?: unknown }).limit;

					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: HUB_REPO_DETAILS_TOOL_CONFIG.name,
							query: loggedRepoIds,
							parameters: {
								repo_ids: repoIds,
								count: repoIds.length,
								repo_type: repoTypeSafe,
								include_readme: includeReadme,
								operations,
								config: typeof config === 'string' ? config : undefined,
								split: typeof split === 'string' ? split : undefined,
								offset: typeof offset === 'number' ? offset : undefined,
								limit: typeof limit === 'number' ? limit : undefined,
							},
							baseOptions: getLoggingOptions(),
							successOptions: (details) => ({
								totalResults: details.totalResults,
								resultsShared: details.resultsShared,
								responseCharCount: details.formatted.length,
							}),
						},
						async () => {
							const tool = new HubInspectTool(hfToken, undefined);
							return tool.inspect(params as unknown as HubInspectParams, includeReadme);
						}
					);
					return {
						content: [{ type: 'text', text: result.formatted }],
					};
				}
			);
		}

		const hfFsToolConfig = HF_FS_TOOL_CONFIG;
		if (shouldRegisterSelectedTool(hfFsToolConfig.name)) {
			server.registerTool(
				hfFsToolConfig.name,
				{
					title: hfFsToolConfig.title,
					description: hfFsToolConfig.description,
					inputSchema: hfFsToolConfig.schema,
					outputSchema: hfFsToolConfig.outputSchema,
					annotations: hfFsToolConfig.annotations,
				},
				async (request: HfFsRequest) => {
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: hfFsToolConfig.name,
							query: [request.cmd, ...request.args].join(' '),
							parameters: {
								cmd: request.cmd,
								args: request.args,
							},
							baseOptions: getLoggingOptions(),
							successOptions: (fsResult) => {
								const shared =
									'entries' in fsResult ? fsResult.entries.length : fsResult.op === 'stat' && !fsResult.exists ? 0 : 1;
								return {
									totalResults: 'entries' in fsResult ? fsResult.entries.length : shared,
									resultsShared: shared,
									responseCharCount: formatHfFsMarkdown(fsResult).length,
								};
							},
						},
						async () => {
							const tool = new HfFsTool(hfToken, undefined);
							return await tool.run(request);
						}
					);
					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatHfFsMarkdown(result) }],
					};
				}
			);
		}

		if (hfToken && toolSelection.behaviorFlags.enableHfFsWrite) {
			const hfFsWriteToolConfig = HfFsWriteTool.createToolConfig();
			if (shouldRegisterFixedTool(hfFsWriteToolConfig.name)) {
				server.registerTool(
					hfFsWriteToolConfig.name,
					{
						title: hfFsWriteToolConfig.title,
						description: hfFsWriteToolConfig.description,
						inputSchema: hfFsWriteToolConfig.schema,
						outputSchema: hfFsWriteToolConfig.outputSchema,
						annotations: hfFsWriteToolConfig.annotations,
					},
					async (request: HfFsWriteRequest) => {
						const result = await runWithQueryLogging(
							logToolQuery,
							{
								methodName: hfFsWriteToolConfig.name,
								query: [request.cmd, ...request.args].join(' '),
								parameters: {
									cmd: request.cmd,
									args: request.args,
									content_type:
										request.cmd === 'put' ? (request.args.includes('--base64') ? 'base64' : 'text') : undefined,
								},
								baseOptions: getLoggingOptions(),
								successOptions: (writeResult) => ({
									totalResults: 1,
									resultsShared: 1,
									responseCharCount: formatHfFsWriteMarkdown(writeResult).length,
								}),
							},
							async () => {
								const tool = new HfFsWriteTool(hfToken, undefined);
								return await tool.run(request);
							}
						);
						return {
							structuredContent: { ...result },
							content: [{ type: 'text', text: formatHfFsWriteMarkdown(result) }],
						};
					}
				);
			}
		}

		if (shouldRegisterSelectedTool(HF_JOBS_TOOL_CONFIG.name)) {
			server.registerTool(
				HF_JOBS_TOOL_CONFIG.name,
				{
					title: HF_JOBS_TOOL_CONFIG.annotations.title,
					description: HF_JOBS_TOOL_CONFIG.description,
					inputSchema: HF_JOBS_TOOL_CONFIG.schema,
					annotations: HF_JOBS_TOOL_CONFIG.annotations,
				},
				async (params: z.infer<typeof HF_JOBS_TOOL_CONFIG.schema>, ctx) => {
					// Jobs require authentication - check if user has token
					const isAuthenticated = !!hfToken;
					const loggedOperation = params.operation ?? 'no-operation';
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: HF_JOBS_TOOL_CONFIG.name,
							query: loggedOperation,
							parameters: params.args || {},
							baseOptions: getLoggingOptions(),
							successOptions: (jobResult) => ({
								totalResults: jobResult.totalResults,
								resultsShared: jobResult.resultsShared,
								responseCharCount: jobResult.formatted.length,
							}),
						},
						async () => {
							const jobsTool = new HfJobsTool(hfToken, isAuthenticated, username);
							return jobsTool.execute(params, { onProgress: createProgressRelay(ctx) });
						}
					);

					return {
						content: [{ type: 'text', text: result.formatted }],
						...(result.isError && { isError: true }),
					};
				}
			);
		}

		const SANDBOX_REDACTED_KEYS = ['args', 'handle', 'sandbox_token', 'text', 'base64', 'stdin', 'body', 'env'];
		const redactSandboxParameters = (args: Record<string, unknown> | undefined): Record<string, unknown> => {
			if (!args) {
				return {};
			}

			return Object.fromEntries(
				Object.entries(args).map(([key, value]) => {
					if (SANDBOX_REDACTED_KEYS.includes(key)) {
						return [key, '<redacted>'];
					}
					return [key, value];
				})
			);
		};

		const sandboxToolConfig = HfSandboxTool.createToolConfig(username);
		if (shouldRegisterSelectedTool(sandboxToolConfig.name)) {
			server.registerTool(
				sandboxToolConfig.name,
				{
					title: sandboxToolConfig.title,
					description: sandboxToolConfig.description,
					inputSchema: sandboxToolConfig.schema,
					outputSchema: sandboxToolConfig.outputSchema,
					annotations: sandboxToolConfig.annotations,
				},
				async (params: HfSandboxParams, ctx) => {
					const isAuthenticated = !!hfToken;
					const onProgress = createProgressRelay(ctx);
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: sandboxToolConfig.name,
							query: params.cmd,
							parameters: redactSandboxParameters(params),
							baseOptions: getLoggingOptions(),
							successOptions: (sandboxResult) => ({
								totalResults: 1,
								resultsShared: 1,
								responseCharCount: formatSandboxMarkdown(sandboxResult).length,
							}),
						},
						async () => {
							const sandboxTool = new HfSandboxTool(hfToken, isAuthenticated, username);
							return sandboxTool.run(params, { onProgress });
						}
					);

					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatSandboxMarkdown(result) }],
					};
				}
			);
		}

		const sandboxExecToolConfig = HfSandboxExecTool.createToolConfig(username);
		if (shouldRegisterSelectedTool(sandboxExecToolConfig.name)) {
			server.registerTool(
				sandboxExecToolConfig.name,
				{
					title: sandboxExecToolConfig.title,
					description: sandboxExecToolConfig.description,
					inputSchema: sandboxExecToolConfig.schema,
					outputSchema: sandboxExecToolConfig.outputSchema,
					annotations: sandboxExecToolConfig.annotations,
				},
				async (params: HfSandboxExecParams, ctx) => {
					const isAuthenticated = !!hfToken;
					const onProgress = createProgressRelay(ctx);
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: sandboxExecToolConfig.name,
							query: params.cmd,
							parameters: redactSandboxParameters(params),
							baseOptions: getLoggingOptions(),
							successOptions: (execResult) => ({
								totalResults: 1,
								resultsShared: 1,
								responseCharCount: formatSandboxExecMarkdown(execResult).length,
							}),
						},
						async () => {
							const sandboxExecTool = new HfSandboxExecTool(hfToken, isAuthenticated, username);
							return sandboxExecTool.run(params, { onProgress });
						}
					);

					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatSandboxExecMarkdown(result) }],
					};
				}
			);
		}

		const sandboxFsToolConfig = HfSandboxFsTool.createToolConfig(username);
		if (shouldRegisterSelectedTool(sandboxFsToolConfig.name)) {
			server.registerTool(
				sandboxFsToolConfig.name,
				{
					title: sandboxFsToolConfig.title,
					description: sandboxFsToolConfig.description,
					inputSchema: sandboxFsToolConfig.schema,
					outputSchema: sandboxFsToolConfig.outputSchema,
					annotations: sandboxFsToolConfig.annotations,
				},
				async (params: HfSandboxFsParams) => {
					const isAuthenticated = !!hfToken;
					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: sandboxFsToolConfig.name,
							query: params.cmd,
							parameters: redactSandboxParameters(params),
							baseOptions: getLoggingOptions(),
							successOptions: (fsResult) => ({
								totalResults: 1,
								resultsShared: 1,
								responseCharCount: formatSandboxFsMarkdown(fsResult).length,
							}),
						},
						async () => {
							const sandboxFsTool = new HfSandboxFsTool(hfToken, isAuthenticated, username);
							return sandboxFsTool.run(params);
						}
					);

					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatSandboxFsMarkdown(result) }],
					};
				}
			);
		}

		// Get dynamic config based on environment (uses DYNAMIC_SPACE_DATA env var)
		const dynamicSpaceToolConfig = getDynamicSpaceToolConfig();
		if (shouldRegisterSelectedTool(dynamicSpaceToolConfig.name)) {
			server.registerTool(
				dynamicSpaceToolConfig.name,
				{
					title: dynamicSpaceToolConfig.annotations.title,
					description: dynamicSpaceToolConfig.description,
					inputSchema: dynamicSpaceToolConfig.schema,
					annotations: dynamicSpaceToolConfig.annotations,
				},
				async (params: SpaceArgs, ctx) => {
					// Check if invoke operation is disabled by gradio=none
					const { gradio } = extractAuthBouquetAndMix(headers);
					if (params.operation === 'invoke' && gradio === 'none') {
						const errorMessage =
							'The invoke operation is disabled because gradio=none is set. ' +
							'To use invoke, remove gradio=none from your headers or set gradio to a space ID. ' +
							`You can still use operation=${VIEW_PARAMETERS} to inspect the tool schema.`;
						return {
							content: [{ type: 'text', text: errorMessage }],
							isError: true,
						};
					}

					const loggedOperation = params.operation ?? 'no-operation';

					if (params.operation === 'invoke') {
						const startTime = Date.now();
						let notificationCount = 0;

						try {
							const spaceTool = new SpaceTool(hfToken);
							const progressRelay = createProgressRelay(ctx);
							const result = await spaceTool.execute(params, {
								onProgress: progressRelay
									? async (progress) => {
											notificationCount++;
											await progressRelay(progress);
										}
									: undefined,
							});

							if ('result' in result && result.result) {
								const invokeResult = result as InvokeResult;
								const success = !invokeResult.isError;

								const stripImageContent = noImageContentHeaderEnabled || toolSelection.behaviorFlags.stripGradioImages;
								const postProcessOptions: GradioToolCallOptions = {
									stripImageContent,
									toolName: dynamicSpaceToolConfig.name,
									outwardFacingName: dynamicSpaceToolConfig.name,
								};

								const processedResult = applyResultPostProcessing(
									invokeResult.result as CallToolResult,
									postProcessOptions
								);

								const warningsContent =
									invokeResult.warnings.length > 0
										? [
												{
													type: 'text' as const,
													text:
														(invokeResult.warnings.length === 1 ? 'Warning:\n' : 'Warnings:\n') +
														invokeResult.warnings.map((w) => `- ${w}`).join('\n') +
														'\n',
												},
											]
										: [];

								const durationMs = Date.now() - startTime;
								const responseContent = [...warningsContent, ...(processedResult.content as unknown[])];
								logGradioEvent(params.space_name || 'unknown-space', clientCorrelationId || 'unknown', {
									durationMs,
									isAuthenticated: !!hfToken,
									clientName: sessionInfo?.clientInfo?.name,
									clientVersion: sessionInfo?.clientInfo?.version,
									success,
									error: invokeResult.isError ? JSON.stringify(responseContent) : undefined,
									responseSizeBytes: JSON.stringify(responseContent).length,
									isDynamic: true,
									notificationCount,
									clientSessionId: sessionInfo?.clientSessionId,
									requestId: sessionInfo?.requestId,
									protocolEra: sessionInfo?.protocolEra,
									protocolVersion: sessionInfo?.protocolVersion,
									clientCapabilities: sessionInfo?.clientCapabilities,
									userHash: sessionInfo?.userHash,
								});

								return {
									content: responseContent,
									...(invokeResult.isError && { isError: true }),
								} as CallToolResult;
							}

							const toolResult = result as ToolResult;
							const success = !toolResult.isError;

							const durationMs = Date.now() - startTime;
							logToolQuery(dynamicSpaceToolConfig.name, loggedOperation, params, {
								...getLoggingOptions(),
								totalResults: toolResult.totalResults,
								resultsShared: toolResult.resultsShared,
								responseCharCount: toolResult.formatted.length,
								durationMs,
								success,
								...(toolResult.isError ? { error: getToolResultErrorMessage(toolResult) } : {}),
							});

							return {
								content: [{ type: 'text', text: toolResult.formatted }],
								...(toolResult.isError && { isError: true }),
							};
						} catch (err) {
							const durationMs = Date.now() - startTime;
							logGradioEvent(params.space_name || 'unknown-space', clientCorrelationId || 'unknown', {
								durationMs,
								isAuthenticated: !!hfToken,
								clientName: sessionInfo?.clientInfo?.name,
								clientVersion: sessionInfo?.clientInfo?.version,
								success: false,
								error: err,
								isDynamic: true,
								notificationCount,
								clientSessionId: sessionInfo?.clientSessionId,
								requestId: sessionInfo?.requestId,
								protocolEra: sessionInfo?.protocolEra,
								protocolVersion: sessionInfo?.protocolVersion,
								clientCapabilities: sessionInfo?.clientCapabilities,
								userHash: sessionInfo?.userHash,
							});
							throw err;
						}
					}

					const toolResult = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: dynamicSpaceToolConfig.name,
							query: loggedOperation,
							parameters: params,
							baseOptions: getLoggingOptions(),
							successOptions: (result) => ({
								totalResults: result.totalResults,
								resultsShared: result.resultsShared,
								responseCharCount: result.formatted.length,
							}),
						},
						async () => {
							const spaceTool = new SpaceTool(hfToken);
							const result = await spaceTool.execute(params);
							return result as ToolResult;
						}
					);

					return {
						content: [{ type: 'text', text: toolResult.formatted }],
						...(toolResult.isError && { isError: true }),
					};
				}
			);
		}

		// Register SEP-2640 discovery methods and verified in-memory skill resources.
		if (skillCatalog && hasSkills) {
			registerSkillResources(server, skillCatalog, {
				protocolVersion: sessionInfo?.protocolVersion,
				ttlMs: getSkillCatalogRemainingTtlMs(skillCatalog),
			});
		}

		logger.info(
			{
				mode: toolSelection.mode,
				reason: toolSelection.reason,
				enabledCount: toolSelection.enabledToolIds.length,
				mixedBouquet: toolSelection.mixedBouquet?.join(','),
			},
			'Immutable tool selection applied'
		);

		registerCapabilities(server, {
			hasSkills,
		});

		return {
			server,
			enabledToolIds: toolSelection.enabledToolIds,
			behaviorFlags: toolSelection.behaviorFlags,
		};
	};
};
