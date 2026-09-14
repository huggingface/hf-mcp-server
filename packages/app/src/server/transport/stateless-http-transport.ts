import {
	BaseTransport,
	type ServerRequestContext,
	type SessionMetadata,
	type ServerFactory,
} from './base-transport.js';
import {
	createMcpHandler,
	isJSONRPCNotification,
	isLegacyRequest,
	McpServer,
	type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { logger } from '../utils/logger.js';
import type { Request, Response, Express } from 'express';
import { JsonRpcErrors, extractJsonRpcId } from './json-rpc-errors.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractQueryParamsToHeaders } from '../utils/query-params.js';
import { isBrowser } from '../utils/browser-detection.js';
import { buildOAuthResourceHeader } from '../utils/oauth-resource.js';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logSystemEvent } from '../utils/query-logger.js';
import { disabledToolCallName, disabledToolMessage } from '../utils/disabled-tools.js';
import { isClientDenied } from '../../shared/client-denylist.js';
import { getSkillCatalog } from '../skills/skill-catalog-cache.js';
import { listSkillResources, readSkillResource, readSkillDirectory } from '../skills/skill-resource-data.js';
import {
	RESOURCES_DIRECTORY_READ_METHOD,
	ResourcesDirectoryReadParamsSchema,
} from '../skills/skill-directory-schema.js';
import { SKILLS_GET_METHOD, SKILLS_LIST_METHOD } from '../skills/skill-method-schema.js';
import { getProxyToolsConfig } from '../utils/proxy-tools-config.js';
import { BOUQUET_FALLBACK } from '../../shared/settings.js';
import type { AppSettings } from '../../shared/settings.js';
import { getErrorLogFields } from '../utils/observability.js';
import { isProgressToken } from '../utils/progress-token.js';
import type { ServerDiscoverOutcome, SubscriptionMethod } from '../../shared/transport-metrics.js';
import { handleServerCardRequest, SERVER_CARD_PATH } from '../server-card.js';
import { getDirectToolCallSettings, withoutDiscoverySelectionHeaders } from '../utils/direct-tool-settings.js';
import {
	logSkillEvent,
	type SkillEventLogger,
	type SkillEventName,
	type SkillEventLoggerOptions,
} from '../utils/skill-event-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resource methods that build the full server and thus expose the Skills surface.
const RESOURCE_METHODS = new Set([
	'resources/list',
	'resources/read',
	'resources/templates/list',
	RESOURCES_DIRECTORY_READ_METHOD,
]);
const SKILL_METHODS = new Set([SKILLS_LIST_METHOD, SKILLS_GET_METHOD]);
const FULL_SERVER_METHODS = new Set(['tools/list', 'tools/call', 'initialize', ...RESOURCE_METHODS, ...SKILL_METHODS]);
// Resource-subscription methods we never support (skills are static — nothing to
// notify `resources/updated` about). Rejected cheaply before any server is built.
const UNSUPPORTED_SUBSCRIBE_METHODS = new Set(['resources/subscribe', 'resources/unsubscribe']);
const UNSUPPORTED_PROMPT_METHODS = new Set(['prompts/list', 'prompts/get']);
export const MAX_METRICS_RESPONSE_CAPTURE_BYTES = 64 * 1024;

interface JsonRpcRequestBody {
	method?: string;
	id?: string | number | null;
	params?: {
		uri?: unknown;
		cursor?: unknown;
		clientInfo?: unknown;
		capabilities?: unknown;
		protocolVersion?: unknown;
		name?: string;
		arguments?: unknown;
		notifications?: unknown;
		_meta?: Record<string, unknown>;
	};
}

export interface ClassifiedSkillRequest {
	methodName: SkillEventName;
	cursorSupplied: boolean;
	targetUri?: string;
}

interface SkillEventContext {
	clientSessionId?: string;
	requestId?: string;
	protocolEra: 'legacy' | 'modern';
	protocolVersion?: string;
	userHash?: string;
	isAuthenticated: boolean;
	clientInfo?: { name: string; version: string };
}

export function classifySkillRequest(requestBody: unknown): ClassifiedSkillRequest | null {
	if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody)) {
		return null;
	}
	const body = requestBody as JsonRpcRequestBody;
	const cursorSupplied = body.params?.cursor !== undefined;

	if (body.method === SKILLS_LIST_METHOD) {
		return { methodName: 'skills/list', cursorSupplied };
	}
	if (body.method === SKILLS_GET_METHOD) {
		return {
			methodName: 'skills/get',
			cursorSupplied: false,
			...(typeof body.params?.uri === 'string' ? { targetUri: body.params.uri } : {}),
		};
	}

	const uri = body.params?.uri;
	if (typeof uri !== 'string' || !uri.startsWith('skill://')) {
		return null;
	}
	if (body.method === 'resources/read') {
		return { methodName: 'skills/resource-read', cursorSupplied: false, targetUri: uri };
	}
	if (body.method === RESOURCES_DIRECTORY_READ_METHOD) {
		return { methodName: 'skills/directory-read', cursorSupplied, targetUri: uri };
	}
	return null;
}

interface ModernRequestData {
	headers: Record<string, string>;
	factoryHeaders: Record<string, string>;
	clientInfo?: { name: string; version: string };
	requestId: string;
	isAuthenticated: boolean;
	authenticatedUser?: ServerRequestContext['authenticatedUser'];
	useFullServer: boolean;
	skipGradio: boolean;
	discoveryOnly: boolean;
	userSettings?: AppSettings;
	protocolVersion: string;
	clientCapabilities: Record<string, unknown>;
	userHash?: string;
}

const SUBSCRIPTION_BOOLEAN_FILTER_FIELDS = ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const;
const SUBSCRIPTION_FILTER_FIELDS = new Set<string>([...SUBSCRIPTION_BOOLEAN_FILTER_FIELDS, 'resourceSubscriptions']);

function resourceSubscriptionCountBucket(length: number): string {
	if (length === 0) return '0';
	if (length === 1) return '1';
	if (length <= 10) return '2-10';
	if (length <= 100) return '11-100';
	return '101+';
}

/**
 * Produce a low-cardinality summary of subscription intent. In particular,
 * never retain resource URIs from the modern listen filter.
 */
