import { createHash } from 'node:crypto';
import type { TransportType } from './constants.js';

export type ProtocolEra = 'legacy' | 'modern';
export type SubscriptionMethod = 'resources/subscribe' | 'resources/unsubscribe' | 'subscriptions/listen';

export interface SubscriptionAttempt {
	method: SubscriptionMethod;
	protocolEra: ProtocolEra;
	protocolVersion: string;
	clientName?: string;
	clientVersion?: string;
	requestShape: string;
}

interface SubscriptionAttemptMetrics extends SubscriptionAttempt {
	count: number;
	firstSeen: Date;
	lastSeen: Date;
}

interface ProtocolUsageMetrics {
	era: ProtocolEra;
	version: string;
	requestCount: number;
	toolCallCount: number;
	firstSeen: Date;
	lastSeen: Date;
}

interface AggregateProtocolUsageMetrics extends ProtocolUsageMetrics {
	uniqueClients: number;
	uniqueUsers: number;
	unattributedRequests: number;
}

/**
 * Core metrics data tracked by each transport
 */
export interface TransportMetrics {
	startupTime: Date;

	// Requests split by protocol behavior era.
	protocolEras: {
		legacy: number;
		modern: number;
	};
	protocolVersions: Map<string, AggregateProtocolUsageMetrics>;

	// Connection metrics
	connections: {
		active: number | 'stateless';
		total: number;
		authenticated: number;
		denied: number;
		anonymous: number;
		unauthorized?: number; // 401 errors
		cleaned?: number;
		uniqueIps?: number; // Unique IP addresses that have connected
		uniqueUsers?: number; // Unique authenticated HF usernames, stored as hashes
	};

	// Session lifecycle metrics (including stateless analytics sessions)
	sessions?: {
		created: number;
		resumedFailed: number;
		deleted: number;
	};

	// Request metrics
	requests: {
		total: number;
		averagePerMinute: number;
		lastMinute: number;
		lastHour: number;
		last3Hours: number;
	};

	// Error metrics
	errors: {
		expected: number; // 4xx errors
		unexpected: number; // 5xx errors
		lastError?: {
			type: string;
			message: string;
			timestamp: Date;
		};
	};

	// Client identity aggregation (name version)
	clients: Map<string, ClientMetrics>;

	// Method metrics
	methods: Map<string, MethodMetrics>;

	// Legacy resource-subscription and modern subscription-stream attempts.
	// Request shapes are sanitized before reaching this metrics layer.
	subscriptionAttempts: Map<string, SubscriptionAttemptMetrics>;

	// Static page hits (for stateless transport)
	staticPageHits200?: number;
	staticPageHits405?: number;
}

/**
 * Metrics per client identity (name@version)
 */
interface ClientMetrics {
	name: string;
	version: string;
	requestCount: number;
	firstSeen: Date;
	lastSeen: Date;
	isConnected: boolean;
	activeConnections: number;
	totalConnections: number;
	toolCallCount: number;
	newIpCount: number;
	anonCount: number;
	uniqueAuthCount: number;
	uniqueUserCount: number;
	protocols: Map<string, ProtocolUsageMetrics>;
}

/**
 * Metrics per client for a specific method
 */
interface ClientMethodMetrics {
	clientName: string;
	count: number;
}

/**
 * Metrics per MCP method
 */
interface MethodMetrics {
	method: string;
	count: number;
	firstCalled: Date;
	lastCalled: Date;
	averageResponseTime?: number;
	errors: number;
	byClient: Map<string, ClientMethodMetrics>;
}

/**
 * API call metrics for external HuggingFace API calls
 */
interface ApiCallMetrics {
	anonymous: number;
	authenticated: number;
	unauthorized: number; // 401
	forbidden: number; // 403
}

/**
 * Gradio tool call metrics
 */
interface GradioToolMetrics {
	success: number;
	failure: number;
	byTool: Record<string, { success: number; failure: number }>;
}

/**
 * Gradio cache metrics for space metadata and schemas
 */
