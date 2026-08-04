import type { McpServer } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import { logger } from '../utils/logger.js';
import type { TransportMetrics } from '../../shared/transport-metrics.js';
import { MetricsCounter } from '../../shared/transport-metrics.js';
import type { AppSettings } from '../../shared/settings.js';
import type { ToolBehaviorFlags } from '../../shared/behavior-flags.js';
import type { ProtocolEra } from '../../shared/transport-metrics.js';
import { whoAmI, HubApiError, type WhoAmI } from '@huggingface/hub';
import { extractAuthBouquetAndMix } from '../utils/auth-utils.js';
import { getMetricsSafeName } from '../utils/gradio-metrics.js';
import { isGradioTool } from '../utils/gradio-utils.js';

/**
 * Result returned by ServerFactory containing the server instance and optional user details
 */
export interface ServerFactoryResult {
	server: McpServer;
	enabledToolIds?: string[];
	behaviorFlags?: ToolBehaviorFlags;
}

export interface ServerRequestContext {
	clientSessionId?: string;
	requestId?: string;
	protocolEra?: ProtocolEra;
	protocolVersion?: string;
	userHash?: string;
	clientCapabilities?: Record<string, unknown>;
	isAuthenticated?: boolean;
	clientInfo?: { name: string; version: string };
	authenticatedUser?: WhoAmI;
}

/**
 * Factory function to create server instances
 * This should be provided during transport construction to enable per-connection server instances
 * Returns both the server instance and optional user details from authentication
 */
export type ServerFactory = (
	headers: Record<string, string> | null,
	userSettings?: AppSettings,
	skipGradio?: boolean,
	sessionInfo?: ServerRequestContext
) => Promise<ServerFactoryResult>;

/**
 * Standardized session metadata structure for all transports
 */
export interface SessionMetadata {
	id: string;
	connectedAt: Date;
	lastActivity: Date;
	requestCount: number;
	isAuthenticated: boolean;
	clientInfo?: {
		name: string;
		version: string;
	};
	capabilities: {
		sampling?: boolean;
		roots?: boolean;
	};
	clientCapabilities?: Record<string, unknown>;
	protocolEra?: ProtocolEra;
	protocolVersion?: string;
	userHash?: string;
	ipAddress?: string;
	authToken?: string;
}

/**
 * Base class for all transport implementations
 */
export abstract class BaseTransport {
	protected serverFactory: ServerFactory;
	protected app: Express;
	protected metrics: MetricsCounter;

	constructor(serverFactory: ServerFactory, app: Express) {
		this.serverFactory = serverFactory;
		this.app = app;
		this.metrics = new MetricsCounter();
	}

	/**
	 * Initialize the transport with the given options
	 */
	abstract initialize(): Promise<void>;

	/**
	 * Clean up the transport resources
	 */
	abstract cleanup(): Promise<void>;

	/**
	 * Get all active sessions with their metadata
	 * Returns an array of session metadata for connection dashboard
	 */
	getSessions(): SessionMetadata[] {
		return [];
	}

	/**
	 * Get current transport metrics
	 */
	getMetrics(): TransportMetrics {
		return this.metrics.getMetrics();
	}

	/**
	 * Track a new request received by the transport
	 */
	protected trackRequest(): void {
		this.metrics.trackRequest();
	}

	protected trackProtocolRequest(era: ProtocolEra, version: string): void {
		this.metrics.trackProtocolRequest(era, version);
	}

	protected trackClientProtocol(
		clientInfo: { name: string; version: string },
		era: ProtocolEra,
		version: string
	): void {
		this.metrics.trackClientProtocol(clientInfo, era, version);
	}

	protected trackProtocolToolCall(
		method: string | null,
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): void {
		if (method?.startsWith('tools/call:')) {
			this.metrics.trackProtocolToolCall(era, version, clientInfo);
		}
	}

	protected trackAuthenticatedUser(
		username: string | undefined,
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): string | undefined {
		return username ? this.metrics.trackAuthenticatedUser(username, era, version, clientInfo) : undefined;
	}

	/**
	 * Track an error in the transport
	 */
	protected trackError(statusCode?: number, error?: Error): void {
		this.metrics.trackError(statusCode, error);
	}

	/**
	 * Track a new connection established (global counter)
	 */
	protected trackNewConnection(): void {
		this.metrics.trackNewConnection();
	}

