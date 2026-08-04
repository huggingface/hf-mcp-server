export interface JobsProgress {
	progress?: number;
	message?: string;
}

export type JobsProgressCallback = (progress: JobsProgress) => void | Promise<void>;

/**
 * Job progress is advisory and must never interrupt the underlying operation.
 */
export async function notifyJobsProgress(
	onProgress: JobsProgressCallback | undefined,
	progress: JobsProgress
): Promise<void> {
	if (!onProgress) {
		return;
	}

	try {
		await onProgress(progress);
	} catch {
		// Ignore disconnected clients and callback failures.
	}
}
