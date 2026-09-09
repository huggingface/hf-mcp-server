import { afterEach, describe, expect, it, vi } from 'vitest';
import { HfApiError } from '../../src/hf-api-call.js';
import { JobsApiClient } from '../../src/jobs/api-client.js';
import { HF_JOB_OUTPUT_SCHEMA, HF_JOBS_OUTPUT_SCHEMA } from '../../src/jobs/hf-jobs-output-schema.js';
import {
	collectSensitiveValues,
	redactSensitiveText,
	toHfJobOutput,
	toHfScheduledJobOutput,
} from '../../src/jobs/jobs-output.js';
import { HF_JOBS_TOOL_CONFIG, HfJobsTool } from '../../src/jobs/jobs-tool.js';
import { runArgsSchema } from '../../src/jobs/types.js';
import type { JobInfo, JobOwner, ScheduledJobInfo } from '../../src/jobs/types.js';

const mocks = vi.hoisted(() => ({
	fetchJobLogs: vi.fn(),
}));

vi.mock('../../src/jobs/sse-handler.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/jobs/sse-handler.js')>();
	return {
		...actual,
		fetchJobLogs: mocks.fetchJobLogs,
	};
});

const job: JobInfo = {
	id: 'job-123',
	url: 'https://huggingface.co/jobs/alice/job-123',
	endpoint: 'https://job-123.example.com',
	createdAt: '2026-08-13T10:00:00.000Z',
	finishedAt: '2026-08-13T10:01:00.000Z',
	dockerImage: 'python:3.12',
	command: ['python', '-c', 'print("done")'],
	arguments: [],
	environment: { PUBLIC_SETTING: 'plain-value' },
	secrets: { HF_TOKEN: 'real-secret', EMPTY_SECRET: null },
	flavor: 'cpu-basic',
	status: { stage: 'COMPLETED', message: null },
	owner: { id: 'user-1', name: 'alice', type: 'user' },
	createdBy: { id: 'user-1', name: 'alice', type: 'user' },
	tags: ['test'],
	labels: { purpose: 'test' },
	timeout: 60,
};

const scheduledJob: ScheduledJobInfo = {
	id: 'scheduled-123',
	schedule: '@daily',
	suspend: false,
	lastRun: '2026-08-12T10:00:00.000Z',
	nextRun: '2026-08-14T10:00:00.000Z',
	owner: job.owner,
	createdAt: '2026-08-10T10:00:00.000Z',
	jobSpec: {
		dockerImage: 'python:3.12',
		command: ['python', 'daily.py'],
		arguments: [],
		environment: { PUBLIC_SETTING: 'plain-value' },
		secrets: { HF_TOKEN: 'real-secret' },
		flavor: 'cpu-basic',
		timeoutSeconds: 120,
		volumes: [{ type: 'dataset', source: 'org/data', mountPath: '/data', readOnly: true }],
		expose: { ports: [7860] },
	},
};

afterEach(() => {
	vi.restoreAllMocks();
	mocks.fetchJobLogs.mockReset();
});

