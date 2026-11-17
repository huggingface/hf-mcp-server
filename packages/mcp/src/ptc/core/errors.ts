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

const STATUS_IN_MESSAGE = /\b(401|403|404|409|422|429|5\d\d)\b/;

/**
 * Convert an unknown error thrown by a reused helper into a PtcError.
 * Known statuses (`statusCode` or `status` on the error, or a status in the message) map to codes;
 * hf_fs-style "EXXX: message" errors keep their (already user-facing) message.
 * Anything else becomes a generic, retryable upstream failure.
 */
export function toPtcError(error: unknown, subject = 'request'): PtcError {
	if (error instanceof PtcError) return error;
	if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
		return new PtcError('CANCELLED', `${subject}: cancelled or timed out.`, true);
	}
	const withStatus = error as { statusCode?: unknown; status?: unknown } | null;
	const status = withStatus?.statusCode ?? withStatus?.status;
	if (typeof status === 'number' && status >= 400) return ptcHttpError(status, subject);
	const message = error instanceof Error ? error.message : '';
	const fsCode = /^(EINVAL|ENOENT|ENOTDIR|EISDIR|ENOTSUP|EACCES|EFBIG|E2BIG|EPERM):\s*(.{1,300})/.exec(message);
	if (fsCode) {
		const map: Record<string, PtcErrorCode> = {
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
		return new PtcError(map[fsCode[1] ?? ''] ?? 'INVALID_ARGUMENT', `${subject}: ${fsCode[2] ?? ''}`.trim());
	}
	const statusMatch = STATUS_IN_MESSAGE.exec(message);
	if (statusMatch) return ptcHttpError(Number(statusMatch[1]), subject);
	return new PtcError(
		'UPSTREAM_UNAVAILABLE',
		`${subject}: upstream request failed. Check the arguments or retry later.`,
		true
	);
}
