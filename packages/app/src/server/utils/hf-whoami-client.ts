import { createHash } from 'node:crypto';
import { fetchWithProfile, type SafeFetchProfile } from '@llmindset/hf-mcp/network';
import { hfWhoamiResponseSchema, type HfWhoamiResponse } from '@llmindset/hf-mcp';
import { resolveValidatedHubFetchTarget } from './hub-url-policy.js';

// The /api/whoami-v2 response contract lives in @llmindset/hf-mcp (shared with the PTC hf_whoami tool).
export { type HfWhoamiResponse, type HfWhoamiAuthentication } from '@llmindset/hf-mcp';

const DEFAULT_HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
const DEFAULT_HF_API_TIMEOUT_MS = 12_500;
export const WHOAMI_CACHE_TTL_MS = 60_000;
const MAX_WHOAMI_CACHE_ENTRIES = 2_048;

interface WhoamiCacheEntry {
	value: HfWhoamiResponse;
	expiresAtMs: number;
}

const whoamiCache = new Map<string, WhoamiCacheEntry>();
const inFlightWhoami = new Map<string, Promise<HfWhoamiResponse>>();

function whoamiCacheKey(url: string, accessToken: string): string {
	return createHash('sha256').update(url).update('\0').update(accessToken).digest('base64url');
}

function getCachedWhoami(key: string, now: number): HfWhoamiResponse | undefined {
	const entry = whoamiCache.get(key);
	if (!entry) {
		return undefined;
	}
	if (entry.expiresAtMs <= now) {
		whoamiCache.delete(key);
		return undefined;
	}
	whoamiCache.delete(key);
	whoamiCache.set(key, entry);
	return entry.value;
}

function setCachedWhoami(key: string, value: HfWhoamiResponse, now: number): void {
	let expiresAtMs = now + WHOAMI_CACHE_TTL_MS;
	if (typeof value.auth.expiresAt === 'string') {
		const authExpiresAtMs = Date.parse(value.auth.expiresAt);
		if (Number.isFinite(authExpiresAtMs)) {
			if (authExpiresAtMs <= now) {
				whoamiCache.delete(key);
				return;
			}
			if (authExpiresAtMs < expiresAtMs) {
				expiresAtMs = authExpiresAtMs;
			}
		}
	}
	whoamiCache.delete(key);
	whoamiCache.set(key, { value, expiresAtMs });
	while (whoamiCache.size > MAX_WHOAMI_CACHE_ENTRIES) {
		const oldestKey = whoamiCache.keys().next().value;
		if (oldestKey === undefined) break;
		whoamiCache.delete(oldestKey);
	}
}

export function resetHfWhoamiCache(): void {
	whoamiCache.clear();
	inFlightWhoami.clear();
}

function resolveHfWhoamiTarget(): { url: string; profile: SafeFetchProfile } {
	const configured = process.env.HF_WHOAMI_URL?.trim();
	return resolveValidatedHubFetchTarget(configured || DEFAULT_HF_WHOAMI_URL, 'HF_WHOAMI_URL');
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

async function fetchHfWhoamiUncached(
	url: string,
	profile: SafeFetchProfile,
	accessToken: string
): Promise<HfWhoamiResponse> {
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

/**
 * Calls the Hub API directly instead of relying on the narrower, stale
 * @huggingface/hub whoAmI response declarations.
 */
export async function fetchHfWhoami(accessToken: string): Promise<HfWhoamiResponse> {
	const { url, profile } = resolveHfWhoamiTarget();
	const key = whoamiCacheKey(url, accessToken);
	const cached = getCachedWhoami(key, Date.now());
	if (cached) {
		return cached;
	}

	const existing = inFlightWhoami.get(key);
	if (existing) {
		return existing;
	}

	const request = fetchHfWhoamiUncached(url, profile, accessToken)
		.then((result) => {
			setCachedWhoami(key, result, Date.now());
			return result;
		})
		.finally(() => {
			if (inFlightWhoami.get(key) === request) {
				inFlightWhoami.delete(key);
			}
		});

	inFlightWhoami.set(key, request);
	return request;
}
