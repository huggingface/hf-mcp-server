import { z } from 'zod';
import { ProtocolError, ProtocolErrorCode, type McpServer, type ServerResult } from '@modelcontextprotocol/server';
import {
	collectSensitiveValues,
	HfApiError,
	JobsApiClient,
	redactSensitiveText,
	type JobSecretsInfo,
} from '@llmindset/hf-mcp';
import { logger } from '../utils/logger.js';

// Experimental MCP Events extension (SEP-3415), poll delivery only.
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const EVENTS_LIST_METHOD = 'events/list';
export const EVENTS_POLL_METHOD = 'events/poll';
export const JOB_STATUS_CHANGED = 'job.status_changed';

// SEP-3415 error codes.
const NOT_FOUND = -32023;
const FORBIDDEN = -32024;

// Core transport code for a routing header that disagrees with the body.
export const HEADER_MISMATCH = -32020;

const TERMINAL_STAGES = new Set(['COMPLETED', 'CANCELED', 'ERROR', 'DELETED']);
const ACTIVE_POLL_MS = 15_000;
// A finished job cannot change stage again, so slow the client right down.
const TERMINAL_POLL_MS = 600_000;

const ISO_DATE_PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const STAGE_CURSOR_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

const EventsListParamsSchema = z.looseObject({
	cursor: z.string().optional(),
});

const EventsPollParamsSchema = z.looseObject({
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).optional(),
	cursor: z.string().nullish(),
	maxAgeMs: z.number().int().nonnegative().optional(),
	maxEvents: z.number().int().min(1).optional(),
});

const JOB_STATUS_CHANGED_DESCRIPTOR = {
	name: JOB_STATUS_CHANGED,
	description:
		'Fires when a Hugging Face Job run changes stage, for example from RUNNING to COMPLETED or ERROR. ' +
		'Subscribe after starting a job to learn when it finishes without polling job status tools.',
	delivery: ['poll'],
	inputSchema: {
		type: 'object',
		properties: {
			job_id: {
				type: 'string',
				minLength: 1,
				description: 'Job run ID returned when starting or listing a job (not a scheduled job ID)',
			},
			namespace: {
				type: 'string',
				minLength: 1,
				description: 'User or organization that owns the job. Defaults to the authenticated user.',
			},
		},
		required: ['job_id'],
	},
	payloadSchema: {
		type: 'object',
		properties: {
			job_id: { type: 'string' },
			namespace: { type: 'string' },
			// No enum: the Hub also reports stages such as SCHEDULING that its OpenAPI spec omits.
			stage: { type: 'string' },
			message: { type: 'string' },
			url: { type: 'string' },
		},
		required: ['job_id', 'stage'],
	},
};

/** The slice of the Jobs API client the poll handler needs. */
export interface JobStatusReader {
	getJob(
		jobId: string,
		namespace?: string
	): Promise<{
		id: string;
		status: { stage: string; message?: string | null };
		owner?: { name?: string };
		url?: string;
		startedAt?: string;
		finishedAt?: string;
		environment?: Record<string, string>;
		secrets?: JobSecretsInfo;
	}>;
}

interface RegisterJobEventsOptions {
	hfToken: string;
	username?: string;
	/** Test seam; defaults to the Hub Jobs API. */
	jobs?: JobStatusReader;
	now?: () => Date;
}

