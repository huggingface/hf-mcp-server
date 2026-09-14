import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
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
	HF_FS_ATTACH_MAX_BYTES,
	HfFsTool,
	HfFsAttachmentIntegrityError,
	classifyHfFsError,
	formatHfFsBatchMarkdown,
	formatHfFsRecoveryError,
	isHfFsAttachExecutionResult,
	toHfFsBatchResult,
	type HfFsBatchExecutionItem,
	type HfFsBatchResult,
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
	CREATE_REPO_TOOL_ID,
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
import {
	summarizeCompletedHfFsBatch,
	summarizeInterruptedHfFsBatch,
	type CompletedHfFsQueryTelemetry,
} from './utils/hf-fs-telemetry.js';
import { recordHfFsLiveMetrics } from './utils/hf-fs-live-metrics.js';
import { createHfWhoamiOutput, formatHfWhoamiMarkdown } from './utils/hf-whoami.js';
import type { HfWhoamiResponse } from './utils/hf-whoami-client.js';
import { McpAuthorizationError, verifyMcpAuthorization } from './utils/mcp-authorization.js';
import { hfWhoamiOutputSchema } from './output-schemas/hf-whoami-output-schema.js';
import { MCP_SERVER_NAME } from './server-card.js';
import { buildServerInstructions } from './server-instructions.js';
import { getGrantedOAuthScopes } from './utils/oauth-scopes.js';

const MAX_HF_FS_ATTACHMENT_BASE64_BYTES = 4 * Math.ceil(HF_FS_ATTACH_MAX_BYTES / 3);
const CREATE_REPO_OAUTH_SCOPES = new Set(['contribute-repos', 'write-repos']);

function shouldAutoEnableCreateRepo(
	enableHfFsWrite: boolean,
	hfToken: string | undefined,
	userDetails: HfWhoamiResponse | undefined
): boolean {
	if (!enableHfFsWrite || userDetails?.auth.type !== 'oauth') {
		return false;
	}

	const grantedScopes = getGrantedOAuthScopes(hfToken);
	return grantedScopes.scopes?.some((scope) => CREATE_REPO_OAUTH_SCOPES.has(scope)) === true;
}

function encodeHfFsAttachment(data: Uint8Array, expectedBytes: number): string {
	if (
		!Number.isSafeInteger(expectedBytes) ||
		expectedBytes < 0 ||
		expectedBytes > HF_FS_ATTACH_MAX_BYTES ||
		data.byteLength !== expectedBytes
	) {
		throw new HfFsAttachmentIntegrityError('hf_fs attachment bytes did not match validated attachment metadata.');
	}
	const encodedLength = 4 * Math.ceil(data.byteLength / 3);
	if (!Number.isSafeInteger(encodedLength) || encodedLength > MAX_HF_FS_ATTACHMENT_BASE64_BYTES) {
		throw new HfFsAttachmentIntegrityError('hf_fs attachment exceeds the safe base64 response limit.');
	}
	const encoded = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
	if (encoded.length !== encodedLength) {
		throw new HfFsAttachmentIntegrityError(
			'hf_fs attachment base64 length did not match the deterministic encoded length.'
		);
	}
	return encoded;
}

interface PreparedHfFsBatchExecution {
	structuredContent: HfFsBatchResult;
	text: string;
	images: { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }[];
	successCount: number;
	telemetry: CompletedHfFsQueryTelemetry;
}

