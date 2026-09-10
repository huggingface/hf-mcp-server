import type {
	ScheduledRunArgs,
	ScheduledUvArgs,
	ScheduledPsArgs,
	ScheduledJobArgs,
	ScheduledJobSpec,
} from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { formatScheduledJobsTable, formatScheduledJobDetails } from '../formatters.js';
import { createJobSpec } from './utils.js';
import { resolveUvCommand, UV_DEFAULT_IMAGE } from './uv-utils.js';
import { collectSensitiveValues, toHfScheduledJobOutput, type JobsCommandResult } from '../jobs-output.js';

/**
 * Execute 'scheduled run' command
 * Creates a scheduled job
 */
export async function scheduledRunCommand(
	args: ScheduledRunArgs,
	client: JobsApiClient,
	token?: string
): Promise<JobsCommandResult> {
	if (args.resource_group_id && !args.namespace) {
		throw new Error('resource_group_id requires the owning organization as namespace.');
	}
	// Create job spec
	const jobSpec = createJobSpec({
		image: args.image,
		command: args.command,
		flavor: args.flavor,
		env: args.env,
		secrets: args.secrets,
		timeout: args.timeout,
		hfToken: token,
		volumes: args.volumes,
		resourceGroupId: args.resource_group_id,
	});

	// Create scheduled job spec
	const scheduledSpec: ScheduledJobSpec = {
		schedule: args.schedule,
		suspend: args.suspend,
		jobSpec,
	};

	// Submit scheduled job
	const scheduledJob = await client.createScheduledJob(scheduledSpec, args.namespace);
	const sensitiveValues = collectSensitiveValues(jobSpec, [token]);

	const message = `✓ Scheduled job created successfully!

**Scheduled Job ID:** ${scheduledJob.id}
**Schedule:** ${scheduledJob.schedule}
**Suspended:** ${scheduledJob.suspend ? 'Yes' : 'No'}
**Next Run:** ${scheduledJob.nextRun || 'N/A'}

	To inspect, call this tool with \`{"operation": "scheduled inspect", "args": {"scheduled_job_id": "${scheduledJob.id}"}}\`
	To list all, call this tool with \`{"operation": "scheduled ps"}\``;
	return {
		formatted: message,
		outcome: {
			kind: 'scheduled_job',
			scheduled_job: toHfScheduledJobOutput(scheduledJob, sensitiveValues),
		},
		totalResults: 1,
		resultsShared: 1,
	};
}

/**
 * Execute 'scheduled uv' command
 * Creates a scheduled UV job
 */
export async function scheduledUvCommand(
	args: ScheduledUvArgs,
	client: JobsApiClient,
	token?: string
): Promise<JobsCommandResult> {
	// For UV, use standard UV image
	const image = UV_DEFAULT_IMAGE;

	// Build UV command (similar to regular uv command)
	const command = resolveUvCommand(args);

	// Convert to scheduled run args
	const scheduledRunArgs: ScheduledRunArgs = {
		schedule: args.schedule,
		suspend: args.suspend,
		image,
		command,
		flavor: args.flavor,
		env: args.env,
		secrets: args.secrets,
		timeout: args.timeout,
		detach: args.detach,
		namespace: args.namespace,
		resource_group_id: args.resource_group_id,
		volumes: args.volumes,
	};

	return scheduledRunCommand(scheduledRunArgs, client, token);
}

/**
 * Execute 'scheduled ps' command
 * Lists scheduled jobs
 */
export async function scheduledPsCommand(args: ScheduledPsArgs, client: JobsApiClient): Promise<JobsCommandResult> {
	// Fetch all scheduled jobs
	const allJobs = await client.listScheduledJobs(args.namespace);

	// Filter jobs
	let jobs = allJobs;

	// Default: hide suspended jobs unless --all is specified
	if (!args.all) {
		jobs = jobs.filter((job) => !job.suspend);
	}

	// Format as markdown table
	const table = formatScheduledJobsTable(jobs);

	if (jobs.length === 0) {
		return {
			formatted: args.all
				? 'No scheduled jobs found.'
				: 'No active scheduled jobs found. Use `{"args": {"all": true}}` to show suspended jobs.',
			outcome: {
				kind: 'scheduled_jobs',
				scheduled_jobs: [],
				total_scheduled_jobs: allJobs.length,
			},
			totalResults: allJobs.length,
			resultsShared: 0,
		};
	}

	return {
		formatted: `**Scheduled Jobs (${jobs.length} of ${allJobs.length} total):**

${table}`,
		outcome: {
			kind: 'scheduled_jobs',
			scheduled_jobs: jobs.map((job) => toHfScheduledJobOutput(job)),
			total_scheduled_jobs: allJobs.length,
		},
		totalResults: allJobs.length,
		resultsShared: jobs.length,
	};
}

/**
 * Execute 'scheduled inspect' command
 * Gets details of a scheduled job
 */
export async function scheduledInspectCommand(
	args: ScheduledJobArgs,
	client: JobsApiClient
): Promise<JobsCommandResult> {
	const job = await client.getScheduledJob(args.scheduled_job_id, args.namespace);
	const scheduledJob = toHfScheduledJobOutput(job);
	return {
		formatted: `**Scheduled Job Details:**\n\n${formatScheduledJobDetails(scheduledJob)}`,
		outcome: {
			kind: 'scheduled_job',
			scheduled_job: scheduledJob,
		},
		totalResults: 1,
		resultsShared: 1,
	};
}

/**
 * Execute 'scheduled delete' command
 * Deletes a scheduled job
 */
export async function scheduledDeleteCommand(
	args: ScheduledJobArgs,
	client: JobsApiClient
): Promise<JobsCommandResult> {
	await client.deleteScheduledJob(args.scheduled_job_id, args.namespace);

	const message = `✓ Scheduled job ${args.scheduled_job_id} has been deleted.`;
	return acknowledgement(args.scheduled_job_id, 'deleted', message);
}

/**
 * Execute 'scheduled suspend' command
 * Suspends a scheduled job
 */
export async function scheduledSuspendCommand(
	args: ScheduledJobArgs,
	client: JobsApiClient
): Promise<JobsCommandResult> {
	await client.suspendScheduledJob(args.scheduled_job_id, args.namespace);

	const message = `✓ Scheduled job ${args.scheduled_job_id} has been suspended.

To resume, call this tool with \`{"operation": "scheduled resume", "args": {"scheduled_job_id": "${args.scheduled_job_id}"}}\``;
	return acknowledgement(args.scheduled_job_id, 'suspended', message);
}

/**
 * Execute 'scheduled resume' command
 * Resumes a suspended scheduled job
 */
export async function scheduledResumeCommand(
	args: ScheduledJobArgs,
	client: JobsApiClient
): Promise<JobsCommandResult> {
	await client.resumeScheduledJob(args.scheduled_job_id, args.namespace);

	const message = `✓ Scheduled job ${args.scheduled_job_id} has been resumed.

To inspect, call this tool with \`{"operation": "scheduled inspect", "args": {"scheduled_job_id": "${args.scheduled_job_id}"}}\``;
	return acknowledgement(args.scheduled_job_id, 'resumed', message);
}

function acknowledgement(
	resourceId: string,
	action: 'deleted' | 'suspended' | 'resumed',
	message: string
): JobsCommandResult {
	return {
		formatted: message,
		outcome: {
			kind: 'acknowledgement',
			resource_id: resourceId,
			action,
			message,
		},
		totalResults: 1,
		resultsShared: 1,
	};
}
