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

export interface ClusterShutdownBudget {
	drainMs: number;
	ipcFlushMs: number;
	finalStatsMs: number;
	supervisorWaitMs: number;
}

/**
 * Derive coordinated worker + supervisor shutdown timeouts from `SHUTDOWN_GRACE_MS`
 * so workers always get their full HTTP drain + IPC flush + final stats budget before
 * the supervisor sends `SIGKILL`, while reserving >= 25% of `graceMs` (min 250ms) for
 * supervisor dataset log flushing and exit.
 */
export function computeClusterShutdownBudget(graceMs: number): ClusterShutdownBudget {
	const safeGraceMs = Number.isFinite(graceMs) && graceMs > 0 ? Math.max(100, Math.floor(graceMs)) : 25_000;
	const drainMs = Math.min(5_000, Math.max(10, Math.floor(safeGraceMs / 3)));
	const maxWorkerBudgetMs = Math.max(drainMs + 20, Math.floor(safeGraceMs * 0.62));
	const postDrainAvailMs = Math.max(20, maxWorkerBudgetMs - drainMs);
	const finalStatsMs = Math.min(500, Math.max(10, Math.floor(postDrainAvailMs * 0.2)));
	const ipcFlushMs = Math.min(2_000, Math.max(10, postDrainAvailMs - finalStatsMs));
	const workerTotalMs = drainMs + ipcFlushMs + finalStatsMs;
	const maxSupervisorWaitMs = Math.max(workerTotalMs + 10, Math.floor(safeGraceMs * 0.75));
	const headroomMs = Math.min(1_000, Math.max(10, Math.floor(safeGraceMs * 0.08)));
	const supervisorWaitMs = Math.min(maxSupervisorWaitMs, workerTotalMs + headroomMs);
	return {
		drainMs,
		ipcFlushMs,
		finalStatsMs,
		supervisorWaitMs,
	};
}
