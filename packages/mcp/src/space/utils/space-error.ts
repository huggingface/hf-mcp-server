import type { DynamicSpaceErrorMetadata, ToolResult } from '../../types/tool-result.js';
import { SpaceHttpError } from './space-http.js';

/** Only typed HTTP failures during fetching override the caller's fallback. */
export function formatSpaceFailure(error: unknown, fallback: DynamicSpaceErrorMetadata, context: string): ToolResult {
	let errorMetadata = fallback;
	let action: string | undefined;
	if (
		error instanceof SpaceHttpError &&
		(fallback.code === 'metadata_fetch_failed' || fallback.code === 'schema_fetch_failed')
	) {
		let code: DynamicSpaceErrorMetadata['code'] | undefined;
		if (error.status === 401) {
			code = 'authentication_required';
			action = 'Provide a valid Hugging Face token with access to this Space, then try again.';
		} else if (error.status === 403) {
			code = 'access_denied';
			action = 'Check the token permissions and request access from the Space owner before trying again.';
		} else if (error.status === 404) {
			code = 'not_found_or_inaccessible';
			action =
				'Verify the Space name and your access; the Space or endpoint may be missing or inaccessible.' +
				(fallback.stage === 'schema' ? ' Confirm that the Space is running and MCP is enabled.' : '');
		} else if (error.status === 429 || (error.status >= 500 && error.status <= 599)) {
			code = 'service_unavailable';
			action = 'Check the Space service status and wait before trying again; respect Retry-After if provided.';
		}
		if (code) errorMetadata = { stage: fallback.stage, code };
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		formatted: `${context}: ${message}${action ? `\n\nNext action: ${action}` : ''}`,
		totalResults: 0,
		resultsShared: 0,
		isError: true,
		errorMetadata,
	};
}
