/**
 * The PTC bouquet (`?bouquet=ptc`, alias `codemode`) is an isolated profile served by
 * the same MCP server: its own toolset (packages/mcp/src/ptc), instructions and
 * metrics. It is not one of BOUQUETS, rejects mix, ignores gradio, and never adds legacy tools.
 */
const PTC_BOUQUETS = ['ptc', 'codemode'] as const;

export function isPtcProfile(headers?: Record<string, string> | null): boolean {
	const bouquet = headers?.['x-mcp-bouquet'];
	return bouquet !== undefined && (PTC_BOUQUETS as readonly string[]).includes(bouquet);
}

/** PTC is a standalone profile, never an additive bouquet. */
export function validatePtcMix(headers?: Record<string, string> | null): void {
	const mixes = (headers?.['x-mcp-mix'] ?? '')
		.split(',')
		.map((mix) => mix.trim())
		.filter(Boolean);
	if (
		(isPtcProfile(headers) && mixes.length > 0) ||
		mixes.some((mix) => (PTC_BOUQUETS as readonly string[]).includes(mix))
	) {
		throw new Error('PTC bouquets (ptc/codemode) cannot be mixed. Use bouquet=ptc or bouquet=codemode without mix.');
	}
}
