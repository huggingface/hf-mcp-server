import { createHash } from 'node:crypto';
import { CACHE_CONFIG } from '../utils/gradio-cache.js';
import type { TaggedMethod } from './tag.js';

/**
 * Per-process memory of the current tag for each selection, so a checked
 * `tools/call` is a string comparison rather than a full server build.
 *
 * For eligible requests, definitions are a function of the deployed code, the
 * salt and the request's selection (see `definitionTagsMemoKey`), except for the
 * default Gradio Space, whose metadata and schema come from caches with their own
 * TTL. Entries expire on the same schedule, after which the next checked call takes
 * the full path once and refreshes the entry.
 */
export const MEMO_TTL_MS = Math.min(CACHE_CONFIG.SCHEMA_TTL, CACHE_CONFIG.SPACE_METADATA_TTL);
const MAX_ENTRIES = 10_000;

interface Remembered {
	tag: string;
	at: number;
}

let entries = new Map<string, Partial<Record<TaggedMethod, Remembered>>>();

export interface MemoKeyInput {
	headers: Record<string, string>;
	salt: string;
	/** Authenticated user name, when the request identified one. */
	userName?: string;
	clientName?: string;
	protocolVersion?: string;
	/** DISABLE_TOOLS, read per request by the server factory. */
	disabledTools?: string;
}

/**
 * Everything that can change the tool list or discovery result of an eligible
 * request. Over-keying only costs misses; under-keying would let a stale tag match,
 * so anything uncertain is included. Returns undefined (no memo) for a token whose
 * user was not identified.
 */
export function definitionTagsMemoKey(input: MemoKeyInput): string | undefined {
	const { headers } = input;
	const hasToken = /^Bearer\s+\S+/i.test(headers.authorization ?? '');
	if (hasToken && !input.userName) return undefined;
	const selection = Object.keys(headers)
		.filter((name) => name.startsWith('x-mcp-'))
		.sort()
		.map((name) => [name, headers[name]]);
	const parts = {
		selection,
		user: hasToken ? input.userName : null,
		clientName: input.clientName ?? null,
		userAgent: headers['user-agent'] ?? null,
		protocolVersion: input.protocolVersion ?? null,
		disabledTools: input.disabledTools ?? null,
		salt: input.salt,
	};
	return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

export function rememberTag(key: string, method: TaggedMethod, tag: string, now = Date.now()): void {
	const entry = entries.get(key) ?? {};
	entries.delete(key); // re-insert as most recent
	entry[method] = { tag, at: now };
	entries.set(key, entry);
	if (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest !== undefined) entries.delete(oldest);
	}
}

/** The current tag for this selection, or undefined when unknown or expired. */
export function recallTag(key: string, method: TaggedMethod, now = Date.now()): string | undefined {
	const remembered = entries.get(key)?.[method];
	if (!remembered) return undefined;
	if (now - remembered.at >= MEMO_TTL_MS) return undefined;
	return remembered.tag;
}

export function definitionTagsMemoSize(): number {
	return entries.size;
}

export function resetDefinitionTagsMemo(): void {
	entries = new Map();
}
