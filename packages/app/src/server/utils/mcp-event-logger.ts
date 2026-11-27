import pino, { type Logger, type LoggerOptions } from 'pino';
import { registerTransportLogger } from './transport-loggers.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SERVER_BUILD_SHA, SERVER_VERSION } from '../server-build-info.js';
import { getMcpServerSessionId } from './query-logger.js';
import { forward, isClusterWorker } from '../cluster/ipc.js';
import type { EventMetricMethod, EventMetricOutcome } from '../../shared/events-metrics.js';

export interface McpEventLoggerOptions {
	clientSessionId?: string;
	requestId?: string;
	protocolEra: 'legacy' | 'modern';
	protocolVersion?: string;
	userHash?: string;
	isAuthenticated: boolean;
	clientName?: string;
	clientVersion?: string;
	eventName?: string;
	durationMs: number;
	success: boolean;
	outcome: EventMetricOutcome;
	errorCode?: number;
	cursorSupplied: boolean;
	maxAgeMsSupplied: boolean;
	deliveredEventCount?: number;
	truncated?: boolean;
}

export interface McpEventLogEntry {
	mcpServerSessionId: string;
	serverVersion: string;
	serverBuildSha: string;
	clientSessionId: string | null;
	requestId: string | null;
	protocolEra: 'legacy' | 'modern';
	protocolVersion: string | null;
	userHash: string | null;
	name: string | null;
	version: string | null;
	methodName: EventMetricMethod;
	eventName: string | null;
	authorized: boolean;
	durationMs: number;
	success: boolean;
	outcome: EventMetricOutcome;
	errorCode: number | null;
	cursorSupplied: boolean;
	maxAgeMsSupplied: boolean;
	deliveredEventCount: number | null;
	truncated: boolean | null;
}

export type McpEventLogger = (methodName: EventMetricMethod, options: McpEventLoggerOptions) => void;

const EVENT_LOGS_ENABLED = (process.env.LOG_MCP_EVENTS ?? 'true').toLowerCase() === 'true';
const DATASET_CONFIGURED = !!process.env.LOGGING_DATASET_ID;
const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const HF_TOKEN_CONFIGURED = Boolean(process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN);
const EVENT_DATASET_ACTIVE = !IS_TEST_ENV && EVENT_LOGS_ENABLED && DATASET_CONFIGURED && HF_TOKEN_CONFIGURED;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createMcpEventLogger(): Logger | null {
	if (IS_TEST_ENV || isClusterWorker) {
		return null;
	}
	if (!EVENT_LOGS_ENABLED || !DATASET_CONFIGURED) {
		return null;
	}

	const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;
	if (!hfToken) {
		console.warn(
			'[Event Logger] MCP event protocol logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)'
		);
		return null;
	}

	try {
		const transportPath = join(__dirname, 'hf-dataset-transport.js');
		const baseOptions: LoggerOptions = {
			level: 'info',
			timestamp: pino.stdTimeFunctions.isoTime,
		};
		return registerTransportLogger(
			pino({
				...baseOptions,
				transport: {
					target: transportPath,
					options: { sync: false, logType: 'Event' },
				},
			}),
			{ datasetTargets: 1 }
		);
	} catch (error) {
		console.error('[Event Logger] Failed to setup MCP event protocol logging transport:', error);
		return null;
	}
}

const mcpEventLogger = createMcpEventLogger();

const emitMcpEventLog = forward('log.mcpEvent', (entry: McpEventLogEntry): void => {
	mcpEventLogger?.info(entry, 'MCP event protocol request logged');
});

/**
 * Build an allowlisted event-protocol log row. Normalized event names and
 * outcome classifications are retained for adoption analysis; job IDs,
 * namespaces, cursor values, event payloads, and error messages are
 * deliberately not accepted.
 */
export function buildMcpEventLogEntry(methodName: EventMetricMethod, options: McpEventLoggerOptions): McpEventLogEntry {
	const deliveredEventCount =
		options.deliveredEventCount !== undefined &&
		Number.isSafeInteger(options.deliveredEventCount) &&
		options.deliveredEventCount >= 0
			? options.deliveredEventCount
			: null;
	const errorCode =
		options.errorCode !== undefined && Number.isSafeInteger(options.errorCode) ? options.errorCode : null;

	return {
		mcpServerSessionId: getMcpServerSessionId(),
		serverVersion: SERVER_VERSION,
		serverBuildSha: SERVER_BUILD_SHA,
		clientSessionId: options.clientSessionId ?? null,
		requestId: options.requestId ?? null,
		protocolEra: options.protocolEra,
		protocolVersion: options.protocolVersion ?? null,
		userHash: options.userHash ?? null,
		name: options.clientName ?? null,
		version: options.clientVersion ?? null,
		methodName,
		eventName: options.eventName ?? null,
		authorized: options.isAuthenticated,
		durationMs: Math.max(0, Math.round(options.durationMs)),
		success: options.success,
		outcome: options.outcome,
		errorCode,
		cursorSupplied: options.cursorSupplied,
		maxAgeMsSupplied: options.maxAgeMsSupplied,
		deliveredEventCount,
		truncated: typeof options.truncated === 'boolean' ? options.truncated : null,
	};
}

export function logMcpEvent(methodName: EventMetricMethod, options: McpEventLoggerOptions): void {
	if (!mcpEventLogger && !(isClusterWorker && EVENT_DATASET_ACTIVE)) {
		return;
	}
	emitMcpEventLog(buildMcpEventLogEntry(methodName, options));
}
