import type { LogsArgs } from '../types.js';
import type { JobsApiClient } from '../api-client.js';
import { fetchJobLogs, DEFAULT_LOG_WAIT_MS, DEFAULT_LOG_WAIT_SECONDS } from '../sse-handler.js';
import { notifyJobsProgress, type JobsProgressCallback } from '../progress.js';

/**
 * Execute the 'logs' command
 * Fetches logs from a job via SSE
 */
export async function logsCommand(
	args: LogsArgs,
	client: JobsApiClient,
	token?: string,
	onProgress?: JobsProgressCallback
): Promise<string> {
	await notifyJobsProgress(onProgress, { progress: 0, message: `Following logs for job ${args.job_id}.` });

	// Get namespace for the logs URL
	const namespace = await client.getNamespace(args.namespace);
	const logsUrl = client.getLogsUrl(args.job_id, namespace);

	// Fetch logs with timeout and line limit
	const result = await fetchJobLogs(logsUrl, {
		token,
		maxDuration: DEFAULT_LOG_WAIT_MS,
		maxLines: args.tail,
		onProgress,
	});

	if (result.logs.length === 0) {
		return `No logs available for job ${args.job_id}`;
	}

	let response = `**Logs for job ${args.job_id}** (last ${args.tail} lines):\n\n${'```'}\n`;
	response += result.logs.join('\n');
	response += `\n${'```'}`;

	if (result.finished) {
		response += '\n\n✓ Job finished.';
	} else if (result.truncated) {
		await notifyJobsProgress(onProgress, {
			message: `Stopped following logs after ${DEFAULT_LOG_WAIT_SECONDS}s; job may still be running.`,
		});
		response += `\n\n⚠ Log collection stopped after ${DEFAULT_LOG_WAIT_SECONDS} seconds. Job may still be running.`;
	}

	return response;
}
