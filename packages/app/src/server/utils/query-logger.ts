import pino, { type Logger, type LoggerOptions } from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SERVER_BUILD_SHA, SERVER_VERSION } from '../server-build-info.js';
import { redactHfTokens, redactSensitiveLogValues } from './hf-dataset-transport.js';

// Feature flags: enable/disable per-log-type; defaults to true
const QUERY_LOGS_ENABLED = (process.env.LOG_QUERY_EVENTS ?? 'true').toLowerCase() === 'true';
const SYSTEM_LOGS_ENABLED = (process.env.LOG_SYSTEM_EVENTS ?? 'true').toLowerCase() === 'true';
const DATASET_CONFIGURED = !!process.env.LOGGING_DATASET_ID;

// Get the current file's directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Structure for query logs - consistent fields for HF dataset viewer
 */
interface QueryLogEntry {
	mcpServerSessionId: string; // MCP Server to Dataset connection
	serverVersion: string;
	serverBuildSha: string;
	clientSessionId?: string | null; // Client to MCP Server connection
	requestId?: string | null; // Request correlation for request-scoped modern HTTP
	protocolEra?: 'legacy' | 'modern' | null;
	protocolVersion?: string | null;
	clientCapabilities?: string | null;
	userHash?: string | null;
	name?: string | null; // ClientInfo.name
	version?: string | null; // ClientInfo.version
	methodName: string;
	query: string;
	parameters: string; // JSON string of parameters for consistent format
	// SessionMetadata fields
	isAuthenticated?: boolean;
	// Response information
	totalResults?: number;
	resultsShared?: number;
	responseCharCount?: number;
	requestJson?: string; // Full JSON of the request
	durationMs?: number;
	success?: boolean;
	errorMessage?: string | null;
}

export interface QueryLoggerOptions {
	clientSessionId?: string;
	requestId?: string;
	protocolEra?: 'legacy' | 'modern';
	protocolVersion?: string;
	clientCapabilities?: Record<string, unknown>;
	userHash?: string;
	isAuthenticated?: boolean;
	clientName?: string;
	clientVersion?: string;
	totalResults?: number;
	resultsShared?: number;
	responseCharCount?: number;
	durationMs?: number;
	success?: boolean;
	error?: unknown;
}

function createQueryLogger(): Logger | null {
	// Disable during tests
	if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
		return null;
	}

	if (!QUERY_LOGS_ENABLED || !DATASET_CONFIGURED) {
		return null;
	}

	const datasetId = process.env.LOGGING_DATASET_ID;
	const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;

	if (!hfToken) {
		console.warn('[Query Logger] Query logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)');
		return null;
	}

	console.log(`[Query Logger] Query logging enabled for dataset: ${datasetId}`);

	try {
		const transportPath = join(__dirname, 'hf-dataset-transport.js');

		const baseOptions: LoggerOptions = {
			level: 'info', // Always log queries when enabled
			timestamp: pino.stdTimeFunctions.isoTime,
		};

		// Only log to HF dataset, no console output for queries
		return pino({
			...baseOptions,
			transport: {
				target: transportPath,
				options: { sync: false, logType: 'Query' },
			},
		});
	} catch (error) {
		console.error('[Query Logger] Failed to setup query logging transport:', error);
		return null;
	}
}

const queryLogger: Logger | null = createQueryLogger();

function createSystemLogger(): Logger | null {
	// Disable during tests
	if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
		return null;
	}

	// Require a dataset
	if (!DATASET_CONFIGURED) {
		return null;
	}

	if (!SYSTEM_LOGS_ENABLED) {
		return null;
	}

	const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;
	if (!hfToken) {
		console.warn(
			'[System Logger] System logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)'
		);
		return null;
	}

	try {
		const transportPath = join(__dirname, 'hf-dataset-transport.js');
		const baseOptions: LoggerOptions = {
			level: 'info',
			timestamp: pino.stdTimeFunctions.isoTime,
		};
		return pino({
			...baseOptions,
			transport: {
				target: transportPath,
				options: { sync: false, logType: 'System' },
			},
		});
	} catch (error) {
		console.error('[System Logger] Failed to setup system logging transport:', error);
		return null;
	}
}

