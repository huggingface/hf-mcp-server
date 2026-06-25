import {
	BaseTransport,
	type TransportOptions,
	STATELESS_MODE,
	type SessionMetadata,
	type ServerFactory,
} from './base-transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../utils/logger.js';
import type { Request, Response, Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonRpcErrors, extractJsonRpcId } from './json-rpc-errors.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { isJSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { extractQueryParamsToHeaders } from '../utils/query-params.js';
import { isBrowser } from '../utils/browser-detection.js';
import { buildOAuthResourceHeader } from '../utils/oauth-resource.js';
import { randomUUID } from 'node:crypto';
import { logSystemEvent } from '../utils/query-logger.js';
import { rewriteLegacySearchToolCallRequest } from '../utils/repo-search-shim.js';
import { isClientDenied } from '../../shared/client-denylist.js';
import { getSkillCatalog } from '../skills/skill-catalog-cache.js';
import { listSkillResources, readSkillResource, readSkillDirectory } from '../skills/skill-resource-data.js';
import { RESOURCES_DIRECTORY_READ_METHOD } from '../skills/skill-directory-schema.js';
import { getProxyToolsConfig } from '../utils/proxy-tools-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resource methods that build the full server and thus expose the Skills surface.
const RESOURCE_METHODS = new Set([
	'resources/list',
	'resources/read',
	'resources/templates/list',
	RESOURCES_DIRECTORY_READ_METHOD,
]);
// Resource-subscription methods we never support (skills are static — nothing to
// notify `resources/updated` about). Rejected cheaply before any server is built.
const UNSUPPORTED_SUBSCRIBE_METHODS = new Set(['resources/subscribe', 'resources/unsubscribe']);

interface JsonRpcRequestBody {
	method?: string;
	id?: string | number | null;
	params?: {
		uri?: unknown;
		cursor?: unknown;
		clientInfo?: unknown;
		capabilities?: unknown;
		name?: string;
	};
}

// Analytics session without server (server is null in analytics mode)
interface AnalyticsSession {
	transport: null;
	server: null;
	metadata: SessionMetadata;
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
	private analyticsSessions: Map<string, AnalyticsSession> = new Map();
	private readonly tempLogMax: number;
	private tempLogCounter: number = 0;
	private tempLogOriginalCount: number = 0;

