import { fetchWithProfile, NETWORK_FETCH_PROFILES, type SafeFetchProfile } from '@llmindset/hf-mcp/network';
import { hfWhoamiResponseSchema, type HfWhoamiResponse } from '@llmindset/hf-mcp';

// The /api/whoami-v2 response contract lives in @llmindset/hf-mcp (shared with the PTC hf_whoami tool).
export { type HfWhoamiResponse, type HfWhoamiAuthentication } from '@llmindset/hf-mcp';

const DEFAULT_HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
const DEFAULT_HF_API_TIMEOUT_MS = 12_500;

function isLoopbackHttpUrl(rawUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		return (
			parsed.protocol === 'http:' &&
			(parsed.hostname === '127.0.0.1' ||
				parsed.hostname === 'localhost' ||
				parsed.hostname === '::1' ||
				parsed.hostname === '[::1]')
		);
	} catch {
		return false;
	}
}

function resolveHfWhoamiTarget(): { url: string; profile: SafeFetchProfile } {
	const configured = process.env.HF_WHOAMI_URL?.trim();
	const url = configured || DEFAULT_HF_WHOAMI_URL;
	return {
		url,
		profile: isLoopbackHttpUrl(url) ? NETWORK_FETCH_PROFILES.localhostHttp() : NETWORK_FETCH_PROFILES.hfHub(),
	};
}

export class HfWhoamiRequestError extends Error {
	readonly kind: 'http' | 'invalid_response';
	readonly statusCode: number | undefined;

	constructor(kind: 'http' | 'invalid_response', statusCode?: number) {
		super(
			kind === 'http'
				? `Hugging Face whoami request failed with status ${statusCode?.toString() ?? 'unknown'}.`
				: 'Hugging Face whoami returned an invalid response.'
		);
		this.name = 'HfWhoamiRequestError';
		this.kind = kind;
		this.statusCode = statusCode;
	}
}

function hfApiTimeoutMs(): number {
	const configured = process.env.HF_API_TIMEOUT;
	if (!configured) {
		return DEFAULT_HF_API_TIMEOUT_MS;
	}

	const parsed = Number.parseInt(configured, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HF_API_TIMEOUT_MS;
}

export function isHfWhoamiUnauthorizedError(error: unknown): boolean {
	return error instanceof HfWhoamiRequestError && error.statusCode === 401;
}

/**
 * Calls the Hub API directly instead of relying on the narrower, stale
 * @huggingface/hub whoAmI response declarations.
 */
export async function fetchHfWhoami(accessToken: string): Promise<HfWhoamiResponse> {
	const { url, profile } = resolveHfWhoamiTarget();
	const { response } = await fetchWithProfile(url, profile, {
		timeoutMs: hfApiTimeoutMs(),
		requestInit: {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${accessToken}`,
			},
		},
	});

	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new HfWhoamiRequestError('http', response.status);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new HfWhoamiRequestError('invalid_response');
	}

	const parsed = hfWhoamiResponseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new HfWhoamiRequestError('invalid_response');
	}
	return parsed.data;
}