const systemLogger: Logger | null = createSystemLogger();

function createGradioLogger(): Logger | null {
	// Disable during tests
	if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
		return null;
	}

	// Require a dataset
	if (!DATASET_CONFIGURED) {
		return null;
	}

	if (!SYSTEM_LOGS_ENABLED) {
		return null;
	}

	const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;
	if (!hfToken) {
		console.warn(
			'[Gradio Logger] Gradio logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)'
		);
		return null;
	}

	try {
		const transportPath = join(__dirname, 'hf-dataset-transport.js');
		const baseOptions: LoggerOptions = {
			level: 'info',
			timestamp: pino.stdTimeFunctions.isoTime,
		};
		return pino({
			...baseOptions,
			transport: {
				target: transportPath,
				options: { sync: false, logType: 'Gradio' },
			},
		});
	} catch (error) {
		console.error('[Gradio Logger] Failed to setup Gradio logging transport:', error);
		return null;
	}
}

const gradioLogger: Logger | null = createGradioLogger();

// Stable session ID for this MCP server instance (process lifetime)
const mcpServerSessionId = crypto.randomUUID();

function getMcpServerSessionId(): string {
	return mcpServerSessionId;
}

/**
 * Log a search query with consistent structure
 */
function logQuery(entry: QueryLogEntry): void {
	if (!queryLogger) {
		return;
	}

	queryLogger.info(entry);
}

function logQueryEvent(
	methodName: string,
	query: string,
	data: Record<string, unknown>,
	options?: QueryLoggerOptions
): void {
	// Use a stable mcpServerSessionId per process/transport instance
	const mcpServerSessionId = getMcpServerSessionId();
	const normalizedDurationMs = options?.durationMs !== undefined ? Math.round(options.durationMs) : undefined;
	const redactedData = redactSensitiveLogValues(data) as Record<string, unknown>;
	const serializedParameters = JSON.stringify(redactedData);
	const requestPayload = {
		methodName,
		query,
		parameters: redactedData,
	};
	const normalizedError =
		options?.error !== undefined && options?.error !== null ? normalizeError(options.error) : null;

	logQuery({
		query,
		methodName,
		parameters: serializedParameters,
		requestJson: JSON.stringify(requestPayload),
		mcpServerSessionId,
		serverVersion: SERVER_VERSION,
		serverBuildSha: SERVER_BUILD_SHA,
		clientSessionId: options?.clientSessionId || null,
		requestId: options?.requestId || null,
		protocolEra: options?.protocolEra || null,
		protocolVersion: options?.protocolVersion || null,
		clientCapabilities: options?.clientCapabilities ? stringifyRedacted(options.clientCapabilities) : null,
		userHash: options?.userHash || null,
		isAuthenticated: options?.isAuthenticated ?? false,
		name: options?.clientName || null,
		version: options?.clientVersion || null,
		totalResults: options?.totalResults,
		resultsShared: options?.resultsShared,
		responseCharCount: options?.responseCharCount,
		durationMs: normalizedDurationMs,
		success: options?.success ?? true,
		errorMessage: normalizedError,
	});
}

/**
 * Log an MCP tool operation.
 */
export function logToolQuery(
	methodName: string,
	query: string,
	data: Record<string, unknown>,
	options?: QueryLoggerOptions
): void {
	logQueryEvent(methodName, query, data, options);
}

/**
 * Simple helper to log system events (initialize, session_delete)
 */
