/**
 * PTC (programmatic tool calling) toolset, served by `?bouquet=ptc`.
 * One typed function per operation; records carry kind/id/uri/url and every
 * resource argument accepts those hf:// uris. See ./README.md.
 */
import type { PtcAccess, PtcTool } from './core/tool.js';
import { LISTING_TOOLS } from './tools/listing.js';
import { DISCOVERY_TOOLS } from './tools/discovery.js';
import { REPO_TOOLS } from './tools/repo.js';
import { DATASET_TOOLS } from './tools/dataset.js';
import { PAPERS_TOOLS } from './tools/papers.js';
import { COLLECTIONS_TOOLS } from './tools/collections.js';
import { DOCS_TOOLS } from './tools/docs.js';
import { SPACES_TOOLS } from './tools/spaces.js';
import { PEOPLE_TOOLS } from './tools/people.js';
import { ACCOUNT_TOOLS } from './tools/account.js';
import { JOBS_TOOLS } from './tools/jobs.js';
import { SANDBOX_TOOLS } from './tools/sandbox.js';

export * from './core/tool.js';
export * from './core/errors.js';
export * from './core/refs.js';
export { advertisedOutputSchema, advertisedOutputJsonSchema } from './core/wire-schema.js';
export { advertisedInputSchema, normalizePtcArguments } from './core/arguments.js';
export type { AdvertisedInputSchema } from './core/arguments.js';
export type { AdvertisedSchema } from './core/wire-schema.js';
export { hubFetch, requestPage, sealCursor, openCursor, HUB_ORIGIN, DATASETS_SERVER_ORIGIN } from './core/hub-http.js';
export type { HubFetchRequest, HubFetchResponse, PtcCallOptions } from './core/hub-http.js';
export { PTC_INSTRUCTIONS } from './instructions.js';
export type {
	PtcModelRecord,
	PtcDatasetRecord,
	PtcSpaceRecord,
	RepoReference as PtcRepoReference,
	PtcModelsSearchResult,
	PtcDatasetsSearchResult,
	PtcSpacesListResult,
	PtcSpacesSearchResult,
} from './listing/records.js';

/** Every PTC tool, in family order. Names are unique (checked at load). */
export const PTC_TOOLS: readonly PtcTool[] = [
	...LISTING_TOOLS,
	...DISCOVERY_TOOLS,
	...REPO_TOOLS,
	...DATASET_TOOLS,
	...PAPERS_TOOLS,
	...COLLECTIONS_TOOLS,
	...DOCS_TOOLS,
	...SPACES_TOOLS,
	...PEOPLE_TOOLS,
	...ACCOUNT_TOOLS,
	...JOBS_TOOLS,
	...SANDBOX_TOOLS,
];

const BY_NAME = new Map(PTC_TOOLS.map((tool) => [tool.name, tool]));
if (BY_NAME.size !== PTC_TOOLS.length) throw new Error('Duplicate PTC tool name');

export const PTC_TOOL_NAMES: readonly string[] = PTC_TOOLS.map((tool) => tool.name);

export function getPtcTool(name: string): PtcTool | undefined {
	return BY_NAME.get(name);
}

const ACCESS_RANK: Record<PtcAccess, number> = { anonymous: 0, authenticated: 1, write: 2 };

/** Tools listed for a caller with the given access (all tools the token can use). */
export function ptcToolsForAccess(access: PtcAccess): PtcTool[] {
	return PTC_TOOLS.filter((tool) => ACCESS_RANK[tool.access] <= ACCESS_RANK[access]);
}