function prepareHfFsBatchExecution(
	requestedCount: number,
	items: readonly HfFsBatchExecutionItem[]
): PreparedHfFsBatchExecution {
	const telemetry = summarizeCompletedHfFsBatch(requestedCount, items);
	const images = items.flatMap((item) => {
		if (item.status !== 'success' || !isHfFsAttachExecutionResult(item.executionResult)) {
			return [];
		}
		return [
			{
				data: encodeHfFsAttachment(item.executionResult.data, item.executionResult.metadata.bytes),
				mimeType: item.executionResult.metadata.mime_type,
			},
		];
	});
	return {
		structuredContent: toHfFsBatchResult(items),
		text: formatHfFsBatchMarkdown(items),
		images,
		successCount: telemetry.hfFsOperationsSucceeded,
		telemetry,
	};
}

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
		const { hfToken } = extractAuthBouquetAndMix(headers, { allowDefaultHfToken: headers === null });
		if (headers?.authorization !== undefined && !hfToken) throw new McpAuthorizationError(401);
		const userDetails = hfToken ? await verifyMcpAuthorization(hfToken, sessionInfo?.authenticatedUser) : undefined;
		sessionInfo = { ...sessionInfo, authenticatedUser: userDetails, isAuthenticated: userDetails !== undefined };
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

		// Create tool selection strategy
		const toolSelectionStrategy = new ToolSelectionStrategy(sharedApiClient);

		let userInfo: string =
			'The Hugging Face tools are being used anonymously and rate limits apply. ' +
			'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
			'create an account at https://hf.co/join for higher limits.';
		let username: string | undefined;

		if (userDetails) {
			username = userDetails.name;
			userInfo = `Hugging Face tools are being used by authenticated user '${userDetails.name}'`;
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
				isAuthenticated: userDetails !== undefined,
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
			failureOptions?: (error: unknown) => BaseQueryLoggerOptions | void;
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
				const failureOptions = config.failureOptions?.(error) ?? {};
				const { success: successOverride, ...restFailureOptions } = failureOptions;
				logFn(config.methodName, config.query, config.parameters, {
					...config.baseOptions,
					...restFailureOptions,
					durationMs,
					success: successOverride ?? false,
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

		// Select tools before registering them on the new server.
		const toolSelectionContext: ToolSelectionContext = {
			headers,
			userSettings,
			hfToken,
		};
		const toolSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);
		if (
			shouldAutoEnableCreateRepo(toolSelection.behaviorFlags.enableHfFsWrite, hfToken, userDetails) &&
			!toolSelection.enabledToolIds.includes(CREATE_REPO_TOOL_ID)
		) {
			toolSelection.enabledToolIds = [...toolSelection.enabledToolIds, CREATE_REPO_TOOL_ID];
		}

		const server = new McpServer(
			{
				name: MCP_SERVER_NAME,
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
				instructions: buildServerInstructions(userInfo),
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

		const whoDescription =
			'Inspect the current Hugging Face authentication context, including the account, visible organization memberships, and credential access details. Read-only and never returns credential values.';

		if (shouldRegisterFixedTool('hf_whoami')) {
			server.registerTool(
				'hf_whoami',
				{
					title: 'Hugging Face User Info',
					description: whoDescription,
					inputSchema: z.object({}),
					outputSchema: hfWhoamiOutputSchema,
					annotations: {
						title: 'Hugging Face User Info',
						destructiveHint: false,
						idempotentHint: false,
						readOnlyHint: true,
						openWorldHint: false,
					},
				},
				() => {
					const result = createHfWhoamiOutput(userDetails, hfToken, CONFIG_GUIDANCE);
					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatHfWhoamiMarkdown(result) }],
					};
				}
			);
		}

		if (shouldRegisterSelectedTool(REPO_SEARCH_TOOL_CONFIG.name)) {
			server.registerTool(
				REPO_SEARCH_TOOL_CONFIG.name,
				{
					title: REPO_SEARCH_TOOL_CONFIG.title,
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
					title: createRepoToolConfig.title,
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

		if (shouldRegisterSelectedTool(HUB_REPO_DETAILS_TOOL_CONFIG.name)) {
			server.registerTool(
				HUB_REPO_DETAILS_TOOL_CONFIG.name,
				{
					title: HUB_REPO_DETAILS_TOOL_CONFIG.title,
					description: HUB_REPO_DETAILS_TOOL_CONFIG.description,
					inputSchema: HUB_REPO_DETAILS_TOOL_CONFIG.schema,
					annotations: HUB_REPO_DETAILS_TOOL_CONFIG.annotations,
				},
				async (params: HubInspectParams) => {
					// Prepare safe logging parameters without relying on strong typing
					const repoIds = params.repo_ids;
					const joinedRepoIds = repoIds.join(', ');
					const loggedRepoIds = joinedRepoIds.length > 500 ? `${joinedRepoIds.slice(0, 497)}...` : joinedRepoIds;

					const result = await runWithQueryLogging(
						logToolQuery,
						{
							methodName: HUB_REPO_DETAILS_TOOL_CONFIG.name,
							query: loggedRepoIds,
							parameters: {
								repo_ids: repoIds,
								count: repoIds.length,
								repo_type: params.repo_type,
								operations: params.operations,
								config: params.config,
								split: params.split,
								offset: params.offset,
								limit: params.limit,
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
							return tool.inspect(params);
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
				async (request: HfFsRequest, ctx) => {
					try {
						const prepared = await runWithQueryLogging(
							logToolQuery,
							{
								methodName: hfFsToolConfig.name,
								query: request.operations.map((operation) => [operation.cmd, ...operation.args].join(' ')).join('\n'),
								parameters: {
									operations: request.operations,
								},
								baseOptions: getLoggingOptions(),
								successOptions: (batchResult) => {
									recordHfFsLiveMetrics(batchResult.telemetry);
									return {
										totalResults: request.operations.length,
										resultsShared: batchResult.successCount,
										responseCharCount: batchResult.text.length,
										success: batchResult.successCount > 0,
										...batchResult.telemetry,
									};
								},
								failureOptions: () => {
									const telemetry = summarizeInterruptedHfFsBatch(
										request.operations.length,
										ctx.mcpReq.signal.aborted ? 'cancelled' : 'failed'
									);
									recordHfFsLiveMetrics(telemetry);
									return telemetry;
								},
							},
							async () => {
								const tool = new HfFsTool(hfToken, undefined, ctx.mcpReq.signal);
								const executionItems = await tool.runBatch(request, {
									imageContentDisabled: noImageContentHeaderEnabled,
								});
								// Encode before success telemetry is emitted. Only aggregate metrics reach
								// logToolQuery; neither Uint8Array data nor base64 image content is logged.
								return prepareHfFsBatchExecution(request.operations.length, executionItems);
							}
						);
						return {
							...(prepared.successCount === 0 ? { isError: true } : {}),
							structuredContent: prepared.structuredContent,
							content: [
								{ type: 'text' as const, text: prepared.text },
								...prepared.images.map((image) => ({ type: 'image' as const, ...image })),
							],
						};
					} catch (error) {
						const recoveryError = classifyHfFsError(error);
						if (!recoveryError) {
							throw error;
						}
						return {
							isError: true,
							content: [{ type: 'text' as const, text: formatHfFsRecoveryError(recoveryError) }],
							_meta: {
								'huggingface.co/hf_fs_error': {
									code: recoveryError.code,
									retryable: recoveryError.retryable,
									...(recoveryError.suggestedOperation ? { suggestedOperation: recoveryError.suggestedOperation } : {}),
								},
							},
						};
					}
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
					title: HF_JOBS_TOOL_CONFIG.title,
					description: HF_JOBS_TOOL_CONFIG.description,
					inputSchema: HF_JOBS_TOOL_CONFIG.schema,
					outputSchema: HF_JOBS_TOOL_CONFIG.outputSchema,
					annotations: HF_JOBS_TOOL_CONFIG.annotations,
				},
				async (params: z.infer<typeof HF_JOBS_TOOL_CONFIG.schema>, ctx) => {
					// Jobs require a verified, MCP-authorized identity.
					const isAuthenticated = userDetails !== undefined;
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
						structuredContent: result.structuredContent,
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
					const isAuthenticated = userDetails !== undefined;
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
					const isAuthenticated = userDetails !== undefined;
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
					const isAuthenticated = userDetails !== undefined;
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
					title: dynamicSpaceToolConfig.title,
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
									isAuthenticated: userDetails !== undefined,
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
								isAuthenticated: userDetails !== undefined,
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
			isAuthenticated: userDetails !== undefined,
			enabledToolIds: toolSelection.enabledToolIds,
			behaviorFlags: toolSelection.behaviorFlags,
		};
	};
};