interface GradioCacheMetrics {
	spaceMetadata: {
		hits: number;
		misses: number;
		hitRate: number; // percentage
		etagRevalidations: number;
		cacheSize: number;
	};
	schemas: {
		hits: number;
		misses: number;
		hitRate: number; // percentage
		cacheSize: number;
	};
	totalHits: number;
	totalMisses: number;
	overallHitRate: number; // percentage
}

const MAX_DISTINCT_METHOD_DETAILS = 500;
const UNEXPECTED_METHOD_DETAIL = '__unexpected__';
const MAX_DISTINCT_PROTOCOL_VERSIONS = 32;
const UNEXPECTED_PROTOCOL_VERSION = '__other__';
const MAX_DISTINCT_SUBSCRIPTION_ATTEMPTS = 500;
const UNEXPECTED_SUBSCRIPTION_DIMENSION = '__other__';
const MAX_SUBSCRIPTION_DIMENSION_LENGTH = 120;

function boundSubscriptionDimension(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, MAX_SUBSCRIPTION_DIMENSION_LENGTH) : undefined;
}

/**
 * API response format for transport metrics
 */
export interface SessionData {
	id: string;
	connectedAt: string; // ISO date string
	lastActivity: string; // ISO date string
	clientInfo?: {
		name: string;
		version: string;
	};
	isConnected: boolean;
	connectionStatus?: 'Connected' | 'Disconnected';
	ipAddress?: string;
	protocolEra?: ProtocolEra;
	protocolVersion?: string;
}

export interface TransportMetricsResponse {
	transport: TransportType;
	isStateless: boolean;
	startupTime: string; // ISO date string
	currentTime: string; // ISO date string
	uptimeSeconds: number;
	protocolEras: {
		legacy: number;
		modern: number;
	};
	protocolVersions: Array<{
		era: ProtocolEra;
		version: string;
		requestCount: number;
		toolCallCount: number;
		uniqueClients: number;
		uniqueUsers: number;
		unattributedRequests: number;
		firstSeen: string;
		lastSeen: string;
	}>;

	connections: {
		active: number | 'stateless';
		total: number;
		authenticated: number;
		denied: number;
		anonymous: number;
		unauthorized?: number;
		cleaned?: number;
		uniqueIps?: number;
		uniqueUsers?: number;
	};

	// Session lifecycle metrics (including stateless analytics sessions)
	sessionLifecycle?: {
		created: number;
		resumedFailed: number;
		deleted: number;
	};

	requests: {
		total: number;
		averagePerMinute: number;
		lastMinute: number;
		lastHour: number;
		last3Hours: number;
	};

	// Static page hits (stateless transport only)
	staticPageHits200?: number;
	staticPageHits405?: number;

	errors: {
		expected: number;
		unexpected: number;
		lastError?: {
			type: string;
			message: string;
			timestamp: string; // ISO date string
		};
	};

	clients: Array<{
		name: string;
		version: string;
		requestCount: number;
		firstSeen: string; // ISO date string
		lastSeen: string; // ISO date string
		isConnected: boolean;
		activeConnections: number;
		totalConnections: number;
		toolCallCount: number;
		newIpCount: number;
		anonCount: number;
		uniqueAuthCount: number;
		uniqueUserCount: number;
		protocols: Array<{
			era: ProtocolEra;
			version: string;
			requestCount: number;
			toolCallCount: number;
			firstSeen: string;
			lastSeen: string;
		}>;
	}>;

	sessions: SessionData[];

	methods: Array<{
		method: string;
		count: number;
		firstCalled: string; // ISO date string
		lastCalled: string; // ISO date string
		averageResponseTime?: number; // milliseconds
		errors: number;
		errorRate: number; // percentage
		byClient: Array<{
			clientName: string;
			count: number;
		}>;
	}>;

	subscriptionAttempts: Array<{
		method: SubscriptionMethod;
		protocolEra: ProtocolEra;
		protocolVersion: string;
		clientName?: string;
		clientVersion?: string;
		requestShape: string;
		count: number;
		firstSeen: string;
		lastSeen: string;
	}>;

	// API call metrics (only shown in external API mode)
	apiMetrics?: ApiCallMetrics;

	// Gradio tool call metrics
	gradioMetrics?: GradioToolMetrics;

	// Gradio cache metrics (discovery optimization)
	gradioCacheMetrics?: GradioCacheMetrics;
}

