/**
 * The completeness core shared by every PTC tool that returns a list (NAMING-SPEC R14):
 * `{hasMore, truncated?, reason?, hint?}` plus extras declared by the tool that sets them.
 */
import { z } from 'zod';

/** Why hasMore is true without a continuation, or why truncated is set. */
const COMPLETENESS_REASONS = [
	/** The Hub's row-sort cursor can skip datasets: only the first page is safe. */
	'row_sort_cursor',
	/** The tool stopped scanning upstream pages for this call; continue with nextCursor. */
	'page_budget',
	/** Popularity sorts rank only a window of recent rows. */
	'ranking_window',
	/** Owner fan-out scanned only some repositories or threads. */
	'owner_fanout_cap',
	/** A list was cut to the tool's item cap; no continuation returns the rest. */
	'items_cap',
	/** Cell text was cut to the response text budget. */
	'text_budget',
] as const;

/**
 * Field semantics are stated once, in PTC_INSTRUCTIONS (server instructions), not per tool:
 * hasMore = more results exist beyond this response (no snapshot or total guarantee);
 * truncated = results are missing that no continuation will return (see reason and hint).
 */
const completenessCore = {
	hasMore: z.boolean(),
	truncated: z.boolean().optional(),
	reason: z.enum(COMPLETENESS_REASONS).optional(),
	hint: z.string().optional(),
};

type CompletenessShape<T extends z.ZodRawShape> = typeof completenessCore & T;

/** A strict completeness object: the core plus the tool's own extras. */
export function completenessSchema<T extends z.ZodRawShape = Record<never, never>>(
	extras?: T
): z.ZodObject<CompletenessShape<T>, z.core.$strict> {
	return z.object({ ...completenessCore, ...(extras ?? ({} as T)) }).strict();
}