	/**
	 * Track an IP address for unique IP metrics
	 */
	protected trackIpAddress(ipAddress: string | undefined): void {
		this.metrics.trackIpAddress(ipAddress);
	}

	/**
	 * Track an IP address for a specific client
	 */
	protected trackClientIpAddress(ipAddress: string | undefined, clientInfo?: { name: string; version: string }): void {
		this.metrics.trackClientIpAddress(ipAddress, clientInfo);
	}

	/**
	 * Track auth status for a specific client
	 */
	protected trackClientAuth(authToken: string | undefined, clientInfo?: { name: string; version: string }): void {
		this.metrics.trackClientAuth(authToken, clientInfo);
	}

	/**
	 * Extract IP address from request headers
	 * Handles x-forwarded-for, x-real-ip, and direct IP
	 */
	protected extractIpAddress(
		headers: Record<string, string | string[] | undefined>,
		directIp?: string
	): string | undefined {
		// Try x-forwarded-for first (most reliable for proxied traffic)
		const forwardedFor = headers['x-forwarded-for'];
		if (forwardedFor) {
			// x-forwarded-for can be a comma-separated list, take the first one (original client)
			const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
			return ip?.split(',')[0]?.trim();
		}

		// Try x-real-ip (nginx)
		const realIp = headers['x-real-ip'];
		if (realIp) {
			return Array.isArray(realIp) ? realIp[0] : realIp;
		}

		// Fallback to direct IP (no proxy scenario)
		return directIp;
	}

	/**
	 * Associate a session with a client identity when client info becomes available
	 */
	protected associateSessionWithClient(clientInfo: { name: string; version: string }): void {
		this.metrics.associateSessionWithClient(clientInfo);
	}

	/**
	 * Update client activity when a request is made
	 */
	protected updateClientActivity(clientInfo?: { name: string; version: string }): void {
		this.metrics.updateClientActivity(clientInfo);
	}

	/**
	 * Extract method name from JSON-RPC request body for tracking
	 * Handles special cases for tools/call and prompts/get to include tool/prompt names
	 * Returns null for responses (which should not be tracked as methods)
	 */
	protected extractMethodForTracking(requestBody: unknown): string | null {
		const body = requestBody as
			| { method?: string; params?: { name?: string; uri?: unknown }; id?: unknown; result?: unknown; error?: unknown }
			| undefined;

		// If this is a JSON-RPC response (has id and result/error but no method), don't track it
		if (body && 'id' in body && !('method' in body)) {
			return null;
		}

		const methodName = body?.method || 'unknown';

		// For tools/call, extract the tool name as well
		if (methodName === 'tools/call' && body?.params && typeof body.params === 'object' && 'name' in body.params) {
			const toolName = body.params.name;
			if (typeof toolName === 'string') {
				// Use utility function to get metrics-safe name
				const safeToolName = getMetricsSafeName(toolName);
				return `tools/call:${safeToolName}`;
			}
		}

		// For prompts/get, extract the prompt name as well
		if (methodName === 'prompts/get' && body?.params && typeof body.params === 'object' && 'name' in body.params) {
			const promptName = body.params.name;
			if (typeof promptName === 'string') {
				return `prompts/get:${promptName}`;
			}
		}

		// For resource URI methods, extract the resource URI as well.
		if (
			(methodName === 'resources/read' ||
				methodName === 'resources/subscribe' ||
				methodName === 'resources/unsubscribe') &&
			body?.params &&
			typeof body.params === 'object' &&
			'uri' in body.params
		) {
			const resourceUri = body.params.uri;
			if (typeof resourceUri === 'string') {
				return `${methodName}:${resourceUri}`;
			}
		}

		return methodName;
	}

	/**
	 * Determine if Gradio endpoints should be skipped based on request type
	 * Returns true for initialize requests or non-Gradio tool calls
	 */
	/**
	 * Determines if a request is a tools/call targeting a Gradio endpoint
	 * @param requestBody - The JSON-RPC request body
	 * @returns true if this is a tools/call for a Gradio tool, false otherwise
	 */
	protected isGradioToolCall(requestBody: unknown): boolean {
		const body = requestBody as { method?: string; params?: { name?: string; arguments?: unknown } } | undefined;
		const methodName = body?.method || 'unknown';

		// Check if this is a tools/call with a valid tool name
		if (methodName === 'tools/call' && body?.params && typeof body.params === 'object' && 'name' in body.params) {
			const toolName = body.params.name;
			if (typeof toolName === 'string') {
				// Check for standard Gradio tools (gr<number>_ or grp<number>_)
				if (isGradioTool(toolName)) {
					return true;
				}

				// Special case: dynamic_space with "invoke" operation needs streaming
				if (toolName === 'dynamic_space' && body.params.arguments) {
					const args = body.params.arguments as { operation?: string } | undefined;
					if (args?.operation === 'invoke') {
						return true;
					}
				}
			}
		}

		return false;
	}

