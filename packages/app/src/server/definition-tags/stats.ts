import type { DefinitionTagsStats } from '../../shared/definition-tags-status.js';
import { forward } from '../cluster/ipc.js';

function empty(): DefinitionTagsStats {
	return {
		taggedLists: 0,
		taggedDiscoveries: 0,
		checkedCalls: 0,
		memoChecks: 0,
		matched: 0,
		mismatched: 0,
		staleTools: 0,
		staleDiscovery: 0,
		since: new Date().toISOString(),
	};
}

let stats = empty();

export const recordTaggedList = forward('definitionTags.recordTaggedList', (): void => {
	stats.taggedLists++;
});

export const recordTaggedDiscovery = forward('definitionTags.recordTaggedDiscovery', (): void => {
	stats.taggedDiscoveries++;
});

export const recordCheckedCall = forward(
	'definitionTags.recordCheckedCall',
	(stale: readonly ('tools/list' | 'server/discover')[], fromMemo = false): void => {
		const now = new Date().toISOString();
		stats.checkedCalls++;
		if (fromMemo) stats.memoChecks++;
		stats.lastCheckedAt = now;
		if (stale.length === 0) {
			stats.matched++;
			return;
		}
		stats.mismatched++;
		stats.lastMismatchAt = now;
		if (stale.includes('tools/list')) stats.staleTools++;
		if (stale.includes('server/discover')) stats.staleDiscovery++;
	}
);

export function definitionTagsStats(): DefinitionTagsStats {
	return { ...stats };
}

export function resetDefinitionTagsStats(): void {
	stats = empty();
}
