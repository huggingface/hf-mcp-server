import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { PtcError } from '../core/errors.js';
import { hubFetch, requestPage } from '../core/hub-http.js';
import {
	collectionItem,
	paperItem,
	parseCollectionRef,
	parseRef,
	personRefSchema,
	refSchema,
	repoItem,
	type PtcItem,
} from '../core/refs.js';
import { definePtcTool, READ_ONLY, type PtcTool } from '../core/tool.js';
import { PAPER_REF } from '../listing/schemas.js';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 2048): string | undefined =>
	typeof value === 'string' && value ? value.slice(0, max) : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const REPO_ID = /^[\w.-]+(?:\/[\w.-]+)?$/;
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const MAX_ITEMS = 1000;
const MAX_HISTORY = 100;

function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const collectionEntry = z
	.object({
		// model | dataset | space | paper | bucket | collection
		kind: z.string(),
		id: z.string(),
		uri: z.string(),
		url: z.string(),
		title: z.string().optional(),
		// Curator's note attached to this item.
		note: z.string().optional(),
		position: z.number().optional(),
		likes: z.number().optional(),
		upvotes: z.number().optional(),
		downloads: z.number().optional(),
		pipelineTag: z.string().optional(),
	})
	.strict();
type CollectionEntry = z.infer<typeof collectionEntry>;

/** Map one collection item (union of 6 types upstream) to a typed Item, or undefined if unknown. */
function entryItem(item: Json): PtcItem | undefined {
	const type = item.type;
	const id = str(item.id, 256);
	if (type === 'model' || type === 'dataset' || type === 'space' || type === 'bucket') {
		return id && REPO_ID.test(id) ? repoItem(type, id) : undefined;
	}
	if (type === 'paper') return id && /^\d{4}\.\d{4,5}$/.test(id) ? paperItem(id) : undefined;
	if (type === 'collection') {
		const slug = str(item.slug, 300);
		const owner = isRecord(item.owner) ? str(item.owner.name, 96) : undefined;
		const full = slug?.includes('/') ? slug : slug && owner ? `${owner}/${slug}` : undefined;
		return full && SLUG.test(full) ? collectionItem(full) : undefined;
	}
	return undefined;
}

function collectionEntryOf(item: Json): CollectionEntry | undefined {
	const ref = entryItem(item);
	if (!ref) return undefined;
	const note = isRecord(item.note) ? str(item.note.text, 2000) : undefined;
	return compact({
		...ref,
		title: str(item.title, 500)?.replace(/\s+/g, ' '),
		note: note?.trim() || undefined,
		position: num(item.position),
		likes: num(item.likes),
		upvotes: num(item.upvotes),
		downloads: num(item.downloads),
		pipelineTag: str(item.pipeline_tag, 100),
	});
}

function sortedItems(value: unknown): Json[] {
	return records(value)
		.map((item, index) => ({ item, order: num(item.position) ?? index }))
		.sort((a, b) => a.order - b.order)
		.map(({ item }) => item);
}

const summaryFields = {
	kind: z.literal('collection'),
	// Collection slug, owner/slug-id.
	id: z.string(),
	uri: z.string(),
	url: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	owner: z.string().optional(),
	upvotes: z.number().optional(),
	private: z.boolean().optional(),
	// True when the collection groups gated repositories.
	gated: z.boolean().optional(),
	lastModified: z.string().optional(),
};

function summaryOf(data: Json) {
	const slug = str(data.slug, 300) ?? str(data.name, 300);
	if (!slug || !SLUG.test(slug)) return undefined;
	return compact({
		...collectionItem(slug),
		kind: 'collection' as const,
		title: str(data.title, 500),
		description: str(data.description, 2000),
		owner: isRecord(data.owner) ? str(data.owner.name, 96) : undefined,
		upvotes: num(data.upvotes),
		private: typeof data.private === 'boolean' ? data.private : undefined,
		gated: typeof data.gating === 'boolean' ? data.gating : undefined,
		lastModified: str(data.lastUpdated, 64),
	});
}

