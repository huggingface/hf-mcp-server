/**
 * Soft paging guard. Exhaustive paging is the main way a code-mode client overspends (one Codex
 * run paged a listing 215 times). Cursors carry their page number (core/hub-http.ts); from
 * PAGING_NOTE_FROM_PAGE on, a result's `completeness` says how deep the caller is. Paging still works.
 *
 * The note is added after the zod contract has validated the result, so the contracts do not
 * declare it; `withoutPagingNote` lets the advertised output schema validate noted results too.
 */

export const PAGING_NOTE_FROM_PAGE = 10;

const PAGING_KEYS = ['page', 'paging_note'] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function withPagingNote(data: Json, page: number): Json {
	const completeness = data.completeness;
	if (page < PAGING_NOTE_FROM_PAGE || !isObject(completeness)) return data;
	return {
		...data,
		completeness: {
			...completeness,
			page,
			paging_note: `Page ${String(page)} of this query. Lists are pages, not totals: narrow the filters (query, owner, sort) instead of paging further unless every item is needed.`,
		},
	};
}

/** The result as the zod contract knows it (returns the same object when there is no note). */
export function withoutPagingNote(value: unknown): unknown {
	if (!isObject(value) || !isObject(value.completeness)) return value;
	const completeness = value.completeness;
	if (!PAGING_KEYS.some((key) => key in completeness)) return value;
	const rest = Object.fromEntries(
		Object.entries(completeness).filter(([key]) => !(PAGING_KEYS as readonly string[]).includes(key))
	);
	return { ...value, completeness: rest };
}
