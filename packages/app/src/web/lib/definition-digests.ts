import type { DefinitionDigestsStatus } from '../../shared/definition-digests-status.js';

/** Served only in definition-digests test mode (404 otherwise). */
export const DEFINITION_DIGESTS_STATUS_URL = '/api/definition-digests';

export const definitionDigestsFetcher = (url: string): Promise<DefinitionDigestsStatus> =>
	fetch(url).then((res) => {
		if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
		return res.json() as Promise<DefinitionDigestsStatus>;
	});
