import { PtcError } from '../core/errors.js';
import { requestPage } from '../core/hub-http.js';
import { canonicalPersonNames } from '../core/person.js';
import type { PtcContext } from '../core/tool.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from '../../network/fetch-profile.js';
import { readCappedText, ResponseTooLargeError } from '../../network/read-capped.js';
import { modelQuery, datasetQuery, spaceListQuery, spaceSearchQuery } from './query.js';
import type { z } from 'zod';
import {
	modelsOutputSchema,
	datasetsOutputSchema,
	spacesListOutputSchema,
	spacesSearchOutputSchema,
	normalizeModel,
	normalizeDataset,
	normalizeSpace,
	reference,
	spaceRecordSchema,
	type PtcSpaceRecord,
	type PtcModelsSearchResult,
	type PtcDatasetsSearchResult,
	type PtcSpacesListResult,
	type PtcSpacesSearchResult,
} from './records.js';
import type { ModelsInput, DatasetsInput, SpacesListInput, SpacesSearchInput } from './schemas.js';

type ListingPath = '/api/models' | '/api/datasets' | '/api/spaces';

async function listing<T, P extends ListingPath>(
	path: P,
	params: URLSearchParams,
	cursor: string | undefined,
	ctx: PtcContext,
	normalize: (row: unknown) => T
) {
	const page = await requestPage(path, params, cursor, ctx);
	let items: T[];
	try {
		items = page.rows.map((row) => normalize(row));
	} catch {
		throw new PtcError('UPSTREAM_RESPONSE', 'malformed upstream metadata or output contract violation.');
	}
	// The Hub builds dotted row-count sort cursors from a literal property,
	// silently jumping to null rows. Never advertise that unsafe continuation.
	const rowPaginationBlocked =
		path === '/api/datasets' && params.get('sort') === 'datasetsServerInfo.numRows' && page.nextCursor !== null;
	const nextCursor = rowPaginationBlocked ? null : page.nextCursor;
	return {
		items,
		next_cursor: nextCursor,
		returned_count: items.length,
		completeness: {
			scope: 'listing_page' as const,
			global_complete: false as const,
			continuation_available: nextCursor !== null,
			end_of_listing: rowPaginationBlocked ? null : nextCursor === null,
			...(rowPaginationBlocked ? { pagination_blocked_reason: 'upstream_row_sort_cursor' as const } : {}),
		},
	};
}

function checked<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new PtcError('UPSTREAM_RESPONSE', 'malformed upstream metadata or output contract violation.');
	}
	return result.data;
}

/**
 * The listings' author= filter is case-sensitive ("qwen" and "EVALSTATE" match nothing), so authors_any
 * names are resolved to their canonical case first (cached; see core/person.ts). Names that are no
 * user or organization are reported in completeness.unknown_owners instead of a silent empty page.
 */
async function withCanonicalAuthors<V extends { authors_any?: string[] }>(
	v: V,
	ctx: PtcContext
): Promise<{ input: V; unknown: string[] }> {
	const { names, unknown } = await canonicalPersonNames(v.authors_any ?? [], ctx);
	return { input: { ...v, authors_any: names }, unknown };
}

function withUnknownOwners<T extends { completeness: object }>(page: T, unknown: string[]): T {
	return unknown.length ? { ...page, completeness: { ...page.completeness, unknown_owners: unknown } } : page;
}

export async function listModels(v: ModelsInput, ctx: PtcContext): Promise<PtcModelsSearchResult> {
	// No await (and no extra request) without authors_any.
	const { input, unknown } = v.authors_any?.length ? await withCanonicalAuthors(v, ctx) : { input: v, unknown: [] };
	const page = await listing('/api/models', modelQuery(input), v.cursor, ctx, normalizeModel);
	return checked(modelsOutputSchema, withUnknownOwners(page, unknown));
}
export async function listDatasets(v: DatasetsInput, ctx: PtcContext): Promise<PtcDatasetsSearchResult> {
	const { input, unknown } = v.authors_any?.length ? await withCanonicalAuthors(v, ctx) : { input: v, unknown: [] };
	const page = await listing('/api/datasets', datasetQuery(input), v.cursor, ctx, normalizeDataset);
	return checked(datasetsOutputSchema, withUnknownOwners(page, unknown));
}
export async function listSpaces(v: SpacesListInput, ctx: PtcContext): Promise<PtcSpacesListResult> {
	const { input, unknown } = v.authors_any?.length ? await withCanonicalAuthors(v, ctx) : { input: v, unknown: [] };
	const page = await listing('/api/spaces', spaceListQuery(input), v.cursor, ctx, normalizeSpace);
	return checked(spacesListOutputSchema, withUnknownOwners(page, unknown));
}

