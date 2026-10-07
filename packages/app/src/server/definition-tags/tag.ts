import { createHash } from 'node:crypto';

/** Methods this server tags and checks on `tools/call` (both are relevant to a call). */
export const TAGGED_METHODS = ['tools/list', 'server/discover'] as const;
export type TaggedMethod = (typeof TAGGED_METHODS)[number];
/** Method -> the stale tag the client sent (never a current tag). */
export type StaleTags = Partial<Record<TaggedMethod, string>>;

// Canonicalize the JSON wire representation: undefined object properties are absent,
// array order is semantic, and object keys are sorted independently of insertion order.
function canonical(value: unknown): string {
	const json: unknown = JSON.parse(JSON.stringify(value));
	function encode(item: unknown): string {
		if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
		if (item !== null && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
				.join(',')}}`;
		}
		return JSON.stringify(item);
	}
	return encode(json);
}

/**
 * Deterministic tag for `value` as produced by `method`. The method is part of the
 * hash input, so equal payloads from different methods never share a tag. A salt
 * changes every tag without changing definitions (deploy-wide invalidation or test
 * rotation).
 */
export function definitionTag(method: string, value: unknown, salt = ''): string {
	const hash = createHash('sha256').update(`huggingface.co/definition-tags/v1/${method}\n`);
	if (salt) hash.update(`salt:${salt}\n`);
	return `sha256:${hash.update(canonical(value)).digest('hex')}`;
}

/** Sorts by a string key (JS ordinal), rejecting duplicates: collection order never affects a tag. */
export function sortedUnique<T>(items: readonly T[], key: (item: T) => string, kind: string): T[] {
	const seen = new Set<string>();
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) throw new Error(`Duplicate ${kind}: ${k}`);
		seen.add(k);
	}
	return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