	constructor(serverFactory: ServerFactory, app: Express) {
		super(serverFactory, app);
		this.analyticsMode = process.env.ANALYTICS_MODE === 'true';
		this.tempLogMax = parseInt(process.env.TEMPLOG_MAX || '0', 10);

		// we basically just keep a map, memeory usage is small so we can get away with - no cleanup needed
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

		const methodsRequiringFullServer = new Set([
			'tools/list',
			'tools/call',
			'prompts/list',
			'prompts/get',
			'initialize',
			'resources/list',
			'resources/read',
			'resources/templates/list',
		]);

		if (method && methodsRequiringFullServer.has(method)) {
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

	override initialize(_options: TransportOptions): Promise<void> {
		this.app.post('/mcp', (req: Request, res: Response) => {
			this.trackRequest();
			void this.handleJsonRpcRequest(req, res);
		});

		// Analytics mode doesn't need cleanup - can handle millions of sessions

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
		this.app.delete('/mcp', (req: Request, res: Response) => {
			this.trackRequest();
			void this.handleDeleteRequest(req, res);
		});

		logger.info('HTTP JSON transport initialized (stateless mode)');
		return Promise.resolve();
	}

	private async handleJsonRpcRequest(req: Request, res: Response): Promise<void> {
		const startTime = Date.now();
		let server: McpServer | null = null;
		let transport: StreamableHTTPServerTransport | null = null;
		let sessionId: string | undefined;

		// Check HF token validity if present
		const headers = req.headers as Record<string, string>;
		extractQueryParamsToHeaders(req, headers);

		// Extract IP address for tracking
		const ipAddress = this.extractIpAddress(req.headers, req.ip);
		this.trackIpAddress(ipAddress);

		// Extract method name for tracking using shared utility
		const requestBody = req.body as
			| { method?: string; params?: { clientInfo?: unknown; capabilities?: unknown; name?: string } }
			| undefined;

		const trackingName = this.extractMethodForTracking(requestBody);

		// Resource subscriptions are never supported (skills are static). Reject these
		// cheaply before building any server — cursor-vscode floods `resources/subscribe`.
		const rpcMethod = requestBody?.method;
		if (rpcMethod && UNSUPPORTED_SUBSCRIBE_METHODS.has(rpcMethod)) {
			const earlySessionId = headers['mcp-session-id'];
			const earlyClientInfo =
				this.extractClientInfoFromRequest(requestBody) ??
				(typeof earlySessionId === 'string'
					? this.analyticsSessions.get(earlySessionId)?.metadata.clientInfo
					: undefined);

			this.trackMethodCall(trackingName, startTime, false, earlyClientInfo);
			res.status(200).json(JsonRpcErrors.methodNotFound(extractJsonRpcId(req.body), `${rpcMethod} is not supported`));
			return;
		}

		const authResult = await this.validateAuthAndTrackMetrics(headers);
		if (!authResult.shouldContinue || trackingName === 'tools/call:Authenticate') {
			res.set('WWW-Authenticate', buildOAuthResourceHeader(req));
			res.status(authResult.statusCode || 401).send('Unauthorized');
			return;
		}

		// Analytics mode session tracking
		if (this.analyticsMode) {
			sessionId = headers['mcp-session-id'];
			// Handle session creation/resumption
			if (requestBody?.method === 'initialize') {
				// Create new session
				sessionId = randomUUID();
				this.createAnalyticsSession(sessionId, authResult.userIdentified, ipAddress);

				// Add session ID to response headers
				res.setHeader('Mcp-Session-Id', sessionId);

				// Log initialize event
				const initClientInfo = this.extractClientInfoFromRequest(requestBody);
				logSystemEvent('initialize', sessionId, {
					clientSessionId: sessionId,
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
			const clientInfo = analyticsSession?.metadata.clientInfo;
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
			let clientInfo = analyticsSession?.metadata.clientInfo;
			if (extractedClientInfo) {
				clientInfo = extractedClientInfo;
			}

			if (await this.tryHandleStaticResourceRequest(req, res, requestBody, clientInfo, startTime)) {
				return;
			}

			// Determine which server to use, passing client name + user-agent for resource method filtering
			const useFullServer = this.shouldHandle(requestBody, clientInfo?.name, headers['user-agent']);
			let directResponse = true;

			if (useFullServer) {
				// Create new server instance using factory with request headers and bouquet
				extractQueryParamsToHeaders(req, headers);

				// Skip Gradio endpoints for initialize requests or non-Gradio tool calls
				const skipGradio = this.skipGradioSetup(requestBody);

				// Pass session info to server factory for query logging
				const sessionInfoForLogging = {
					clientSessionId: sessionId,
					isAuthenticated: analyticsSession?.metadata.isAuthenticated ?? isAuthenticated,
					clientInfo,
				};
				const result = await this.serverFactory(headers, undefined, skipGradio, sessionInfoForLogging);
				server = result.server;

				// For Gradio + Streamable HTTP tool calls, disable direct response to enable streaming/progress notifications
				directResponse = !(this.isGradioToolCall(requestBody) || this.isStreamableHttpToolCall(requestBody));
			} else {
				// Create fresh stub responder for simple requests
				server = new McpServer({ name: '@huggingface/internal-responder', version: '0.0.1' });
			}

			// Create new transport instance for this request
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: directResponse,
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

			const { rewrittenBody, legacyToolName, rewrittenToolName } = rewriteLegacySearchToolCallRequest(req.body);
			if (legacyToolName && rewrittenToolName) {
				logger.info({ legacyToolName, rewrittenToolName }, 'Rewriting legacy tool call');
			}

			await transport.handleRequest(req, res, rewrittenBody);

			// Track successful method call with client info
			this.trackMethodCall(trackingName, startTime, false, clientInfo);

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
			const clientInfo = analyticsSession?.metadata.clientInfo;
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
			logger.info({ sessionId }, 'Analytics session deleted via DELETE request');

			// Log session delete event
			logSystemEvent('session_delete', sessionId, {
				clientSessionId: sessionId,
				isAuthenticated: analyticsSession?.metadata.isAuthenticated,
				clientName: analyticsSession?.metadata.clientInfo?.name,
				clientVersion: analyticsSession?.metadata.clientInfo?.version,
				requestJson: { method: 'session_delete', sessionId },
				ipAddress: analyticsSession?.metadata.ipAddress,
			});

			res.status(200).json({ jsonrpc: '2.0', result: { deleted: true } });
		} else {
			this.trackError(404);
			logger.debug({ sessionId }, 'Analytics session not found for deletion');
			res.status(404).json(JsonRpcErrors.sessionNotFound(sessionId, null));
		}
	}

	/**
	 * Mark transport as shutting down
	 */
	override shutdown(): void {
		// Stateless transport doesn't need to reject new connections
		logger.debug('Stateless HTTP transport shutdown signaled');
	}

	/**
	 * Get the number of active connections - returns STATELESS_MODE for stateless transport
	 */
	override getActiveConnectionCount(): number {
		// In analytics mode, return the number of tracked sessions
		if (this.analyticsMode) {
			return this.analyticsSessions.size;
		}
		// Stateless transports don't track active connections
		return STATELESS_MODE;
	}

	/**
	 * Get all active sessions - returns empty array for stateless transport
	 */
	override getSessions(): SessionMetadata[] {
		// Stateless transport doesn't maintain sessions for metrics display
		// Even in analytics mode, we track sessions internally but don't expose them
		// to avoid returning massive amounts of session data
		return [];
	}

	/**
	 * Clean up resources
	 */
	override async cleanup(): Promise<void> {
		// Clear analytics sessions if needed
		this.analyticsSessions.clear();
		logger.info('HTTP JSON transport cleanup complete');
		return Promise.resolve();
	}

	// Analytics mode methods
	private createAnalyticsSession(sessionId: string, isAuthenticated: boolean, ipAddress?: string): void {
		const session: AnalyticsSession = {
			transport: null,
			server: null, // Server is null in analytics mode
			metadata: {
				id: sessionId,
				connectedAt: new Date(),
				lastActivity: new Date(),
				requestCount: 1,
				isAuthenticated,
				capabilities: {},
				ipAddress,
			},
		};

		this.analyticsSessions.set(sessionId, session);
		this.metrics.trackSessionCreated();

		logger.debug({ sessionId, isAuthenticated }, 'Analytics session created');
	}

	private updateAnalyticsSessionActivity(sessionId: string): void {
		const session = this.analyticsSessions.get(sessionId);
		if (session) {
			session.metadata.lastActivity = new Date();
			session.metadata.requestCount++;
		}
	}

	private updateAnalyticsSessionClientInfo(sessionId: string, clientInfo: { name: string; version: string }): void {
		const session = this.analyticsSessions.get(sessionId);
		if (session) {
			session.metadata.clientInfo = clientInfo;
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
