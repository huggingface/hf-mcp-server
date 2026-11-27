import type { LogsArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { fetchJobLogs, DEFAULT_LOG_WAIT_MS, DEFAULT_LOG_WAIT_SECONDS } from '../sse-handler.js';
import { notifyJobsProgress, type JobsProgressCallback } from '../progress.js';
import { collectSensitiveValues, redactSensitiveText, type JobsCommandResult } from '../jobs-output.js';

/**
 * Execute the 'logs' command
 * Fetches logs from a job via SSE
 */
export async function logsCommand(
	args: LogsArgs,
	client: JobsApiClient,
	token?: string,
	onProgress?: JobsProgressCallback
): Promise<JobsCommandResult> {
	await notifyJobsProgress(onProgress, { progress: 0, message: `Following logs for job ${args.job_id}.` });

	// Get namespace for the logs URL; ask upstream for tail + 5 so retry banners and drop flags remain exact.
	const namespace = await client.getNamespace(args.namespace);
	const logsUrl = client.getLogsUrl(args.job_id, namespace, args.tail + 5);
	let job;
	try {
		job = await client.getJob(args.job_id, args.namespace);
	} catch (error) {
		throw new Error(
			`Could not safely retrieve logs because job metadata was unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error }
		);
	}
	const sensitiveValues = collectSensitiveValues(job, [token]);

	// Fetch logs with timeout and line limit
	const result = await fetchJobLogs(logsUrl, {
		token,
		maxDuration: DEFAULT_LOG_WAIT_MS,
		maxLines: args.tail,
		onProgress,
	});
	const redactedLogs = result.logs.map((line) => redactSensitiveText(line, sensitiveValues));

	if (redactedLogs.length === 0) {
		return {
			formatted: `No logs available for job ${args.job_id}`,
			outcome: {
				kind: 'logs',
				job_id: args.job_id,
				lines: [],
				finished: result.finished,
				truncated: result.truncated,
			},
			totalResults: 0,
			resultsShared: 0,
		};
	}

	let response = `**Logs for job ${args.job_id}** (last ${args.tail} lines):\n\n${'```'}\n`;
	response += redactedLogs.join('\n');
	response += `\n${'```'}`;

	if (result.finished) {
		response += '\n\n✓ Job finished.';
	} else if (result.truncated) {
		await notifyJobsProgress(onProgress, {
			message: `Stopped following logs after ${DEFAULT_LOG_WAIT_SECONDS}s; job may still be running.`,
		});
		response += `\n\n⚠ Log collection stopped after ${DEFAULT_LOG_WAIT_SECONDS} seconds. Job may still be running.`;
	}

	return {
		formatted: response,
		outcome: {
			kind: 'logs',
			job_id: args.job_id,
			lines: redactedLogs,
			finished: result.finished,
			truncated: result.truncated,
		},
		totalResults: redactedLogs.length,
		resultsShared: redactedLogs.length,
	};
}