export function logSystemEvent(
	methodName: string,
	sessionId: string,
	options?: {
		clientSessionId?: string;
		requestId?: string;
		protocolEra?: 'legacy' | 'modern';
		protocolVersion?: string;
		userHash?: string;
		isAuthenticated?: boolean;
		clientName?: string;
		clientVersion?: string;
		requestJson?: unknown;
		capabilities?: unknown;
		ipAddress?: string;
	}
): void {
	if (!systemLogger) {
		return;
	}

	const mcpServerSessionId = getMcpServerSessionId();

	// Extract name and version from capabilities if available
	let capabilitiesName = null;
	let capabilitiesVersion = null;
	if (options?.capabilities && typeof options.capabilities === 'object' && options.capabilities !== null) {
		const caps = options.capabilities as Record<string, unknown>;
		if (caps.clientInfo && typeof caps.clientInfo === 'object' && caps.clientInfo !== null) {
			const clientInfo = caps.clientInfo as Record<string, unknown>;
			capabilitiesName = typeof clientInfo.name === 'string' ? clientInfo.name : null;
			capabilitiesVersion = typeof clientInfo.version === 'string' ? clientInfo.version : null;
		}
	}

	systemLogger.info(
		{
			// Core session tracking fields (no level/message - they are redundant)
			sessionId: options?.protocolEra === 'modern' ? null : sessionId,
			methodName, // Direct method name field

			// Authorization status

			// Client info fields as separate columns
			name: options?.clientName || capabilitiesName || null,
			version: options?.clientVersion || capabilitiesVersion || null,
			authorized: options?.isAuthenticated ?? false, // renamed from isAuthenticated

			// IP address for session tracking
			ipAddress: options?.ipAddress || null,

			// Full request data for context
			capabilities: options?.capabilities ? stringifyRedacted(options.capabilities) : null,
			clientSessionId: options?.clientSessionId || null,
			requestId: options?.requestId || null,
			protocolEra: options?.protocolEra || null,
			protocolVersion: options?.protocolVersion || null,
			userHash: options?.userHash || null,
			requestJson: options?.requestJson
				? stringifyRedacted(options.requestJson)
				: JSON.stringify({ methodName, sessionId }),
			mcpServerSessionId,
		},
		'System event logged'
	);
}

/**
 * Log Gradio API calls with timing, success/error status, and response size
 */
export function logGradioEvent(
	endpointName: string,
	sessionId: string,
	options: {
		durationMs: number;
		isAuthenticated?: boolean;
		clientName?: string;
		clientVersion?: string;
		success: boolean;
		error?: unknown;
		responseSizeBytes?: number;
		notificationCount?: number;
		isDynamic?: boolean;
		clientSessionId?: string;
		requestId?: string;
		protocolEra?: 'legacy' | 'modern';
		protocolVersion?: string;
		clientCapabilities?: Record<string, unknown>;
		userHash?: string;
	}
): void {
	if (!gradioLogger) {
		return;
	}

	const mcpServerSessionId = getMcpServerSessionId();

	// Normalize error to a readable string
	let errorString: string | null = null;
	if (options.error !== undefined && options.error !== null) {
		if (typeof options.error === 'string') {
			errorString = options.error;
		} else if (options.error instanceof Error) {
			errorString = options.error.message;
		} else {
			try {
				errorString = JSON.stringify(options.error);
			} catch {
				errorString = String(options.error);
			}
		}
	}

	gradioLogger.info(
		{
			sessionId: options.clientSessionId ?? (options.protocolEra === 'modern' ? null : sessionId),
			requestId: options.requestId ?? (options.protocolEra === 'modern' ? sessionId : null),
			protocolEra: options.protocolEra || null,
			protocolVersion: options.protocolVersion || null,
			clientCapabilities: options.clientCapabilities ? stringifyRedacted(options.clientCapabilities) : null,
			userHash: options.userHash || null,
			endpointName, // e.g., "user/repo"
			name: options.clientName || null,
			version: options.clientVersion || null,
			authorized: options.isAuthenticated ?? false,
			durationMs: options.durationMs,
			success: options.success,
			error: errorString,
			responseSizeBytes: options.responseSizeBytes || null,
			notificationCount: options.notificationCount || 0,
			isDynamic: options.isDynamic ?? false,
			mcpServerSessionId,
		},
		'Gradio event logged'
	);
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) {
		return redactHfTokens(`${error.name}: ${error.message}`);
	}
	if (typeof error === 'string') {
		return redactHfTokens(error);
	}
	try {
		return stringifyRedacted(error);
	} catch {
		return redactHfTokens(String(error));
	}
}

function stringifyRedacted(value: unknown): string {
	return JSON.stringify(redactSensitiveLogValues(value));
}
