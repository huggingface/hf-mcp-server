import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';
import { HfApiError } from '@llmindset/hf-mcp';
import {
	EVENTS_LIST_METHOD,
	EVENTS_POLL_METHOD,
	eventsNameHeaderMismatch,
	JOB_STATUS_CHANGED,
	jobEventsEnabled,
	registerJobEvents,
	supportsEventsProtocol,
	type JobStatusReader,
} from '../../src/server/events/job-events.js';

type RequestHandler = (params: Record<string, unknown>) => unknown;
type Job = Awaited<ReturnType<JobStatusReader['getJob']>>;

interface PollResult {
	resultType: string;
	events: Array<{ eventId: string; name: string; timestamp: string; data: Record<string, unknown> }>;
	cursor: string;
	truncated: boolean;
	hasMore: boolean;
	nextPollMs: number;
}

function setup(getJob: JobStatusReader['getJob']): {
	list: RequestHandler;
	poll: (params: Record<string, unknown>) => Promise<PollResult>;
	calls: Array<[string, string | undefined]>;
} {
	const handlers = new Map<string, RequestHandler>();
	const server = {
		server: {
			setRequestHandler(method: string, _schemas: unknown, handler: RequestHandler) {
				handlers.set(method, handler);
			},
		},
	} as unknown as McpServer;
	const calls: Array<[string, string | undefined]> = [];
	registerJobEvents(server, {
		hfToken: 'hf_test',
		username: 'alice',
		jobs: {
			getJob: (jobId, namespace) => {
				calls.push([jobId, namespace]);
				return getJob(jobId, namespace);
			},
		},
		now: () => new Date('2026-11-12T10:00:00Z'),
	});
	const list = handlers.get(EVENTS_LIST_METHOD);
	const poll = handlers.get(EVENTS_POLL_METHOD);
	if (!list || !poll) throw new Error('event handlers were not registered');
	return { list, poll: (params) => poll(params) as Promise<PollResult>, calls };
}

function job(stage: string, extra: Partial<Job> = {}): Job {
	return { id: 'job-1', status: { stage }, owner: { name: 'alice' }, ...extra };
}

describe('job events', () => {
	afterEach(() => {
		delete process.env.MCP_EVENTS_ENABLED;
	});

	it('is opt-in and limited to the 2026-07-28 protocol and later', () => {
		expect(jobEventsEnabled()).toBe(false);
		process.env.MCP_EVENTS_ENABLED = 'true';
		expect(jobEventsEnabled()).toBe(true);

		expect(supportsEventsProtocol(undefined)).toBe(false);
		expect(supportsEventsProtocol('2025-11-25')).toBe(false);
		expect(supportsEventsProtocol('2026-07-28')).toBe(true);
	});

	it('requires Mcp-Name to match the event name on events/poll only', () => {
		const poll = { method: EVENTS_POLL_METHOD, params: { name: JOB_STATUS_CHANGED } };
		expect(eventsNameHeaderMismatch(poll, JOB_STATUS_CHANGED)).toBeNull();
		const encoded = `=?base64?${Buffer.from(JOB_STATUS_CHANGED).toString('base64')}?=`;
		expect(eventsNameHeaderMismatch(poll, encoded)).toBeNull();
		expect(eventsNameHeaderMismatch(poll, undefined)).toMatch(/required/);
		expect(eventsNameHeaderMismatch(poll, 'job.deleted')).toMatch(/does not match/);
		expect(eventsNameHeaderMismatch({ method: EVENTS_LIST_METHOD, params: {} }, undefined)).toBeNull();
		expect(eventsNameHeaderMismatch({ method: EVENTS_POLL_METHOD, params: {} }, undefined)).toBeNull();
		expect(eventsNameHeaderMismatch({ method: 'tools/call', params: { name: 'x' } }, undefined)).toBeNull();
	});

	it('lists one poll-only event type', () => {
		const { list } = setup(() => Promise.resolve(job('RUNNING')));

		const result = list({}) as { resultType: string; events: Array<Record<string, unknown>> };

		expect(result.resultType).toBe('complete');
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({ name: JOB_STATUS_CHANGED, delivery: ['poll'] });
		expect(result.events[0]?.inputSchema).toMatchObject({ required: ['job_id'] });
	});

	it('starts from now when no cursor is supplied', async () => {
		const { poll, calls } = setup(() => Promise.resolve(job('RUNNING')));

		const result = await poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1' } });

		expect(result).toEqual({
			resultType: 'complete',
			events: [],
			cursor: 'RUNNING',
			truncated: false,
			hasMore: false,
			nextPollMs: 15_000,
		});
		expect(calls).toEqual([['job-1', undefined]]);
	});

	it('reports nothing while the stage matches the cursor', async () => {
		const { poll } = setup(() => Promise.resolve(job('RUNNING')));

		const result = await poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1' }, cursor: 'RUNNING' });

		expect(result.events).toEqual([]);
		expect(result.cursor).toBe('RUNNING');
	});

	it('delivers one event when the stage changes and then slows polling', async () => {
		const { poll, calls } = setup(() =>
			Promise.resolve(
				job('ERROR', {
					status: { stage: 'ERROR', message: 'exit code 1' },
					url: 'https://huggingface.co/jobs/acme/job-1',
					finishedAt: '2026-11-12T09:59:00Z',
				})
			)
		);

		const result = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1', namespace: 'acme' },
			cursor: 'RUNNING',
		});

		expect(result.events).toEqual([
			{
				eventId: 'job-1:ERROR',
				name: JOB_STATUS_CHANGED,
				timestamp: '2026-11-12T09:59:00Z',
				data: {
					job_id: 'job-1',
					namespace: 'acme',
					stage: 'ERROR',
					message: 'exit code 1',
					url: 'https://huggingface.co/jobs/acme/job-1',
				},
			},
		]);
		expect(result.cursor).toBe('ERROR');
		expect(result.nextPollMs).toBe(600_000);
		expect(calls).toEqual([['job-1', 'acme']]);

		const repeat = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1', namespace: 'acme' },
			cursor: result.cursor,
		});
		expect(repeat.events).toEqual([]);
	});

	it('rejects unknown event names and bad arguments before calling the Hub', async () => {
		const { poll, calls } = setup(() => Promise.resolve(job('RUNNING')));

		await expect(poll({ name: 'job.deleted', arguments: { job_id: 'job-1' } })).rejects.toMatchObject({
			code: -32023,
			data: { kind: 'event' },
		});
		await expect(poll({ name: JOB_STATUS_CHANGED })).rejects.toMatchObject({
			code: ProtocolErrorCode.InvalidParams,
		});
		await expect(
			poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1', namespace: 7 } })
		).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		expect(calls).toEqual([]);
	});

	it('maps Hub failures onto protocol errors', async () => {
		const failing = (status: number) =>
			setup(() => Promise.reject(new HfApiError('failed', status, 'status text'))).poll({
				name: JOB_STATUS_CHANGED,
				arguments: { job_id: 'job-1' },
				cursor: 'RUNNING',
			});

		await expect(failing(403)).rejects.toMatchObject({ code: -32024 });
		await expect(failing(401)).rejects.toMatchObject({ code: -32024 });
		await expect(failing(404)).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		await expect(failing(503)).rejects.toBeInstanceOf(HfApiError);
	});
});
