/**
 * Server instructions for the PTC bouquet only. Deliberately one rule-only line:
 * Codex tool_search and fast-agent capability_search index server instructions into
 * every tool entry, so tool names or task vocabulary here would flatten ranking.
 * Guidance lives in tool descriptions and schema field descriptions instead. Rules shared by every
 * tool's output (uri threading, paging, returnedCount, completeness) are said here once, so output
 * schemas do not repeat them per field.
 * See docs-internal/ptc-parity/tool-search-seo.md and INSTRUCTIONS-RESEARCH.md (P1, 163 chars, all clients).
 */
export const PTC_INSTRUCTIONS =
	'Pass returned uris unchanged to later calls. Page with nextCursor (reads: nextOffset), same other arguments; returnedCount is per page. completeness: hasMore with null cursor = paging blocked; truncated = results no page returns (see reason, hint).';
