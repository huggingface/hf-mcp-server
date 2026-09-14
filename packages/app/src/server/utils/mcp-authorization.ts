import { isDeepStrictEqual } from 'node:util';
import { fetchHfWhoami, isHfWhoamiUnauthorizedError, type HfWhoamiResponse } from './hf-whoami-client.js';
import { getGrantedOAuthScopes } from './oauth-scopes.js';

export class McpAuthorizationError extends Error {
	constructor(
		readonly statusCode: 401 | 403 | 503,
		message?: string
	) {
		super(
			message ??
				(statusCode === 403
					? 'OAuth authorization requires the exact read-mcp scope.'
					: statusCode === 401
						? 'Invalid Hugging Face credential.'
						: 'Hugging Face authentication is temporarily unavailable.')
		);
		this.name = 'McpAuthorizationError';
	}
}

interface VerifiedIdentity {
	token: string;
	snapshot: HfWhoamiResponse;
	expiresAt: number;
	remainingUses: number;
}

// Bounded handoff, NOT request-bound proof or a general token cache. Two reuses
// cover transport -> proxy -> factory. Retained internal references can reuse
// only the same token and unchanged identity within this short window; HTTP
// starts with fresh Hub validation on every request. Never renew on reuse.
const verifiedTokens = new WeakMap<HfWhoamiResponse, VerifiedIdentity>();
const VERIFICATION_HANDOFF_MS = 30_000;

function requireMcpScope(token: string, user: HfWhoamiResponse): void {
	// These non-OAuth types are evidenced by the whoami client/output fixtures.
	// The upstream schema intentionally accepts arbitrary types; policy must not.
	if (user.auth.type !== 'oauth' && user.auth.type !== 'access_token' && user.auth.type !== 'app_token') {
		throw new McpAuthorizationError(401, 'Unsupported Hugging Face credential type.');
	}
	const granted = getGrantedOAuthScopes(token);
	// Either signal suffices: an OAuth token must never fall through to PAT policy.
	if (user.auth.type === 'oauth' || granted.status !== 'not_oauth') {
		if (granted.status !== 'available' || !granted.scopes?.includes('read-mcp')) {
			throw new McpAuthorizationError(403);
		}
	}
	// Verified PATs (including fine-grained tokens) and app tokens need no OAuth scope. Hub
	// continues to enforce their resource/operation permissions on each API call.
}

/**
 * Global fail-closed policy for HTTP, STDIO and direct factory callers. A supplied
 * credential must pass Hub whoami AND MCP authorization before any tool/proxy
 * construction. STDIO startup fails on invalid, insufficient or unavailable auth;
 * there is no degraded authenticated session. Anonymous use remains supported.
 */
export async function verifyMcpAuthorization(token: string, contextUser?: HfWhoamiResponse): Promise<HfWhoamiResponse> {
	if (contextUser) {
		const verified = verifiedTokens.get(contextUser);
		if (
			verified &&
			verified.token === token &&
			verified.remainingUses > 0 &&
			Date.now() < verified.expiresAt &&
			isDeepStrictEqual(contextUser, verified.snapshot)
		) {
			verified.remainingUses -= 1;
			if (verified.remainingUses === 0) verifiedTokens.delete(contextUser);
			requireMcpScope(token, contextUser);
			return contextUser;
		}
		// Mutation, expiry or a different bearer cannot inherit verification.
		verifiedTokens.delete(contextUser);
	}

	let user: HfWhoamiResponse;
	try {
		user = await fetchHfWhoami(token);
	} catch (error) {
		throw new McpAuthorizationError(isHfWhoamiUnauthorizedError(error) ? 401 : 503);
	}
	// Decoding a claim is authorization input only AFTER Hub validated this token.
	requireMcpScope(token, user);
	verifiedTokens.set(user, {
		token,
		snapshot: structuredClone(user),
		expiresAt: Date.now() + VERIFICATION_HANDOFF_MS,
		remainingUses: 2,
	});
	return user;
}
