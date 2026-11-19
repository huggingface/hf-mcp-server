import { Buffer } from 'node:buffer';

const HF_OAUTH_ACCESS_TOKEN_PREFIX = 'hf_oauth_';
const HF_OAUTH_REFRESH_TOKEN_PREFIX = 'hf_oauth__refresh_';
const MAX_JWT_PAYLOAD_BYTES = 16_384;

export interface GrantedOAuthScopes {
	status: 'available' | 'not_oauth' | 'unavailable';
	scopes: string[] | null;
}

function uniqueNonEmptyStrings(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== 'string' || entry.trim().length === 0) {
			return null;
		}
		const scope = entry.trim();
		if (!seen.has(scope)) {
			seen.add(scope);
			result.push(scope);
		}
	}
	return result;
}

/**
 * Reads the granted scope claim from an HF OAuth access token.
 *
 * Authentication is still performed by the Hub `whoami-v2` call. This
 * routine only reads an already-authenticated token's signed payload for
 * display; it never treats local JWT decoding as proof of authentication.
 */
export function getGrantedOAuthScopes(token: string | undefined): GrantedOAuthScopes {
	if (!token?.startsWith(HF_OAUTH_ACCESS_TOKEN_PREFIX)) {
		return { status: 'not_oauth', scopes: null };
	}
	if (token.startsWith(HF_OAUTH_REFRESH_TOKEN_PREFIX)) {
		return { status: 'unavailable', scopes: null };
	}

	const jwt = token.slice(HF_OAUTH_ACCESS_TOKEN_PREFIX.length);
	const segments = jwt.split('.');
	const payloadSegment = segments[1];
	if (segments.length !== 3 || !payloadSegment) {
		return { status: 'unavailable', scopes: null };
	}

	try {
		const payloadBuffer = Buffer.from(payloadSegment, 'base64url');
		if (payloadBuffer.byteLength === 0 || payloadBuffer.byteLength > MAX_JWT_PAYLOAD_BYTES) {
			return { status: 'unavailable', scopes: null };
		}

		const payload: unknown = JSON.parse(payloadBuffer.toString('utf8'));
		if (typeof payload !== 'object' || payload === null || !('scope' in payload)) {
			return { status: 'unavailable', scopes: null };
		}

		const rawScopes = (payload as { scope?: unknown }).scope;
		const scopes =
			typeof rawScopes === 'string'
				? uniqueNonEmptyStrings(rawScopes.split(/\s+/).filter(Boolean))
				: uniqueNonEmptyStrings(rawScopes);
		return scopes ? { status: 'available', scopes } : { status: 'unavailable', scopes: null };
	} catch {
		return { status: 'unavailable', scopes: null };
	}
}