/** Byte budget for the operator catalog body, enforced while streaming. */
const MAX_CATALOG_CHARS = 1_000_000;
const MAX_CATALOG_ROWS = 1000;

/** Operator catalog CSV (DYNAMIC_SPACE_DATA): `space_id,category,"description"` per line, as for dynamic_space discover. */
function parseCatalog(content: string): PtcSpaceRecord[] {
	const records: PtcSpaceRecord[] = [];
	for (const line of content.split('\n')) {
		if (records.length >= MAX_CATALOG_ROWS) break;
		const match = /^([^,]+),([^,]+),"([^"]*)"\s*$/.exec(line.trim()) ?? /^([^,]+),([^,]+),(.*)$/.exec(line.trim());
		const id = match?.[1]?.trim();
		if (!match || !id || !/^[\w.-]+\/[\w.-]+$/.test(id)) continue;
		const parsed = spaceRecordSchema.safeParse({
			...reference('space', id),
			category: match[2]?.trim().slice(0, 2048) || undefined,
			short_description: match[3]?.trim() || undefined,
		});
		if (parsed.success) records.push(parsed.data);
	}
	return records;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

async function loadCatalog(ctx: PtcContext): Promise<PtcSpaceRecord[]> {
	const url = process.env.DYNAMIC_SPACE_DATA;
	if (!url) {
		throw new PtcError(
			'UNSUPPORTED',
			'source curated is not available: this server has no curated Space catalog configured. Use source hub.'
		);
	}
	const profile =
		process.env.ALLOW_PERMISSIVE_URLS === 'true'
			? NETWORK_FETCH_PROFILES.httpOrHttpsPermissive()
			: NETWORK_FETCH_PROFILES.externalHttps();
	let content: string;
	try {
		const { response } = await fetchWithProfile(url, profile, {
			timeoutMs: 10_000,
			...(ctx.signal ? { requestInit: { signal: ctx.signal } } : {}),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		// Streamed with a byte budget: an oversized catalog is refused without being buffered.
		content = await readCappedText(response, MAX_CATALOG_CHARS, ctx.signal);
	} catch (error) {
		if (ctx.signal?.aborted) throw new PtcError('CANCELLED', 'curated Space catalog: cancelled.', true);
		if (error instanceof ResponseTooLargeError) {
			throw new PtcError('UPSTREAM_RESPONSE', 'curated Space catalog is too large.');
		}
		// Never echo the operator URL or upstream details.
		throw new PtcError('UPSTREAM_UNAVAILABLE', 'curated Space catalog could not be loaded.', true);
	}
	return parseCatalog(content);
}

async function curatedSpaces(v: SpacesSearchInput, ctx: PtcContext): Promise<PtcSpacesSearchResult> {
	const catalog = await loadCatalog(ctx);
	const terms = (v.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	const eligible = catalog.filter((item) => {
		if (v.category && slug(item.category ?? '') !== v.category) return false;
		const haystack = `${item.id} ${item.category ?? ''} ${item.short_description ?? ''}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
	const items = eligible.slice(0, v.limit);
	return checked(spacesSearchOutputSchema, {
		items,
		next_cursor: null,
		returned_count: items.length,
		candidate_count: catalog.length,
		eligible_count: eligible.length,
		completeness: {
			scope: 'curated_catalog',
			global_complete: false,
			continuation_available: false,
			end_of_listing: null,
		},
	});
}

export async function searchSpaces(v: SpacesSearchInput, ctx: PtcContext): Promise<PtcSpacesSearchResult> {
	if (v.source === 'curated') return curatedSpaces(v, ctx);
	const path = '/api/spaces/semantic-search' as const;
	const page = await requestPage(path, spaceSearchQuery(v), undefined, ctx);
	let candidates;
	try {
		candidates = page.rows.map(normalizeSpace);
	} catch {
		throw new PtcError('UPSTREAM_RESPONSE', 'malformed upstream metadata or output contract violation.');
	}
	const eligible = candidates.filter(
		(item) =>
			(!v.mcp_only || item.tags?.includes('mcp-server')) &&
			(!v.tags_any || v.tags_any.some((tag) => item.tags?.includes(tag))) &&
			(!v.sdks || v.sdks.some((sdk) => sdk === item.sdk)) &&
			(v.include_non_running || item.runtime?.stage === 'RUNNING' || item.runtime?.stage === 'RUNNING_BUILDING')
	);
	const items = eligible.slice(0, v.limit);
	return checked(spacesSearchOutputSchema, {
		items,
		next_cursor: null,
		returned_count: items.length,
		candidate_count: candidates.length,
		eligible_count: eligible.length,
		completeness: {
			scope: 'semantic_candidates',
			global_complete: false,
			continuation_available: false,
			end_of_listing: null,
		},
	});
}
