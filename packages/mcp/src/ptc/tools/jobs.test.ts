import { afterEach, describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcTool } from '../core/tool.js';
import { JOBS_TOOLS } from './jobs.js';

const logsMock = vi.hoisted(() => vi.fn());
vi.mock('../../jobs/sse-handler.js', () => ({ fetchJobLogs: logsMock }));

/** fetchJobLogs stand-in: applies the caller's redaction like the real streamer does. */
function fakeLogs(logs: string[], rest: { finished: boolean; truncated: boolean; linesDropped?: boolean }) {
	logsMock.mockImplementation((_url: string, options: { redact?: (text: string) => string }) =>
		Promise.resolve({
			logs: logs.map((line) => options.redact?.(line) ?? line),
			linesDropped: false,
			...rest,
		})
	);
}

function tool(name: string): PtcTool {
	const found = JOBS_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

const TOKEN = 'hf_tokenvalue';
const ctxBase = { hfToken: TOKEN, username: 'alice' };

function job(overrides: Record<string, unknown> = {}) {
	return {
		id: 'job1',
		createdAt: '2026-11-16T00:00:00Z',
		dockerImage: 'python:3.12',
		command: ['python', '-c', 'print(1)'],
		environment: { MODE: 'sekrit-env-value' },
		// OpenAPI: secrets is an array of names.
		secrets: ['HF_TOKEN'],
		hfToken: TOKEN,
		flavor: 'cpu-basic',
		status: { stage: 'RUNNING', message: null },
		owner: { id: 'u1', name: 'alice', type: 'user', avatarUrl: 'x' },
		labels: { team: 'ml' },
		...overrides,
	};
}
function scheduled(overrides: Record<string, unknown> = {}) {
	return {
		id: 'sch1',
		schedule: '@daily',
		suspend: false,
		concurrency: false,
		createdAt: '2026-11-16T00:00:00Z',
		owner: { id: 'u1', name: 'alice', type: 'user' },
		jobSpec: {
			dockerImage: 'python:3.12',
			command: ['python', 'x.py'],
			environment: { A: 'value-a' },
			secrets: ['S'],
			flavor: 'cpu-basic',
			labels: { team: 'ml', env: 'prod' },
		},
		...overrides,
	};
}

interface Route {
	method?: string;
	path: string;
	body?: unknown;
	status?: number;
	headers?: Record<string, string>;
}
function router(routes: Route[]) {
	const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input, init) => {
		const url = new URL(input as string);
		const method = init?.method ?? 'GET';
		calls.push({ method, url, body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined });
		const route = routes.find((r) => r.path === url.pathname && (r.method ?? 'GET') === method);
		if (!route) return Promise.resolve(new Response('missing', { status: 404 }));
		if (route.body === undefined) return Promise.resolve(new Response(null, { status: route.status ?? 200 }));
		return Promise.resolve(Response.json(route.body, { status: route.status ?? 200, headers: route.headers }));
	});
	return { fetch, calls };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('hf_job_run', () => {
	it('builds a uv script spec, forwards the token as a secret and never echoes values', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		const { structured } = await callPtcTool(
			tool('hf_job_run'),
			{
				script: 'print("hi")\nprint("there")',
				dependencies: ['torch'],
				flavor: 'a10g-small',
				env: { MODE: 'sekrit-env-value' },
				forwardHfToken: true,
				volumes: ['hf://datasets/org/ds:/data:ro'],
				labels: { team: 'ml' },
				timeout: '2h',
			},
			{ ...ctxBase, fetch }
		);
		const body = calls[0]?.body as Record<string, unknown>;
		expect(body.dockerImage).toBe('ghcr.io/astral-sh/uv:python3.12-bookworm');
		expect((body.command as string[])[0]).toBe('/bin/sh');
		expect(String((body.command as string[])[2])).toContain('uv run --with torch');
		expect(body.secrets).toEqual({ HF_TOKEN: TOKEN });
		expect(body.timeoutSeconds).toBe(7200);
		expect(body.flavor).toBe('a10g-small');
		expect(body.volumes).toEqual([{ type: 'dataset', source: 'org/ds', mountPath: '/data', readOnly: true }]);
		expect(structured).toMatchObject({
			job: {
				kind: 'job',
				id: 'job1',
				namespace: 'alice',
				url: 'https://huggingface.co/jobs/alice/job1',
				environmentVariableNames: ['MODE'],
				secretNames: ['HF_TOKEN'],
				owner: 'alice',
			},
		});
		const text = JSON.stringify(structured);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain('sekrit-env-value');
	});

	it('runs a command in a Space image and follows logs when waitSeconds is set', async () => {
		const { fetch, calls } = router([
			{ method: 'POST', path: '/api/jobs/acme', body: job({ owner: { id: 'o', name: 'acme' } }) },
			{ path: '/api/jobs/acme/job1', body: job({ owner: { id: 'o', name: 'acme' }, status: { stage: 'COMPLETED' } }) },
		]);
		fakeLogs(['step 1', `token ${TOKEN}`], { finished: true, truncated: false });
		const { structured } = await callPtcTool(
			tool('hf_job_run'),
			{ command: ['python', 'app.py'], space: 'hf://spaces/acme/trainer', namespace: 'acme', waitSeconds: 5 },
			{ ...ctxBase, fetch }
		);
		expect((calls[0]?.body as Record<string, unknown>).spaceId).toBe('acme/trainer');
		expect(logsMock.mock.calls[0]?.[0]).toBe('https://huggingface.co/api/jobs/acme/job1/logs');
		expect(logsMock.mock.calls[0]?.[1]).toMatchObject({ maxDuration: 5000 });
		expect(structured).toMatchObject({
			job: { status: { stage: 'COMPLETED' } },
			logs: { lines: ['step 1', 'token <redacted>'], finished: true },
		});
	});

	it('does not report a submission when the paid POST fails', async () => {
		const { fetch } = router([{ method: 'POST', path: '/api/jobs/alice', status: 403 }]);
		await expect(
			callPtcTool(tool('hf_job_run'), { command: ['ls'], waitSeconds: 5 }, { ...ctxBase, fetch })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(logsMock).not.toHaveBeenCalled();
	});

	it.each(['logs', 'progress'])('keeps the paid submission when %s fails', async (failure) => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		const error = new Error(`private details: ${TOKEN}`);
		const onProgress = vi.fn();
		if (failure === 'logs') logsMock.mockRejectedValueOnce(error);
		else onProgress.mockRejectedValueOnce(error);

		const result = await callPtcTool(
			tool('hf_job_run'),
			{ command: ['ls'], waitSeconds: failure === 'logs' ? 5 : 0 },
			{ ...ctxBase, fetch, onProgress }
		);
		expect(result.isError).toBe(false);
		expect(result.structured).toMatchObject({
			job: { id: 'job1', url: 'https://huggingface.co/jobs/alice/job1' },
		});
		expect(result.structured.note).toContain('hf_job_logs');
		expect(result.structured.logs).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(calls.map((c) => c.method)).toEqual(['POST']);
	});

	it('preserves caller cancellation while following a submitted job without inviting a retry', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		const controller = new AbortController();
		logsMock.mockImplementationOnce(() => {
			controller.abort();
			throw controller.signal.reason;
		});
		await expect(
			callPtcTool(
				tool('hf_job_run'),
				{ command: ['ls'], waitSeconds: 5 },
				{ ...ctxBase, fetch, signal: controller.signal }
			)
		).rejects.toMatchObject({
			code: 'CANCELLED',
			retryable: false,
			message: 'Request cancelled after job job1 was submitted; do not resubmit it.',
		});
		expect(calls.map((c) => c.method)).toEqual(['POST']);
	});

	it('keeps collected logs and the submitted job if status refresh fails', async () => {
		const { fetch } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		fakeLogs(['step 1'], { finished: false, truncated: true });
		const { structured } = await callPtcTool(
			tool('hf_job_run'),
			{ command: ['ls'], waitSeconds: 5 },
			{ ...ctxBase, fetch }
		);
		expect(structured).toMatchObject({
			job: { id: 'job1' },
			logs: { lines: ['step 1'] },
		});
		expect(structured.note).toContain('hf_job_get');
	});

	it('runs a single-line inline script as code, and a .py path as a file', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		await callPtcTool(tool('hf_job_run'), { script: 'print("hi")' }, { ...ctxBase, fetch });
		const inline = (calls[0]?.body as { command: string[] }).command;
		expect(inline.slice(0, 2)).toEqual(['/bin/sh', '-lc']);
		expect(inline[2]).toContain(Buffer.from('print("hi")').toString('base64'));
		await callPtcTool(tool('hf_job_run'), { script: '/data/train.py' }, { ...ctxBase, fetch });
		expect((calls[1]?.body as { command: string[] }).command).toEqual(['uv', 'run', '/data/train.py']);
	});

	it('parses spelled-out timeouts and rejects unknown units', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		await callPtcTool(tool('hf_job_run'), { command: ['ls'], timeout: '30minutes' }, { ...ctxBase, fetch });
		expect((calls[0]?.body as { timeoutSeconds: number }).timeoutSeconds).toBe(1800);
		await expect(
			callPtcTool(tool('hf_job_run'), { command: ['ls'], timeout: '5x' }, { ...ctxBase, fetch })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		expect(calls).toHaveLength(1);
	});

	it('substitutes "$HF_TOKEN" only in secrets and only with forwardHfToken', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/jobs/alice', body: job() }]);
		const run = (input: Record<string, unknown>) =>
			callPtcTool(tool('hf_job_run'), { command: ['ls'], ...input }, { ...ctxBase, fetch });
		await expect(run({ secrets: { MY_TOKEN: '$HF_TOKEN' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(run({ env: { MY_TOKEN: '${HF_TOKEN}' }, forwardHfToken: true })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		expect(calls).toHaveLength(0);
		await run({ secrets: { MY_TOKEN: '$HF_TOKEN' }, env: { OTHER: '$HOME' }, forwardHfToken: true });
		const body = calls[0]?.body as { secrets: Record<string, string>; environment: Record<string, string> };
		expect(body.secrets).toEqual({ MY_TOKEN: TOKEN, HF_TOKEN: TOKEN });
		expect(body.environment).toEqual({ OTHER: '$HOME' });
		await run({ secrets: { PLAIN: 'value' } });
		expect((calls[1]?.body as { secrets: Record<string, string> }).secrets).toEqual({ PLAIN: 'value' });
	});

	it('reads a submitted job back by id when the POST response is not a full job', async () => {
		const { fetch, calls } = router([
			{ method: 'POST', path: '/api/jobs/alice', body: { id: 'job1' } },
			{ path: '/api/jobs/alice/job1', body: job() },
		]);
		const { structured } = await callPtcTool(tool('hf_job_run'), { command: ['ls'] }, { ...ctxBase, fetch });
		expect(structured).toMatchObject({ job: { id: 'job1', kind: 'job' } });
		expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
			'POST /api/jobs/alice',
			'GET /api/jobs/alice/job1',
		]);
		const failing = router([{ method: 'POST', path: '/api/jobs/alice', body: { id: 'job1' } }]);
		const error = await callPtcTool(
			tool('hf_job_run'),
			{ command: ['ls'] },
			{ ...ctxBase, fetch: failing.fetch }
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'UPSTREAM_RESPONSE', retryable: false });
		expect(String((error as Error).message)).toContain('job job1 was submitted');
	});

	it('requires exactly one of script or command', async () => {
		await expect(callPtcTool(tool('hf_job_run'), {}, ctxBase)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(callPtcTool(tool('hf_job_run'), { script: 'x.py', command: ['ls'] }, ctxBase)).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(callPtcTool(tool('hf_job_run'), { command: ['ls'], volumes: ['bad'] }, ctxBase)).rejects.toMatchObject(
			{ code: 'INVALID_ARGUMENT' }
		);
	});

	it('resolves the namespace via whoami when the context has no username', async () => {
		const { fetch, calls } = router([
			{ path: '/api/whoami-v2', body: { name: 'bob' } },
			{ method: 'POST', path: '/api/jobs/bob', body: job({ owner: { id: 'b', name: 'bob' } }) },
		]);
		await callPtcTool(tool('hf_job_run'), { command: 'echo hi' }, { hfToken: TOKEN, fetch });
		expect(calls.map((c) => c.url.pathname)).toEqual(['/api/whoami-v2', '/api/jobs/bob']);
	});
});