/**
 * Convert internal metrics to API response format
 */
export function formatMetricsForAPI(
	metrics: TransportMetrics,
	transport: TransportType,
	isStateless: boolean,
	sessions: SessionData[] = []
): TransportMetricsResponse {
	const currentTime = new Date();
	const uptimeSeconds = Math.floor((currentTime.getTime() - metrics.startupTime.getTime()) / 1000);

	return {
		transport,
		isStateless,
		startupTime: metrics.startupTime.toISOString(),
		currentTime: currentTime.toISOString(),
		uptimeSeconds,
		protocolEras: metrics.protocolEras,
		protocolVersions: Array.from(metrics.protocolVersions.values())
			.map((protocol) => ({
				...protocol,
				firstSeen: protocol.firstSeen.toISOString(),
				lastSeen: protocol.lastSeen.toISOString(),
			}))
			.sort((a, b) => b.requestCount - a.requestCount),
		connections: metrics.connections,
		sessionLifecycle: metrics.sessions,
		requests: metrics.requests,
		errors: {
			...metrics.errors,
			lastError: metrics.errors.lastError
				? {
						...metrics.errors.lastError,
						timestamp: metrics.errors.lastError.timestamp.toISOString(),
					}
				: undefined,
		},
		clients: Array.from(metrics.clients.values()).map((client) => ({
			...client,
			firstSeen: client.firstSeen.toISOString(),
			lastSeen: client.lastSeen.toISOString(),
			protocols: Array.from(client.protocols.values())
				.map((protocol) => ({
					...protocol,
					firstSeen: protocol.firstSeen.toISOString(),
					lastSeen: protocol.lastSeen.toISOString(),
				}))
				.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
		})),
		sessions,
		staticPageHits200: metrics.staticPageHits200,
		staticPageHits405: metrics.staticPageHits405,
		methods: Array.from(metrics.methods.values()).map((method) => ({
			...method,
			firstCalled: method.firstCalled.toISOString(),
			lastCalled: method.lastCalled.toISOString(),
			errorRate: method.count > 0 ? (method.errors / method.count) * 100 : 0,
			byClient: Array.from(method.byClient.values()).map((client) => ({
				clientName: client.clientName,
				count: client.count,
			})),
		})),
		subscriptionAttempts: Array.from(metrics.subscriptionAttempts.values())
			.map((attempt) => ({
				...attempt,
				firstSeen: attempt.firstSeen.toISOString(),
				lastSeen: attempt.lastSeen.toISOString(),
			}))
			.sort((a, b) => b.count - a.count),
	};
}

/**
 * Check if a method name is an initialization request
 */
export function isInitializeRequest(method: string): boolean {
	return method === 'initialize';
}

/**
 * Create a new empty metrics object
 */
function createEmptyMetrics(): TransportMetrics {
	return {
		startupTime: new Date(),
		protocolEras: {
			legacy: 0,
			modern: 0,
		},
		protocolVersions: new Map(),
		connections: {
			active: 0,
			total: 0,
			authenticated: 0,
			denied: 0,
			anonymous: 0,
		},
		sessions: {
			created: 0,
			resumedFailed: 0,
			deleted: 0,
		},
		requests: {
			total: 0,
			averagePerMinute: 0,
			lastMinute: 0,
			lastHour: 0,
			last3Hours: 0,
		},
		errors: {
			expected: 0,
			unexpected: 0,
		},
		clients: new Map(),
		methods: new Map(),
		subscriptionAttempts: new Map(),
		staticPageHits200: 0,
		staticPageHits405: 0,
	};
}

/**
 * Get client identity key from name and version
 */
function getClientKey(name: string, version: string): string {
	return `${name} ${version}`;
}

/**
 * Rolling window counter for tracking metrics over time periods
 */
class RollingWindowCounter {
	private readonly buckets: number[];
	private currentBucket: number = 0;
	private lastRotation: number = Date.now();

	constructor(windowMinutes: number) {
		this.buckets = new Array(windowMinutes).fill(0);
	}

	increment(): void {
		this.rotateBucketsIfNeeded();
		const current = this.buckets[this.currentBucket] ?? 0;
		this.buckets[this.currentBucket] = current + 1;
	}