export function summarizeSubscriptionRequest(method: SubscriptionMethod, params: unknown): string {
	if (method !== 'subscriptions/listen') {
		if (typeof params !== 'object' || params === null || Array.isArray(params) || !('uri' in params)) {
			return 'uri:missing';
		}
		return typeof params.uri === 'string' ? 'uri:present' : 'uri:invalid';
	}

	if (typeof params !== 'object' || params === null || Array.isArray(params) || !('notifications' in params)) {
		return 'notifications:missing';
	}
	const notificationValue = params.notifications;
	if (typeof notificationValue !== 'object' || notificationValue === null || Array.isArray(notificationValue)) {
		return 'notifications:invalid';
	}
	const notifications = notificationValue as Record<string, unknown>;

	const parts: string[] = [];
	for (const field of SUBSCRIPTION_BOOLEAN_FILTER_FIELDS) {
		if (!(field in notifications)) continue;
		const value = notifications[field];
		parts.push(`${field}:${typeof value === 'boolean' ? String(value) : 'invalid'}`);
	}

	if ('resourceSubscriptions' in notifications) {
		const subscriptions = notifications.resourceSubscriptions;
		if (Array.isArray(subscriptions) && subscriptions.every((uri) => typeof uri === 'string')) {
			parts.push(`resourceSubscriptions:${resourceSubscriptionCountBucket(subscriptions.length)}`);
		} else {
			parts.push('resourceSubscriptions:invalid');
		}
	}

	if (Object.keys(notifications).some((field) => !SUBSCRIPTION_FILTER_FIELDS.has(field))) {
		parts.push('unknownFields:present');
	}

	return parts.length > 0 ? `notifications:${parts.join(',')}` : 'notifications:empty';
}

export interface CapturedResponseSummary {
	isError: boolean;
	jsonRpcErrorCode?: number;
	responseItemCount?: number;
	truncated?: boolean;
}

function getResponseItemCount(result: unknown): number | undefined {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) {
		return undefined;
	}
	const record = result as Record<string, unknown>;
	for (const field of ['skills', 'resources', 'contents']) {
		const value = record[field];
		if (Array.isArray(value)) {
			return value.length;
		}
	}
	return typeof record.skill === 'object' && record.skill !== null ? 1 : undefined;
}

function inspectResponseBody(body: string): CapturedResponseSummary {
	const ssePayloads = body
		.split(/\r?\n\r?\n/u)
		.map((event) =>
			event
				.split(/\r?\n/u)
				.filter((line) => line === 'data' || line.startsWith('data:'))
				.map((line) => {
					if (line === 'data') return '';
					const value = line.slice(5);
					return value.startsWith(' ') ? value.slice(1) : value;
				})
				.join('\n')
		)
		.filter((payload) => payload.length > 0);
	const payloads = ssePayloads.length > 0 ? ssePayloads : [body];
	let isError = false;
	let jsonRpcErrorCode: number | undefined;
	let responseItemCount: number | undefined;

	for (const payload of payloads) {
		try {
			const parsed = JSON.parse(payload) as
				{ error?: unknown; result?: { isError?: unknown } } | { error?: unknown; result?: { isError?: unknown } }[];
			const responses = Array.isArray(parsed) ? parsed : [parsed];
			for (const response of responses) {
				if (response.error !== undefined) {
					isError = true;
					if (
						jsonRpcErrorCode === undefined &&
						typeof response.error === 'object' &&
						response.error !== null &&
						'code' in response.error &&
						typeof response.error.code === 'number'
					) {
						jsonRpcErrorCode = response.error.code;
					}
				}
				if (response.result?.isError === true) {
					isError = true;
				}
				responseItemCount ??= getResponseItemCount(response.result);
			}
		} catch {
			// Ignore SSE control events and malformed response fragments.
		}
	}
	return {
		isError,
		...(jsonRpcErrorCode !== undefined ? { jsonRpcErrorCode } : {}),
		...(responseItemCount !== undefined ? { responseItemCount } : {}),
	};
}

export function classifyServerDiscoverOutcome(input: {
	httpStatus: number;
	response: CapturedResponseSummary;
}): ServerDiscoverOutcome {
	const { httpStatus, response } = input;
	if (httpStatus === 401 || httpStatus === 403) return 'authRejected';
	if (response.jsonRpcErrorCode === -32603 || httpStatus >= 500) return 'internalServerError';
	if (response.jsonRpcErrorCode === -32020) return 'headerBodyMismatch';
	if (response.jsonRpcErrorCode === -32022) return 'unsupportedVersion';
	if (
		response.jsonRpcErrorCode === -32700 ||
		response.jsonRpcErrorCode === -32600 ||
		response.jsonRpcErrorCode === -32601 ||
		response.jsonRpcErrorCode === -32602 ||
		httpStatus === 400
	) {
		return 'invalidRequest';
	}
	if (response.truncated) return 'otherError';
	if (httpStatus < 200 || httpStatus >= 300 || response.isError) return 'otherError';
	return 'success';
}

export class MetricsResponseCapture {
	private readonly chunks: Buffer[] = [];
	private capturedBytes = 0;
	private truncated = false;

	add(chunk: unknown): void {
		if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return;

		const remainingBytes = MAX_METRICS_RESPONSE_CAPTURE_BYTES - this.capturedBytes;
		if (remainingBytes <= 0) {
			this.truncated = true;
			return;
		}

		if (typeof chunk === 'string') {
			const candidate = Buffer.from(chunk.slice(0, remainingBytes));
			const captured = candidate.subarray(0, remainingBytes);
			if (captured.length > 0) {
				this.chunks.push(Buffer.from(captured));
				this.capturedBytes += captured.length;
			}
			if (chunk.length > remainingBytes || candidate.length > remainingBytes) {
				this.truncated = true;
			}
			return;
		}

		const captured = chunk.subarray(0, remainingBytes);
		if (captured.length > 0) {
			this.chunks.push(Buffer.from(captured));
			this.capturedBytes += captured.length;
		}
		if (chunk.length > remainingBytes) {
			this.truncated = true;
		}
	}

	isError(): boolean {
		return this.summary().isError;
	}

	summary(): CapturedResponseSummary {
		if (this.truncated) return { isError: false, truncated: true };
		return inspectResponseBody(Buffer.concat(this.chunks, this.capturedBytes).toString('utf8'));
	}
}

/**
 * Stateless HTTP JSON transport implementation
 * Creates a new server AND transport instance for each request to ensure complete isolation
 *
 * In analytics mode (ANALYTICS_MODE=true), maintains session tracking for analytics purposes
 * without affecting the stateless nature of request processing
 */
export class StatelessHttpTransport extends BaseTransport {
	private readonly analyticsMode: boolean;
	private analyticsSessions: Map<string, SessionMetadata> = new Map();
	private readonly tempLogMax: number;
	private tempLogCounter: number = 0;
	private tempLogOriginalCount: number = 0;
	private readonly modernRequestStorage = new AsyncLocalStorage<ModernRequestData>();
	private modernHandler?: McpHttpHandler;
	private modernNodeHandler?: ReturnType<typeof toNodeHandler>;
	private readonly skillEventLogger: SkillEventLogger;

	private trackSubscriptionAttempt(
		method: SubscriptionMethod,
		protocolEra: 'legacy' | 'modern',
		protocolVersion: string,
		params: unknown,
		clientInfo?: { name: string; version: string }
	): void {
		this.metrics.trackSubscriptionAttempt({
			method,
			protocolEra,
			protocolVersion,
			clientName: clientInfo?.name,
			clientVersion: clientInfo?.version,
			requestShape: summarizeSubscriptionRequest(method, params),
		});
	}

