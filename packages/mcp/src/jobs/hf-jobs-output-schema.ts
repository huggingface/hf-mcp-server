import { z } from 'zod';

export const HF_JOBS_OPERATIONS = [
	'run',
	'uv',
	'ps',
	'logs',
	'inspect',
	'cancel',
	'update-labels',
	'scheduled update-labels',
	'scheduled run',
	'scheduled uv',
	'scheduled ps',
	'scheduled inspect',
	'scheduled delete',
	'scheduled suspend',
	'scheduled resume',
] as const;

const ownerSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	type: z.enum(['user', 'org']).optional(),
});

const jobStatusSchema = z.strictObject({
	stage: z.string(),
	message: z.string().nullable().optional(),
	expose_urls: z.array(z.string()).optional(),
});

const volumeSchema = z.strictObject({
	type: z.enum(['bucket', 'model', 'dataset', 'space']),
	source: z.string(),
	mount_path: z.string(),
	revision: z.string().optional(),
	read_only: z.boolean().optional(),
	path: z.string().optional(),
});

export const HF_JOB_OUTPUT_SCHEMA = z.strictObject({
	id: z.string(),
	url: z.string().optional(),
	endpoint: z.string().optional(),
	created_at: z.string(),
	finished_at: z.string().optional(),
	docker_image: z.string().optional(),
	space_id: z.string().optional(),
	command: z.array(z.string()).optional(),
	arguments: z.array(z.string()).optional(),
	environment_variable_names: z.array(z.string()),
	secret_names: z.array(z.string()),
	flavor: z.string(),
	status: jobStatusSchema,
	owner: ownerSchema,
	created_by: ownerSchema.optional(),
	tags: z.array(z.string()).optional(),
	labels: z.record(z.string(), z.string()).optional(),
	timeout_seconds: z.number().optional(),
});

export const HF_SCHEDULED_JOB_OUTPUT_SCHEMA = z.strictObject({
	id: z.string(),
	schedule: z.string(),
	suspended: z.boolean(),
	last_run: z.string().optional(),
	next_run: z.string().optional(),
	owner: ownerSchema,
	created_at: z.string(),
	job_spec: z.strictObject({
		docker_image: z.string().optional(),
		space_id: z.string().optional(),
		command: z.array(z.string()).optional().describe("Absent when the image's default command runs."),
		arguments: z.array(z.string()).optional(),
		environment_variable_names: z.array(z.string()),
		secret_names: z.array(z.string()),
		flavor: z.string(),
		timeout_seconds: z.number().optional(),
		volumes: z.array(volumeSchema).optional(),
		labels: z.record(z.string(), z.string()).optional(),
		exposed_ports: z.array(z.number().int()).optional(),
	}),
});

const inspectionSchema = z.discriminatedUnion('status', [
	z.strictObject({
		job_id: z.string(),
		status: z.literal('success'),
		job: HF_JOB_OUTPUT_SCHEMA,
	}),
	z.strictObject({
		job_id: z.string(),
		status: z.literal('error'),
		message: z.string(),
	}),
]);

export const HF_JOBS_OUTCOME_SCHEMA = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('usage'),
		available_operations: z.array(z.enum(HF_JOBS_OPERATIONS)),
		instructions: z.string(),
	}),
	z.strictObject({
		kind: z.literal('help'),
		operation: z.enum(HF_JOBS_OPERATIONS),
		reason: z.enum(['requested', 'missing_arguments']),
		instructions: z.string(),
	}),
	z.strictObject({
		kind: z.literal('job'),
		job: HF_JOB_OUTPUT_SCHEMA,
		logs: z.array(z.string()).optional(),
		logs_finished: z.boolean().optional(),
		logs_truncated: z.boolean().optional(),
		logs_error: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal('jobs'),
		jobs: z.array(HF_JOB_OUTPUT_SCHEMA),
		total_jobs: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal('logs'),
		job_id: z.string(),
		lines: z.array(z.string()),
		finished: z.boolean(),
		truncated: z.boolean(),
	}),
	z.strictObject({
		kind: z.literal('inspections'),
		requested_job_ids: z.array(z.string()),
		inspections: z.array(inspectionSchema),
	}),
	z.strictObject({
		kind: z.literal('scheduled_job'),
		scheduled_job: HF_SCHEDULED_JOB_OUTPUT_SCHEMA,
	}),
	z.strictObject({
		kind: z.literal('scheduled_jobs'),
		scheduled_jobs: z.array(HF_SCHEDULED_JOB_OUTPUT_SCHEMA),
		total_scheduled_jobs: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal('acknowledgement'),
		resource_id: z.string(),
		action: z.enum(['canceled', 'deleted', 'suspended', 'resumed']),
		message: z.string(),
	}),
	z.strictObject({
		kind: z.literal('unavailable'),
		message: z.string(),
		upgrade_url: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal('error'),
		code: z.enum(['unknown_operation', 'validation', 'execution']),
		message: z.string(),
	}),
]);

/**
 * Structured output contract for `hf_jobs`.
 *
 * Counts describe operation-specific output items: resources for create/list/
 * inspect actions and lines for logs. `total_results` is the number considered
 * and `results_shared` is the number represented successfully in the response.
 * Informational and error outcomes use zero for both.
 *
 * Environment and secret values are intentionally excluded. Only their names
 * are exposed in job and scheduled-job records.
 */
export const HF_JOBS_OUTPUT_SCHEMA = z.strictObject({
	operation: z.enum(HF_JOBS_OPERATIONS).optional(),
	outcome: HF_JOBS_OUTCOME_SCHEMA,
	total_results: z.number().int().nonnegative(),
	results_shared: z.number().int().nonnegative(),
});

export type HfJobsOperation = (typeof HF_JOBS_OPERATIONS)[number];
export type HfJobOutput = z.infer<typeof HF_JOB_OUTPUT_SCHEMA>;
export type HfScheduledJobOutput = z.infer<typeof HF_SCHEDULED_JOB_OUTPUT_SCHEMA>;
export type HfJobsOutcome = z.infer<typeof HF_JOBS_OUTCOME_SCHEMA>;
export type HfJobsOutput = z.infer<typeof HF_JOBS_OUTPUT_SCHEMA>;

/** @deprecated Use HF_JOBS_OUTPUT_SCHEMA. */
export const HF_JOBS_PROPOSED_OUTPUT_SCHEMA = HF_JOBS_OUTPUT_SCHEMA;