	getCount(): number {
		this.rotateBucketsIfNeeded();
		return this.buckets.reduce((sum, count) => sum + count, 0);
	}

	private rotateBucketsIfNeeded(): void {
		const now = Date.now();
		const minutesPassed = Math.floor((now - this.lastRotation) / 60000);

		// Rotate and clear buckets for each minute that has passed
		for (let i = 0; i < minutesPassed && i < this.buckets.length; i++) {
			this.currentBucket = (this.currentBucket + 1) % this.buckets.length;
			this.buckets[this.currentBucket] = 0;
		}

		// If all buckets need to be cleared (time gap > window size)
		if (minutesPassed >= this.buckets.length) {
			this.buckets.fill(0);
			this.currentBucket = 0;
		}

		if (minutesPassed > 0) {
			// Update to the last minute boundary that was processed
			this.lastRotation = this.lastRotation + minutesPassed * 60000;
		}
	}
}

/**
 * Hash auth tokens before counting them to avoid storing raw secrets.
 */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function hashUserIdentity(username: string): string {
	return createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
}

function getProtocolKey(era: ProtocolEra, version: string): string {
	return `${era}:${version}`;
}

/**
 * Centralized metrics counter for transport operations
 */
export class MetricsCounter {
	private metrics: TransportMetrics;
	private rollingMinute: RollingWindowCounter;
	private rollingHour: RollingWindowCounter;
	private rolling3Hours: RollingWindowCounter;
	private uniqueIps: Set<string>;
	private clientIps: Map<string, Set<string>>; // Map of clientKey -> Set of IPs
	private clientAuthHashes: Map<string, Set<string>>; // Map of clientKey -> Set of auth token hashes
	private uniqueUserHashes: Set<string>;
	private clientUserHashes: Map<string, Set<string>>;
	private protocolClientKeys: Map<string, Set<string>>;
	private protocolUserHashes: Map<string, Set<string>>;
	private methodDetailsByBaseMethod: Map<string, Set<string>>;

	constructor() {
		this.metrics = createEmptyMetrics();
		this.rollingMinute = new RollingWindowCounter(1);
		this.rollingHour = new RollingWindowCounter(60);
		this.rolling3Hours = new RollingWindowCounter(180);
		this.uniqueIps = new Set();
		this.clientIps = new Map();
		this.clientAuthHashes = new Map();
		this.uniqueUserHashes = new Set();
		this.clientUserHashes = new Map();
		this.protocolClientKeys = new Map();
		this.protocolUserHashes = new Map();
		this.methodDetailsByBaseMethod = new Map();
	}

	/**
	 * Get the underlying metrics data
	 */
	getMetrics(): TransportMetrics {
		this.updateRequestRates();

		// Update unique IPs count
		this.metrics.connections.uniqueIps = this.uniqueIps.size;
		this.metrics.connections.uniqueUsers = this.uniqueUserHashes.size;

		return this.metrics;
	}

	/**
	 * Track a new request received by the transport
	 */
	trackRequest(): void {
		this.metrics.requests.total++;

		// Update rolling window counters
		this.rollingMinute.increment();
		this.rollingHour.increment();
		this.rolling3Hours.increment();

		this.updateRequestRates();
	}

	/**
	 * Track the protocol era selected for an MCP request.
	 */
	trackProtocolEra(era: ProtocolEra): void {
		this.metrics.protocolEras[era]++;
	}

	/**
	 * Track one request under its exact negotiated/proposed protocol version.
	 */
	trackProtocolRequest(era: ProtocolEra, version: string): void {
		this.trackProtocolEra(era);
		const normalizedVersion = this.normalizeProtocolVersion(era, version);
		const key = getProtocolKey(era, normalizedVersion);
		const existing = this.metrics.protocolVersions.get(key);
		if (existing) {
			existing.requestCount++;
			existing.unattributedRequests++;
			existing.lastSeen = new Date();
			return;
		}
		this.metrics.protocolVersions.set(key, {
			era,
			version: normalizedVersion,
			requestCount: 1,
			toolCallCount: 0,
			uniqueClients: 0,
			uniqueUsers: 0,
			unattributedRequests: 1,
			firstSeen: new Date(),
			lastSeen: new Date(),
		});
	}