	constructor(serverFactory: ServerFactory, app: Express, skillEventLogger: SkillEventLogger = logSkillEvent) {
		super(serverFactory, app);
		this.skillEventLogger = skillEventLogger;
		this.analyticsMode = process.env.ANALYTICS_MODE === 'true';
		this.tempLogMax = parseInt(process.env.TEMPLOG_MAX || '0', 10);

		if (this.analyticsMode) {
			logger.info('Analytics mode enabled for stateless HTTP transport.');
		}

		if (this.tempLogMax > 0) {
			logger.info(`Temporary logging available with max count: ${this.tempLogMax}`);
		}
	}

	private recordSkillEvent(
		requestBody: JsonRpcRequestBody | undefined,
		startTime: number,
		success: boolean,
		context: SkillEventContext,
		responseItemCount?: number
	): void {
		const classified = classifySkillRequest(requestBody);
		if (!classified) return;

		const options: SkillEventLoggerOptions = {
			clientSessionId: context.clientSessionId,
			requestId: context.requestId,
			protocolEra: context.protocolEra,
			protocolVersion: context.protocolVersion,
			userHash: context.userHash,
			isAuthenticated: context.isAuthenticated,
			clientName: context.clientInfo?.name,
			clientVersion: context.clientInfo?.version,
			durationMs: Date.now() - startTime,
			success,
			cursorSupplied: classified.cursorSupplied,
			targetUri: classified.targetUri,
			responseItemCount,
		};

		try {
			this.skillEventLogger(classified.methodName, options);
		} catch (error) {
			logger.warn({ error, methodName: classified.methodName }, 'Failed to record Skills protocol event');
		}
	}

	/**
	 * Determines if a request should be handled by the full server
	 * or can be handled by the stub responder
	 */
	private shouldHandle(requestBody: unknown, clientName?: string, userAgent?: string): boolean {
		const body = requestBody as { method?: string } | undefined;
		const method = body?.method;

		if (method && FULL_SERVER_METHODS.has(method)) {
			// Denied clients (e.g. cursor-vscode flooding the resource surface) get no
			// resources: route their resource list/read to the stub responder so the
			// full Skills server is never built for them.
			if ((RESOURCE_METHODS.has(method) || SKILL_METHODS.has(method)) && isClientDenied(clientName, userAgent)) {
				return false;
			}
			return true;
		}

		// All other requests can be handled by stub responder
		return false;
	}

	private requestsProgress(requestBody: unknown): boolean {
		const body = requestBody as { method?: unknown; params?: { _meta?: { progressToken?: unknown } } } | undefined;
		const token = body?.params?._meta?.progressToken;
		return body?.method === 'tools/call' && isProgressToken(token);
	}

	private hasProxyAppResources(): boolean {
		return getProxyToolsConfig().some((config) => {
			const ui = config.meta?.ui;
			return (
				typeof ui === 'object' &&
				ui !== null &&
				'resourceUri' in ui &&
				typeof ui.resourceUri === 'string' &&
				ui.resourceUri.startsWith('ui://')
			);
		});
	}

	private async tryHandleStaticResourceRequest(
		req: Request,
		res: Response,
		requestBody: JsonRpcRequestBody | undefined,
		clientInfo: { name: string; version: string } | undefined,
		startTime: number,
		eventContext: SkillEventContext
	): Promise<boolean> {
		const method = requestBody?.method;
		if (!method || !RESOURCE_METHODS.has(method)) return false;

		// Resource discovery must include dynamic Gradio MCP Apps.
		if (method === 'resources/list' || method === 'resources/templates/list') return false;

		// Preserve the full server path for resource surfaces that are not purely static skills.
		if (this.hasProxyAppResources()) return false;
		if (isClientDenied(clientInfo?.name, req.headers['user-agent'])) return false;

		const catalog = await getSkillCatalog();
		if (!catalog?.entries.length) return false;

		const id = extractJsonRpcId(req.body);

		if (method === 'resources/list') {
			res.status(200).json({
				jsonrpc: '2.0',
				id,
				result: {
					resources: listSkillResources(catalog),
				},
			});
			this.trackMethodCall('resources/list', startTime, false, clientInfo);
			return true;
		}

		if (method === 'resources/templates/list') {
			res.status(200).json({
				jsonrpc: '2.0',
				id,
				result: {
					resourceTemplates: [],
				},
			});
			this.trackMethodCall('resources/templates/list', startTime, false, clientInfo);
			return true;
		}

		const uri = requestBody?.params?.uri;
		if (method === 'resources/read' && typeof uri === 'string' && uri.startsWith('skill://')) {
			const content = await readSkillResource(catalog, uri);
			if (!content) {
				res.status(200).json(JsonRpcErrors.invalidParams(`Unknown resource URI: ${uri}`, id));
				this.trackMethodCall('resources/read', startTime, true, clientInfo);
				this.recordSkillEvent(requestBody, startTime, false, eventContext);
				return true;
			}

			res.status(200).json({
				jsonrpc: '2.0',
				id,
				result: {
					contents: [content],
				},
			});
			this.trackMethodCall('resources/read', startTime, false, clientInfo);
			this.recordSkillEvent(requestBody, startTime, true, eventContext, 1);
			return true;
		}

		if (method === RESOURCES_DIRECTORY_READ_METHOD && typeof uri === 'string' && uri.startsWith('skill://')) {
			const parsedParams = ResourcesDirectoryReadParamsSchema.safeParse(requestBody.params);
			if (!parsedParams.success) return false;
			const { cursor } = parsedParams.data;
			const listing = readSkillDirectory(catalog, uri, cursor);
			if (!listing) {
				res.status(200).json(JsonRpcErrors.invalidParams(`Not a directory resource: ${uri}`, id));
				this.trackMethodCall(RESOURCES_DIRECTORY_READ_METHOD, startTime, true, clientInfo);
				this.recordSkillEvent(requestBody, startTime, false, eventContext);
				return true;
			}

			res.status(200).json({
				jsonrpc: '2.0',
				id,
				result: listing,
			});
			this.trackMethodCall(RESOURCES_DIRECTORY_READ_METHOD, startTime, false, clientInfo);
			this.recordSkillEvent(requestBody, startTime, true, eventContext, listing.resources.length);
			return true;
		}

		return false;
	}

	private extractModernClientInfo(
		requestBody: JsonRpcRequestBody | undefined
	): { name: string; version: string } | undefined {
		const clientInfo = requestBody?.params?._meta?.['io.modelcontextprotocol/clientInfo'];
		if (typeof clientInfo !== 'object' || clientInfo === null) return undefined;

		const { name, version } = clientInfo as { name?: unknown; version?: unknown };
		return typeof name === 'string' && typeof version === 'string' ? { name, version } : undefined;
	}

