import type { ServerContext } from '@modelcontextprotocol/server';
import { logger } from './logger.js';
import { isProgressToken } from './progress-token.js';

interface ProgressUpdate {
	progress?: number;
	total?: number;
	message?: string;
}

export type ProgressRelay = (progress: ProgressUpdate) => Promise<void>;

export function createProgressRelay(extra: ServerContext | undefined): ProgressRelay | undefined {
	if (!extra) {
		return undefined;
	}

	const progressToken = extra.mcpReq._meta?.progressToken;
	if (!isProgressToken(progressToken)) {
		return undefined;
	}

	let disabled = false;
	let fallbackProgress = 0;

	return async (progress): Promise<void> => {
		if (disabled || extra.mcpReq.signal.aborted) {
			disabled = true;
			return;
		}

		let progressValue = progress.progress;
		if (progressValue === undefined) {
			fallbackProgress += 1;
			progressValue = fallbackProgress;
		} else {
			fallbackProgress = Math.max(fallbackProgress, progressValue);
		}
		try {
			await extra.mcpReq.notify({
				method: 'notifications/progress',
				params: {
					progressToken,
					progress: progressValue,
					...(progress.total !== undefined ? { total: progress.total } : {}),
					...(progress.message !== undefined ? { message: progress.message } : {}),
				},
			});
		} catch (error) {
			disabled = true;
			logger.trace({ error, progressToken }, 'Progress relay disabled after notification failure');
		}
	};
}