	protected skipGradioSetup(requestBody: unknown): boolean {
		const body = requestBody as { method?: string; params?: { name?: string } } | undefined;

		const methodName = body?.method || 'unknown';

		// Always skip for initialize requests
		if (methodName === 'initialize') {
			return true;
		}

		// For tools/call, check if it's a Gradio tool using the dedicated method
		if (methodName === 'tools/call') {
			// Return true (skip) for non-Gradio tools, false (don't skip) for Gradio tools
			return !this.isGradioToolCall(requestBody);
		}

		// For other methods, don't skip Gradio (conservative default)
		return false;
	}

	/**
	 * Track a method call with timing and error status
	 */
	protected trackMethodCall(
		methodName: string | null,
		startTime: number,
		isError: boolean = false,
		clientInfo?: { name: string; version: string }
	): void {
		const duration = Date.now() - startTime;
		this.metrics.trackMethod(methodName, duration, isError, clientInfo);
	}

	/**
	 * Extract client info from initialize request parameters
	 * Used by stateless transports to capture client info directly from request
	 * @param requestBody - The request body containing initialize params
	 * @returns Client info if available in the request
	 */
	protected extractClientInfoFromRequest(requestBody: unknown): { name: string; version: string } | undefined {
		const body = requestBody as { method?: string; params?: { clientInfo?: unknown } } | undefined;

		if (body?.method === 'initialize' && body?.params) {
			const clientInfo = body.params.clientInfo as { name?: string; version?: string } | undefined;
			if (clientInfo?.name && clientInfo?.version) {
				return { name: clientInfo.name, version: clientInfo.version };
			}
		}

		return undefined;
	}

	/**
	 * Validate HF token and track authentication metrics
	 * Returns true if request should continue, false if 401 should be returned
	 */
	protected async validateAuthAndTrackMetrics(
		headers: Record<string, string>
	): Promise<{ shouldContinue: boolean; statusCode?: number; userIdentified: boolean; authenticatedUser?: WhoAmI }> {
		const { hfToken } = extractAuthBouquetAndMix(headers);

		if (hfToken) {
			try {
				const authenticatedUser = await whoAmI({ credentials: { accessToken: hfToken } });
				// Track authenticated connection
				this.metrics.trackAuthenticatedConnection();
				return { shouldContinue: true, userIdentified: true, authenticatedUser };
			} catch (error) {
				// Check for 401 status in multiple possible locations
				const errorObj = error as { statusCode?: number; status?: number };
				const isUnauthorized =
					(error instanceof HubApiError && error.statusCode === 401) ||
					errorObj.statusCode === 401 ||
					errorObj.status === 401 ||
					(error instanceof Error && error.message.includes('401')) ||
					(error instanceof TypeError && error.message.includes('Your access token must start with'));

				if (isUnauthorized) {
					logger.debug('Invalid HF token - returning 401');
					// Track unauthorized connection
					this.metrics.trackUnauthorizedConnection();
					return { shouldContinue: false, statusCode: 401, userIdentified: false };
				}
				// For other errors (network issues, 500s, etc.), continue processing
				// but don't track as authenticated since we couldn't validate
				logger.debug({ error }, 'Non-401 error from whoAmI, continuing without auth tracking');
				// Don't track any auth metrics for this case - token exists but validation failed for non-auth reasons
				return { shouldContinue: true, userIdentified: false };
			}
		} else {
			// Track anonymous connection
			this.metrics.trackAnonymousConnection();
			const shouldContinue: boolean = !headers['x-mcp-force-auth'];
			if (!shouldContinue) logger.trace(`NO TOKEN, FORCE AUTH? ${headers['x-mcp-force-auth']}`);
			return { shouldContinue, userIdentified: false };
		}
	}
}
