import pino, { type Logger, type LoggerOptions } from 'pino';
import { registerTransportLogger } from './transport-loggers.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SERVER_BUILD_SHA, SERVER_VERSION } from '../server-build-info.js';
import { getMcpServerSessionId } from './query-logger.js';
import { forward, isClusterWorker } from '../cluster/ipc.js';

export type SkillEventName = 'skills/list' | 'skills/get' | 'skills/resource-read' | 'skills/directory-read';

export interface SkillEventLoggerOptions {
	clientSessionId?: string;
	requestId?: string;
	protocolEra: 'legacy' | 'modern';
	protocolVersion?: string;
	userHash?: string;
	isAuthenticated: boolean;
	clientName?: string;
	clientVersion?: string;
	durationMs: number;
	success: boolean;
	cursorSupplied: boolean;
	targetUri?: string;
	responseItemCount?: number;
}

export interface SkillLogEntry {
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
	methodName: SkillEventName;
	authorized: boolean;
	durationMs: number;
	success: boolean;
	cursorSupplied: boolean;
	targetUri: string | null;
	responseItemCount: number | null;
}

export type SkillEventLogger = (methodName: SkillEventName, options: SkillEventLoggerOptions) => void;

const SKILL_LOGS_ENABLED = (process.env.LOG_SKILL_EVENTS ?? 'true').toLowerCase() === 'true';
const DATASET_CONFIGURED = !!process.env.LOGGING_DATASET_ID;
const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const HF_TOKEN_CONFIGURED = Boolean(process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN);
const SKILL_DATASET_ACTIVE = !IS_TEST_ENV && SKILL_LOGS_ENABLED && DATASET_CONFIGURED && HF_TOKEN_CONFIGURED;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createSkillLogger(): Logger | null {
	if (IS_TEST_ENV || isClusterWorker) {
		return null;
	}
	if (!SKILL_LOGS_ENABLED || !DATASET_CONFIGURED) {
		return null;
	}

	const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;
	if (!hfToken) {
		console.warn(
			'[Skill Logger] Skills event logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)'
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
					options: { sync: false, logType: 'Skill' },
				},
			}),
			{ datasetTargets: 1 }
		);
	} catch (error) {
		console.error('[Skill Logger] Failed to setup Skills event logging transport:', error);
		return null;
	}
}

const skillLogger = createSkillLogger();

const emitSkillLog = forward('log.skill', (entry: SkillLogEntry): void => {
	skillLogger?.info(entry, 'Skill event logged');
});

/**
 * Build an allowlisted event row. The targeted skill/resource URI is retained
 * for product usage analysis; cursor values, response bodies, frontmatter,
 * content, and error messages are deliberately not accepted.
 */
export function buildSkillLogEntry(methodName: SkillEventName, options: SkillEventLoggerOptions): SkillLogEntry {
	const responseItemCount =
		options.responseItemCount !== undefined &&
		Number.isSafeInteger(options.responseItemCount) &&
		options.responseItemCount >= 0
			? options.responseItemCount
			: null;

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
		authorized: options.isAuthenticated,
		durationMs: Math.max(0, Math.round(options.durationMs)),
		success: options.success,
		cursorSupplied: options.cursorSupplied,
		targetUri: options.targetUri ?? null,
		responseItemCount,
	};
}

export function logSkillEvent(methodName: SkillEventName, options: SkillEventLoggerOptions): void {
	if (!skillLogger && !(isClusterWorker && SKILL_DATASET_ACTIVE)) {
		return;
	}
	emitSkillLog(buildSkillLogEntry(methodName, options));
}
