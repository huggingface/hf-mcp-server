import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';
import { HfApiError, JobsApiClient } from '@llmindset/hf-mcp';
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
		hfToken: 'hf_test_secret_token',
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

	it('is opt-in and limited to modern 2026-07-28 protocol and later', () => {
		expect(jobEventsEnabled()).toBe(false);
		process.env.MCP_EVENTS_ENABLED = 'true';
		expect(jobEventsEnabled()).toBe(true);

		expect(supportsEventsProtocol(undefined)).toBe(false);
		expect(supportsEventsProtocol('unknown')).toBe(false);
		expect(supportsEventsProtocol('2025-11-25')).toBe(false);
		expect(supportsEventsProtocol('2026-07-28')).toBe(true);
		expect(supportsEventsProtocol('2026-07-28', 'legacy')).toBe(false);
	});

	it('requires Mcp-Name to match the event name on valid modern events/poll requests', () => {
		const poll = {
			jsonrpc: '2.0',
			id: 1,
			method: EVENTS_POLL_METHOD,
			params: {
				name: JOB_STATUS_CHANGED,
				_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
			},
		};
		const stdHeaders = { protocolVersion: '2026-07-28', mcpMethod: EVENTS_POLL_METHOD };

		expect(eventsNameHeaderMismatch(poll, JOB_STATUS_CHANGED, stdHeaders)).toBeNull();
		expect(eventsNameHeaderMismatch(poll, `  ${JOB_STATUS_CHANGED}	`, stdHeaders)).toBeNull();
		const encoded = `=?base64?${Buffer.from(JOB_STATUS_CHANGED).toString('base64')}?=`;
		expect(eventsNameHeaderMismatch(poll, encoded, stdHeaders)).toBeNull();
		expect(eventsNameHeaderMismatch(poll, undefined, stdHeaders)).toMatch(/required/);
		expect(eventsNameHeaderMismatch(poll, [JOB_STATUS_CHANGED], stdHeaders)).toMatch(/required/);
		expect(eventsNameHeaderMismatch(poll, '=?base64?not valid!?=', stdHeaders)).toMatch(/invalid Base64/i);
		expect(eventsNameHeaderMismatch(poll, '=?base64?//8=?=', stdHeaders)).toMatch(/invalid Base64/i);
		expect(eventsNameHeaderMismatch(poll, 'job.deleted', stdHeaders)).toMatch(/does not match/);

		// Empty event name with matching empty header passes header check so handler can return NotFound.
		expect(eventsNameHeaderMismatch({ method: EVENTS_POLL_METHOD, params: { name: '' } }, '')).toBeNull();

		// Defers to SDK inbound ladder when earlier envelope or standard headers are invalid.
		expect(
			eventsNameHeaderMismatch(
				{ jsonrpc: '2.0', method: EVENTS_POLL_METHOD, params: poll.params },
				undefined,
				stdHeaders
			)
		).toBeNull();
		expect(
			eventsNameHeaderMismatch(
				{
					...poll,
					params: {
						name: JOB_STATUS_CHANGED,
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientInfo': 'malformed',
						},
					},
				},
				undefined,
				stdHeaders
			)
		).toBeNull();
		expect(eventsNameHeaderMismatch(poll, undefined, { mcpMethod: EVENTS_POLL_METHOD })).toBeNull();
		expect(eventsNameHeaderMismatch(poll, undefined, { protocolVersion: '2026-07-28' })).toBeNull();

		expect(eventsNameHeaderMismatch({ method: EVENTS_LIST_METHOD, params: {} }, undefined)).toBeNull();
		expect(eventsNameHeaderMismatch({ method: EVENTS_POLL_METHOD, params: {} }, undefined)).toBeNull();
		expect(eventsNameHeaderMismatch({ method: 'tools/call', params: { name: 'x' } }, undefined)).toBeNull();
	});

	it('lists one profile-neutral poll-only event type and rejects cursors', () => {
		const { list } = setup(() => Promise.resolve(job('RUNNING')));

		const result = list({}) as { resultType: string; events: Array<Record<string, unknown>> };

		expect(result.resultType).toBe('complete');
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({ name: JOB_STATUS_CHANGED, delivery: ['poll'] });
		expect(result.events[0]?.inputSchema).toMatchObject({ required: ['job_id'] });
		expect(String(result.events[0]?.description)).toContain('once=false');
		expect(String(result.events[0]?.description)).not.toContain('hf_jobs inspect');
		expect(result.events[0]?.payloadSchema).toMatchObject({
			properties: {
				stage: {
					type: 'string',
					description: expect.stringContaining('COMPLETED'),
				},
			},
		});
		expect(list({ cursor: null })).toEqual(result);
		expect(() => list({ cursor: 'stale' })).toThrowError(
			expect.objectContaining({ code: ProtocolErrorCode.InvalidParams })
		);
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

	it('uses startedAt when entering RUNNING and finishedAt on terminal stages', async () => {
		const { poll } = setup(() =>
			Promise.resolve(
				job('RUNNING', {
					startedAt: '2026-11-12T09:58:00Z',
				})
			)
		);

		const running = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1' },
			cursor: 'SCHEDULING',
		});
		expect(running.events[0]?.timestamp).toBe('2026-11-12T09:58:00Z');
		expect(running.nextPollMs).toBe(15_000);
	});

	it('delivers one redacted event when the stage changes and then slows polling', async () => {
		const { poll, calls } = setup(() =>
			Promise.resolve(
				job('ERROR', {
					status: {
						stage: 'ERROR',
						message: 'exit code 1 with env super_secret_env and token hf_test_secret_token',
					},
					environment: { API_KEY: 'super_secret_env' },
					secrets: { DB_PASS: 'db_pw_secret' },
					url: 'https://huggingface.co/jobs/acme/job-1?pw=db_pw_secret',
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
					message: 'exit code 1 with env <redacted> and token <redacted>',
					url: 'https://huggingface.co/jobs/acme/job-1?pw=<redacted>',
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

	it('honors maxAgeMs and resets unrecognized cursors with truncated: true', async () => {
		const { poll } = setup(() =>
			Promise.resolve(
				job('COMPLETED', {
					finishedAt: '2026-11-12T09:50:00Z', // 10 minutes before now (10:00:00Z)
				})
			)
		);

		const stale = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1' },
			cursor: 'RUNNING',
			maxAgeMs: 60_000,
		});
		expect(stale).toEqual({
			resultType: 'complete',
			events: [],
			cursor: 'COMPLETED',
			truncated: true,
			hasMore: false,
			nextPollMs: 600_000,
		});

		const withinWindow = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1' },
			cursor: 'RUNNING',
			maxAgeMs: 900_000,
		});
		expect(withinWindow.events).toHaveLength(1);
		expect(withinWindow.truncated).toBe(false);

		// Initial cursor (null) ignores maxAgeMs and starts from now with truncated: false.
		const initial = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1' },
			cursor: null,
			maxAgeMs: 1_000,
		});
		expect(initial.events).toEqual([]);
		expect(initial.truncated).toBe(false);

		const corrupted = await poll({
			name: JOB_STATUS_CHANGED,
			arguments: { job_id: 'job-1' },
			cursor: '',
		});
		expect(corrupted).toEqual({
			resultType: 'complete',
			events: [],
			cursor: 'COMPLETED',
			truncated: true,
			hasMore: false,
			nextPollMs: 600_000,
		});
	});

	it('rejects unknown event names and bad or path-traversal arguments before calling the Hub', async () => {
		const { poll, calls } = setup(() => Promise.resolve(job('RUNNING')));

		await expect(poll({ name: 'job.deleted', arguments: { job_id: 'job-1' } })).rejects.toMatchObject({
			code: -32023,
			data: { kind: 'event' },
		});
		await expect(poll({ name: JOB_STATUS_CHANGED })).rejects.toMatchObject({
			code: ProtocolErrorCode.InvalidParams,
		});
		await expect(poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: '../secret' } })).rejects.toMatchObject({
			code: ProtocolErrorCode.InvalidParams,
		});
		await expect(
			poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1', namespace: '..' } })
		).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		await expect(
			poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1', namespace: 'org/sub' } })
		).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		await expect(
			poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1', namespace: 7 } })
		).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		expect(calls).toEqual([]);
	});

	it('maps Hub failures onto sanitized protocol errors', async () => {
		const failing = (status: number) =>
			setup(() => Promise.reject(new HfApiError('failed', status, 'status text', 'raw upstream body'))).poll({
				name: JOB_STATUS_CHANGED,
				arguments: { job_id: 'job-1' },
				cursor: 'RUNNING',
			});

		await expect(failing(403)).rejects.toMatchObject({ code: -32024 });
		await expect(failing(401)).rejects.toMatchObject({ code: -32024 });
		await expect(failing(404)).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		await expect(failing(503)).rejects.toMatchObject({
			code: ProtocolErrorCode.InternalError,
			message: 'Hub Jobs API error (503)',
		});
	});

	it('fails with InternalError without calling JobsApiClient when username and namespace are both absent', async () => {
		const handlers = new Map<string, RequestHandler>();
		const server = {
			server: {
				setRequestHandler(method: string, _schemas: unknown, handler: RequestHandler) {
					handlers.set(method, handler);
				},
			},
		} as unknown as McpServer;
		const getJobSpy = vi.spyOn(JobsApiClient.prototype, 'getJob');
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		try {
			registerJobEvents(server, {
				hfToken: 'hf_test_secret_token',
				username: undefined,
			});
			const poll = handlers.get(EVENTS_POLL_METHOD);
			if (!poll) throw new Error('event handler was not registered');

			await expect(
				poll({ name: JOB_STATUS_CHANGED, arguments: { job_id: 'job-1' } }) as Promise<PollResult>
			).rejects.toMatchObject({
				code: ProtocolErrorCode.InternalError,
				message: expect.stringContaining('Unable to resolve job namespace'),
			});
			expect(getJobSpy).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			getJobSpy.mockRestore();
			fetchSpy.mockRestore();
		}
	});
});