describe('HF Jobs structured output', () => {
	it('documents structured run, help, and shell boundaries in discovery and help', async () => {
		const description = HF_JOBS_TOOL_CONFIG.description;
		const match = /Minimal run: (.*)\. Command arrays/.exec(description);
		expect(match).not.toBeNull();
		const example = HF_JOBS_TOOL_CONFIG.schema.parse(JSON.parse(match![1]!));
		expect(example.operation).toBe('run');
		expect(runArgsSchema.parse(example.args).command).toEqual(['python', '-c', 'print(123)']);
		expect(description).toContain('{"operation":"run","args":{"help":true}}');
		expect(description).toContain('full usage: {}');
		expect(description).toContain('"job_id":"<returned job ID>"');
		const tool = new HfJobsTool('token', true);
		const usage = await tool.execute({});
		const help = await tool.execute({ operation: 'run', args: { help: true } });
		expect(help.structuredContent.outcome.kind).toBe('help');
		for (const text of [description, usage.formatted, help.formatted, runArgsSchema.shape.command.description!]) {
			expect(text).toContain('literal argv');
			expect(text).toContain('not shell execution');
			expect(text).toContain('/bin/sh');
			expect(text).toContain('-lc');
			expect(text).toContain('only if the image provides that shell');
			expect(text).not.toContain('POSIX shell semantics');
		}
	});

	it('maps jobs to a strict names-only output without sensitive values', () => {
		const output = toHfJobOutput({
			...job,
			command: ['python', '-c', 'print("plain-value", "real-secret")'],
			status: { ...job.status, message: 'completed with real-secret' },
		});

		expect(output).toMatchObject({
			id: 'job-123',
			endpoint: 'https://job-123.example.com',
			created_at: '2026-08-13T10:00:00.000Z',
			environment_variable_names: ['PUBLIC_SETTING'],
			secret_names: ['EMPTY_SECRET', 'HF_TOKEN'],
			timeout_seconds: 60,
		});
		expect(JSON.stringify(output)).not.toContain('plain-value');
		expect(JSON.stringify(output)).not.toContain('real-secret');
	});

	it('maps scheduled jobs, specs, and volumes without sensitive values', () => {
		const output = toHfScheduledJobOutput({
			...scheduledJob,
			jobSpec: {
				...scheduledJob.jobSpec,
				command: ['python', '-c', 'print("plain-value", "real-secret")'],
			},
		});

		expect(output).toMatchObject({
			id: 'scheduled-123',
			suspended: false,
			job_spec: {
				environment_variable_names: ['PUBLIC_SETTING'],
				secret_names: ['HF_TOKEN'],
				timeout_seconds: 120,
				volumes: [
					{
						type: 'dataset',
						source: 'org/data',
						mount_path: '/data',
						read_only: true,
					},
				],
				exposed_ports: [7860],
			},
		});
		expect(JSON.stringify(output)).not.toContain('plain-value');
		expect(JSON.stringify(output)).not.toContain('real-secret');
	});

	it('tolerates owner objects with extra profile fields (e.g. avatarUrl) from the Jobs API', () => {
		const output = toHfJobOutput({
			...job,
			owner: { id: 'user-1', name: 'alice', type: 'user', avatarUrl: 'https://example.com/a.png' } as JobOwner,
		});

		expect(output.owner).toEqual({ id: 'user-1', name: 'alice', type: 'user' });
		expect(() => HF_JOB_OUTPUT_SCHEMA.parse(output)).not.toThrow();
	});

	it('tolerates a createdBy object missing type', () => {
		const output = toHfJobOutput({
			...job,
			createdBy: { id: 'user-1', name: 'alice' } as JobOwner,
		});

		expect(output.created_by).toEqual({ id: 'user-1', name: 'alice' });
		expect(() => HF_JOB_OUTPUT_SCHEMA.parse(output)).not.toThrow();
	});

	it('accepts baseline owner shapes with and without type', () => {
		const withType = toHfJobOutput({ ...job, owner: { id: 'user-1', name: 'alice', type: 'org' } });
		const withoutType = toHfJobOutput({ ...job, owner: { id: 'user-1', name: 'alice' } });

		expect(withType.owner).toEqual({ id: 'user-1', name: 'alice', type: 'org' });
		expect(withoutType.owner).toEqual({ id: 'user-1', name: 'alice' });
		expect(() => HF_JOB_OUTPUT_SCHEMA.parse(withType)).not.toThrow();
		expect(() => HF_JOB_OUTPUT_SCHEMA.parse(withoutType)).not.toThrow();
	});

	it('preserves job id and status when owner/createdBy metadata is malformed end-to-end via the tool', async () => {
		vi.spyOn(JobsApiClient.prototype, 'getJob').mockResolvedValue({
			...job,
			status: { stage: 'COMPLETED' },
			owner: { id: 'user-1', name: 'alice', type: 'user', avatarUrl: 'https://example.com/a.png' } as JobOwner,
			createdBy: { id: 'user-1', name: 'alice' } as JobOwner,
		});

		const result = await new HfJobsTool('token', true).execute({
			operation: 'inspect',
			args: { job_id: 'job-123' },
		});

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent.outcome).toMatchObject({
			kind: 'inspections',
			inspections: [{ job_id: 'job-123', status: 'success', job: { id: 'job-123', status: { stage: 'COMPLETED' } } }],
		});
	});

	it('redacts known values longest-first', () => {
		const values = collectSensitiveValues(job, ['token']);
		expect(redactSensitiveText('plain-value real-secret token', values)).toBe('<redacted> <redacted> <redacted>');
	});

	it('returns schema-valid informational and validation outcomes', async () => {
		const unavailable = await new HfJobsTool(undefined, false).execute({});
		const usage = await new HfJobsTool('token', true).execute({});
		const help = await new HfJobsTool('token', true).execute({ operation: 'run' });
		const unknown = await new HfJobsTool('token', true).execute({ operation: 'not-real' });
		const validation = await new HfJobsTool('token', true).execute({
			operation: 'run',
			args: { command: 42 },
		});

		expect(unavailable.structuredContent.outcome.kind).toBe('unavailable');
		expect(usage.structuredContent.outcome.kind).toBe('usage');
		expect(help.structuredContent.outcome).toMatchObject({ kind: 'help', reason: 'missing_arguments' });
		expect(unknown.structuredContent.outcome).toMatchObject({ kind: 'error', code: 'unknown_operation' });
		expect(validation.structuredContent.outcome).toMatchObject({ kind: 'error', code: 'validation' });
		for (const result of [unavailable, usage, help, unknown, validation]) {
			expect(HF_JOBS_OUTPUT_SCHEMA.parse(result.structuredContent)).toEqual(result.structuredContent);
		}
		expect(unknown.isError).toBe(true);
		expect(validation.isError).toBe(true);
	});

	it('returns filtered jobs with accurate counts and sanitized Markdown-independent records', async () => {
		vi.spyOn(JobsApiClient.prototype, 'listJobs').mockResolvedValue([
			{ ...job, status: { stage: 'RUNNING' } },
			{ ...job, id: 'job-complete', status: { stage: 'COMPLETED' } },
		]);

		const result = await new HfJobsTool('token', true).execute({ operation: 'ps', args: {} });

		expect(result.structuredContent).toMatchObject({
			operation: 'ps',
			outcome: {
				kind: 'jobs',
				total_jobs: 2,
				jobs: [{ id: 'job-123' }],
			},
			total_results: 2,
			results_shared: 1,
		});
		expect(JSON.stringify(result)).not.toContain('plain-value');
		expect(JSON.stringify(result)).not.toContain('real-secret');
	});

	it('returns a sanitized scheduled job and acknowledgement outcomes', async () => {
		vi.spyOn(JobsApiClient.prototype, 'getScheduledJob').mockResolvedValue(scheduledJob);
		vi.spyOn(JobsApiClient.prototype, 'deleteScheduledJob').mockResolvedValue();

		const inspect = await new HfJobsTool('token', true).execute({
			operation: 'scheduled inspect',
			args: { scheduled_job_id: 'scheduled-123' },
		});
		const deleted = await new HfJobsTool('token', true).execute({
			operation: 'scheduled delete',
			args: { scheduled_job_id: 'scheduled-123' },
		});

		expect(inspect.structuredContent.outcome).toMatchObject({
			kind: 'scheduled_job',
			scheduled_job: { id: 'scheduled-123' },
		});
		expect(deleted.structuredContent.outcome).toMatchObject({
			kind: 'acknowledgement',
			resource_id: 'scheduled-123',
			action: 'deleted',
		});
		expect(JSON.stringify(inspect)).not.toContain('plain-value');
		expect(JSON.stringify(inspect)).not.toContain('real-secret');
	});

	it('preserves a created job when attached log collection fails', async () => {
		vi.spyOn(JobsApiClient.prototype, 'runJob').mockResolvedValue({ ...job, status: { stage: 'RUNNING' } });
		mocks.fetchJobLogs.mockRejectedValue(new Error('stream unavailable'));

		const result = await new HfJobsTool('token', true).execute({
			operation: 'run',
			args: { command: ['python', '-c', 'print("done")'] },
		});

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			operation: 'run',
			outcome: {
				kind: 'job',
				job: { id: 'job-123' },
				logs_error: 'stream unavailable',
			},
			total_results: 1,
			results_shared: 1,
		});
		expect(result.formatted).toContain('Could not collect logs: stream unavailable');
	});

	it('fails closed instead of returning unredacted logs when job metadata is unavailable', async () => {
		vi.spyOn(JobsApiClient.prototype, 'getNamespace').mockResolvedValue('alice');
		vi.spyOn(JobsApiClient.prototype, 'getJob').mockRejectedValue(new Error('metadata unavailable'));

		const result = await new HfJobsTool('token', true).execute({
			operation: 'logs',
			args: { job_id: 'job-123' },
		});

		expect(mocks.fetchJobLogs).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.structuredContent.outcome).toMatchObject({ kind: 'error', code: 'execution' });
		expect(result.formatted).toContain('Could not safely retrieve logs');
	});

	it('correlates partial multi-job inspection results and sanitizes Markdown', async () => {
		vi.spyOn(JobsApiClient.prototype, 'getJob').mockImplementation(async (jobId) => {
			if (jobId === 'missing') throw new Error('Not found');
			return job;
		});

		const result = await new HfJobsTool('token', true).execute({
			operation: 'inspect',
			args: { job_id: ['job-123', 'missing'] },
		});

		expect(result.structuredContent).toMatchObject({
			operation: 'inspect',
			outcome: {
				kind: 'inspections',
				requested_job_ids: ['job-123', 'missing'],
				inspections: [
					{ job_id: 'job-123', status: 'success', job: { id: 'job-123' } },
					{ job_id: 'missing', status: 'error', message: 'Failed to fetch job missing: Not found' },
				],
			},
			total_results: 2,
			results_shared: 1,
		});
		expect(result.formatted).toContain('Failed to fetch job missing: Not found');
		expect(result.formatted).not.toContain('plain-value');
		expect(result.formatted).not.toContain('real-secret');
	});

	it('does not include an API response body in execution errors', async () => {
		vi.spyOn(JobsApiClient.prototype, 'listJobs').mockRejectedValue(
			new HfApiError(
				'API request failed: 400 Bad Request',
				400,
				'Bad Request',
				'{"secrets":{"HF_TOKEN":"real-secret"}}'
			)
		);

		const result = await new HfJobsTool('token', true).execute({ operation: 'ps', args: {} });

		expect(result.structuredContent.outcome).toMatchObject({ kind: 'error', code: 'execution' });
		expect(JSON.stringify(result)).not.toContain('real-secret');
		expect(result.formatted).not.toContain('Server response');
	});
});
