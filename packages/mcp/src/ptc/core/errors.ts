/**
 * Only explicitly constructed, sanitized errors may cross the MCP boundary.
 * Raw fetch exceptions, upstream bodies, URLs and credentials never do.
 */
export type PtcErrorCode =
	| 'INVALID_ARGUMENT'
	| 'INVALID_CURSOR'
	| 'NOT_FOUND'
	| 'AUTH_REQUIRED'
	| 'FORBIDDEN'
	| 'UNSUPPORTED'
	| 'CONFLICT'
	| 'UPSTREAM_HTTP'
	| 'UPSTREAM_RESPONSE'
	| 'UPSTREAM_UNAVAILABLE'
	| 'CANCELLED';

export class PtcError extends Error {
	constructor(
		public readonly code: PtcErrorCode,
		message: string,
		public readonly retryable = false
	) {
		super(message);
		this.name = 'PtcError';
	}
}

/** Map an HTTP status to a safe error. Never includes the response body. */
export function ptcHttpError(status: number, subject = 'resource'): PtcError {
	if (status === 401) return new PtcError('AUTH_REQUIRED', `${subject}: authentication required.`);
	if (status === 403) return new PtcError('FORBIDDEN', `${subject}: access denied for this token.`);
	if (status === 404) return new PtcError('NOT_FOUND', `${subject} not found (or not visible to this token).`);
	if (status === 409) return new PtcError('CONFLICT', `${subject}: conflict (it may already exist).`);
	if (status === 400 || status === 422)
		return new PtcError('INVALID_ARGUMENT', `${subject}: request rejected by the Hub.`);
	return new PtcError('UPSTREAM_HTTP', `${subject}: upstream HTTP ${String(status)}.`, status === 429 || status >= 500);
}

/**
 * HTTP-shaped messages thrown by reused legacy helpers. Only these shapes count as a status; a
 * number elsewhere in a message (an id, a size, "page 404") does not:
 *   "HTTP 404: Not Found"                               (space/utils/space-http SpaceHttpError)
 *   "... failed with status 404 Not Found"              (hf-fs-docs fetches)
 *   "Failed to fetch logs: 404 Not Found"               (jobs/sse-handler)
 *   "API request failed: 404 Not Found"                 (hf-api-call HfApiError, also has .status)
 *   "Sandbox RPC /x failed with 500: ..."               (sandbox-tool)
 */
const HTTP_STATUS_MESSAGE = [
	/^HTTP (\d{3})\b/,
	/\bstatus (\d{3})\b/i,
	/\bfailed(?: to fetch [\w ]{1,40})?(?: with)?:? (\d{3})\b/i,
];

function statusInMessage(message: string): number | undefined {
	for (const shape of HTTP_STATUS_MESSAGE) {
		const status = Number(shape.exec(message)?.[1]);
		if (status >= 400 && status <= 599) return status;
	}
	return undefined;
}

const ERRNO_CODES: Record<string, PtcErrorCode> = {
	EINVAL: 'INVALID_ARGUMENT',
	ENOENT: 'NOT_FOUND',
	ENOTDIR: 'INVALID_ARGUMENT',
	EISDIR: 'INVALID_ARGUMENT',
	ENOTSUP: 'UNSUPPORTED',
	EACCES: 'FORBIDDEN',
	EPERM: 'FORBIDDEN',
	EFBIG: 'INVALID_ARGUMENT',
	E2BIG: 'INVALID_ARGUMENT',
};
const ERRNO_MESSAGE = /^(EINVAL|ENOENT|ENOTDIR|EISDIR|ENOTSUP|EACCES|EFBIG|E2BIG|EPERM):\s*([\s\S]*)$/;
const MAX_DETAIL = 200;

/**
 * The user-facing part of an hf_fs-style "EXXX: message": no errno prefix, no legacy shell hints
 * ("Try: cat ..."), no control characters, no token-like strings or URL queries, bounded length.
 */
function errnoDetail(detail: string): string {
	const clean = detail
		.replace(/\s*Try:[\s\S]*$/, '')
		.replace(/\p{Cc}+/gu, ' ')
		.replace(/\bhf_[A-Za-z0-9]{6,}\b/g, '[redacted]')
		.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 3)}...` : clean;
}

/**
 * Convert an unknown error thrown by a reused helper into a PtcError.
 * Statuses come from a structured `statusCode`/`status` field or an HTTP-shaped message (above).
 * hf_fs-style "EXXX: message" errors map the errno to a code and keep a sanitized detail.
 * Anything else becomes a generic, retryable upstream failure.
 */
export function toPtcError(error: unknown, subject = 'request'): PtcError {
	if (error instanceof PtcError) return error;
	if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
		return new PtcError('CANCELLED', `${subject}: cancelled or timed out.`, true);
	}
	const withStatus = error as { statusCode?: unknown; status?: unknown } | null;
	const status = withStatus?.statusCode ?? withStatus?.status;
	if (typeof status === 'number' && status >= 400 && status <= 599) return ptcHttpError(status, subject);
	const message = error instanceof Error ? error.message : '';
	const errno = ERRNO_MESSAGE.exec(message);
	if (errno) {
		const detail = errnoDetail(errno[2] ?? '');
		const code = ERRNO_CODES[errno[1] ?? ''] ?? 'INVALID_ARGUMENT';
		return new PtcError(
			code,
			detail ? `${subject}: ${detail}` : `${subject}: ${code.toLowerCase().replace('_', ' ')}.`
		);
	}
	const messageStatus = statusInMessage(message);
	if (messageStatus !== undefined) return ptcHttpError(messageStatus, subject);
	return new PtcError(
		'UPSTREAM_UNAVAILABLE',
		`${subject}: upstream request failed. Check the arguments or retry later.`,
		true
	);
}