	private extractModernProtocolVersion(requestBody: JsonRpcRequestBody | undefined): string {
		const version = requestBody?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
		return typeof version === 'string' ? version : 'unknown';
	}

	private extractModernClientCapabilities(requestBody: JsonRpcRequestBody | undefined): Record<string, unknown> {
		const capabilities = requestBody?.params?._meta?.['io.modelcontextprotocol/clientCapabilities'];
		return typeof capabilities === 'object' && capabilities !== null && !Array.isArray(capabilities)
			? (capabilities as Record<string, unknown>)
			: {};
	}

	private toWebRequest(req: Request): globalThis.Request {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (Array.isArray(value)) {
				for (const item of value) headers.append(name, item);
			} else if (value !== undefined) {
				headers.set(name, value);
			}
		}

		const host = req.get('host') || 'localhost';
		return new globalThis.Request(`${req.protocol}://${host}${req.originalUrl}`, {
			method: req.method,
			headers,
			body: JSON.stringify(req.body),
		});
	}

	private setupModernHandler(): void {
		this.modernHandler = createMcpHandler(
			async () => {
				const requestData = this.modernRequestStorage.getStore();
				if (!requestData) {
					throw new Error('Modern MCP server factory called outside a request context');
				}

				if (!requestData.useFullServer) {
					return new McpServer({ name: '@huggingface/internal-responder', version: '0.0.1' });
				}

				const result = await this.serverFactory(
					requestData.factoryHeaders,
					requestData.discoveryOnly ? BOUQUET_FALLBACK : requestData.userSettings,
					requestData.skipGradio,
					{
						requestId: requestData.requestId,
						isAuthenticated: requestData.isAuthenticated,
						clientInfo: requestData.clientInfo,
						authenticatedUser: requestData.authenticatedUser,
						protocolEra: 'modern',
						protocolVersion: requestData.protocolVersion,
						clientCapabilities: requestData.clientCapabilities,
						userHash: requestData.userHash,
					}
				);
				result.server.server.onerror = (error) => {
					this.trackError(undefined, error);
					logger.error(
						{
							...getErrorLogFields(error),
							requestId: requestData.requestId,
							protocolEra: 'modern',
							protocolVersion: requestData.protocolVersion,
							clientName: requestData.clientInfo?.name,
							clientVersion: requestData.clientInfo?.version,
						},
						'Modern HTTP MCP server error'
					);
				};
				return result.server;
			},
			{
				legacy: 'reject',
				responseMode: 'auto',
				// This deployment does not publish subscription notifications, so
				// refuse listen streams through the SDK's pre-ack capacity guard.
				maxSubscriptions: 0,
				onerror: (error) => {
					const requestData = this.modernRequestStorage.getStore();
					logger.error(
						{
							...getErrorLogFields(error),
							requestId: requestData?.requestId,
							protocolEra: 'modern',
							protocolVersion: requestData?.protocolVersion,
							clientName: requestData?.clientInfo?.name,
							clientVersion: requestData?.clientInfo?.version,
						},
						'Modern HTTP MCP handler error'
					);
				},
			}
		);
		this.modernNodeHandler = toNodeHandler(this.modernHandler);
	}

	override initialize(): Promise<void> {
		this.setupModernHandler();

		this.app.get(SERVER_CARD_PATH, handleServerCardRequest);

		this.app.post('/mcp', async (req: Request, res: Response) => {
			this.trackRequest();
			const legacy = await isLegacyRequest(this.toWebRequest(req));
			if (legacy) {
				await this.handleJsonRpcRequest(req, res);
			} else {
				await this.handleModernRequest(req, res);
			}
		});

		// Serve the MCP welcome page on GET requests (or 405 if strict compliance is enabled)
		this.app.get('/mcp', async (req: Request, res: Response) => {
			if (!(await this.validateSuppliedAuth(req, res))) return;
			// Check for strict compliance mode or non-browser client
			if (process.env.MCP_STRICT_COMPLIANCE === 'true' || !isBrowser(req.headers)) {
				this.metrics.trackStaticPageHit(405);
				logger.debug('Rejected GET request to /mcp in strict compliance mode or from non-browser client');
				res
					.status(405)
					.json(JsonRpcErrors.methodNotAllowed(null, 'Method not allowed. Use POST for stateless JSON-RPC requests.'));
				return;
			}

			// Check if the request is not secure and redirect to HTTPS (skip for localhost)
			const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
			const host = req.get('host') || '';
			const isLocalhost =
				host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:');
			if (!isSecure && !isLocalhost) {
				const httpsUrl = `https://${host}${req.originalUrl}`;
				logger.debug(`Redirecting insecure request to HTTPS: ${httpsUrl}`);
				res.redirect(301, httpsUrl);
				return;
			}

			// Track successful static page hit
			this.metrics.trackStaticPageHit(200);

			// Serve the MCP welcome page (always serve the self-contained version)
			const mcpWelcomePath = path.join(__dirname, '..', '..', 'web', 'mcp-welcome.html');
			res.sendFile(mcpWelcomePath);
		});

		// Handle DELETE requests for analytics tracking
		this.app.delete('/mcp', async (req: Request, res: Response) => {
			this.trackRequest();
			if (!(await this.validateSuppliedAuth(req, res))) return;
			await this.handleDeleteRequest(req, res);
		});

		logger.info('HTTP JSON transport initialized (stateless mode)');
		return Promise.resolve();
	}

	private async validateSuppliedAuth(req: Request, res: Response): Promise<boolean> {
		if (req.headers.authorization === undefined) return true;
		const auth = await this.validateAuthAndTrackMetrics(req.headers as Record<string, string>);
		if (auth.shouldContinue) return true;
		this.sendAuthFailure(req, res, auth.statusCode ?? 401);
		return false;
	}

	private sendAuthFailure(req: Request, res: Response, status: number): void {
		if (status !== 503) {
			const challenge = status === 403 ? ', error="insufficient_scope", scope="read-mcp"' : '';
			res.set('WWW-Authenticate', buildOAuthResourceHeader(req) + challenge);
		}
		res
			.status(status)
			.send(
				status === 503
					? 'Authentication service unavailable'
					: status === 403
						? 'Insufficient OAuth scope: read-mcp required'
						: 'Unauthorized'
			);
	}

	private async handleModernRequest(req: Request, res: Response): Promise<void> {
		const startTime = Date.now();
		const requestId = randomUUID();
		const headers = req.headers as Record<string, string>;
		extractQueryParamsToHeaders(req, headers);

		const requestBody = req.body as JsonRpcRequestBody | undefined;
		const trackingName = this.extractMethodForTracking(requestBody);
		const clientInfo = this.extractModernClientInfo(requestBody);
		const protocolVersion = this.extractModernProtocolVersion(requestBody);
		const clientCapabilities = this.extractModernClientCapabilities(requestBody);
		const ipAddress = this.extractIpAddress(req.headers, req.ip);
		const isServerDiscover = requestBody?.method === 'server/discover';
		let serverDiscoverOutcomeTracked = false;
		const trackServerDiscoverOutcome = (outcome: ServerDiscoverOutcome): void => {
			if (!isServerDiscover || serverDiscoverOutcomeTracked) return;
			this.metrics.trackServerDiscoverOutcome(outcome);
			serverDiscoverOutcomeTracked = true;
		};

		this.trackIpAddress(ipAddress);
		this.trackProtocolRequest('modern', protocolVersion);
		if (requestBody?.method === 'subscriptions/listen') {
			this.trackSubscriptionAttempt('subscriptions/listen', 'modern', protocolVersion, requestBody.params, clientInfo);
		}

		const authResult = await this.validateAuthAndTrackMetrics(headers);
		if (!authResult.shouldContinue) {
			trackServerDiscoverOutcome('authRejected');
			this.recordSkillEvent(requestBody, startTime, false, {
				requestId,
				protocolEra: 'modern',
				protocolVersion,
				isAuthenticated: false,
				clientInfo,
			});
			this.sendAuthFailure(req, res, authResult.statusCode ?? 401);
			return;
		}

		const disabledTool = disabledToolCallName(requestBody);
		if (disabledTool) {
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
			res.status(200).json(JsonRpcErrors.invalidParams(disabledToolMessage(disabledTool), extractJsonRpcId(req.body)));
			return;
		}

		this.trackNewConnection();
		if (clientInfo) {
			// Modern HTTP is request-scoped. Mark the identity connected only
			// while this exchange is active instead of manufacturing a session.
			this.associateSessionWithClient(clientInfo);
			this.updateClientActivity(clientInfo);
			this.trackClientIpAddress(ipAddress, clientInfo);
			this.trackClientAuth(headers['authorization']?.replace(/^Bearer\s+/i, ''), clientInfo);
			this.trackClientProtocol(clientInfo, 'modern', protocolVersion);
		}
		const userHash = this.trackAuthenticatedUser(
			authResult.authenticatedUser?.name,
			'modern',
			protocolVersion,
			clientInfo
		);
		this.trackProtocolToolCall(trackingName, 'modern', protocolVersion, clientInfo);

		if (isServerDiscover) {
			logSystemEvent('server_discover', requestId, {
				requestId,
				protocolEra: 'modern',
				protocolVersion,
				userHash,
				isAuthenticated: authResult.userIdentified,
				clientName: clientInfo?.name,
				clientVersion: clientInfo?.version,
				requestJson: requestBody.params || {},
				capabilities: clientCapabilities,
				ipAddress,
			});
		}

		const useFullServer = isServerDiscover || this.shouldHandle(requestBody, clientInfo?.name, headers['user-agent']);
		const userSettings = isServerDiscover ? undefined : getDirectToolCallSettings(requestBody, headers);
		const skipGradio = isServerDiscover || userSettings !== undefined || this.skipGradioSetup(requestBody);
		const factoryHeaders = userSettings !== undefined ? withoutDiscoverySelectionHeaders(headers) : headers;
		const requestData: ModernRequestData = {
			headers,
			factoryHeaders,
			clientInfo,
			requestId,
			isAuthenticated: authResult.userIdentified,
			authenticatedUser: authResult.authenticatedUser,
			useFullServer,
			skipGradio,
			discoveryOnly: isServerDiscover,
			userSettings,
			protocolVersion,
			clientCapabilities,
			userHash,
		};

		const responseCapture = new MetricsResponseCapture();
		const originalWrite = res.write;
		const originalEnd = res.end;
		res.write = ((chunk: unknown, ...args: unknown[]) => {
			responseCapture.add(chunk);
			return Reflect.apply(originalWrite, res, [chunk, ...args]) as boolean;
		}) as typeof res.write;
		res.end = ((chunk?: unknown, ...args: unknown[]) => {
			responseCapture.add(chunk);
			return Reflect.apply(originalEnd, res, [chunk, ...args]) as Response;
		}) as typeof res.end;

		try {
			if (!this.modernNodeHandler) {
				throw new Error('Modern MCP handler is not initialized');
			}
			await this.modernRequestStorage.run(requestData, async () => {
				await this.modernNodeHandler?.(req, res, req.body);
			});

			const responseSummary = responseCapture.summary();
			const responseIsError = res.statusCode >= 400 || responseSummary.isError || responseSummary.truncated === true;
			this.trackMethodCall(trackingName, startTime, responseIsError, clientInfo);
			this.recordSkillEvent(
				requestBody,
				startTime,
				res.statusCode < 400 && !responseSummary.isError,
				{
					requestId,
					protocolEra: 'modern',
					protocolVersion,
					userHash,
					isAuthenticated: authResult.userIdentified,
					clientInfo,
				},
				responseSummary.responseItemCount
			);
			trackServerDiscoverOutcome(
				classifyServerDiscoverOutcome({
					httpStatus: res.statusCode,
					response: responseSummary,
				})
			);
			if (res.statusCode >= 400) {
				this.trackError(res.statusCode);
			}

			logger.debug(
				{
					duration: Date.now() - startTime,
					method: trackingName,
					protocolEra: 'modern',
					requestId,
					handledBy: useFullServer ? 'full' : 'stub',
				},
				'Modern MCP request completed'
			);
		} catch (error) {
			trackServerDiscoverOutcome('internalServerError');
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
			this.recordSkillEvent(requestBody, startTime, false, {
				requestId,
				protocolEra: 'modern',
				protocolVersion,
				userHash,
				isAuthenticated: authResult.userIdentified,
				clientInfo,
			});
			this.trackError(500, error instanceof Error ? error : new Error(String(error)));
			logger.error({ error, method: trackingName, requestId }, 'Error handling modern MCP request');
			if (!res.headersSent) {
				res.status(500).json(JsonRpcErrors.internalError(extractJsonRpcId(req.body)));
			}
		} finally {
			res.write = originalWrite;
			res.end = originalEnd;
			if (clientInfo) {
				this.metrics.disconnectClient(clientInfo);
			}
		}
	}

	private async handleJsonRpcRequest(req: Request, res: Response): Promise<void> {
		const startTime = Date.now();
		let server: McpServer | null = null;
		let transport: NodeStreamableHTTPServerTransport | null = null;
		let sessionId: string | undefined;

		// Check HF token validity if present
		const headers = req.headers as Record<string, string>;
		extractQueryParamsToHeaders(req, headers);

		// Extract IP address for tracking
		const ipAddress = this.extractIpAddress(req.headers, req.ip);
		this.trackIpAddress(ipAddress);

		// Extract method name for tracking using shared utility
		const requestBody = req.body as JsonRpcRequestBody | undefined;

		const trackingName = this.extractMethodForTracking(requestBody);
		const requestSessionId = headers['mcp-session-id'];
		sessionId = typeof requestSessionId === 'string' ? requestSessionId : undefined;
		const existingSession =
			typeof requestSessionId === 'string' ? this.analyticsSessions.get(requestSessionId) : undefined;
		const requestedProtocolVersion = requestBody?.params?.protocolVersion;
		const protocolVersion =
			(typeof requestedProtocolVersion === 'string' ? requestedProtocolVersion : undefined) ??
			headers['mcp-protocol-version'] ??
			existingSession?.protocolVersion ??
			'unknown';
		const sentCapabilities = requestBody?.params?.capabilities;
		const clientCapabilities =
			typeof sentCapabilities === 'object' && sentCapabilities !== null && !Array.isArray(sentCapabilities)
				? (sentCapabilities as Record<string, unknown>)
				: (existingSession?.clientCapabilities ?? {});
		this.trackProtocolRequest('legacy', protocolVersion);

		const authResult = await this.validateAuthAndTrackMetrics(headers);
		if (!authResult.shouldContinue) {
			this.recordSkillEvent(requestBody, startTime, false, {
				clientSessionId: typeof requestSessionId === 'string' ? requestSessionId : undefined,
				protocolEra: 'legacy',
				protocolVersion,
				isAuthenticated: false,
				clientInfo: existingSession?.clientInfo,
			});
			this.sendAuthFailure(req, res, authResult.statusCode ?? 401);
			return;
		}

		// Resource subscriptions are never supported (skills are static). Reject these
		// cheaply before building any server — cursor-vscode floods `resources/subscribe`.
		const rpcMethod = requestBody?.method;
		if (rpcMethod && UNSUPPORTED_SUBSCRIBE_METHODS.has(rpcMethod)) {
			const earlySessionId = headers['mcp-session-id'];
			const earlyClientInfo =
				this.extractClientInfoFromRequest(requestBody) ??
				(typeof earlySessionId === 'string' ? this.analyticsSessions.get(earlySessionId)?.clientInfo : undefined);

			this.trackSubscriptionAttempt(
				rpcMethod as 'resources/subscribe' | 'resources/unsubscribe',
				'legacy',
				protocolVersion,
				requestBody?.params,
				earlyClientInfo
			);
			this.trackMethodCall(trackingName, startTime, true, earlyClientInfo);
			res.status(200).json(JsonRpcErrors.methodNotFound(extractJsonRpcId(req.body), `${rpcMethod} is not supported`));
			return;
		}

		const protocolClientInfo = this.extractClientInfoFromRequest(requestBody) ?? existingSession?.clientInfo;
		const userHash = this.trackAuthenticatedUser(
			authResult.authenticatedUser?.name,
			'legacy',
			protocolVersion,
			protocolClientInfo
		);
		if (requestBody?.method !== 'initialize' && protocolClientInfo) {
			this.updateClientActivity(protocolClientInfo);
			this.trackClientProtocol(protocolClientInfo, 'legacy', protocolVersion);
		}
		this.trackProtocolToolCall(trackingName, 'legacy', protocolVersion, protocolClientInfo);

		if (rpcMethod && UNSUPPORTED_PROMPT_METHODS.has(rpcMethod)) {
			const promptSessionId = headers['mcp-session-id'];
			const clientInfo =
				this.extractClientInfoFromRequest(requestBody) ??
				(typeof promptSessionId === 'string' ? this.analyticsSessions.get(promptSessionId)?.clientInfo : undefined);
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
			res.status(200).json(JsonRpcErrors.methodNotFound(extractJsonRpcId(req.body), `${rpcMethod} is not supported`));
			return;
		}

		const disabledTool = disabledToolCallName(requestBody);
		if (disabledTool) {
			const disabledSessionId = headers['mcp-session-id'];
			const clientInfo =
				this.extractClientInfoFromRequest(requestBody) ??
				(typeof disabledSessionId === 'string' ? this.analyticsSessions.get(disabledSessionId)?.clientInfo : undefined);
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
			res.status(200).json(JsonRpcErrors.invalidParams(disabledToolMessage(disabledTool), extractJsonRpcId(req.body)));
			return;
		}
		const directToolSettings = getDirectToolCallSettings(requestBody, headers);
		const factoryHeaders = directToolSettings !== undefined ? withoutDiscoverySelectionHeaders(headers) : headers;

		// Analytics mode session tracking
		if (this.analyticsMode) {
			sessionId = headers['mcp-session-id'];
			// Handle session creation/resumption
			if (requestBody?.method === 'initialize') {
				// Create new session
				sessionId = randomUUID();
				this.createAnalyticsSession(
					sessionId,
					authResult.userIdentified,
					ipAddress,
					protocolVersion,
					clientCapabilities,
					userHash
				);

				// Add session ID to response headers
				res.setHeader('Mcp-Session-Id', sessionId);

				// Log initialize event
				const initClientInfo = this.extractClientInfoFromRequest(requestBody);
				logSystemEvent('initialize', sessionId, {
					clientSessionId: sessionId,
					protocolEra: 'legacy',
					protocolVersion,
					userHash,
					isAuthenticated: authResult.userIdentified,
					clientName: initClientInfo?.name,
					clientVersion: initClientInfo?.version,
					requestJson: requestBody.params || '{}',
					capabilities: requestBody?.params?.capabilities,
					ipAddress,
				});
			} else if (sessionId) {
				// Try to resume existing session
				if (this.analyticsSessions.has(sessionId)) {
					this.updateAnalyticsSessionActivity(sessionId);
				} else {
					// Session not found - track failed resumption and return 404
					this.metrics.trackSessionResumeFailed();
					this.trackError(404);

					// Log details if temp logging is active
					if (this.tempLogCounter > 0) {
						const logNumber = this.tempLogOriginalCount - this.tempLogCounter + 1;

						// Redact HF token if present - show only last 5 chars
						let hfTokenInfo: string | undefined;
						const hfToken = headers['authorization'] || headers['hf-token'] || headers['x-hf-token'];
						if (hfToken) {
							const tokenStr = hfToken.replace(/^Bearer\s+/i, '');
							if (tokenStr.length > 5) {
								hfTokenInfo = `[REDACTED]...${tokenStr.slice(-5)}`;
							} else {
								hfTokenInfo = '[PRESENT BUT TOO SHORT]';
							}
						}

						console.log(`[TEMPLOG ${logNumber}/${this.tempLogOriginalCount}] Session Resume Failed:`, {
							sessionId: sessionId,
							timestamp: new Date().toISOString(),
							headers: {
								userAgent: headers['user-agent'],
								clientSessionId: headers['mcp-session-id'],
								xForwardedFor: headers['x-forwarded-for'],
								origin: headers['origin'],
								referer: headers['referer'],
								hfToken: hfTokenInfo || '[NOT PRESENT]',
							},
							method: requestBody?.method,
							clientInfo: requestBody?.params?.clientInfo,
							sessionExisted: false,
							activeSessionCount: this.analyticsSessions.size,
						});
						this.tempLogCounter--;

						if (this.tempLogCounter === 0) {
							logger.info('Temporary logging completed - auto-disabled');
						}
					}

					logger.debug({ sessionId }, 'Analytics session not found for resumption');
					this.recordSkillEvent(requestBody, startTime, false, {
						clientSessionId: sessionId,
						protocolEra: 'legacy',
						protocolVersion,
						userHash,
						isAuthenticated: authResult.userIdentified,
						clientInfo: protocolClientInfo,
					});
					res.status(404).json(JsonRpcErrors.sessionNotFound(sessionId, extractJsonRpcId(req.body)));
					return;
				}
			} else {
				// No session ID provided for non-initialize request - return 400
				this.trackError(400);
				logger.debug('Missing session ID for non-initialize request in analytics mode');
				this.recordSkillEvent(requestBody, startTime, false, {
					protocolEra: 'legacy',
					protocolVersion,
					userHash,
					isAuthenticated: authResult.userIdentified,
					clientInfo: protocolClientInfo,
				});
				res.status(400).json(JsonRpcErrors.invalidRequest(extractJsonRpcId(req.body), 'Session ID required'));
				return;
			}
		}

		// Track new connection for metrics (each request is a "connection" in stateless mode)
		this.trackNewConnection();

		if (isJSONRPCNotification(req.body)) {
			// For notifications, try to get client info from analytics session
			const analyticsSession = sessionId ? this.analyticsSessions.get(sessionId) : undefined;
			const clientInfo = analyticsSession?.clientInfo;
			this.trackMethodCall(trackingName, startTime, false, clientInfo);
			this.recordSkillEvent(requestBody, startTime, false, {
				clientSessionId: sessionId,
				protocolEra: 'legacy',
				protocolVersion,
				userHash,
				isAuthenticated: analyticsSession?.isAuthenticated ?? authResult.userIdentified,
				clientInfo: clientInfo ?? protocolClientInfo,
			});
			res.status(202).json({ jsonrpc: '2.0', result: null });
			return;
		}

		try {
			// Track client info for initialize requests
			const extractedClientInfo = this.extractClientInfoFromRequest(requestBody);
			if (extractedClientInfo) {
				this.associateSessionWithClient(extractedClientInfo);
				this.updateClientActivity(extractedClientInfo);

				// Track IP address for this client
				this.trackClientIpAddress(ipAddress, extractedClientInfo);

				// Track auth status for this client
				const authToken = headers['authorization']?.replace(/^Bearer\s+/i, '');
				this.trackClientAuth(authToken, extractedClientInfo);

				// Update analytics session with client info
				if (this.analyticsMode && sessionId) {
					this.updateAnalyticsSessionClientInfo(sessionId, extractedClientInfo);
				}

				logger.debug(
					{
						clientInfo: requestBody?.params?.clientInfo,
						capabilities: requestBody?.params?.capabilities,
					},
					'Initialize request received'
				);
			}

			// Get session metadata for query logging
			const isAuthenticated = authResult.userIdentified;
			const analyticsSession = sessionId ? this.analyticsSessions.get(sessionId) : undefined;

			// For initialize requests, get client info directly from the request
			let clientInfo = analyticsSession?.clientInfo;
			if (extractedClientInfo) {
				clientInfo = extractedClientInfo;
			}
			if (requestBody?.method === 'initialize' && clientInfo) {
				this.trackClientProtocol(clientInfo, 'legacy', protocolVersion);
				this.trackAuthenticatedUser(authResult.authenticatedUser?.name, 'legacy', protocolVersion, clientInfo);
			}

			if (
				await this.tryHandleStaticResourceRequest(req, res, requestBody, clientInfo, startTime, {
					clientSessionId: sessionId,
					protocolEra: 'legacy',
					protocolVersion,
					userHash,
					isAuthenticated: analyticsSession?.isAuthenticated ?? isAuthenticated,
					clientInfo,
				})
			) {
				return;
			}

			// Determine which server to use, passing client name + user-agent for resource method filtering
			const useFullServer = this.shouldHandle(requestBody, clientInfo?.name, headers['user-agent']);
			if (useFullServer) {
				// Create new server instance using factory with request headers and bouquet
				// Skip Gradio endpoints for initialize requests or non-Gradio tool calls
				const skipGradio = directToolSettings !== undefined || this.skipGradioSetup(requestBody);

				// Pass session info to server factory for query logging
				const sessionInfoForLogging = {
					clientSessionId: sessionId,
					protocolEra: 'legacy' as const,
					protocolVersion,
					clientCapabilities,
					userHash,
					isAuthenticated: analyticsSession?.isAuthenticated ?? isAuthenticated,
					clientInfo,
					authenticatedUser: authResult.authenticatedUser,
				};
				const result = await this.serverFactory(factoryHeaders, directToolSettings, skipGradio, sessionInfoForLogging);
				server = result.server;
			} else {
				// Create fresh stub responder for simple requests
				server = new McpServer({ name: '@huggingface/internal-responder', version: '0.0.1' });
			}

			// Create new transport instance for this request
			transport = new NodeStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: !this.requestsProgress(requestBody),
			});

			// Setup cleanup handlers - only cleanup on client disconnect
			const cleanup = async () => {
				if (transport) {
					await transport.close().catch((err: unknown) => {
						logger.warn({ error: err }, 'Error closing transport');
					});
				}
				if (server) {
					await server.close().catch((err: unknown) => {
						logger.warn({ error: err }, 'Error closing server');
					});
				}
			};

			// Only cleanup on early client disconnect
			res.on('close', () => {
				logger.debug('Client disconnected');
				void cleanup();
			});

			// Set up error tracking for server errors
			server.server.onerror = (error) => {
				this.trackError(undefined, error);
				logger.error({ error }, 'Stateless HTTP server error');
			};

			// Connect and handle
			await server.connect(transport);

			const responseCapture = new MetricsResponseCapture();
			const originalWrite = res.write;
			const originalEnd = res.end;
			res.write = ((chunk: unknown, ...args: unknown[]) => {
				responseCapture.add(chunk);
				return Reflect.apply(originalWrite, res, [chunk, ...args]) as boolean;
			}) as typeof res.write;
			res.end = ((chunk?: unknown, ...args: unknown[]) => {
				responseCapture.add(chunk);
				return Reflect.apply(originalEnd, res, [chunk, ...args]) as Response;
			}) as typeof res.end;
			try {
				await transport.handleRequest(req, res, req.body);
			} finally {
				res.write = originalWrite;
				res.end = originalEnd;
			}

			const responseSummary = responseCapture.summary();
			const responseIsError = responseSummary.isError;
			this.trackMethodCall(trackingName, startTime, responseIsError, clientInfo);
			this.recordSkillEvent(
				requestBody,
				startTime,
				!responseIsError,
				{
					clientSessionId: sessionId,
					protocolEra: 'legacy',
					protocolVersion,
					userHash,
					isAuthenticated: analyticsSession?.isAuthenticated ?? isAuthenticated,
					clientInfo,
				},
				responseSummary.responseItemCount
			);

			logger.debug(
				{
					duration: Date.now() - startTime,
					method: trackingName,
					handledBy: useFullServer ? 'full' : 'stub',
				},
				'Request completed'
			);
		} catch (error) {
			// Extract more error information for better debugging
			const errorInfo = {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				name: error instanceof Error ? error.name : undefined,
				...(error && typeof error === 'object' ? error : {}),
			};

			logger.error(
				{
					error: errorInfo,
					method: trackingName,
					requestBody: requestBody?.method,
					headers: Object.keys(headers),
				},
				'Error handling request'
			);

			// Track failed method call - try to get client info from analytics session
			const analyticsSession = sessionId ? this.analyticsSessions.get(sessionId) : undefined;
			const clientInfo = analyticsSession?.clientInfo;
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
			this.recordSkillEvent(requestBody, startTime, false, {
				clientSessionId: sessionId,
				protocolEra: 'legacy',
				protocolVersion,
				userHash,
				isAuthenticated: analyticsSession?.isAuthenticated ?? authResult.userIdentified,
				clientInfo: clientInfo ?? protocolClientInfo,
			});

			this.trackError(500, error instanceof Error ? error : new Error(String(error)));

			// Ensure cleanup on error
			if (transport) {
				await transport.close().catch(() => {
					// Ignore cleanup errors during error handling
				});
			}
			if (server) {
				await server.close().catch(() => {
					// Ignore cleanup errors during error handling
				});
			}

			if (!res.headersSent) {
				const id = extractJsonRpcId(req.body as unknown);
				res.status(500).json(JsonRpcErrors.internalError(id));
			}
		}
	}

	private async handleDeleteRequest(req: Request, res: Response): Promise<void> {
		if (!this.analyticsMode) {
			this.trackError(405);
			logger.warn('Rejected DELETE request to /mcp in stateless mode (analytics disabled)');
			res
				.status(405)
				.json(JsonRpcErrors.methodNotAllowed(null, 'Method not allowed. Use POST for stateless JSON-RPC requests.'));
			return;
		}

		const headers = req.headers as Record<string, string>;
		const sessionId = headers['mcp-session-id'];

		if (!sessionId) {
			this.trackError(400);
			res.status(400).json(JsonRpcErrors.invalidRequest(null, 'Session ID required for DELETE requests'));
			return;
		}

		if (this.analyticsSessions.has(sessionId)) {
			// Get session info before deletion for logging
			const analyticsSession = this.analyticsSessions.get(sessionId);

			this.analyticsSessions.delete(sessionId);
			this.metrics.trackSessionDeleted();
			this.metrics.updateActiveConnections(this.analyticsSessions.size);
			this.metrics.disconnectClient(analyticsSession?.clientInfo);
			logger.info({ sessionId }, 'Analytics session deleted via DELETE request');

			// Log session delete event
			logSystemEvent('session_delete', sessionId, {
				clientSessionId: sessionId,
				protocolEra: analyticsSession?.protocolEra,
				protocolVersion: analyticsSession?.protocolVersion,
				userHash: analyticsSession?.userHash,
				isAuthenticated: analyticsSession?.isAuthenticated,
				clientName: analyticsSession?.clientInfo?.name,
				clientVersion: analyticsSession?.clientInfo?.version,
				requestJson: { method: 'session_delete', sessionId },
				ipAddress: analyticsSession?.ipAddress,
			});

			res.status(200).json({ jsonrpc: '2.0', result: { deleted: true } });
		} else {
			this.trackError(404);
			logger.debug({ sessionId }, 'Analytics session not found for deletion');
			res.status(404).json(JsonRpcErrors.sessionNotFound(sessionId, null));
		}
	}

	/**
	 * Clean up resources
	 */
	override async cleanup(): Promise<void> {
		await this.modernHandler?.close().catch((error: unknown) => {
			logger.warn({ error }, 'Error closing modern HTTP MCP handler');
		});
		this.modernHandler = undefined;
		this.modernNodeHandler = undefined;
		for (const session of this.analyticsSessions.values()) {
			this.metrics.disconnectClient(session.clientInfo);
		}
		this.analyticsSessions.clear();
		this.metrics.updateActiveConnections(0);
		logger.info('HTTP JSON transport cleanup complete');
		return Promise.resolve();
	}

	override getSessions(): SessionMetadata[] {
		return this.analyticsMode ? Array.from(this.analyticsSessions.values()) : [];
	}

	// Analytics mode methods
	private createAnalyticsSession(
		sessionId: string,
		isAuthenticated: boolean,
		ipAddress?: string,
		protocolVersion?: string,
		clientCapabilities?: Record<string, unknown>,
		userHash?: string
	): void {
		const session: SessionMetadata = {
			id: sessionId,
			connectedAt: new Date(),
			lastActivity: new Date(),
			requestCount: 1,
			isAuthenticated,
			capabilities: {},
			ipAddress,
			protocolEra: 'legacy',
			protocolVersion,
			clientCapabilities,
			userHash,
		};

		this.analyticsSessions.set(sessionId, session);
		this.metrics.trackSessionCreated();
		this.metrics.updateActiveConnections(this.analyticsSessions.size);

		logger.debug({ sessionId, isAuthenticated }, 'Analytics session created');
	}

	private updateAnalyticsSessionActivity(sessionId: string): void {
		const session = this.analyticsSessions.get(sessionId);
		if (session) {
			session.lastActivity = new Date();
			session.requestCount++;
		}
	}

	private updateAnalyticsSessionClientInfo(sessionId: string, clientInfo: { name: string; version: string }): void {
		const session = this.analyticsSessions.get(sessionId);
		if (session) {
			session.clientInfo = clientInfo;
		}
	}

	/**
	 * Activate temporary logging for session resume failures
	 * @param count Number of failures to log
	 * @returns The actual number of logs that will be captured
	 */
	activateTempLogging(count: number): number {
		if (this.tempLogMax <= 0) return 0;
		this.tempLogCounter = Math.min(count, this.tempLogMax);
		this.tempLogOriginalCount = this.tempLogCounter;
		if (this.tempLogCounter > 0) {
			logger.info(`Temporary logging activated for ${this.tempLogCounter} session resume failures`);
		}
		return this.tempLogCounter;
	}

	/**
	 * Get the current temp logging status
	 */
	getTempLogStatus(): { enabled: boolean; remaining: number; maxAllowed: number } {
		return {
			enabled: this.tempLogMax > 0,
			remaining: this.tempLogCounter,
			maxAllowed: this.tempLogMax,
		};
	}
}
