import type { CacheHint } from '@modelcontextprotocol/server';
import { BOUQUETS } from '../../shared/bouquet-presets.js';
import { extractAuthBouquetAndMix } from '../utils/auth-utils.js';
import type { DefinitionTagsStatus, DefinitionTagsStats } from '../../shared/definition-tags-status.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TEST_SALT_LENGTH = 128;

export interface DefinitionTagsPolicy {
	ttlMs: number;
	/** Mixed into every tag; changes tags without changing definitions. */
	salt: string;
	/** Memo key for this request's selection (set by the transport; see memo.ts). */
	memoKey?: string;
	/** Known tags already matched against the memo; the adapter must not re-check. */
	verified?: boolean;
}

export interface PolicyEnvironment {
	/** DEFINITION_TAGS=off disables tags, checks and cache hints. */
	DEFINITION_TAGS?: string;
	/** Cache TTL for eligible tools/list and server/discover results (ms, default 5 min). */
	DEFINITION_TAGS_TTL_MS?: string;
	/** Deploy-wide salt; changing it invalidates every client's tags. */
	DEFINITION_TAGS_SALT?: string;
	/** "true" enables the runtime test salt (set via /api/definition-tags/salt). */
	DEFINITION_TAGS_TEST?: string;
}

// Per-process: with several replicas, each needs the same salt or tags flap.
let testSalt = '';
let testSaltUpdatedAt: string | undefined;

export function definitionTagsTestEnabled(env: PolicyEnvironment = process.env): boolean {
	return env.DEFINITION_TAGS_TEST === 'true';
}

export function getDefinitionTagsTestSalt(): string {
	return testSalt;
}

/** Sets (or, with '', clears) the runtime test salt. Throws on invalid input. */
export function setDefinitionTagsTestSalt(value: string): void {
	if (value.length > MAX_TEST_SALT_LENGTH || !/^[\x21-\x7e]*$/.test(value)) {
		throw new RangeError(`Salt must be at most ${MAX_TEST_SALT_LENGTH} printable ASCII characters without spaces`);
	}
	testSalt = value;
	testSaltUpdatedAt = new Date().toISOString();
}

/** Dashboard status; the caller supplies the error code and stats to avoid import cycles. */
export function definitionTagsStatus(
	errorCode: number,
	stats: DefinitionTagsStats,
	env: PolicyEnvironment = process.env
): DefinitionTagsStatus {
	return {
		enabled: definitionTagsEnabled(env),
		ttlMs: ttlMs(env.DEFINITION_TAGS_TTL_MS),
		deploySalt: env.DEFINITION_TAGS_SALT ?? '',
		testSalt,
		...(testSaltUpdatedAt ? { testSaltUpdatedAt } : {}),
		errorCode,
		stats,
	};
}

function ttlMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

/**
 * Decide whether a request gets definition tags (and cache hints).
 *
 * Tags are offered only where the complete tool list is cheap to build (no
 * per-user settings fetch; at most the cached default Gradio space):
 *  - anonymous requests: settings resolve locally (BOUQUET_FALLBACK, or the static
 *    defaults whose Gradio space metadata and schema are cached); and
 *  - a named bouquet other than `all`, with or without a token (bouquets take
 *    precedence over settings and skip settings-derived Gradio spaces).
 * An explicit gradio selection (other than `none`) always needs Space discovery.
 *
 * Everything else returns undefined: no tags, no checks (hints are ignored),
 * and the existing per-request shortcuts stay in place.
 */
export function definitionTagsPolicy(
	headers: Record<string, string> | null,
	env: PolicyEnvironment = process.env
): DefinitionTagsPolicy | undefined {
	if (!headers || !definitionTagsEnabled(env)) return undefined;

	const { hfToken, bouquet, gradio } = extractAuthBouquetAndMix(headers);
	if (gradio && gradio !== 'none') return undefined;

	const namedBouquet = bouquet !== undefined && bouquet !== 'all' && Object.hasOwn(BOUQUETS, bouquet);
	if (!namedBouquet && hfToken) return undefined;

	return {
		ttlMs: ttlMs(env.DEFINITION_TAGS_TTL_MS),
		salt: definitionTagsSalt(env),
	};
}

/** False when DEFINITION_TAGS=off. */
export function definitionTagsEnabled(env: PolicyEnvironment = process.env): boolean {
	return env.DEFINITION_TAGS !== 'off';
}

/** Effective salt: deploy-wide salt, then the runtime test salt when test mode is on. */
export function definitionTagsSalt(env: PolicyEnvironment = process.env): string {
	const runtimeSalt = definitionTagsTestEnabled(env) ? testSalt : '';
	return [env.DEFINITION_TAGS_SALT ?? '', runtimeSalt].filter(Boolean).join('/');
}

/**
 * Cache hints for eligible requests. Always `private`: `public` means every caller
 * would get the same result, not merely that it holds no user data. An anonymous
 * tool list omits tools that require sign-in, so a signed-in caller sharing a cache
 * would be served the shorter list. (The TypeScript client also keys shared entries
 * by server name, not URL, so different bouquets would collide.) Discovery can
 * vary by client and names the user in instructions.
 */
export function definitionTagsCacheHints(
	policy: DefinitionTagsPolicy
): Partial<Record<'tools/list' | 'server/discover', CacheHint>> {
	return {
		'tools/list': { ttlMs: policy.ttlMs, cacheScope: 'private' },
		'server/discover': { ttlMs: policy.ttlMs, cacheScope: 'private' },
	};
}
