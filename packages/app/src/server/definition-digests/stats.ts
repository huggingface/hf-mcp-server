import type { DefinitionDigestsStats } from '../../shared/definition-digests-status.js';

function empty(): DefinitionDigestsStats {
	return {
		digestedLists: 0,
		digestedDiscoveries: 0,
		checkedCalls: 0,
		matched: 0,
		mismatched: 0,
		staleTools: 0,
		staleInstructions: 0,
		since: new Date().toISOString(),
	};
}

let stats = empty();

export function recordDigestedList(): void {
	stats.digestedLists++;
}

export function recordDigestedDiscovery(): void {
	stats.digestedDiscoveries++;
}

export function recordCheckedCall(stale: readonly ('tools' | 'instructions')[]): void {
	const now = new Date().toISOString();
	stats.checkedCalls++;
	stats.lastCheckedAt = now;
	if (stale.length === 0) {
		stats.matched++;
		return;
	}
	stats.mismatched++;
	stats.lastMismatchAt = now;
	if (stale.includes('tools')) stats.staleTools++;
	if (stale.includes('instructions')) stats.staleInstructions++;
}

export function definitionDigestsStats(): DefinitionDigestsStats {
	return { ...stats };
}

export function resetDefinitionDigestsStats(): void {
	stats = empty();
}