	/**
	 * Attribute a protocol request to an MCP client implementation.
	 */
	trackClientProtocol(clientInfo: { name: string; version: string }, era: ProtocolEra, version: string): void {
		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		const clientMetrics = this.metrics.clients.get(clientKey);
		if (!clientMetrics) return;

		const normalizedVersion = this.normalizeProtocolVersion(era, version);
		const protocolKey = getProtocolKey(era, normalizedVersion);
		const clientProtocol = clientMetrics.protocols.get(protocolKey);
		if (clientProtocol) {
			clientProtocol.requestCount++;
			clientProtocol.lastSeen = new Date();
		} else {
			clientMetrics.protocols.set(protocolKey, {
				era,
				version: normalizedVersion,
				requestCount: 1,
				toolCallCount: 0,
				firstSeen: new Date(),
				lastSeen: new Date(),
			});
		}

		let clients = this.protocolClientKeys.get(protocolKey);
		if (!clients) {
			clients = new Set();
			this.protocolClientKeys.set(protocolKey, clients);
		}
		clients.add(clientKey);
		const aggregate = this.metrics.protocolVersions.get(protocolKey);
		if (aggregate) {
			aggregate.uniqueClients = clients.size;
			aggregate.unattributedRequests = Math.max(0, aggregate.unattributedRequests - 1);
		}
	}

	/**
	 * Attribute a tool call to the exact protocol revision used for the request.
	 */
	trackProtocolToolCall(era: ProtocolEra, version: string, clientInfo?: { name: string; version: string }): void {
		const normalizedVersion = this.normalizeProtocolVersion(era, version);
		const protocolKey = getProtocolKey(era, normalizedVersion);
		const aggregate = this.metrics.protocolVersions.get(protocolKey);
		if (aggregate) aggregate.toolCallCount++;

		if (!clientInfo) return;
		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		const clientProtocol = this.metrics.clients.get(clientKey)?.protocols.get(protocolKey);
		if (clientProtocol) clientProtocol.toolCallCount++;
	}

	/**
	 * Count authenticated users without retaining raw usernames.
	 */
	trackAuthenticatedUser(
		username: string,
		era: ProtocolEra,
		version: string,
		clientInfo?: { name: string; version: string }
	): string {
		const userHash = hashUserIdentity(username);
		this.uniqueUserHashes.add(userHash);

		const normalizedVersion = this.normalizeProtocolVersion(era, version);
		const protocolKey = getProtocolKey(era, normalizedVersion);
		let protocolUsers = this.protocolUserHashes.get(protocolKey);
		if (!protocolUsers) {
			protocolUsers = new Set();
			this.protocolUserHashes.set(protocolKey, protocolUsers);
		}
		protocolUsers.add(userHash);
		const aggregate = this.metrics.protocolVersions.get(protocolKey);
		if (aggregate) aggregate.uniqueUsers = protocolUsers.size;

		if (clientInfo) {
			const clientKey = getClientKey(clientInfo.name, clientInfo.version);
			let clientUsers = this.clientUserHashes.get(clientKey);
			if (!clientUsers) {
				clientUsers = new Set();
				this.clientUserHashes.set(clientKey, clientUsers);
			}
			clientUsers.add(userHash);
			const clientMetrics = this.metrics.clients.get(clientKey);
			if (clientMetrics) clientMetrics.uniqueUserCount = clientUsers.size;
		}
		return userHash;
	}

	private normalizeProtocolVersion(era: ProtocolEra, version: string): string {
		const normalized = version || 'unknown';
		const key = getProtocolKey(era, normalized);
		if (this.metrics.protocolVersions.has(key)) return normalized;

		const distinctForEra = Array.from(this.metrics.protocolVersions.values()).filter(
			(protocol) => protocol.era === era && protocol.version !== UNEXPECTED_PROTOCOL_VERSION
		).length;
		return distinctForEra < MAX_DISTINCT_PROTOCOL_VERSIONS ? normalized : UNEXPECTED_PROTOCOL_VERSION;
	}

