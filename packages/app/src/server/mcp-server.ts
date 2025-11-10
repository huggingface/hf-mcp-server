import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { createRequire } from 'module';
import { whoAmI, type WhoAmI } from '@huggingface/hub';
import {
	SpaceSearchTool,
	formatSearchResults,
	SEMANTIC_SEARCH_TOOL_CONFIG,
	type SearchParams,
	ModelSearchTool,
	MODEL_SEARCH_TOOL_CONFIG,
	type ModelSearchParams,
	ModelDetailTool,
	MODEL_DETAIL_TOOL_CONFIG,
	MODEL_DETAIL_PROMPT_CONFIG,
	type ModelDetailParams,
	PaperSearchTool,
	PAPER_SEARCH_TOOL_CONFIG,
	DatasetSearchTool,
	DATASET_SEARCH_TOOL_CONFIG,
	type DatasetSearchParams,
	DatasetDetailTool,
	DATASET_DETAIL_TOOL_CONFIG,
	DATASET_DETAIL_PROMPT_CONFIG,
	type DatasetDetailParams,
	HUB_INSPECT_TOOL_CONFIG,
	HubInspectTool,
	type HubInspectParams,
	DuplicateSpaceTool,
	formatDuplicateResult,
	type DuplicateSpaceParams,
	SpaceInfoTool,
	formatSpaceInfoResult,
	SpaceFilesTool,
	type SpaceFilesParams,
	type SpaceInfoParams,
	UseSpaceTool,
	USE_SPACE_TOOL_CONFIG,
	formatUseSpaceResult,
	type UseSpaceParams,
	UserSummaryPrompt,
	USER_SUMMARY_PROMPT_CONFIG,
	type UserSummaryParams,
	PaperSummaryPrompt,
	PAPER_SUMMARY_PROMPT_CONFIG,
	type PaperSummaryParams,
	CONFIG_GUIDANCE,
	TOOL_ID_GROUPS,
	DOCS_SEMANTIC_SEARCH_CONFIG,
	DocSearchTool,
	type DocSearchParams,
	DOC_FETCH_CONFIG,
	DocFetchTool,
	type DocFetchParams,
	HF_JOBS_TOOL_CONFIG,
	HfJobsTool,
	SPACE_TOOL_CONFIG,
	SpaceTool,
	type SpaceArgs,
} from '@llmindset/hf-mcp';

import type { ServerFactory, ServerFactoryResult } from './transport/base-transport.js';
import type { McpApiClient } from './utils/mcp-api-client.js';
import type { WebServer } from './web-server.js';
import { logger } from './utils/logger.js';
import { logSearchQuery, logPromptQuery } from './utils/query-logger.js';
import { DEFAULT_SPACE_TOOLS, type AppSettings } from '../shared/settings.js';
import { extractAuthBouquetAndMix } from './utils/auth-utils.js';
import { ToolSelectionStrategy, type ToolSelectionContext } from './utils/tool-selection-strategy.js';
import { hasReadmeFlag } from '../shared/behavior-flags.js';
import { registerCapabilities } from './utils/capability-utils.js';
import { createGradioWidgetResourceConfig } from './resources/gradio-widget-resource.js';

// Fallback settings when API fails (enables all tools)
export const BOUQUET_FALLBACK: AppSettings = {
	builtInTools: [...TOOL_ID_GROUPS.hf_api],
	spaceTools: DEFAULT_SPACE_TOOLS,
};

// Default tools for unauthenticated users when using external settings API
export const BOUQUET_ANON_DEFAULT: AppSettings = {
	builtInTools: [...TOOL_ID_GROUPS.hf_api],
	spaceTools: DEFAULT_SPACE_TOOLS,
};

// Bouquet configurations moved to tool-selection-strategy.ts

/**
 * Creates a ServerFactory function that produces McpServer instances with all tools registered
 * The shared ApiClient provides global tool state management across all server instances
 */