export interface ModernStandardHeaders {
	protocolVersion?: string | string[];
	mcpMethod?: string | string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip RFC 9110 optional whitespace (SP / HTAB) around a header field value. */
function stripHttpOws(value: string): string {
	let start = 0;
	while (start < value.length && (value.charCodeAt(start) === 9 || value.charCodeAt(start) === 32)) {
		start += 1;
	}
	let end = value.length;
	while (end > start && (value.charCodeAt(end - 1) === 9 || value.charCodeAt(end - 1) === 32)) {
		end -= 1;
	}
	return start === 0 && end === value.length ? value : value.slice(start, end);
}

function decodeMcpNameHeader(value: string): string | undefined {
	if (!(value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))) {
		return value;
	}
	const b64 = value.slice(BASE64_SENTINEL_PREFIX.length, value.length - BASE64_SENTINEL_SUFFIX.length);
	if (!BASE64_CANONICAL.test(b64)) return undefined;
	try {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return UTF8_FATAL_DECODER.decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * True only when the modern JSON-RPC envelope and preceding standard headers will pass
 * the SDK's inbound validation rungs, so we do not mask earlier ladder errors.
 */
function passesPrecedingModernLadderRungs(body: unknown, standardHeaders: ModernStandardHeaders): boolean {
	if (!isPlainObject(body) || body.jsonrpc !== '2.0') return false;
	if (typeof body.id !== 'string' && typeof body.id !== 'number') return false;
	if (!isPlainObject(body.params) || !isPlainObject(body.params._meta)) return false;

	const meta = body.params._meta;
	const claimedVersion = meta['io.modelcontextprotocol/protocolVersion'];
	if (typeof claimedVersion !== 'string' || !supportsEventsProtocol(claimedVersion, 'modern')) return false;

	const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
	if (
		clientInfo !== undefined &&
		(!isPlainObject(clientInfo) || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string')
	) {
		return false;
	}
	const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
	if (capabilities !== undefined && !isPlainObject(capabilities)) return false;
	const progressToken = meta.progressToken;
	if (progressToken !== undefined && typeof progressToken !== 'string' && typeof progressToken !== 'number') {
		return false;
	}

	if (
		typeof standardHeaders.protocolVersion !== 'string' ||
		stripHttpOws(standardHeaders.protocolVersion) !== claimedVersion
	) {
		return false;
	}
	if (typeof standardHeaders.mcpMethod !== 'string' || stripHttpOws(standardHeaders.mcpMethod) !== EVENTS_POLL_METHOD) {
		return false;
	}
	return true;
}

/**
 * SEP-3415 requires `Mcp-Name` to equal `params.name` on events/poll. The SDK checks
 * this header only for its own name-bearing methods, so the transport calls this.
 * Returns a reason when the request must be rejected with 400 HeaderMismatch.
 */
export function eventsNameHeaderMismatch(
	body: unknown,
	header: string | string[] | undefined,
	standardHeaders?: ModernStandardHeaders
): string | null {
	const request = body as { method?: unknown; params?: { name?: unknown } } | undefined;
	const name = request?.params?.name;
	// A missing or non-string name is the handler's InvalidParams, not a header problem.
	if (request?.method !== EVENTS_POLL_METHOD || typeof name !== 'string') return null;
	if (standardHeaders !== undefined && !passesPrecedingModernLadderRungs(body, standardHeaders)) return null;
	if (typeof header !== 'string') return 'Mcp-Name header is required for events/poll';
	const normalized = stripHttpOws(header);
	if (!normalized && name !== '') return 'Mcp-Name header is required for events/poll';
	const decoded = decodeMcpNameHeader(normalized);
	if (decoded === undefined) return 'Mcp-Name header carries an invalid Base64 sentinel value';
	return decoded === name ? null : 'Mcp-Name header does not match params.name';
}

/** Events are opt-in while the extension is experimental. */
export function jobEventsEnabled(): boolean {
	return process.env.MCP_EVENTS_ENABLED === 'true';
}

/** SEP-3415 is defined for modern-era protocol revision 2026-07-28 and later. */
export function supportsEventsProtocol(
	protocolVersion: string | undefined,
	protocolEra: 'modern' | 'legacy' = 'modern'
): boolean {
	return (
		protocolEra === 'modern' &&
		protocolVersion !== undefined &&
		ISO_DATE_PROTOCOL_VERSION.test(protocolVersion) &&
		protocolVersion >= '2026-07-28'
	);
}

export function registerJobEvents(server: McpServer, options: RegisterJobEventsOptions): void {
	const jobs = options.jobs ?? new JobsApiClient(options.hfToken, options.username);
	const now = options.now ?? (() => new Date());

	server.server.setRequestHandler(
		EVENTS_LIST_METHOD,
		{ params: EventsListParamsSchema },
		({ cursor }): ServerResult => {
			if (cursor !== undefined) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor');
			}
			return { resultType: 'complete', events: [JOB_STATUS_CHANGED_DESCRIPTOR] } as ServerResult;
		}
	);

	server.server.setRequestHandler(
		EVENTS_POLL_METHOD,
		{ params: EventsPollParamsSchema },
		async ({ name, arguments: args, cursor, maxAgeMs }): Promise<ServerResult> => {
			if (name !== JOB_STATUS_CHANGED) {
				throw new ProtocolError(NOT_FOUND as ProtocolErrorCode, 'NotFound', { kind: 'event' });
			}
			const jobId = args?.job_id;
			const namespace = args?.namespace;
			if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'job_id must be a valid job ID');
			}
			if (
				namespace !== undefined &&
				(typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace) || namespace === '.' || namespace === '..')
			) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'namespace must be a valid user or organization name');
			}

			let job: Awaited<ReturnType<JobStatusReader['getJob']>>;
			try {
				job = await jobs.getJob(jobId, namespace);
			} catch (error) {
				if (error instanceof HfApiError && (error.status === 401 || error.status === 403)) {
					throw new ProtocolError(FORBIDDEN as ProtocolErrorCode, 'Forbidden', { reason: 'No access to this job' });
				}
				if (error instanceof HfApiError && error.status === 404) {
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown job: ${jobId}`);
				}
				if (error instanceof HfApiError) {
					throw new ProtocolError(ProtocolErrorCode.InternalError, `Hub Jobs API error (${error.status ?? 'unknown'})`);
				}
				logger.warn({ err: error, jobId }, 'Unexpected failure polling job status');
				throw new ProtocolError(ProtocolErrorCode.InternalError, 'Failed to fetch job status');
			}

			const stage = job.status.stage;
			const nextPollMs = TERMINAL_STAGES.has(stage) ? TERMINAL_POLL_MS : ACTIVE_POLL_MS;

			// An unrecognised non-null cursor resets to the current stage with truncated: true per SEP-3415.
			if (typeof cursor === 'string' && !STAGE_CURSOR_PATTERN.test(cursor)) {
				return {
					resultType: 'complete',
					events: [],
					cursor: stage,
					truncated: true,
					hasMore: false,
					nextPollMs,
				} as ServerResult;
			}

			// The cursor is the last stage the client saw. No cursor means "start from now".
			// A job that passes through several stages between polls reports only the latest.
			const changed = typeof cursor === 'string' && cursor !== stage;
			if (!changed) {
				return {
					resultType: 'complete',
					events: [],
					cursor: stage,
					truncated: false,
					hasMore: false,
					nextPollMs,
				} as ServerResult;
			}

			const timestamp =
				(TERMINAL_STAGES.has(stage) && job.finishedAt) || (stage === 'RUNNING' && job.startedAt) || now().toISOString();

			if (maxAgeMs !== undefined) {
				const eventTime = Date.parse(timestamp);
				if (Number.isFinite(eventTime) && eventTime < now().getTime() - maxAgeMs) {
					return {
						resultType: 'complete',
						events: [],
						cursor: stage,
						truncated: true,
						hasMore: false,
						nextPollMs,
					} as ServerResult;
				}
			}

			const sensitive = collectSensitiveValues(job, [options.hfToken]);
			const message = job.status.message ? redactSensitiveText(job.status.message, sensitive) : undefined;
			const url = job.url ? redactSensitiveText(job.url, sensitive) : undefined;
			const owner = namespace ?? job.owner?.name ?? options.username;
			return {
				resultType: 'complete',
				events: [
					{
						eventId: `${job.id}:${stage}`,
						name: JOB_STATUS_CHANGED,
						timestamp,
						data: {
							job_id: job.id,
							...(owner ? { namespace: owner } : {}),
							stage,
							...(message ? { message } : {}),
							...(url ? { url } : {}),
						},
					},
				],
				cursor: stage,
				truncated: false,
				hasMore: false,
				nextPollMs,
			} as ServerResult;
		}
	);

	logger.debug('registered job events');
}