	/**
	 * Track an error in the transport
	 */
	trackError(statusCode?: number, error?: Error): void {
		if (statusCode && statusCode >= 400 && statusCode < 500) {
			this.metrics.errors.expected++;
		} else {
			this.metrics.errors.unexpected++;
		}

		if (error) {
			this.metrics.errors.lastError = {
				type: error.constructor.name,
				message: error.message,
				timestamp: new Date(),
			};
		}
	}

	/**
	 * Track a new connection established (global counter)
	 */
	trackNewConnection(): void {
		this.metrics.connections.total++;
	}

	/**
	 * Track an IP address
	 */
	trackIpAddress(ipAddress: string | undefined): void {
		if (ipAddress) {
			this.uniqueIps.add(ipAddress);
		}
	}

	/**
	 * Track an IP address for a specific client
	 */
	trackClientIpAddress(ipAddress: string | undefined, clientInfo?: { name: string; version: string }): void {
		// Always track globally
		this.trackIpAddress(ipAddress);

		// Track per-client if client info is available
		if (ipAddress && clientInfo) {
			const clientKey = getClientKey(clientInfo.name, clientInfo.version);
			const clientMetrics = this.metrics.clients.get(clientKey);

			if (clientMetrics) {
				// Get or create the IP set for this client
				let clientIpSet = this.clientIps.get(clientKey);
				if (!clientIpSet) {
					clientIpSet = new Set();
					this.clientIps.set(clientKey, clientIpSet);
				}

				// Check if this is a new IP for this client
				const isNewIp = !clientIpSet.has(ipAddress);
				if (isNewIp) {
					clientIpSet.add(ipAddress);
					clientMetrics.newIpCount++;
				}
			}
		}
	}

	/**
	 * Track auth status for a specific client
	 */
	trackClientAuth(authToken: string | undefined, clientInfo?: { name: string; version: string }): void {
		if (!clientInfo) return;

		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		const clientMetrics = this.metrics.clients.get(clientKey);

		if (clientMetrics) {
			if (!authToken) {
				// Anonymous request
				clientMetrics.anonCount++;
			} else {
				// Authenticated request - hash the token for privacy
				const tokenHash = hashToken(authToken);

				// Get or create the auth hash set for this client
				let clientAuthSet = this.clientAuthHashes.get(clientKey);
				if (!clientAuthSet) {
					clientAuthSet = new Set();
					this.clientAuthHashes.set(clientKey, clientAuthSet);
				}

				// Check if this is a new auth token for this client
				const isNewAuth = !clientAuthSet.has(tokenHash);
				if (isNewAuth) {
					clientAuthSet.add(tokenHash);
					clientMetrics.uniqueAuthCount++;
				}
			}
		}
	}

	/**
	 * Update active connection count
	 */
	updateActiveConnections(count: number): void {
		this.metrics.connections.active = count;
	}

	/**
	 * Track a session that was cleaned up/removed
	 */
	trackSessionCleaned(): void {
		if (!this.metrics.connections.cleaned) {
			this.metrics.connections.cleaned = 0;
		}
		this.metrics.connections.cleaned++;
	}

	/**
	 * Associate a session with a client identity when client info becomes available
	 */
	associateSessionWithClient(clientInfo: { name: string; version: string }): void {
		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		let clientMetrics = this.metrics.clients.get(clientKey);

		if (!clientMetrics) {
			clientMetrics = {
				name: clientInfo.name,
				version: clientInfo.version,
				requestCount: 0,
				firstSeen: new Date(),
				lastSeen: new Date(),
				isConnected: true,
				activeConnections: 1,
				totalConnections: 1,
				toolCallCount: 0,
				newIpCount: 0,
				anonCount: 0,
				uniqueAuthCount: 0,
				uniqueUserCount: 0,
				protocols: new Map(),
			};
			this.metrics.clients.set(clientKey, clientMetrics);
		} else {
			clientMetrics.lastSeen = new Date();
			clientMetrics.isConnected = true;
			clientMetrics.activeConnections++;
			clientMetrics.totalConnections++;
		}
	}

	/**
	 * Update client activity when a request is made
	 */
	updateClientActivity(clientInfo?: { name: string; version: string }): void {
		if (!clientInfo) return;

		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		const clientMetrics = this.metrics.clients.get(clientKey);

		if (clientMetrics) {
			clientMetrics.requestCount++;
			clientMetrics.lastSeen = new Date();
		}
	}

