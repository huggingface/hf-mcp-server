import type { RunArgs, UvArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { createJobSpec } from './utils.js';
import { fetchJobLogs, DEFAULT_LOG_WAIT_MS, DEFAULT_MAX_LOG_LINES, DEFAULT_LOG_WAIT_SECONDS } from '../sse-handler.js';
import { resolveUvCommand, UV_DEFAULT_IMAGE } from './uv-utils.js';
import { notifyJobsProgress, type JobsProgressCallback } from '../progress.js';
import { collectSensitiveValues, redactSensitiveText, toHfJobOutput, type JobsCommandResult } from '../jobs-output.js';

/**
 * Execute the 'run' command
 * Creates and runs a job, optionally waiting for logs
 */
export async function runCommand(
	args: RunArgs,
	client: JobsApiClient,
	token?: string,
	onProgress?: JobsProgressCallback
): Promise<JobsCommandResult> {
	await notifyJobsProgress(onProgress, { progress: 0, message: 'Submitting job.' });
	if (args.resource_group_id && !args.namespace) {
		throw new Error('resource_group_id requires the owning organization as namespace.');
	}

	// Create job spec from args
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

	// Submit job
	const job = await client.runJob(jobSpec, args.namespace);
	await notifyJobsProgress(onProgress, { message: `Job ${job.id} submitted with status ${job.status.stage}.` });

	const jobUrl = `https://huggingface.co/jobs/${job.owner.name}/${job.id}`;
	const sensitiveValues = collectSensitiveValues(jobSpec, [token]);
	const jobOutput = toHfJobOutput(job, jobUrl, sensitiveValues);

	// If detached, return immediately
	if (args.detach) {
		return {
			formatted: `Job started successfully!

**Job ID:** ${job.id}
**Status:** ${job.status.stage}
**View at:** ${jobUrl}

	To check logs, call this tool with \`{"operation": "logs", "args": {"job_id": "${job.id}"}}\`
	To inspect, call this tool with \`{"operation": "inspect", "args": {"job_id": "${job.id}"}}\``,
			outcome: { kind: 'job', job: jobOutput },
			totalResults: 1,
			resultsShared: 1,
		};
	}

	// Not detached - fetch logs
	const logsUrl = client.getLogsUrl(job.id, job.owner.name);
	let logResult;
	try {
		logResult = await fetchJobLogs(logsUrl, {
			token,
			maxDuration: DEFAULT_LOG_WAIT_MS,
			maxLines: DEFAULT_MAX_LOG_LINES,
			onProgress,
		});
	} catch (error) {
		const logsError = error instanceof Error ? error.message : String(error);
		return {
			formatted:
				`Job started: ${job.id}\n\n` + `Could not collect logs: ${logsError}\n\n` + `View job details: ${jobUrl}`,
			outcome: {
				kind: 'job',
				job: jobOutput,
				logs_error: logsError,
			},
			totalResults: 1,
			resultsShared: 1,
		};
	}

	const redactedLogs = logResult.logs.map((line) => redactSensitiveText(line, sensitiveValues));
	let response = `Job started: ${job.id}\n\n`;

	if (redactedLogs.length > 0) {
		response += `**Logs (last ${DEFAULT_MAX_LOG_LINES} lines):**\n\`\`\`\n`;
		response += redactedLogs.join('\n');
		response += '\n```\n\n';
	}

	if (logResult.finished) {
		response += `Job finished. Full details: ${jobUrl}`;
	} else if (logResult.truncated) {
		await notifyJobsProgress(onProgress, {
			message: `Stopped following logs after ${DEFAULT_LOG_WAIT_SECONDS}s; job may still be running.`,
		});
		response += `Log collection stopped after ${DEFAULT_LOG_WAIT_SECONDS}s. Job may still be running.\n`;
		response += `View full logs: ${jobUrl}`;
	}

	return {
		formatted: response,
		outcome: {
			kind: 'job',
			job: jobOutput,
			logs: redactedLogs,
			logs_finished: logResult.finished,
			logs_truncated: logResult.truncated,
		},
		totalResults: 1,
		resultsShared: 1,
	};
}

/**
 * Execute the 'uv' command
 * Creates and runs a UV-based Python job
 */
export async function uvCommand(
	args: UvArgs,
	client: JobsApiClient,
	token?: string,
	onProgress?: JobsProgressCallback
): Promise<JobsCommandResult> {
	// UV jobs use a standard UV image unless overridden
	const image = UV_DEFAULT_IMAGE;

	// Detect script source and build command
	const command = resolveUvCommand(args);

	// Convert to run args
	const runArgs: RunArgs = {
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

	return runCommand(runArgs, client, token, onProgress);
}
