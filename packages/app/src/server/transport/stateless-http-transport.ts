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
import { RESOURCES_DIRECTORY_READ_METHOD } from '../skills/skill-directory-schema.js';
import { getProxyToolsConfig } from '../utils/proxy-tools-config.js';
import { BOUQUET_FALLBACK } from '../../shared/settings.js';
import { getErrorLogFields } from '../utils/observability.js';
import { isProgressToken } from '../utils/progress-token.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resource methods that build the full server and thus expose the Skills surface.
const RESOURCE_METHODS = new Set([
	'resources/list',
	'resources/read',
	'resources/templates/list',
	RESOURCES_DIRECTORY_READ_METHOD,
]);
const FULL_SERVER_METHODS = new Set(['tools/list', 'tools/call', 'initialize', ...RESOURCE_METHODS]);
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
		_meta?: Record<string, unknown>;
	};
}

interface ModernRequestData {
	headers: Record<string, string>;
	clientInfo?: { name: string; version: string };
	requestId: string;
	isAuthenticated: boolean;
	authenticatedUser?: ServerRequestContext['authenticatedUser'];
	useFullServer: boolean;
	skipGradio: boolean;
	discoveryOnly: boolean;
	protocolVersion: string;
	clientCapabilities: Record<string, unknown>;
	userHash?: string;
}

function isErrorResponseBody(body: string): boolean {
	const ssePayloads = body
		.split(/\r?\n/u)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim());
	const payloads = ssePayloads.length > 0 ? ssePayloads : [body];

	for (const payload of payloads) {
		try {
			const parsed = JSON.parse(payload) as
				{ error?: unknown; result?: { isError?: unknown } } | { error?: unknown; result?: { isError?: unknown } }[];
			const responses = Array.isArray(parsed) ? parsed : [parsed];
			if (responses.some((response) => response.error !== undefined || response.result?.isError === true)) {
				return true;
			}
		} catch {
			// Ignore SSE control events and malformed response fragments.
		}
	}
	return false;
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
		if (this.truncated) return false;
		return isErrorResponseBody(Buffer.concat(this.chunks, this.capturedBytes).toString('utf8'));
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

	constructor(serverFactory: ServerFactory, app: Express) {
		super(serverFactory, app);
		this.analyticsMode = process.env.ANALYTICS_MODE === 'true';
		this.tempLogMax = parseInt(process.env.TEMPLOG_MAX || '0', 10);

		if (this.analyticsMode) {
			logger.info('Analytics mode enabled for stateless HTTP transport.');
		}

		if (this.tempLogMax > 0) {
			logger.info(`Temporary logging available with max count: ${this.tempLogMax}`);
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
			if (RESOURCE_METHODS.has(method) && isClientDenied(clientName, userAgent)) {
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
		startTime: number
	): Promise<boolean> {
		const method = requestBody?.method;
		if (!method || !RESOURCE_METHODS.has(method)) return false;

		// Preserve the full server path for resource surfaces that are not purely static skills.
		if (clientInfo?.name === 'openai-mcp' || this.hasProxyAppResources()) return false;
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
			return true;
		}

		if (method === RESOURCES_DIRECTORY_READ_METHOD && typeof uri === 'string' && uri.startsWith('skill://')) {
			const cursor = typeof requestBody?.params?.cursor === 'string' ? requestBody.params.cursor : undefined;
			const listing = readSkillDirectory(catalog, uri, cursor);
			if (!listing) {
				res.status(200).json(JsonRpcErrors.invalidParams(`Not a directory resource: ${uri}`, id));
				this.trackMethodCall(RESOURCES_DIRECTORY_READ_METHOD, startTime, true, clientInfo);
				return true;
			}

			res.status(200).json({
				jsonrpc: '2.0',
				id,
				result: listing,
			});
			this.trackMethodCall(RESOURCES_DIRECTORY_READ_METHOD, startTime, false, clientInfo);
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
					requestData.headers,
					requestData.discoveryOnly ? BOUQUET_FALLBACK : undefined,
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
		this.app.get('/mcp', (req: Request, res: Response) => {
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
			await this.handleDeleteRequest(req, res);
		});

		logger.info('HTTP JSON transport initialized (stateless mode)');
		return Promise.resolve();
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

		this.trackIpAddress(ipAddress);
		this.trackProtocolRequest('modern', protocolVersion);

		const authResult = await this.validateAuthAndTrackMetrics(headers);
		if (!authResult.shouldContinue) {
			res.set('WWW-Authenticate', buildOAuthResourceHeader(req));
			res.status(authResult.statusCode || 401).send('Unauthorized');
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

		if (requestBody?.method === 'server/discover') {
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

		const useFullServer =
			requestBody?.method === 'server/discover' ||
			this.shouldHandle(requestBody, clientInfo?.name, headers['user-agent']);
		const skipGradio = requestBody?.method === 'server/discover' || this.skipGradioSetup(requestBody);
		const requestData: ModernRequestData = {
			headers,
			clientInfo,
			requestId,
			isAuthenticated: authResult.userIdentified,
			authenticatedUser: authResult.authenticatedUser,
			useFullServer,
			skipGradio,
			discoveryOnly: requestBody?.method === 'server/discover',
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

			const responseIsError = res.statusCode >= 400 || responseCapture.isError();
			this.trackMethodCall(trackingName, startTime, responseIsError, clientInfo);
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
			this.trackMethodCall(trackingName, startTime, true, clientInfo);
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

		// Resource subscriptions are never supported (skills are static). Reject these
		// cheaply before building any server — cursor-vscode floods `resources/subscribe`.
		const rpcMethod = requestBody?.method;
		if (rpcMethod && UNSUPPORTED_SUBSCRIBE_METHODS.has(rpcMethod)) {
			const earlySessionId = headers['mcp-session-id'];
			const earlyClientInfo =
				this.extractClientInfoFromRequest(requestBody) ??
				(typeof earlySessionId === 'string' ? this.analyticsSessions.get(earlySessionId)?.clientInfo : undefined);

			this.trackMethodCall(trackingName, startTime, true, earlyClientInfo);
			res.status(200).json(JsonRpcErrors.methodNotFound(extractJsonRpcId(req.body), `${rpcMethod} is not supported`));
			return;
		}

		const authResult = await this.validateAuthAndTrackMetrics(headers);
		if (!authResult.shouldContinue) {
			res.set('WWW-Authenticate', buildOAuthResourceHeader(req));
			res.status(authResult.statusCode || 401).send('Unauthorized');
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
					res.status(404).json(JsonRpcErrors.sessionNotFound(sessionId, extractJsonRpcId(req.body)));
					return;
				}
			} else {
				// No session ID provided for non-initialize request - return 400
				this.trackError(400);
				logger.debug('Missing session ID for non-initialize request in analytics mode');
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

			if (await this.tryHandleStaticResourceRequest(req, res, requestBody, clientInfo, startTime)) {
				return;
			}

			// Determine which server to use, passing client name + user-agent for resource method filtering
			const useFullServer = this.shouldHandle(requestBody, clientInfo?.name, headers['user-agent']);
			if (useFullServer) {
				// Create new server instance using factory with request headers and bouquet
				// Skip Gradio endpoints for initialize requests or non-Gradio tool calls
				const skipGradio = this.skipGradioSetup(requestBody);

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
				const result = await this.serverFactory(headers, undefined, skipGradio, sessionInfoForLogging);
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

			const responseIsError = responseCapture.isError();
			this.trackMethodCall(trackingName, startTime, responseIsError, clientInfo);

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