	/**
	 * Mark a client connection as disconnected
	 */
	disconnectClient(clientInfo?: { name: string; version: string }): void {
		if (!clientInfo) return;

		const clientKey = getClientKey(clientInfo.name, clientInfo.version);
		const clientMetrics = this.metrics.clients.get(clientKey);

		if (clientMetrics && clientMetrics.activeConnections > 0) {
			clientMetrics.activeConnections--;
			if (clientMetrics.activeConnections === 0) {
				clientMetrics.isConnected = false;
			}
		}
	}

	/**
	 * Track a method call
	 */
	trackMethod(
		method: string | null,
		responseTime?: number,
		isError: boolean = false,
		clientInfo?: { name: string; version: string }
	): void {
		if (!method) return;
		method = this.normalizeMethodName(method);
		let methodMetrics = this.metrics.methods.get(method);

		if (!methodMetrics) {
			methodMetrics = {
				method,
				count: 0,
				firstCalled: new Date(),
				lastCalled: new Date(),
				errors: 0,
				byClient: new Map(),
			};
			this.metrics.methods.set(method, methodMetrics);
		}

		methodMetrics.count++;
		methodMetrics.lastCalled = new Date();

		// Track per-client breakdown
		if (clientInfo) {
			const clientName = clientInfo.name;
			let clientMethodMetrics = methodMetrics.byClient.get(clientName);

			if (!clientMethodMetrics) {
				clientMethodMetrics = {
					clientName,
					count: 0,
				};
				methodMetrics.byClient.set(clientName, clientMethodMetrics);
			}

			clientMethodMetrics.count++;

			// If this is a tool call, increment the client's tool call count
			if (method.startsWith('tools/call:')) {
				const clientKey = getClientKey(clientInfo.name, clientInfo.version);
				const clientMetrics = this.metrics.clients.get(clientKey);
				if (clientMetrics) {
					clientMetrics.toolCallCount++;
				}
			}
		}

		if (isError) {
			methodMetrics.errors++;
		}

		// Update average response time if provided
		if (responseTime !== undefined && !isError) {
			const successfulCalls = methodMetrics.count - methodMetrics.errors;
			if (successfulCalls === 1) {
				methodMetrics.averageResponseTime = responseTime;
			} else {
				const currentAvg = methodMetrics.averageResponseTime || 0;
				const totalTime = currentAvg * (successfulCalls - 1) + responseTime;
				methodMetrics.averageResponseTime = totalTime / successfulCalls;
			}
		}
	}

	/**
	 * Track subscription intent without retaining resource URIs or other
	 * caller-controlled filter values.
	 */
	trackSubscriptionAttempt(attempt: SubscriptionAttempt): void {
		const boundedProtocolVersion =
			boundSubscriptionDimension(attempt.protocolVersion) ?? UNEXPECTED_SUBSCRIPTION_DIMENSION;
		const normalizedAttempt = {
			...attempt,
			protocolVersion: this.normalizeProtocolVersion(attempt.protocolEra, boundedProtocolVersion),
			clientName: boundSubscriptionDimension(attempt.clientName),
			clientVersion: boundSubscriptionDimension(attempt.clientVersion),
			requestShape: boundSubscriptionDimension(attempt.requestShape) ?? UNEXPECTED_SUBSCRIPTION_DIMENSION,
		};
		let key = JSON.stringify([
			normalizedAttempt.method,
			normalizedAttempt.protocolEra,
			normalizedAttempt.protocolVersion,
			normalizedAttempt.clientName,
			normalizedAttempt.clientVersion,
			normalizedAttempt.requestShape,
		]);
		let existing = this.metrics.subscriptionAttempts.get(key);

		if (!existing && this.metrics.subscriptionAttempts.size >= MAX_DISTINCT_SUBSCRIPTION_ATTEMPTS) {
			const overflowAttempt: SubscriptionAttempt = {
				method: normalizedAttempt.method,
				protocolEra: normalizedAttempt.protocolEra,
				protocolVersion: UNEXPECTED_SUBSCRIPTION_DIMENSION,
				requestShape: UNEXPECTED_SUBSCRIPTION_DIMENSION,
			};
			key = JSON.stringify([
				overflowAttempt.method,
				overflowAttempt.protocolEra,
				overflowAttempt.protocolVersion,
				overflowAttempt.requestShape,
			]);
			existing = this.metrics.subscriptionAttempts.get(key);
			if (!existing) {
				this.metrics.subscriptionAttempts.set(key, {
					...overflowAttempt,
					count: 1,
					firstSeen: new Date(),
					lastSeen: new Date(),
				});
				return;
			}
		}

		if (existing) {
			existing.count++;
			existing.lastSeen = new Date();
			return;
		}

		this.metrics.subscriptionAttempts.set(key, {
			...normalizedAttempt,
			count: 1,
			firstSeen: new Date(),
			lastSeen: new Date(),
		});
	}

