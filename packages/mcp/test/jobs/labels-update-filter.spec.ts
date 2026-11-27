import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../../src/network/safe-fetch.js';
import { JobsApiClient } from '../../src/jobs/api-client.js';
import { HfJobsTool } from '../../src/jobs/jobs-tool.js';
import { HF_JOBS_OUTPUT_SCHEMA } from '../../src/jobs/hf-jobs-output-schema.js';
import {
	psArgsSchema,
	scheduledPsArgsSchema,
	updateLabelsArgsSchema,
	scheduledUpdateLabelsArgsSchema,
} from '../../src/jobs/types.js';

vi.mock('../../src/network/safe-fetch.js', () => ({
	safeFetch: vi.fn(),
}));

const job = {
	id: 'j',
	createdAt: '',
	owner: { id: 'u', name: 'alice' },
	status: { stage: 'RUNNING' },
	command: ['echo', 'secret-value'],
	secrets: { TOKEN: 'secret-value' },
	flavor: 'cpu-basic',
	labels: {},
};
const scheduled = { id: 's', createdAt: '', owner: job.owner, schedule: '@daily', suspend: false, jobSpec: job };
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(safeFetch).mockReset();
});

function mockFetch(payload: unknown) {
	return vi.mocked(safeFetch).mockImplementation(async (url) => ({
		response: new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}),
		finalUrl: new URL(url),
		redirectsFollowed: 0,
	}));
}

describe('label updates and filters', () => {
	it('describes the update target without inheriting cancel help', async () => {
		const tool = new HfJobsTool('token', true);
		const help = await tool.execute({ operation: 'update-labels', args: { help: true } });
		expect(help.formatted).toContain('Job ID whose labels to update');
		expect(help.formatted).not.toContain('Job ID to cancel');
		const cancelHelp = await tool.execute({ operation: 'cancel', args: { help: true } });
		expect(cancelHelp.formatted).toContain('Job ID to cancel');
	});

	it('validates labels for every schema and requires replacement labels', () => {
		for (const schema of [
			psArgsSchema,
			scheduledPsArgsSchema,
			updateLabelsArgsSchema,
			scheduledUpdateLabelsArgsSchema,
		]) {
			const ids = { job_id: 'j', scheduled_job_id: 's' };
			expect(schema.safeParse({ ...ids, labels: {} }).success).toBe(true);
			expect(schema.safeParse({ ...ids, labels: { team_name: 'ML-team_2' } }).success).toBe(true);
			for (const invalid of ['not valid', 'dot.here', 'equals=here']) {
				expect(schema.safeParse({ ...ids, labels: { [invalid]: 'valid' } }).success).toBe(false);
				expect(schema.safeParse({ ...ids, labels: { valid: invalid } }).success).toBe(false);
			}
		}
		expect(updateLabelsArgsSchema.safeParse({ job_id: 'j' }).success).toBe(false);
		expect(scheduledUpdateLabelsArgsSchema.safeParse({ scheduled_job_id: 's' }).success).toBe(false);
	});
	it('sends repeated normal label query parameters', async () => {
		const fetch = mockFetch([]);
		await new JobsApiClient('token', 'alice').listJobs(undefined, { team: 'ml', name: 'train' });
		expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.getAll('label')).toEqual(['team=ml', 'name=train']);
	});
	it('sends only first scheduled label and matches all labels locally', async () => {
		const fetch = mockFetch([
			{ ...scheduled, jobSpec: { ...job, labels: { team: 'ml', name: 'train' } } },
			{ ...scheduled, jobSpec: { ...job, labels: { team: 'ml' } } },
			{ ...scheduled, jobSpec: { ...job, labels: undefined } },
		]);
		const result = await new JobsApiClient('token', 'alice').listScheduledJobs(undefined, {
			team: 'ml',
			name: 'train',
		});
		expect(result).toHaveLength(1);
		expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.getAll('label')).toEqual(['team=ml']);
	});
	it('replaces labels without reading or merging old labels', async () => {
		const fetch = mockFetch(job);
		await new JobsApiClient('token', 'alice').updateJobLabels('j', { team: 'new' }, 'org');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toBe('https://huggingface.co/api/jobs/org/j/labels');
		expect(fetch.mock.calls[0]?.[1]?.requestInit).toMatchObject({ method: 'PUT', body: '{"labels":{"team":"new"}}' });
	});
	it('forwards ps labels through routing and preserves status filtering', async () => {
		const list = vi.spyOn(JobsApiClient.prototype, 'listJobs').mockResolvedValue([job]);
		await new HfJobsTool('token', true, 'alice').execute({ operation: 'ps', args: { labels: { team: 'ml' } } });
		expect(list).toHaveBeenCalledWith(undefined, { team: 'ml' });
		const scheduledList = vi.spyOn(JobsApiClient.prototype, 'listScheduledJobs').mockResolvedValue([scheduled]);
		await new HfJobsTool('token', true, 'alice').execute({
			operation: 'scheduled ps',
			args: { labels: { team: 'ml' } },
		});
		expect(scheduledList).toHaveBeenCalledWith(undefined, { team: 'ml' });
	});
	for (const isScheduled of [false, true]) {
		it(`routes ${isScheduled ? 'scheduled ' : ''}updates, clears and redacts`, async () => {
			const fetch = mockFetch(isScheduled ? scheduled : job);
			const operation = isScheduled ? 'scheduled update-labels' : 'update-labels';
			const result = await new HfJobsTool('token', true, 'alice').execute({
				operation,
				args: { [isScheduled ? 'scheduled_job_id' : 'job_id']: isScheduled ? 's' : 'j', labels: {} },
			});
			expect(fetch.mock.calls[0]?.[0]).toBe(
				`https://huggingface.co/api/${isScheduled ? 'scheduled-jobs/alice/s' : 'jobs/alice/j'}/labels`
			);
			expect(fetch.mock.calls[0]?.[1]?.requestInit).toMatchObject({ method: 'PUT', body: '{"labels":{}}' });
			expect(JSON.stringify(result)).not.toContain('secret-value');
			expect(HF_JOBS_OUTPUT_SCHEMA.safeParse(result.structuredContent).success).toBe(true);
		});
	}

	it('rejects path-traversal or invalid namespace and jobId segments before calling fetch', async () => {
		const fetch = mockFetch(job);
		const client = new JobsApiClient('token', 'alice');
		await expect(client.getJob('../secret')).rejects.toThrow('Invalid job ID');
		await expect(client.getJob('job/extra')).rejects.toThrow('Invalid job ID');
		await expect(client.getJob('job?x=1')).rejects.toThrow('Invalid job ID');
		await expect(client.getJob('job-1', '..')).rejects.toThrow('Invalid namespace');
		await expect(client.getJob('job-1', '.')).rejects.toThrow('Invalid namespace');
		await expect(client.getJob('job-1', 'alice/bob')).rejects.toThrow('Invalid namespace');
		await expect(client.cancelJob('../cancel')).rejects.toThrow('Invalid job ID');
		expect(() => client.getLogsUrl('../logs', 'alice')).toThrow('Invalid job ID');
		expect(() => client.getLogsUrl('job-1', '../ns')).toThrow('Invalid namespace');
		expect(fetch).not.toHaveBeenCalled();
	});
});
