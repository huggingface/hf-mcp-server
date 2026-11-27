import { jobLogTailSchema, type LogEvent } from './types.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from '../network/fetch-profile.js';
import { notifyJobsProgress, type JobsProgressCallback } from './progress.js';

/**
 * Default duration to wait for logs when not detached (in milliseconds)
 */
export const DEFAULT_LOG_WAIT_MS = 10000; // 10 seconds

/**
 * Default duration to wait for logs when not detached (in seconds, for display)
 */
export const DEFAULT_LOG_WAIT_SECONDS = DEFAULT_LOG_WAIT_MS / 1000;

/**
 * Default maximum number of log lines to return
 */
export const DEFAULT_MAX_LOG_LINES = 20;

/**
 * Options for fetching logs via SSE
 */
interface SseLogOptions {
	/** Maximum time to collect logs in milliseconds (default: 10000 = 10s) */
	maxDuration?: number;
	/** Maximum number of lines to return (default: 20) */
	maxLines?: number;
	/** HF API token for authentication */
	token?: string;
	/** Receives log and lifecycle events while the stream is consumed. */
	onProgress?: JobsProgressCallback;
	/** Applied to every line before it is stored, measured or truncated for progress (secret redaction). */
	redact?: (text: string) => string;
	/** Retained-size budget in characters: older lines are dropped while streaming once it is exceeded. */
	maxChars?: number;
	/** Each retained line is cut to this many characters (after redaction). */
	maxLineChars?: number;
	/**
	 * Snapshot settle window in ms: once at least one non-empty SSE chunk has been read, cleanly stop
	 * reading (without marking `truncated`) after this many ms of silence.
	 */
	idleTimeoutMs?: number;
	/**
	 * Optional initial quiet window in ms from response headers when no SSE chunk arrives at all
	 * (used for already-terminal jobs whose log stream opens cleanly with zero events).
	 */
	initialIdleTimeoutMs?: number;
	/** Caller cancellation: aborts the stream and rejects with an AbortError. */
	signal?: AbortSignal;
}

/** An SSE line longer than this without a newline is discarded rather than buffered. */
const MAX_PENDING_CHARS = 1_048_576;

/**
 * Result from fetching logs
 */
interface SseLogResult {
	/** Log lines collected */
	logs: string[];
	/** Whether the job finished during collection */
	finished: boolean;
	/** Whether collection was truncated due to timeout */
	truncated: boolean;
	/** Whether lines were dropped by maxLines, maxChars or an oversized line. */
	linesDropped: boolean;
}

/**
 * Fetch logs from a job via Server-Sent Events (SSE)
 * Collects logs for a maximum duration and returns the last N lines
 *
 * @param url - The SSE endpoint URL for job logs
 * @param options - Options for log collection
 * @returns Log result with collected lines and status
 */
export async function fetchJobLogs(url: string, options: SseLogOptions = {}): Promise<SseLogResult> {
	const { maxDuration = DEFAULT_LOG_WAIT_MS, maxLines = DEFAULT_MAX_LOG_LINES, token, onProgress, signal } = options;
	// Validate direct callers before opening the stream: a negative limit can never be reached by eviction.
	if (!jobLogTailSchema.safeParse(maxLines).success)
		throw new RangeError('maxLines must be an integer from 1 to 2000.');
	const redact = options.redact ?? ((text: string) => text);
	const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
	const maxLineChars = options.maxLineChars ?? Number.POSITIVE_INFINITY;

	// Bounded while streaming: at most maxLines lines and maxChars characters are ever retained.
	const logLines: string[] = [];
	let retainedChars = 0;
	let linesDropped = false;
	const keep = (raw: string): void => {
		const clean = redact(raw);
		const cut = clean.length > maxLineChars;
		const line = cut ? `${clean.slice(0, maxLineChars)}…` : clean;
		if (cut) linesDropped = true;
		logLines.push(line);
		retainedChars += line.length;
		while (logLines.length > maxLines || (retainedChars > maxChars && logLines.length > 1)) {
			retainedChars -= logLines.shift()?.length ?? 0;
			linesDropped = true;
		}
	};
	let finished = false;
	let truncated = false;
	let idleSettled = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	signal?.throwIfAborted();
	// Create abort controller for timeout
	const controller = new AbortController();
	const clearIdleTimer = (): void => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const timeoutId = setTimeout(() => {
		clearIdleTimer();
		if (idleSettled) return;
		truncated = true;
		controller.abort();
	}, maxDuration);
	const armIdleTimer = (ms: number | undefined): void => {
		clearIdleTimer();
		if (ms !== undefined && ms > 0 && !controller.signal.aborted) {
			idleTimer = setTimeout(() => {
				clearTimeout(timeoutId);
				if (truncated) return;
				idleSettled = true;
				controller.abort();
			}, ms);
		}
	};
	const onCallerAbort = () => controller.abort();
	signal?.addEventListener('abort', onCallerAbort, { once: true });

	try {
		const headers: Record<string, string> = {
			Accept: 'text/event-stream',
		};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		const { response } = await fetchWithProfile(url, NETWORK_FETCH_PROFILES.externalHttps(), {
			timeoutMs: maxDuration,
			requestInit: {
				headers,
				signal: controller.signal,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch logs: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error('Response body is null');
		}

		armIdleTimer(options.initialIdleTimeoutMs);

		// Process the SSE stream
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			// A cancelled reader can report done: never treat a caller abort as a normal end.
			signal?.throwIfAborted();

			if (done) {
				break;
			}

			if (value.byteLength > 0) {
				armIdleTimer(options.idleTimeoutMs);
			}

			// Decode chunk and add to buffer
			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // Keep incomplete line in buffer
			if (buffer.length > MAX_PENDING_CHARS) {
				buffer = '';
				linesDropped = true;
			}

			for (const line of lines) {
				// SSE format: "data: {json}"
				if (line.startsWith('data: ')) {
					try {
						const jsonStr = line.substring(6); // Remove "data: " prefix
						const event = JSON.parse(jsonStr) as LogEvent;

						// Filter out system messages
						if (event.data.startsWith('===== Job started')) {
							await notifyJobsProgress(onProgress, { message: 'Job started.' });
							continue;
						}

						// Check for job finished message
						if (event.data.startsWith('===== Job finished')) {
							finished = true;
							// Extract status from message if present
							// e.g., "===== Job finished: status=COMPLETED ====="
							keep(event.data);
							await notifyJobsProgress(onProgress, { message: redact(event.data).slice(0, 160) });
							break;
						}

						// Add log line
						keep(event.data);
						// Redact before shortening, so a secret cut at the boundary cannot leak a prefix.
						const message = redact(event.data).replace(/\s+$/u, '').split(/\r?\n/u).filter(Boolean).at(-1);
						await notifyJobsProgress(onProgress, {
							message: message ? `job: ${message.slice(0, 160)}` : 'Received job output.',
						});
					} catch {
						// Ignore malformed JSON
						continue;
					}
				}
			}

			// Break if job finished
			if (finished) {
				break;
			}
		}

		// Close the reader
		await reader.cancel();
	} catch (error) {
		signal?.throwIfAborted();
		// Timeouts and snapshot idle-settle timers abort the stream while waiting for more SSE chunks.
		if (!truncated && !idleSettled && !controller.signal.aborted) {
			throw error;
		}
	} finally {
		clearTimeout(timeoutId);
		clearIdleTimer();
		signal?.removeEventListener('abort', onCallerAbort);
	}
	signal?.throwIfAborted();

	return {
		logs: logLines,
		finished,
		truncated: truncated && !finished,
		linesDropped,
	};
}