	private normalizeMethodName(method: string): string {
		const detailSeparator = method.indexOf(':');
		if (detailSeparator === -1) return method;

		const baseMethod = method.slice(0, detailSeparator);
		const detail = method.slice(detailSeparator + 1);
		let knownDetails = this.methodDetailsByBaseMethod.get(baseMethod);
		if (!knownDetails) {
			knownDetails = new Set();
			this.methodDetailsByBaseMethod.set(baseMethod, knownDetails);
		}

		if (knownDetails.has(detail)) return method;
		if (knownDetails.size < MAX_DISTINCT_METHOD_DETAILS) {
			knownDetails.add(detail);
			return method;
		}

		return `${baseMethod}:${UNEXPECTED_METHOD_DETAIL}`;
	}

	/**
	 * Track a static page hit with status code
	 */
	trackStaticPageHit(statusCode: number): void {
		if (statusCode === 200) {
			this.metrics.staticPageHits200 = (this.metrics.staticPageHits200 || 0) + 1;
		} else if (statusCode === 405) {
			this.metrics.staticPageHits405 = (this.metrics.staticPageHits405 || 0) + 1;
		}
	}

	/**
	 * Track authenticated connection
	 */
	trackAuthenticatedConnection(): void {
		this.metrics.connections.authenticated++;
	}

	/**
	 * Track anonymous connection
	 */
	trackAnonymousConnection(): void {
		this.metrics.connections.anonymous++;
	}

	/**
	 * Track unauthorized connection (401)
	 */
	trackUnauthorizedConnection(): void {
		if (!this.metrics.connections.unauthorized) {
			this.metrics.connections.unauthorized = 0;
		}
		this.metrics.connections.unauthorized++;
	}

	/**
	 * Track a new session being created
	 */
	trackSessionCreated(): void {
		if (this.metrics.sessions) {
			this.metrics.sessions.created++;
		}
	}

	/**
	 * Track a failed session resumption attempt
	 */
	trackSessionResumeFailed(): void {
		if (this.metrics.sessions) {
			this.metrics.sessions.resumedFailed++;
		}
	}

	/**
	 * Track a session being deleted/cleaned up
	 */
	trackSessionDeleted(): void {
		if (this.metrics.sessions) {
			this.metrics.sessions.deleted++;
		}
	}

	/**
	 * Update request rates using only the portion of each window for which the
	 * current process has actually been running. A server with 30 minutes of
	 * uptime must not dilute its one-hour and three-hour rates over 60 or 180
	 * minutes. Rates are recalculated when read so lifetime throughput decays
	 * correctly during idle periods.
	 */
	private updateRequestRates(): void {
		const uptimeMinutes = Math.max((Date.now() - this.metrics.startupTime.getTime()) / 60000, 1);
		const roundRate = (count: number, minutes: number): number => Math.round((count / minutes) * 100) / 100;

		this.metrics.requests.lastMinute = this.rollingMinute.getCount();
		this.metrics.requests.lastHour = roundRate(this.rollingHour.getCount(), Math.min(uptimeMinutes, 60));
		this.metrics.requests.last3Hours = roundRate(this.rolling3Hours.getCount(), Math.min(uptimeMinutes, 180));
		this.metrics.requests.averagePerMinute = roundRate(this.metrics.requests.total, uptimeMinutes);
	}
}
