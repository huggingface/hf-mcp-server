import { afterEach, describe, expect, it, vi } from 'vitest';
import { HF_JOBS_TOOL_CONFIG, HfJobsTool } from '../../src/jobs/jobs-tool.js';
import type { JobInfo, JobSpec, ScheduledJobInfo, ScheduledJobSpec } from '../../src/jobs/types.js';
import { runArgsSchema, uvArgsSchema, scheduledRunArgsSchema, scheduledUvArgsSchema } from '../../src/jobs/types.js';

const CALLER_TOKEN = 'hf_caller_token_not_for_containers';
const operations = ['run', 'uv', 'scheduled run', 'scheduled uv'] as const;

function submissionArgs(operation: string): Record<string, unknown> {
	return {
		...(operation.endsWith('uv')
			? { script: 'print(123)' }
			: { image: 'python:3.12', command: ['echo', '$HF_TOKEN', '${HF_TOKEN}'] }),
		...(operation.startsWith('scheduled') ? { schedule: '@daily' } : {}),
		detach: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(operations)('%s caller-token boundary', (operation) => {
	for (const token of [CALLER_TOKEN, undefined]) {
		for (const field of ['env', 'secrets']) {
			for (const key of ['HF_TOKEN', 'OTHER', 'CUSTOM_TOKEN']) {
				it.each(['$HF_TOKEN', '${HF_TOKEN}'])(
					`rejects %s in ${field}.${key} ${token ? 'with' : 'without'} a caller token before side effects`,
					async (value) => {
						const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
						const onProgress = vi.fn();
						const tool = new HfJobsTool(token, true);
						const result = await tool.execute(
							{ operation, args: { ...submissionArgs(operation), [field]: { [key]: value } } },
							{ onProgress }
						);

						expect(result.isError).toBe(true);
						expect(result.formatted).toContain('Caller-token forwarding is disabled');
						expect(result.formatted).toContain('literal, explicitly scoped secret');
						expect(result.formatted).not.toContain(CALLER_TOKEN);
						expect(fetch).not.toHaveBeenCalled();
						expect(onProgress).not.toHaveBeenCalled();
					}
				);
			}
		}
	}

	it.each([false, true])(
		'authenticates the API without ambient payload injection (literal secrets: %s)',
		async (withSecrets) => {
			const job: JobInfo = {
				id: 'job-123',
				createdAt: '2026-09-10T00:00:00Z',
				dockerImage: 'python:3.12',
				command: ['echo', 'hello'],
				environment: {},
				flavor: 'cpu-basic',
				status: { stage: 'RUNNING' },
				owner: { id: 'user-1', name: 'alice', type: 'user' },
			};
			const scheduledJob: ScheduledJobInfo = {
				id: 'scheduled-123',
				schedule: '@daily',
				suspend: false,
				owner: job.owner,
				createdAt: job.createdAt,
				jobSpec: { dockerImage: 'python:3.12', command: ['echo', 'hello'], flavor: 'cpu-basic' },
			};
			const fetch = vi
				.spyOn(globalThis, 'fetch')
				.mockImplementation(async (url) =>
					Response.json(
						String(url).endsWith('/whoami-v2')
							? { name: 'alice' }
							: operation.startsWith('scheduled')
								? scheduledJob
								: job
					)
				);
			const env = { NAME: 'literal-setting', HF_TOKEN: 'explicit-env-token', TEMPLATE: 'prefix-${HF_TOKEN}' };
			const secrets = { HF_TOKEN: 'explicit-secret-token', OTHER: 'literal-secret', TEMPLATE: '$OTHER' };
			const tool = new HfJobsTool(CALLER_TOKEN, true);
			const result = await tool.execute({
				operation,
				args: { ...submissionArgs(operation), ...(withSecrets ? { env, secrets } : {}) },
			});

			expect(result.isError).not.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(2);
			for (const [, init] of fetch.mock.calls) {
				expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${CALLER_TOKEN}`);
			}
			const init = fetch.mock.calls[1]![1]!;
			expect(init.method).toBe('POST');
			const body = String(init.body);
			expect(body).not.toContain(CALLER_TOKEN);
			const payload = JSON.parse(body) as JobSpec | ScheduledJobSpec;
			const spec = 'jobSpec' in payload ? payload.jobSpec : payload;
			expect(spec.environment).toEqual(withSecrets ? env : {});
			expect(spec.secrets).toEqual(withSecrets ? secrets : {});
			if (!operation.endsWith('uv')) {
				expect(spec.command).toEqual(['echo', '$HF_TOKEN', '${HF_TOKEN}']);
			}
		}
	);
});

describe('Jobs forwarding guidance', () => {
	it.each(operations)('documents rejection and literal secrets in %s help', async (operation) => {
		const tool = new HfJobsTool(CALLER_TOKEN, true);
		const help = await tool.execute({ operation, args: { help: true } });
		expect(help.formatted).toContain('Caller-token forwarding');
		expect(help.formatted).toContain('literal');
		expect(help.formatted).toContain('$HF_TOKEN');
		expect(help.formatted).toContain('${HF_TOKEN}');
	});

	it('documents the boundary in discovery, usage, and submission schemas', async () => {
		const usage = await new HfJobsTool(CALLER_TOKEN, true).execute({});
		for (const text of [HF_JOBS_TOOL_CONFIG.description, usage.formatted]) {
			expect(text).toContain('Caller-token forwarding is disabled');
			expect(text).toContain('caller token still authenticates the Jobs API');
		}
		for (const schema of [runArgsSchema, uvArgsSchema, scheduledRunArgsSchema, scheduledUvArgsSchema]) {
			for (const field of ['env', 'secrets'] as const) {
				expect(schema.shape[field].description).toContain('$HF_TOKEN or ${HF_TOKEN}');
				expect(schema.shape[field].description).toContain('rejected for every key');
			}
		}
	});
});
