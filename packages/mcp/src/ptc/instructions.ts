/**
 * Server instructions for the PTC bouquet only. Deliberately one rule-only line:
 * Codex tool_search and fast-agent capability_search index server instructions into
 * every tool entry, so tool names or task vocabulary here would flatten ranking.
 * Guidance lives in tool descriptions and schema field descriptions instead.
 * See docs-internal/ptc-parity/tool-search-seo.md and INSTRUCTIONS-RESEARCH.md (P1, 163 chars, all clients).
 */
export const PTC_INSTRUCTIONS =
	'Pass returned uri values unchanged to follow-up calls. Page with next_cursor (reads: next_offset) only as far as needed, other arguments unchanged. returned_count counts this page only.';