describe('hf_job_schedule', () => {
	it('posts schedule, suspend, concurrency and the job spec', async () => {
		const { fetch, calls } = router([{ method: 'POST', path: '/api/scheduled-jobs/alice', body: scheduled() }]);
		const { structured } = await callPtcTool(
			tool('hf_job_schedule'),
			{ schedule: '@daily', command: ['python', 'x.py'], concurrency: true },
			{ ...ctxBase, fetch }
		);
		expect(calls[0]?.body).toMatchObject({
			schedule: '@daily',
			suspend: false,
			concurrency: true,
			jobSpec: { command: ['python', 'x.py'], dockerImage: 'python:3.12' },
		});
		expect(structured).toMatchObject({
			scheduledJob: {
				kind: 'scheduled_job',
				id: 'sch1',
				schedule: '@daily',
				owner: 'alice',
				jobSpec: { environmentVariableNames: ['A'] },
			},
		});
		expect(JSON.stringify(structured)).not.toContain('value-a');
	});
});

describe('hf_jobs_list', () => {
	it('lists jobs with stage/label filters and an opaque cursor', async () => {
		const { fetch, calls } = router([
			{
				path: '/api/jobs/alice',
				body: [job()],
				headers: {
					link: '<https://huggingface.co/api/jobs/alice?stage=RUNNING&label=team%3Dml&cursor=abc>; rel="next"',
				},
			},
		]);
		const { structured } = await callPtcTool(
			tool('hf_jobs_list'),
			{ stagesAny: ['RUNNING'], labels: { team: 'ml' } },
			{ ...ctxBase, fetch }
		);
		expect(calls[0]?.url.searchParams.getAll('stage')).toEqual(['RUNNING']);
		expect(calls[0]?.url.searchParams.getAll('label')).toEqual(['team=ml']);
		expect(structured).toMatchObject({ returnedCount: 1, completeness: { hasMore: expect.any(Boolean) as boolean } });
		expect(typeof structured.nextCursor).toBe('string');
		expect(structured.nextCursor).not.toContain('abc');
	});

	it('lists scheduled jobs filtering extra labels locally and rejects stages', async () => {
		const { fetch, calls } = router([
			{
				path: '/api/scheduled-jobs/alice',
				body: [scheduled(), scheduled({ id: 'sch2', jobSpec: { ...scheduled().jobSpec, labels: { team: 'ml' } } })],
			},
		]);
		const { structured } = await callPtcTool(
			tool('hf_jobs_list'),
			{ kind: 'scheduled', labels: { team: 'ml', env: 'prod' } },
			{ ...ctxBase, fetch }
		);
		expect(calls[0]?.url.searchParams.getAll('label')).toEqual(['team=ml']);
		expect((structured.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['sch1']);
		await expect(
			callPtcTool(tool('hf_jobs_list'), { kind: 'scheduled', stagesAny: ['RUNNING'] }, { ...ctxBase, fetch })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	});
});

describe('hf_jobs_list paging (limit)', () => {
	it('slices the fixed upstream page by limit and resumes inside it, then on the next upstream page', async () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			job({ id: `job${String(i)}`, createdBy: { id: 'u2', name: 'bob', type: 'user' } })
		);
		const { fetch, calls } = router([
			{
				path: '/api/jobs/alice',
				body: rows,
				headers: { link: '<https://huggingface.co/api/jobs/alice?cursor=up2>; rel="next"' },
			},
		]);
		const first = await callPtcTool(tool('hf_jobs_list'), { limit: 3 }, { ...ctxBase, fetch });
		const ids = (out: typeof first) => (out.structured.items as Array<{ id: string }>).map((i) => i.id);
		expect(ids(first)).toEqual(['job0', 'job1', 'job2']);
		expect(first.structured.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ owner: 'alice', createdBy: 'bob' })])
		);
		expect(first.structured.completeness).toEqual({ hasMore: true });
		const second = await callPtcTool(
			tool('hf_jobs_list'),
			{ limit: 3, cursor: first.structured.nextCursor },
			{ ...ctxBase, fetch }
		);
		expect(ids(second)).toEqual(['job3', 'job4']);
		expect(calls[1]?.url.searchParams.get('cursor')).toBeNull();
		// The stub repeats the same Link header, which the third call refuses: only the request matters here.
		await callPtcTool(
			tool('hf_jobs_list'),
			{ limit: 3, cursor: second.structured.nextCursor },
			{ ...ctxBase, fetch }
		).catch(() => undefined);
		expect(calls[2]?.url.searchParams.get('cursor')).toBe('up2');
		await expect(
			callPtcTool(
				tool('hf_jobs_list'),
				{ limit: 3, stagesAny: ['RUNNING'], cursor: first.structured.nextCursor },
				{ ...ctxBase, fetch }
			)
		).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
	});

	it('pages scheduled jobs locally and reports the total', async () => {
		const { fetch } = router([
			{ path: '/api/scheduled-jobs/alice', body: [scheduled(), scheduled({ id: 'sch2' }), scheduled({ id: 'sch3' })] },
		]);
		const first = await callPtcTool(tool('hf_jobs_list'), { kind: 'scheduled', limit: 2 }, { ...ctxBase, fetch });
		expect(first.structured).toMatchObject({ returnedCount: 2, completeness: { hasMore: true, total: 3 } });
		const second = await callPtcTool(
			tool('hf_jobs_list'),
			{ kind: 'scheduled', limit: 2, cursor: first.structured.nextCursor },
			{ ...ctxBase, fetch }
		);
		expect(second.structured).toMatchObject({
			items: [{ id: 'sch3' }],
			nextCursor: null,
			completeness: { hasMore: false, total: 3 },
		});
	});
});

