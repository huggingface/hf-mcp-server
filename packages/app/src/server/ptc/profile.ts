import { PTC_BOUQUETS, type PtcBouquet } from '../../shared/ptc-metrics.js';

/**
 * The PTC bouquet (`?bouquet=ptc`, aliases `codemode` and `openaiptc`) is an isolated
 * profile served by the same MCP server: its own toolset (packages/mcp/src/ptc),
 * instructions and metrics. It is not one of BOUQUETS, rejects mix, ignores gradio,
 * and never adds legacy tools.
 */
export function getPtcBouquet(headers?: Record<string, string> | null): PtcBouquet | undefined {
	const bouquet = headers?.['x-mcp-bouquet'];
	return bouquet !== undefined && (PTC_BOUQUETS as readonly string[]).includes(bouquet)
		? (bouquet as PtcBouquet)
		: undefined;
}

export function isPtcProfile(headers?: Record<string, string> | null): boolean {
	return getPtcBouquet(headers) !== undefined;
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
		throw new Error(
			'PTC bouquets (ptc/codemode/openaiptc) cannot be mixed. Use bouquet=ptc, bouquet=codemode, or bouquet=openaiptc without mix.'
		);
	}
}
