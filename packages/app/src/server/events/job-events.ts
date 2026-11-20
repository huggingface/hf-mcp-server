import { z } from 'zod';
import { ProtocolError, ProtocolErrorCode, type McpServer, type ServerResult } from '@modelcontextprotocol/server';
import { HfApiError, JobsApiClient } from '@llmindset/hf-mcp';
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

const EventsListParamsSchema = z.looseObject({
	cursor: z.string().optional(),
});

const EventsPollParamsSchema = z.looseObject({
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).optional(),
	cursor: z.string().nullish(),
});

const JOB_STATUS_CHANGED_DESCRIPTOR = {
	name: JOB_STATUS_CHANGED,
	description:
		'Fires when a Hugging Face Job changes stage, for example from RUNNING to COMPLETED or ERROR. ' +
		'Subscribe after starting a job to learn when it finishes without calling hf_jobs inspect.',
	delivery: ['poll'],
	inputSchema: {
		type: 'object',
		properties: {
			job_id: { type: 'string', description: 'Job ID returned by hf_jobs run' },
			namespace: {
				type: 'string',
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
		finishedAt?: string;
	}>;
}

interface RegisterJobEventsOptions {
	hfToken: string;
	username?: string;
	/** Test seam; defaults to the Hub Jobs API. */
	jobs?: JobStatusReader;
	now?: () => Date;
}

/**
 * SEP-3415 requires `Mcp-Name` to equal `params.name` on events/poll. The SDK checks
 * this header only for its own name-bearing methods, so the transport calls this.
 * Returns a reason when the request must be rejected with 400 HeaderMismatch.
 */
export function eventsNameHeaderMismatch(body: unknown, header: string | string[] | undefined): string | null {
	const request = body as { method?: unknown; params?: { name?: unknown } } | undefined;
	const name = request?.params?.name;
	// A missing or non-string name is the handler's InvalidParams, not a header problem.
	if (request?.method !== EVENTS_POLL_METHOD || typeof name !== 'string') return null;
	if (typeof header !== 'string' || !header) return 'Mcp-Name header is required for events/poll';
	const encoded = /^=\?base64\?(.*)\?=$/.exec(header);
	const value = encoded ? Buffer.from(encoded[1] ?? '', 'base64').toString('utf8') : header;
	return value === name ? null : 'Mcp-Name header does not match params.name';
}

/** Events are opt-in while the extension is experimental. */
export function jobEventsEnabled(): boolean {
	return process.env.MCP_EVENTS_ENABLED === 'true';
}

/** SEP-3415 is defined for protocol revision 2026-07-28 and later. */
export function supportsEventsProtocol(protocolVersion: string | undefined): boolean {
	return protocolVersion !== undefined && protocolVersion >= '2026-07-28';
}

export function registerJobEvents(server: McpServer, options: RegisterJobEventsOptions): void {
	const jobs = options.jobs ?? new JobsApiClient(options.hfToken, options.username);
	const now = options.now ?? (() => new Date());

	server.server.setRequestHandler(
		EVENTS_LIST_METHOD,
		{ params: EventsListParamsSchema },
		(): ServerResult => ({ resultType: 'complete', events: [JOB_STATUS_CHANGED_DESCRIPTOR] }) as ServerResult
	);

	server.server.setRequestHandler(
		EVENTS_POLL_METHOD,
		{ params: EventsPollParamsSchema },
		async ({ name, arguments: args, cursor }): Promise<ServerResult> => {
			if (name !== JOB_STATUS_CHANGED) {
				throw new ProtocolError(NOT_FOUND as ProtocolErrorCode, 'NotFound', { kind: 'event' });
			}
			const jobId = args?.job_id;
			const namespace = args?.namespace;
			if (typeof jobId !== 'string' || !jobId) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'job_id is required');
			}
			if (namespace !== undefined && typeof namespace !== 'string') {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'namespace must be a string');
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
				throw error;
			}

			const stage = job.status.stage;
			// The cursor is the last stage the client saw. No cursor means "start from now".
			// A job that passes through several stages between polls reports only the latest.
			const changed = typeof cursor === 'string' && cursor !== stage;
			const owner = namespace ?? job.owner?.name ?? options.username;
			return {
				resultType: 'complete',
				events: changed
					? [
							{
								eventId: `${job.id}:${stage}`,
								name: JOB_STATUS_CHANGED,
								// The Jobs API reports when a job finished but not when it entered other
								// stages, so those events carry the time of the poll that saw them.
								timestamp: (TERMINAL_STAGES.has(stage) && job.finishedAt) || now().toISOString(),
								data: {
									job_id: job.id,
									...(owner ? { namespace: owner } : {}),
									stage,
									...(job.status.message ? { message: job.status.message } : {}),
									...(job.url ? { url: job.url } : {}),
								},
							},
						]
					: [],
				cursor: stage,
				truncated: false,
				hasMore: false,
				nextPollMs: TERMINAL_STAGES.has(stage) ? TERMINAL_POLL_MS : ACTIVE_POLL_MS,
			} as ServerResult;
		}
	);

	logger.debug('registered job events');
}