describe('hf_jobs_list scheduled (OpenAPI shape)', () => {
	it('lists schedules without a command and reads timing, timeout and secret names from the published keys', async () => {
		const { jobSpec } = scheduled();
		const { command: _command, ...noCommand } = jobSpec;
		const { fetch } = router([
			{
				path: '/api/scheduled-jobs/alice',
				body: [
					scheduled({
						jobSpec: { ...noCommand, timeout: 900, secrets: ['HF_TOKEN', 'WANDB'] },
						status: { lastJob: { id: 'run1', at: '2026-11-16T09:00:00Z' }, nextJobRunAt: '2026-11-17T09:00:00Z' },
					}),
					scheduled({ id: 'sch2', status: { lastJob: null, nextJobRunAt: '2026-11-17T10:00:00Z' } }),
				],
			},
		]);
		const { structured } = await callPtcTool(tool('hf_jobs_list'), { kind: 'scheduled' }, { ...ctxBase, fetch });
		const items = structured.items as Array<Record<string, unknown>>;
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			id: 'sch1',
			lastRunAt: '2026-11-16T09:00:00Z',
			nextRunAt: '2026-11-17T09:00:00Z',
			jobSpec: { timeoutSeconds: 900, secretNames: ['HF_TOKEN', 'WANDB'] },
		});
		expect((items[0]?.jobSpec as Record<string, unknown>).command).toBeUndefined();
		expect(items[1]).toMatchObject({ id: 'sch2', nextRunAt: '2026-11-17T10:00:00Z' });
		expect(items[1]?.lastRunAt).toBeUndefined();
	});
});