// ---------------------------------------------------------------- hf_collections_search

/** contains Ref -> upstream `item` filter: models|datasets|spaces|papers/ID. */
function itemFilter(ref: string): string {
	const value = ref.trim();
	const paper = PAPER_REF.exec(value);
	if (paper?.[1]) return `papers/${paper[1]}`;
	if (/^(?:hf:\/\/papers\/|arxiv:|https?:\/\/(?:www\.)?(?:(?:huggingface|hf)\.co\/papers|arxiv\.org)\/)/i.test(value))
		throw new PtcError('INVALID_ARGUMENT', 'contains: not a valid arXiv ID or paper reference.');
	const parsed = parseRef(value, 'model');
	if (parsed.kind === 'bucket' || !parsed.kind) {
		throw new PtcError('UNSUPPORTED', 'contains accepts a model, dataset, Space or paper reference.');
	}
	return `${parsed.kind}s/${parsed.id}`;
}

const collectionSummary = z
	.object({
		...summaryFields,
		itemsPreview: z.array(collectionEntry).max(4).describe('First few; full list via hf_collection_get.'),
	})
	.strict();

const hfCollectionsSearch = definePtcTool({
	name: 'hf_collections_search',
	family: 'collections',
	title: 'Search Hugging Face collections',
	description:
		'Search collections (curated lists, reading lists) by title or description words, owner, or a contained model, dataset, Space or paper. Sort by trending, upvotes or last update. Returns a page of collection URIs with item previews. See hf_collection_get.',
	input: z
		.object({
			query: z.string().trim().min(1).max(250).optional().describe('Words in the collection title or description.'),
			ownersAny: z
				.array(personRefSchema())
				.min(1)
				.max(10)
				.optional()
				.describe('Only collections of these users/orgs (names or profile uris; max 10).'),
			contains: refSchema.optional().describe('Only collections containing this repo or paper (hf:// uri or ID).'),
			sort: z.enum(['trending', 'upvotes', 'lastModified']).default('trending').describe('Ordering.'),
			limit: z.number().int().min(1).max(100).default(10).describe('Collections per page (max 100).'),
			cursor: z.string().max(4096).optional().describe('nextCursor from a previous call with the same arguments.'),
		})
		.strict(),
	output: z
		.object({
			items: z.array(collectionSummary).max(100),
			returnedCount: z.number().int(),
			nextCursor: z.string().nullable(),
			completeness: completenessSchema(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const params = new URLSearchParams();
		// The Hub search is case-insensitive and echoes q lowercased in its Link header;
		// send it lowercased so the continuation matches the bound query.
		if (input.query) params.set('q', input.query.toLowerCase());
		for (const owner of input.ownersAny ?? []) params.append('owner', owner);
		if (input.contains) params.set('item', itemFilter(input.contains));
		// The upstream Link echoes sort/expand/limit; send them explicitly so the continuation matches.
		params.set('sort', input.sort);
		params.set('expand', 'true');
		params.set('limit', String(input.limit));
		const { rows, nextCursor } = await requestPage('/api/collections', params, input.cursor, ctx);
		const items = records(rows).flatMap((row) => {
			const summary = summaryOf(row);
			if (!summary) return [];
			const preview = sortedItems(row.items)
				.flatMap((item) => collectionEntryOf(item) ?? [])
				.slice(0, 4);
			return [{ ...summary, itemsPreview: preview }];
		});
		return {
			items,
			returnedCount: items.length,
			nextCursor: nextCursor,
			completeness: { hasMore: nextCursor !== null },
		};
	},
});

// ---------------------------------------------------------------- hf_collection_get

const historyEntry = z
	.object({
		// Upstream change type, e.g. add, update, remove.
		action: z.string(),
		item: z.object({ kind: z.string(), id: z.string(), uri: z.string(), url: z.string() }).strict().optional(),
		createdAt: z.string().optional(),
		author: z.string().optional(),
	})
	.strict();

function historyOf(value: unknown): z.infer<typeof historyEntry>[] {
	return records(value).map((entry) => {
		const repo = isRecord(entry.repo) ? entry.repo : undefined;
		const item = repo ? entryItem({ type: repo.type, id: repo.name }) : undefined;
		return compact({
			action: str(entry.type, 50) ?? 'unknown',
			item,
			createdAt: str(entry.date, 64),
			author: isRecord(entry.author) ? str(entry.author.name, 96) : undefined,
		});
	});
}

const hfCollectionGet = definePtcTool({
	name: 'hf_collection_get',
	family: 'collections',
	title: 'Get a Hugging Face collection',
	description:
		'Read one collection (curated list, reading list) by slug, URL or hf:// URI. Returns title, description, owner and items with curator notes and item URIs, including models, datasets, Spaces, papers, buckets and nested collections. Optionally include recent change history. See hf_collections_search.',
	input: z
		.object({
			collection: z
				.string()
				.trim()
				.min(1)
				.max(400)
				.describe('hf://collections/OWNER/SLUG-ID, OWNER/SLUG-ID or collection URL.'),
			includeHistory: z.boolean().default(false).describe('Also return recent change history (up to 100 entries).'),
		})
		.strict(),
	output: z
		.object({
			...summaryFields,
			items: z.array(collectionEntry).max(MAX_ITEMS),
			returnedCount: z.number().int(),
			history: z.array(historyEntry).max(MAX_HISTORY).optional(),
			// truncated (reason items_cap) past MAX_ITEMS items or MAX_HISTORY history entries; the hint says where
			// to see the rest (the Hub API has no paging for these lists).
			completeness: completenessSchema({
				total: z.number().int().describe('Upstream items, including skipped ones.'),
				skippedItems: z
					.number()
					.int()
					.optional()
					.describe('Unsupported types (e.g. kernels) or malformed IDs, left out.'),
				// History entries returned upstream.
				numHistory: z.number().int().optional(),
			}),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const slug = parseCollectionRef(input.collection);
		const path = `/api/collections/${slug.split('/').map(encodeURIComponent).join('/')}`;
		// A renamed owner answers with a same-host 307 to the new path; follow it (Hub hosts only).
		const { data } = await hubFetch({ path, subject: 'collection', followRedirects: true }, ctx);
		const summary = isRecord(data) ? summaryOf({ ...data, slug: str(data.slug, 300) ?? slug }) : undefined;
		if (!isRecord(data) || !summary)
			throw new PtcError('UPSTREAM_RESPONSE', 'collection: unexpected upstream response.');
		const raw = sortedItems(data.items);
		const mapped = raw.flatMap((item) => collectionEntryOf(item) ?? []);
		const items = mapped.slice(0, MAX_ITEMS);
		let history: z.infer<typeof historyEntry>[] | undefined;
		let allHistory: z.infer<typeof historyEntry>[] | undefined;
		if (input.includeHistory) {
			const response = await hubFetch(
				{ path: `${path}/history`, subject: 'collection history', followRedirects: true },
				ctx
			);
			allHistory = historyOf(response.data);
			history = allHistory.slice(0, MAX_HISTORY);
		}
		const itemsTruncated = mapped.length > MAX_ITEMS;
		const historyTruncated = allHistory ? allHistory.length > MAX_HISTORY : undefined;
		return compact({
			...summary,
			items,
			returnedCount: items.length,
			history,
			completeness: compact({
				hasMore: itemsTruncated || !!historyTruncated,
				truncated: itemsTruncated || historyTruncated || undefined,
				reason: itemsTruncated || historyTruncated ? ('items_cap' as const) : undefined,
				total: raw.length,
				skippedItems: raw.length > mapped.length ? raw.length - mapped.length : undefined,
				numHistory: allHistory?.length,
				hint:
					itemsTruncated || historyTruncated
						? `Only part of this collection is returned; browse the rest at ${summary.url}.`
						: undefined,
			}),
		});
	},
});

/** Collections: search and get. */
export const COLLECTIONS_TOOLS: readonly PtcTool[] = [hfCollectionsSearch, hfCollectionGet];