export const createServerFactory = (_webServerInstance: WebServer, sharedApiClient: McpApiClient): ServerFactory => {
	const require = createRequire(import.meta.url);
	const { version } = require('../../package.json') as { version: string };

	return async (
		headers: Record<string, string> | null,
		userSettings?: AppSettings,
		skipGradio?: boolean,
		sessionInfo?: {
			clientSessionId?: string;
			isAuthenticated?: boolean;
			clientInfo?: { name: string; version: string };
		}
	): Promise<ServerFactoryResult> => {
		logger.debug({ skipGradio, sessionInfo }, '=== CREATING NEW MCP SERVER INSTANCE ===');
		// Extract auth using shared utility
		const { hfToken } = extractAuthBouquetAndMix(headers);

		// Create tool selection strategy
		const toolSelectionStrategy = new ToolSelectionStrategy(sharedApiClient);

		let userInfo: string =
			'The Hugging Face tools are being used anonymously and rate limits apply. ' +
			'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
			'create an account at https://hf.co/join for higher limits.';
		let username: string | undefined;
		let userDetails: WhoAmI | undefined;

		if (hfToken) {
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
		const getLoggingOptions = () => {
			const options = {
				clientSessionId: sessionInfo?.clientSessionId,
				isAuthenticated: sessionInfo?.isAuthenticated ?? !!hfToken,
				clientName: sessionInfo?.clientInfo?.name,
				clientVersion: sessionInfo?.clientInfo?.version,
			};
			logger.debug({ sessionInfo, options }, 'Query logging options:');
			return options;
		};

		/**
		 *  we will set capabilities below. use of the convenience .tool() registration methods automatically
		 * sets tools: {listChanged: true} .
		 */
		const server = new McpServer(
			{
				name: '@huggingface/mcp-services',
				version: version,
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
					"You have tools for searching the Hugging Face Hub. arXiv paper id's are often " +
					'used as references between datasets, models and papers. There are over 100 tags in use, ' +
					"common tags include 'Text Generation', 'Transformers', 'Image Classification' and so on.\n" +
					"The User has access to 'Prompts' that provide ways to summarise various types of " +
					'Hugging Face hub content, and you may guide them to check this feature. ' +
					userInfo,
			}
		);

		interface Tool {
			enable(): void;
			disable(): void;
		}

		// Get tool selection first (needed for runtime configuration like ALLOW_README_INCLUDE)
		const toolSelectionContext: ToolSelectionContext = {
			headers,
			userSettings,
			hfToken,
		};
		const toolSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);

		// Always register all tools and store instances for dynamic control
		const toolInstances: { [name: string]: Tool } = {};

		const whoDescription = userDetails
			? `Hugging Face tools are being used by authenticated user '${username}'`
			: 'Hugging Face tools are being used anonymously and may be rate limited. Call this tool for instructions on joining and authenticating.';

		const response = userDetails ? `You are authenticated as ${username ?? 'unknown'}.` : CONFIG_GUIDANCE;
		server.tool(
			'hf_whoami',
			whoDescription,
			{},
			{ readOnlyHint: true, openWorldHint: false, title: 'Hugging Face User Info' },
			() => {
				return { content: [{ type: 'text', text: response }] };
			}
		);

		/** always leave tool active so flow can complete / allow uid change */
		if (process.env.AUTHENTICATE_TOOL === 'true') {
			server.tool(
				'Authenticate',
				'Authenticate with Hugging Face',
				{},
				{ title: 'Hugging Face Authentication' },
				() => {
					return { content: [{ type: 'text', text: 'You have successfully authenticated' }] };
				}
			);
		}

		server.prompt(
			USER_SUMMARY_PROMPT_CONFIG.name,
			USER_SUMMARY_PROMPT_CONFIG.description,
			USER_SUMMARY_PROMPT_CONFIG.schema.shape,
			async (params: UserSummaryParams) => {
				const userSummary = new UserSummaryPrompt(hfToken);
				const summaryText = await userSummary.generateSummary(params);
				logPromptQuery(
					USER_SUMMARY_PROMPT_CONFIG.name,
					params.user_id,
					{ user_id: params.user_id },
					{
						...getLoggingOptions(),
						totalResults: 1,
						resultsShared: 1,
						responseCharCount: summaryText.length,
					}
				);

				return {
					description: `User summary for ${params.user_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: summaryText,
							},
						},
					],
				};
			}
		);

		server.prompt(
			PAPER_SUMMARY_PROMPT_CONFIG.name,
			PAPER_SUMMARY_PROMPT_CONFIG.description,
			PAPER_SUMMARY_PROMPT_CONFIG.schema.shape,
			async (params: PaperSummaryParams) => {
				const paperSummary = new PaperSummaryPrompt(hfToken);
				const summaryText = await paperSummary.generateSummary(params);
				logPromptQuery(
					PAPER_SUMMARY_PROMPT_CONFIG.name,
					params.paper_id,
					{ paper_id: params.paper_id },
					{
						...getLoggingOptions(),
						totalResults: 1,
						resultsShared: 1,
						responseCharCount: summaryText.length,
					}
				);

				return {
					description: `Paper summary for ${params.paper_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: summaryText,
							},
						},
					],
				};
			}
		);

		server.prompt(
			MODEL_DETAIL_PROMPT_CONFIG.name,
			MODEL_DETAIL_PROMPT_CONFIG.description,
			MODEL_DETAIL_PROMPT_CONFIG.schema.shape,
			async (params: ModelDetailParams) => {
				const modelDetail = new ModelDetailTool(hfToken, undefined);
				const result = await modelDetail.getDetails(params.model_id, true);
				logPromptQuery(
					MODEL_DETAIL_PROMPT_CONFIG.name,
					params.model_id,
					{ model_id: params.model_id },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);

				return {
					description: `Model details for ${params.model_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: result.formatted,
							},
						},
					],
				};
			}
		);

		server.prompt(
			DATASET_DETAIL_PROMPT_CONFIG.name,
			DATASET_DETAIL_PROMPT_CONFIG.description,
			DATASET_DETAIL_PROMPT_CONFIG.schema.shape,
			async (params: DatasetDetailParams) => {
				const datasetDetail = new DatasetDetailTool(hfToken, undefined);
				const result = await datasetDetail.getDetails(params.dataset_id, true);
				logPromptQuery(
					DATASET_DETAIL_PROMPT_CONFIG.name,
					params.dataset_id,
					{ dataset_id: params.dataset_id },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);

				return {
					description: `Dataset details for ${params.dataset_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: result.formatted,
							},
						},
					],
				};
			}
		);

		toolInstances[SEMANTIC_SEARCH_TOOL_CONFIG.name] = server.tool(
			SEMANTIC_SEARCH_TOOL_CONFIG.name,
			SEMANTIC_SEARCH_TOOL_CONFIG.description,
			SEMANTIC_SEARCH_TOOL_CONFIG.schema.shape,
			SEMANTIC_SEARCH_TOOL_CONFIG.annotations,
			async (params: SearchParams) => {
				const semanticSearch = new SpaceSearchTool(hfToken);
				const searchResult = await semanticSearch.search(params.query, params.limit, params.mcp);
				const result = formatSearchResults(params.query, searchResult.results, searchResult.totalCount);
				logSearchQuery(
					SEMANTIC_SEARCH_TOOL_CONFIG.name,
					params.query,
					{ limit: params.limit, mcp: params.mcp },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[MODEL_SEARCH_TOOL_CONFIG.name] = server.tool(
			MODEL_SEARCH_TOOL_CONFIG.name,
			MODEL_SEARCH_TOOL_CONFIG.description,
			MODEL_SEARCH_TOOL_CONFIG.schema.shape,
			MODEL_SEARCH_TOOL_CONFIG.annotations,
			async (params: ModelSearchParams) => {
				const modelSearch = new ModelSearchTool(hfToken);
				const result = await modelSearch.searchWithParams(params);
				logSearchQuery(
					MODEL_SEARCH_TOOL_CONFIG.name,
					params.query || `sort:${params.sort || 'trendingScore'}`,
					params,
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[MODEL_DETAIL_TOOL_CONFIG.name] = server.tool(
			MODEL_DETAIL_TOOL_CONFIG.name,
			MODEL_DETAIL_TOOL_CONFIG.description,
			MODEL_DETAIL_TOOL_CONFIG.schema.shape,
			MODEL_DETAIL_TOOL_CONFIG.annotations,
			async (params: ModelDetailParams) => {
				const modelDetail = new ModelDetailTool(hfToken, undefined);
				const result = await modelDetail.getDetails(params.model_id, false);
				logPromptQuery(
					MODEL_DETAIL_TOOL_CONFIG.name,
					params.model_id,
					{ model_id: params.model_id },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[PAPER_SEARCH_TOOL_CONFIG.name] = server.tool(
			PAPER_SEARCH_TOOL_CONFIG.name,
			PAPER_SEARCH_TOOL_CONFIG.description,
			PAPER_SEARCH_TOOL_CONFIG.schema.shape,
			PAPER_SEARCH_TOOL_CONFIG.annotations,
			async (params: z.infer<typeof PAPER_SEARCH_TOOL_CONFIG.schema>) => {
				const result = await new PaperSearchTool(hfToken).search(
					params.query,
					params.results_limit,
					params.concise_only
				);
				logSearchQuery(
					PAPER_SEARCH_TOOL_CONFIG.name,
					params.query,
					{ results_limit: params.results_limit, concise_only: params.concise_only },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DATASET_SEARCH_TOOL_CONFIG.name] = server.tool(
			DATASET_SEARCH_TOOL_CONFIG.name,
			DATASET_SEARCH_TOOL_CONFIG.description,
			DATASET_SEARCH_TOOL_CONFIG.schema.shape,
			DATASET_SEARCH_TOOL_CONFIG.annotations,
			async (params: DatasetSearchParams) => {
				const datasetSearch = new DatasetSearchTool(hfToken);
				const result = await datasetSearch.searchWithParams(params);
				logSearchQuery(
					DATASET_SEARCH_TOOL_CONFIG.name,
					params.query || `sort:${params.sort || 'trendingScore'}`,
					params,
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DATASET_DETAIL_TOOL_CONFIG.name] = server.tool(
			DATASET_DETAIL_TOOL_CONFIG.name,
			DATASET_DETAIL_TOOL_CONFIG.description,
			DATASET_DETAIL_TOOL_CONFIG.schema.shape,
			DATASET_DETAIL_TOOL_CONFIG.annotations,
			async (params: DatasetDetailParams) => {
				const datasetDetail = new DatasetDetailTool(hfToken, undefined);
				const result = await datasetDetail.getDetails(params.dataset_id, false);
				logPromptQuery(
					DATASET_DETAIL_TOOL_CONFIG.name,
					params.dataset_id,
					{ dataset_id: params.dataset_id },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		// Compute README availability; adjust description and schema accordingly
		const hubInspectReadmeAllowed = hasReadmeFlag(toolSelection.enabledToolIds);
		const hubInspectDescription = hubInspectReadmeAllowed
			? `${HUB_INSPECT_TOOL_CONFIG.description} README file may be requested from the external repository.`
			: HUB_INSPECT_TOOL_CONFIG.description;
		const hubInspectBaseShape = HUB_INSPECT_TOOL_CONFIG.schema.shape as z.ZodRawShape;
		const hubInspectSchemaShape: z.ZodRawShape = hubInspectReadmeAllowed
			? hubInspectBaseShape
			: (() => {
					const { include_readme: _omit, ...rest } = hubInspectBaseShape as unknown as Record<string, unknown>;
					return rest as unknown as z.ZodRawShape;
				})();

		toolInstances[HUB_INSPECT_TOOL_CONFIG.name] = server.tool(
			HUB_INSPECT_TOOL_CONFIG.name,
			hubInspectDescription,
			hubInspectSchemaShape,
			HUB_INSPECT_TOOL_CONFIG.annotations,
			async (params: Record<string, unknown>) => {
				// Re-evaluate flag dynamically to reflect UI changes without restarting server
				const currentSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);
				const allowReadme = hasReadmeFlag(currentSelection.enabledToolIds);
				const wantReadme = (params as { include_readme?: boolean }).include_readme === true; // explicit opt-in required
				const includeReadme = allowReadme && wantReadme;

				const tool = new HubInspectTool(hfToken, undefined);
				const result = await tool.inspect(params as unknown as HubInspectParams, includeReadme);
				// Prepare safe logging parameters without relying on strong typing
				const repoIdsParam = (params as { repo_ids?: unknown }).repo_ids;
				const repoIds = Array.isArray(repoIdsParam) ? repoIdsParam : [];
				const firstRepoId = typeof repoIds[0] === 'string' ? (repoIds[0] as string) : '';
				const repoType = (params as { repo_type?: unknown }).repo_type as unknown;
				const repoTypeSafe =
					repoType === 'model' || repoType === 'dataset' || repoType === 'space' ? repoType : undefined;

				logPromptQuery(
					HUB_INSPECT_TOOL_CONFIG.name,
					firstRepoId,
					{ count: repoIds.length, repo_type: repoTypeSafe, include_readme: includeReadme },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DOCS_SEMANTIC_SEARCH_CONFIG.name] = server.tool(
			DOCS_SEMANTIC_SEARCH_CONFIG.name,
			DOCS_SEMANTIC_SEARCH_CONFIG.description,
			DOCS_SEMANTIC_SEARCH_CONFIG.schema.shape,
			DOCS_SEMANTIC_SEARCH_CONFIG.annotations,
			async (params: DocSearchParams) => {
				const docSearch = new DocSearchTool(hfToken);
				const result = await docSearch.search(params);
				logSearchQuery(
					DOCS_SEMANTIC_SEARCH_CONFIG.name,
					params.query,
					{ product: params.product },
					{
						...getLoggingOptions(),
						totalResults: result.totalResults,
						resultsShared: result.resultsShared,
						responseCharCount: result.formatted.length,
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DOC_FETCH_CONFIG.name] = server.tool(
			DOC_FETCH_CONFIG.name,
			DOC_FETCH_CONFIG.description,
			DOC_FETCH_CONFIG.schema.shape,
			DOC_FETCH_CONFIG.annotations,
			async (params: DocFetchParams) => {
				const docFetch = new DocFetchTool();
				const results = await docFetch.fetch(params);
				return {
					content: [{ type: 'text', text: results }],
				};
			}
		);

		const duplicateToolConfig = DuplicateSpaceTool.createToolConfig(username);
		toolInstances[duplicateToolConfig.name] = server.tool(
			duplicateToolConfig.name,
			duplicateToolConfig.description,
			duplicateToolConfig.schema.shape,
			duplicateToolConfig.annotations,
			async (params: DuplicateSpaceParams) => {
				const duplicateSpace = new DuplicateSpaceTool(hfToken, username);
				const result = await duplicateSpace.duplicate(params);
				return {
					content: [{ type: 'text', text: formatDuplicateResult(result) }],
				};
			}
		);

		const spaceInfoToolConfig = SpaceInfoTool.createToolConfig(username);
		toolInstances[spaceInfoToolConfig.name] = server.tool(
			spaceInfoToolConfig.name,
			spaceInfoToolConfig.description,
			spaceInfoToolConfig.schema.shape,
			spaceInfoToolConfig.annotations,
			async (params: SpaceInfoParams) => {
				const spaceInfoTool = new SpaceInfoTool(hfToken, username);
				const result = await formatSpaceInfoResult(spaceInfoTool, params);
				return {
					content: [{ type: 'text', text: result }],
				};
			}
		);

		const spaceFilesToolConfig = SpaceFilesTool.createToolConfig(username);
		toolInstances[spaceFilesToolConfig.name] = server.tool(
			spaceFilesToolConfig.name,
			spaceFilesToolConfig.description,
			spaceFilesToolConfig.schema.shape,
			spaceFilesToolConfig.annotations,
			async (params: SpaceFilesParams) => {
				const spaceFilesTool = new SpaceFilesTool(hfToken, username);
				const result = await spaceFilesTool.listFiles(params);
				return {
					content: [{ type: 'text', text: result }],
				};
			}
		);

		toolInstances[USE_SPACE_TOOL_CONFIG.name] = server.tool(
			USE_SPACE_TOOL_CONFIG.name,
			USE_SPACE_TOOL_CONFIG.description,
			USE_SPACE_TOOL_CONFIG.schema.shape,
			USE_SPACE_TOOL_CONFIG.annotations,
			async (params: UseSpaceParams) => {
				const useSpaceTool = new UseSpaceTool(hfToken, undefined);
				const result = await formatUseSpaceResult(useSpaceTool, params);
				logPromptQuery(
					USE_SPACE_TOOL_CONFIG.name,
					params.space_id,
					{ space_id: params.space_id },
					{
						...getLoggingOptions(),
						totalResults: result.metadata.totalResults,
						resultsShared: result.metadata.resultsShared,
						responseCharCount: result.metadata.formatted.length,
					}
				);
				return {
					content: result.content,
				};
			}
		);

		toolInstances[HF_JOBS_TOOL_CONFIG.name] = server.tool(
			HF_JOBS_TOOL_CONFIG.name,
			HF_JOBS_TOOL_CONFIG.description,
			HF_JOBS_TOOL_CONFIG.schema.shape,
			HF_JOBS_TOOL_CONFIG.annotations,
			async (params: z.infer<typeof HF_JOBS_TOOL_CONFIG.schema>) => {
				// Jobs require authentication - check if user has token
				const isAuthenticated = !!hfToken;
				const jobsTool = new HfJobsTool(hfToken, isAuthenticated, username);
				const result = await jobsTool.execute(params);

				// Log the query with command and result metrics
				const loggedOperation = params.operation ?? 'no-operation';
				logSearchQuery(HF_JOBS_TOOL_CONFIG.name, loggedOperation, params.args || {}, {
					...getLoggingOptions(),
					totalResults: result.totalResults,
					resultsShared: result.resultsShared,
					responseCharCount: result.formatted.length,
				});

				return {
					content: [{ type: 'text', text: result.formatted }],
					...(result.isError && { isError: true }),
				};
			}
		);

		toolInstances[SPACE_TOOL_CONFIG.name] = server.tool(
			SPACE_TOOL_CONFIG.name,
			SPACE_TOOL_CONFIG.description,
			SPACE_TOOL_CONFIG.schema.shape,
			SPACE_TOOL_CONFIG.annotations,
			async (params: SpaceArgs) => {
				const spaceTool = new SpaceTool(hfToken);
				const result = await spaceTool.execute(params);

				// Log the query with operation and result metrics
				const loggedOperation = params.operation ?? 'no-operation';
				logSearchQuery(SPACE_TOOL_CONFIG.name, loggedOperation, params, {
					...getLoggingOptions(),
					totalResults: result.totalResults,
					resultsShared: result.resultsShared,
					responseCharCount: result.formatted.length,
				});

				return {
					content: [{ type: 'text', text: result.formatted }],
					...(result.isError && { isError: true }),
				};
			}
		);

		// Register Gradio widget resource for OpenAI MCP client (skybridge)
		if (sessionInfo?.clientInfo?.name === 'openai-mcp') {
			logger.debug('Registering Gradio widget resource for skybridge client');
			const widgetConfig = createGradioWidgetResourceConfig(version);
			server.registerResource(widgetConfig.name, widgetConfig.uri, {}, async () => ({
				contents: [
					{
						uri: widgetConfig.uri,
						mimeType: widgetConfig.mimeType,
						text: widgetConfig.htmlContent,
						_meta: widgetConfig.metadata,
					},
				],
			}));
		}

		// Declare the function to apply tool states (we only need to call it if we are
		// applying the tool states either because we have a Gradio tool call (grNN_) or
		// we are responding to a ListToolsRequest). This also helps if there is a
		// mismatch between Client cache state and desired states for these specific tools.
		// NB: That may not always be the case, consider carefully whether you want a tool
		// included in the skipGradio check.
		const applyToolStates = async () => {
			logger.info(
				{
					mode: toolSelection.mode,
					reason: toolSelection.reason,
					enabledCount: toolSelection.enabledToolIds.length,
					totalTools: Object.keys(toolInstances).length,
					mixedBouquet: toolSelection.mixedBouquet,
				},
				'Tool selection strategy applied'
			);

			// Apply the desired state to each tool (tools start enabled by default)
			for (const [toolName, toolInstance] of Object.entries(toolInstances)) {
				if (toolSelection.enabledToolIds.includes(toolName)) {
					toolInstance.enable();
				} else {
					toolInstance.disable();
				}
			}
		};

		// Always register capabilities consistently for stateless vs stateful modes
		const transportInfo = sharedApiClient.getTransportInfo();

		registerCapabilities(server, sharedApiClient, {
			hasResources: sessionInfo?.clientInfo?.name === 'openai-mcp',
		});

		if (!skipGradio) {
			void applyToolStates();

			if (!transportInfo?.jsonResponseEnabled && !transportInfo?.externalApiMode) {
				// Set up event listener for dynamic tool state changes
				const toolStateChangeHandler = (toolId: string, enabled: boolean) => {
					const toolInstance = toolInstances[toolId];
					if (toolInstance) {
						if (enabled) {
							toolInstance.enable();
						} else {
							toolInstance.disable();
						}
						logger.debug({ toolId, enabled }, 'Applied single tool state change');
					}
				};

				sharedApiClient.on('toolStateChange', toolStateChangeHandler);

				// Clean up event listener when server closes
				server.server.onclose = () => {
					sharedApiClient.removeListener('toolStateChange', toolStateChangeHandler);
					logger.debug('Removed toolStateChange listener for closed server');
				};
			}
		}
		return { server, userDetails };
	};
};