describe('hf_job_get / logs / cancel / update', () => {
	it('gets a job by URL, taking the namespace from it', async () => {
		const { fetch, calls } = router([{ path: '/api/jobs/acme/job1', body: job({ owner: { id: 'o', name: 'acme' } }) }]);
		const { structured } = await callPtcTool(
			tool('hf_job_get'),
			{ job: 'https://huggingface.co/jobs/acme/job1' },
			{ ...ctxBase, fetch }
		);
		expect(calls[0]?.url.pathname).toBe('/api/jobs/acme/job1');
		expect(structured).toMatchObject({ job: { id: 'job1', namespace: 'acme' } });
		expect(JSON.stringify(structured)).not.toContain(TOKEN);
	});

	it('gets a scheduled job', async () => {
		const { fetch } = router([{ path: '/api/scheduled-jobs/alice/sch1', body: scheduled() }]);
		const { structured } = await callPtcTool(
			tool('hf_job_get'),
			{ job: 'sch1', kind: 'scheduled' },
			{ ...ctxBase, fetch }
		);
		expect(structured).toMatchObject({ scheduledJob: { id: 'sch1', concurrency: false } });
	});

	it('returns redacted, tailed logs', async () => {
		const { fetch } = router([{ path: '/api/jobs/alice/job1', body: job() }]);
		fakeLogs(['a', 'MODE=sekrit-env-value', 'HF_TOKEN is set'], {
			finished: false,
			truncated: true,
			linesDropped: true,
		});
		const { structured } = await callPtcTool(
			tool('hf_job_logs'),
			{ job: 'job1', tail: 50, followSeconds: 10 },
			{ ...ctxBase, fetch }
		);
		expect(logsMock.mock.calls[0]?.[1]).toMatchObject({
			maxDuration: 10_000,
			maxLines: 50,
			maxChars: 80_000,
			maxLineChars: 4_000,
			token: TOKEN,
		});
		// Secret names (the Hub sends an array of names) are not redacted; values are.
		expect(structured).toMatchObject({
			job: { id: 'job1', stage: 'RUNNING' },
			lines: ['a', 'MODE=<redacted>', 'HF_TOKEN is set'],
			followStopped: true,
			linesTruncated: true,
			returnedCount: 3,
		});
	});

	it('cancels jobs and deletes scheduled jobs', async () => {
		const { fetch, calls } = router([
			{ method: 'POST', path: '/api/jobs/alice/job1/cancel' },
			{ path: '/api/jobs/alice/job1', body: job({ status: { stage: 'CANCELED' } }) },
			{ method: 'DELETE', path: '/api/scheduled-jobs/alice/sch1' },
		]);
		const canceled = await callPtcTool(tool('hf_job_cancel'), { job: 'job1' }, { ...ctxBase, fetch });
		expect(canceled.structured).toMatchObject({ action: 'canceled', job: { status: { stage: 'CANCELED' } } });
		const deleted = await callPtcTool(
			tool('hf_job_cancel'),
			{ job_id: 'sch1', kind: 'scheduled' },
			{ ...ctxBase, fetch }
		);
		expect(deleted.structured).toEqual({
			action: 'deleted',
			scheduledJob: { kind: 'scheduled_job', id: 'sch1', namespace: 'alice' },
		});
		expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
			'POST /api/jobs/alice/job1/cancel',
			'GET /api/jobs/alice/job1',
			'DELETE /api/scheduled-jobs/alice/sch1',
		]);
	});

	it('updates scheduled labels, cron and runs now', async () => {
		const { fetch, calls } = router([
			{ method: 'PUT', path: '/api/scheduled-jobs/alice/sch1/labels', body: scheduled() },
			{ method: 'POST', path: '/api/scheduled-jobs/alice/sch1/schedule' },
			{ method: 'POST', path: '/api/scheduled-jobs/alice/sch1/run', body: job({ id: 'run9' }) },
			{ path: '/api/scheduled-jobs/alice/sch1', body: scheduled({ schedule: '@hourly' }) },
		]);
		const { structured } = await callPtcTool(
			tool('hf_job_update'),
			{ job: 'sch1', kind: 'scheduled', labels: { a: 'b' }, schedule: '@hourly', action: 'run_now' },
			{ ...ctxBase, fetch }
		);
		expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
			'PUT /api/scheduled-jobs/alice/sch1/labels',
			'POST /api/scheduled-jobs/alice/sch1/schedule',
			'POST /api/scheduled-jobs/alice/sch1/run',
			'GET /api/scheduled-jobs/alice/sch1',
		]);
		expect(calls[0]?.body).toEqual({ labels: { a: 'b' } });
		expect(calls[1]?.body).toEqual({ schedule: '@hourly' });
		expect(structured).toMatchObject({ scheduledJob: { schedule: '@hourly' }, triggeredJob: { id: 'run9' } });
	});

	it('keeps a successful run_now when the read-back fails', async () => {
		const { fetch } = router([
			{ method: 'POST', path: '/api/scheduled-jobs/alice/sch1/run', body: job({ id: 'run9' }) },
			{ path: '/api/scheduled-jobs/alice/sch1', status: 503, body: { error: 'busy' } },
		]);
		const { structured } = await callPtcTool(
			tool('hf_job_update'),
			{ job: 'sch1', kind: 'scheduled', action: 'run_now' },
			{ ...ctxBase, fetch }
		);
		expect(structured).toMatchObject({ triggeredJob: { id: 'run9' } });
		expect(structured.scheduledJob).toBeUndefined();
		expect(String(structured.note)).toContain('applied');
	});

	it('reports a completed cancel even when the read-back fails', async () => {
		const { fetch } = router([
			{ method: 'POST', path: '/api/jobs/alice/job1/cancel' },
			{ path: '/api/jobs/alice/job1', status: 500, body: {} },
		]);
		const { structured } = await callPtcTool(tool('hf_job_cancel'), { job_id: 'job1' }, { ...ctxBase, fetch });
		expect(structured).toMatchObject({ action: 'canceled' });
		expect(structured.job).toBeUndefined();
		expect(typeof structured.note).toBe('string');
	});

	it('passes the request signal to the log stream', async () => {
		const { fetch } = router([{ path: '/api/jobs/alice/job1', body: job() }]);
		fakeLogs([], { finished: true, truncated: false });
		const controller = new AbortController();
		await callPtcTool(tool('hf_job_logs'), { job: 'job1' }, { ...ctxBase, fetch, signal: controller.signal });
		expect((logsMock.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal).toBeDefined();
	});

	it('rejects scheduled-only actions for jobs', async () => {
		await expect(callPtcTool(tool('hf_job_update'), { job: 'job1', action: 'suspend' }, ctxBase)).rejects.toMatchObject(
			{ code: 'INVALID_ARGUMENT' }
		);
	});

	it('declares access and annotations', () => {
		const meta = Object.fromEntries(
			JOBS_TOOLS.map((t) => [t.name, [t.access, t.annotations.destructiveHint, t.annotations.readOnlyHint]])
		);
		expect(meta).toEqual({
			hf_job_run: ['write', true, false],
			hf_job_schedule: ['write', true, false],
			hf_jobs_list: ['authenticated', false, true],
			hf_job_get: ['authenticated', false, true],
			hf_job_logs: ['authenticated', false, true],
			hf_job_cancel: ['write', true, false],
			hf_job_update: ['write', true, false],
		});
		for (const t of JOBS_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(150);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});
});
