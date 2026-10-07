import type { DefinitionTagsStatus } from '../../shared/definition-tags-status.js';

/** Served only in definition-tags test mode (404 otherwise). */
export const DEFINITION_TAGS_STATUS_URL = '/api/definition-tags';

export const definitionTagsFetcher = (url: string): Promise<DefinitionTagsStatus> =>
	fetch(url).then((res) => {
		if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
		return res.json() as Promise<DefinitionTagsStatus>;
	});
