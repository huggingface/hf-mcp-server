import os from 'node:os';

const PLAIN_INT_RE = /^\d+$/;
const MAX_WORKERS = 64;

/**
 * Parse `MCP_WORKERS`:
 * - unset, blank, or `'0'` -> `0` (single-process mode, zero IPC)
 * - `'auto'` -> `Math.max(1, Math.min(os.availableParallelism() - 1, 7))`
 * - plain decimal integer `1..64` -> `N`
 * - anything else -> warn to stderr and fall back to `0`
 */
export function parseMcpWorkers(
	raw: string | undefined = process.env.MCP_WORKERS,
	availableParallelism: number = os.availableParallelism()
): number {
	if (raw === undefined) return 0;
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed === '0') return 0;
	if (trimmed.toLowerCase() === 'auto') {
		return Math.max(1, Math.min(availableParallelism - 1, 7));
	}
	if (PLAIN_INT_RE.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		if (parsed >= 1 && parsed <= MAX_WORKERS) {
			return parsed;
		}
	}
	console.warn(
		`[cluster] Ignoring invalid MCP_WORKERS=${JSON.stringify(raw)} (expected 0, auto, or integer 1..${String(MAX_WORKERS)}); falling back to single-process mode`
	);
	return 0;
}
