import { describe, expect, it, vi } from 'vitest';
import { HfJobsTool } from '../../src/jobs/jobs-tool.js';
import {
	jobLabelsSchema,
	runArgsSchema,
	uvArgsSchema,
	scheduledRunArgsSchema,
	scheduledUvArgsSchema,
} from '../../src/jobs/types.js';
import type { JobSpec, ScheduledJobSpec } from '../../src/jobs/types.js';
import type { JobsApiClient } from '../../src/jobs/api-client.js';
import { createJobSpec } from '../../src/jobs/commands/utils.js';
import { runCommand, uvCommand } from '../../src/jobs/commands/run.js';
import { scheduledRunCommand, scheduledUvCommand } from '../../src/jobs/commands/scheduled.js';

const base = { image: 'python:3.12', command: ['echo', 'hello'] };
const input = { ...base, script: 'print("hello")', schedule: '@daily', detach: true };

describe('submission labels', () => {
	it('documents supported label characters in usage and submission help', async () => {
		const tool = new HfJobsTool('token', true);
		const usage = await tool.execute({});
		expect(usage.formatted).toContain('100 alphanumeric, dash, or underscore characters.');
		for (const operation of ['run', 'uv', 'scheduled run', 'scheduled uv']) {
			const help = await tool.execute({ operation, args: { help: true } });
			expect(help.formatted).toContain('alphanumeric, dash, underscore.');
			expect(help.formatted).not.toContain('dot, dash');
		}
	});

	for (const schema of [runArgsSchema, uvArgsSchema, scheduledRunArgsSchema, scheduledUvArgsSchema]) {
		it('accepts name/labels and rejects conflicting aliases in submission schemas', () => {
			expect(schema.parse({ ...input, name: 'train-v1-A_2', labels: { team: 'ml' } }).name).toBe('train-v1-A_2');
			expect(schema.safeParse({ ...input, name: 'same', labels: { name: 'same' } }).success).toBe(false);
			for (const name of ['bad name', 'train.v1', 'train=v1']) {
				expect(schema.safeParse({ ...input, name }).success).toBe(false);
			}
			expect(schema.safeParse({ ...input, name: 'a'.repeat(101) }).success).toBe(false);
		});
	}

	for (const schema of [runArgsSchema, uvArgsSchema, scheduledRunArgsSchema, scheduledUvArgsSchema]) {
		it('accepts flavors missing from the hint list and leaves validation to the Hub', () => {
			expect(schema.parse({ ...input, flavor: 'rtx-pro-6000x8' }).flavor).toBe('rtx-pro-6000x8');
			expect(schema.parse({ ...input, flavor: 'future-gpu-x16' }).flavor).toBe('future-gpu-x16');
			expect(schema.parse(input).flavor).toBe('cpu-basic');
			expect(schema.safeParse({ ...input, flavor: '' }).success).toBe(false);
		});
	}

	it('validates keys and values with the same length and character limits', () => {
		expect(jobLabelsSchema.parse({ ['a'.repeat(100)]: 'Z0-_'.repeat(25) })).toBeDefined();
		for (const invalid of ['a'.repeat(101), 'space here', 'slash/here', 'dot.here', 'equals=here', 'é', 'line\n']) {
			expect(jobLabelsSchema.safeParse({ [invalid]: 'valid' }).success).toBe(false);
			expect(jobLabelsSchema.safeParse({ valid: invalid }).success).toBe(false);
		}
	});

	it('merges without mutation, preserves explicit labels, and never invents names', () => {
		const labels = Object.freeze({ team: 'ml' });
		expect(createJobSpec({ ...base, name: 'train', labels }).labels).toEqual({ team: 'ml', name: 'train' });
		expect(labels).toEqual({ team: 'ml' });
		expect(createJobSpec({ ...base, labels: { name: 'explicit' } }).labels).toEqual({ name: 'explicit' });
		expect(createJobSpec(base)).not.toHaveProperty('labels');
		expect(createJobSpec({ ...base, labels: {} })).not.toHaveProperty('labels');
		expect(createJobSpec({ ...base, labels }).labels).toEqual({ team: 'ml' });
		expect(() => createJobSpec({ ...base, name: '', labels: { name: '' } })).toThrow(/cannot both/);
		expect(() => createJobSpec({ ...base, labels: { invalid: '!' } })).toThrow();
	});

	it('forwards labels through run, uv, scheduled run and scheduled uv', async () => {
		const owner = { id: 'owner', name: 'tester' };
		const runJob = vi.fn(async (spec: JobSpec) => ({
			...spec,
			id: 'job',
			owner,
			createdAt: '',
			status: { stage: 'RUNNING' },
		}));
		const createScheduledJob = vi.fn(async (spec: ScheduledJobSpec) => ({
			...spec,
			id: 'scheduled',
			owner,
			createdAt: '',
		}));
		const client = { runJob, createScheduledJob } as unknown as JobsApiClient;
		const args = { ...input, name: 'train', labels: { team: 'ml' } };
		expect((await runCommand(runArgsSchema.parse(args), client)).formatted).toContain('**Name:** train');
		await uvCommand(uvArgsSchema.parse(args), client);
		expect((await scheduledRunCommand(scheduledRunArgsSchema.parse(args), client)).formatted).toContain(
			'**Name:** train'
		);
		await scheduledUvCommand(scheduledUvArgsSchema.parse(args), client);
		for (const [spec] of runJob.mock.calls) expect(spec.labels).toEqual({ team: 'ml', name: 'train' });
		for (const [spec] of createScheduledJob.mock.calls)
			expect(spec.jobSpec.labels).toEqual({ team: 'ml', name: 'train' });
		expect(runJob).toHaveBeenCalledTimes(2);
		expect(createScheduledJob).toHaveBeenCalledTimes(2);
	});
});
