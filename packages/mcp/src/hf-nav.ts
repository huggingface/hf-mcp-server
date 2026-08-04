import { HUB_URL } from '@huggingface/hub';
import picomatch from 'picomatch';
import { safeFetch } from './network/safe-fetch.js';
import { createHuggingFaceHubPolicy } from './network/url-policy.js';
import { escapeMarkdown, fitsWithinCharBudget, maxCharsForTokenBudget } from './utilities.js';

const DEFAULT_LIMIT = 100;
export const HF_NAV_MAX_LIMIT = 250;
const GLOBAL_EXPANDED_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 2;
const MAX_DEPTH = 5;
const APPROX_CHARS_PER_TOKEN = 4;
export const HF_NAV_MAX_OUTPUT_TOKENS = 20_000;
export const HF_NAV_MAX_OUTPUT_CHARS = maxCharsForTokenBudget(HF_NAV_MAX_OUTPUT_TOKENS, APPROX_CHARS_PER_TOKEN);

export type HfNavOperation = 'ls' | 'stat' | 'cat' | 'find' | 'search';
export type HfNavEntryType = 'dir' | 'file' | 'collection' | 'link';
export type HfNavTargetType = 'repo' | 'collection' | 'paper' | 'bucket';
export type HfNavRepoType = 'model' | 'dataset' | 'space';

export interface HfNavParams {
	op: HfNavOperation;
	uri: string;
	glob?: string;
	recursive?: boolean;
	max_depth?: number;
	name?: string;
	path?: string;
	type?: HfNavEntryType | HfNavEntryType[];
	target_type?: HfNavTargetType | HfNavTargetType[];
	repo_type?: HfNavRepoType | HfNavRepoType[];
	query?: string;
	sort?: 'trending' | 'upvotes' | 'lastModified';
	limit?: number;
}

export interface HfNavEntry {
	type: HfNavEntryType;
	name: string;
	path: string;
	uri: string;
	target_uri?: string;
	target_type?: HfNavTargetType;
	repo_type?: HfNavRepoType;
	title?: string;
	description?: string;
	private?: boolean;
	upvotes?: number;
	updated_at?: string;
	created_at?: string;
	content_type?: 'application/json' | 'text/markdown';
}

interface BaseHfNavResult {
	uri: string;
	op: HfNavOperation;
}

export interface HfNavEntriesResult extends BaseHfNavResult {
	op: 'ls' | 'find' | 'search';
	entries: HfNavEntry[];
	truncated?: boolean;
	truncation_reason?: 'limit';
	truncation_message?: string;
}

export interface HfNavStatResult extends BaseHfNavResult {
	op: 'stat';
	exists: boolean;
	type: HfNavEntryType | 'missing';
	path: string;
	content_type?: 'application/json' | 'text/markdown';
	target_uri?: string;
}

export interface HfNavCatResult extends BaseHfNavResult {
	op: 'cat';
	content: string;
	content_type: 'application/json' | 'text/markdown';
}

export type HfNavResult = HfNavEntriesResult | HfNavStatResult | HfNavCatResult;

type ParsedHfNavUri =
	| { kind: 'root'; uri: 'hf://'; segments: [] }
	| { kind: 'collections-root'; uri: 'hf://collections'; segments: ['collections'] }
	| { kind: 'collections-readme'; uri: 'hf://collections/README.md'; segments: ['collections', 'README.md'] }
	| { kind: 'collection-owner'; uri: string; segments: ['collections', string]; owner: string }
	| { kind: 'collection'; uri: string; segments: ['collections', string, string]; owner: string; slug: string }
	| {
			kind: 'collection-child';
			uri: string;
			segments: ['collections', string, string, string];
			owner: string;
			slug: string;
			child: string;
	  }
	| {
			kind: 'collection-item';
			uri: string;
			segments: ['collections', string, string, 'items', string];
			owner: string;
			slug: string;
			item: string;
	  }
	| { kind: 'unsupported'; uri: string; segments: string[] };

interface CollectionOwner {
	name?: unknown;
}

interface ApiCollectionSummary {
	name?: unknown;
	slug?: unknown;
	title?: unknown;
	description?: unknown;
	private?: unknown;
	upvotes?: unknown;
	lastUpdated?: unknown;
	updatedAt?: unknown;
	createdAt?: unknown;
	owner?: CollectionOwner;
}

interface ApiCollectionDetail {
	slug?: unknown;
	title?: unknown;
	description?: unknown;
	private?: unknown;
	upvotes?: unknown;
	lastUpdated?: unknown;
	updatedAt?: unknown;
	createdAt?: unknown;
	owner?: CollectionOwner;
	items?: unknown;
}

interface ApiCollectionItemBase {
	type?: unknown;
	id?: unknown;
	slug?: unknown;
	title?: unknown;
	private?: unknown;
	upvotes?: unknown;
	lastModified?: unknown;
	lastUpdated?: unknown;
	updatedAt?: unknown;
	createdAt?: unknown;
	publishedAt?: unknown;
	position?: unknown;
	owner?: CollectionOwner;
	author?: unknown;
}

interface CollectionListPage {
	collections: ApiCollectionSummary[];
}

interface TraversalPage {
	entries: HfNavEntry[];
	truncated?: boolean;
}

export class HfNavTool {
	private readonly accessToken?: string;
	private readonly hubUrl: string;
	private readonly collectionCache = new Map<string, Promise<ApiCollectionDetail>>();

	constructor(hfToken?: string, hubUrl?: string) {
		this.accessToken = hfToken;
		this.hubUrl = hubUrl ?? HUB_URL;
	}

	async run(params: HfNavParams): Promise<HfNavResult> {
		validateParams(params);
		const parsed = parseHfNavUri(params.uri);

		switch (params.op) {
			case 'ls':
				return await this.ls(params, parsed);
			case 'stat':
				return await this.stat(params, parsed);
			case 'cat':
				return await this.cat(params, parsed);
			case 'find':
				return await this.find(params, parsed);
			case 'search':
				return await this.search(params, parsed);
		}
	}

	private async ls(params: HfNavParams, parsed: ParsedHfNavUri): Promise<HfNavEntriesResult> {
		const limit = params.limit ?? DEFAULT_LIMIT;
		const recursive = params.recursive ?? false;
		if (recursive) {
			const page = await this.traverse(parsed, {
				limit,
				maxDepth: params.max_depth ?? DEFAULT_MAX_DEPTH,
				matcher: createLsMatcher(params.glob),
			});
			return entriesResult(parsed.uri, 'ls', page.entries, page.truncated);
		}

		const page = await this.lsDirect(parsed, params);
		const matcher = createLsMatcher(params.glob);
		const entries = matcher ? page.entries.filter(matcher) : page.entries;
		return {
			...entriesResult(parsed.uri, 'ls', entries, page.truncated),
			...(page.truncation_message ? { truncation_message: page.truncation_message } : {}),
		};
	}

	private async lsDirect(
		parsed: ParsedHfNavUri,
		params: Pick<HfNavParams, 'limit'>
	): Promise<{ entries: HfNavEntry[]; truncated?: boolean; truncation_message?: string }> {
		const limit = params.limit ?? DEFAULT_LIMIT;
		switch (parsed.kind) {
			case 'root':
				return {
					entries: [{ type: 'dir', name: 'collections', path: 'collections', uri: 'hf://collections' }],
				};
			case 'collections-root': {
				const page = await this.listCollections({
					limit: Math.min(limit, GLOBAL_EXPANDED_LIMIT),
					expand: true,
				});
				return {
					entries: [
						collectionReadmeEntry(),
						...page.collections.flatMap((collection) => {
							const owner = stringValue(collection.owner?.name);
							return owner ? [collectionSummaryToEntry(collection, owner, `${owner}/`)] : [];
						}),
					],
					truncated: page.collections.length >= Math.min(limit, GLOBAL_EXPANDED_LIMIT),
					truncation_message:
						'Showing a bounded collection sample; use search hf://collections with query or ls hf://collections/OWNER.',
				};
			}
			case 'collections-readme':
				throw new Error('ENOTDIR: not a directory');
			case 'collection-owner': {
				const page = await this.listCollections({
					owner: parsed.owner,
					limit,
					expand: false,
				});
				return {
					entries: page.collections.map((collection) => collectionSummaryToEntry(collection, parsed.owner, '')),
					truncated: page.collections.length >= limit,
				};
			}
			case 'collection': {
				try {
					await this.getCollection(parsed.owner, parsed.slug);
				} catch (error) {
					if (isEnoent(error)) {
						throw new Error(
							`ENOENT: no such collection ${parsed.owner}/${parsed.slug}; use search hf://collections with query or ls hf://collections/${encodeHfPathSegment(parsed.owner)}`,
							{ cause: error }
						);
					}
					throw error;
				}
				return { entries: collectionChildren(parsed.uri) };
			}
			case 'collection-child':
				if (parsed.child === 'items') {
					const collection = await this.getCollection(parsed.owner, parsed.slug);
					return {
						entries: collectionItemsToEntries(collection, parsed.uri),
					};
				}
				if (parsed.child === 'metadata.json' || parsed.child === 'history.json') {
					throw new Error('ENOTDIR: not a directory');
				}
				throw new Error(
					`ENOENT: no such collection child "${parsed.child}"; valid children are metadata.json, history.json, and items`
				);
			case 'collection-item':
				throw new Error('ENOTDIR: not a directory');
			case 'unsupported':
				throw new Error('ENOTSUP: operation not supported for this path');
		}
	}

	private async stat(_params: HfNavParams, parsed: ParsedHfNavUri): Promise<HfNavStatResult> {
		switch (parsed.kind) {
			case 'root':
				return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: '' };
			case 'collections-root':
				return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: 'collections' };
			case 'collections-readme':
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: true,
					type: 'file',
					path: 'README.md',
					content_type: 'text/markdown',
				};
			case 'collection-owner':
				return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: parsed.owner };
			case 'collection':
				return await this.statCollection(parsed);
			case 'collection-child':
				return await this.statCollectionChild(parsed);
			case 'collection-item':
				return await this.statCollectionItem(parsed);
			case 'unsupported':
				throw new Error('ENOTSUP: operation not supported for this path');
		}
	}

	private async statCollection(parsed: Extract<ParsedHfNavUri, { kind: 'collection' }>): Promise<HfNavStatResult> {
		try {
			await this.getCollection(parsed.owner, parsed.slug);
			return {
				uri: parsed.uri,
				op: 'stat',
				exists: true,
				type: 'collection',
				path: `${parsed.owner}/${parsed.slug}`,
			};
		} catch (error) {
			if (isEnoent(error)) {
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: false,
					type: 'missing',
					path: `${parsed.owner}/${parsed.slug}`,
				};
			}
			throw error;
		}
	}

	private async statCollectionChild(
		parsed: Extract<ParsedHfNavUri, { kind: 'collection-child' }>
	): Promise<HfNavStatResult> {
		if (parsed.child !== 'metadata.json' && parsed.child !== 'items' && parsed.child !== 'history.json') {
			throw new Error(
				`ENOENT: no such collection child "${parsed.child}"; valid children are metadata.json, history.json, and items`
			);
		}
		try {
			await this.getCollection(parsed.owner, parsed.slug);
		} catch (error) {
			if (isEnoent(error)) {
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: false,
					type: 'missing',
					path: `${parsed.owner}/${parsed.slug}/${parsed.child}`,
				};
			}
			throw error;
		}

		return {
			uri: parsed.uri,
			op: 'stat',
			exists: true,
			type: parsed.child === 'items' ? 'dir' : 'file',
			path: `${parsed.owner}/${parsed.slug}/${parsed.child}`,
			...(parsed.child === 'items' ? {} : { content_type: 'application/json' as const }),
		};
	}

	private async statCollectionItem(
		parsed: Extract<ParsedHfNavUri, { kind: 'collection-item' }>
	): Promise<HfNavStatResult> {
		const itemsUri = `hf://collections/${encodeHfPathSegment(parsed.owner)}/${encodeHfPathSegment(parsed.slug)}/items`;
		try {
			const collection = await this.getCollection(parsed.owner, parsed.slug);
			const entry = collectionItemsToEntries(collection, itemsUri).find((item) => item.name === parsed.item);
			return {
				uri: parsed.uri,
				op: 'stat',
				exists: entry !== undefined,
				type: entry ? 'link' : 'missing',
				path: `${parsed.owner}/${parsed.slug}/items/${parsed.item}`,
				...(entry?.target_uri ? { target_uri: entry.target_uri } : {}),
			};
		} catch (error) {
			if (isEnoent(error)) {
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: false,
					type: 'missing',
					path: `${parsed.owner}/${parsed.slug}/items/${parsed.item}`,
				};
			}
			throw error;
		}
	}

	private async cat(_params: HfNavParams, parsed: ParsedHfNavUri): Promise<HfNavCatResult> {
		if (parsed.kind === 'collections-readme') {
			return {
				uri: parsed.uri,
				op: 'cat',
				content_type: 'text/markdown',
				content: COLLECTIONS_README,
			};
		}
		if (parsed.kind === 'collection') {
			throw new Error(
				`EISDIR: ${parsed.uri} is a collection directory; use ls ${parsed.uri}, cat ${parsed.uri}/metadata.json or ${parsed.uri}/history.json, or ls ${parsed.uri}/items`
			);
		}
		if (parsed.kind !== 'collection-child') {
			throw new Error(
				'EISDIR: collections are structured directories; use ls to discover metadata.json, history.json, and items'
			);
		}
		if (parsed.child === 'items') {
			throw new Error(`EISDIR: ${parsed.uri} is an items directory; use ls ${parsed.uri} to list linked Hub resources`);
		}
		if (parsed.child === 'metadata.json') {
			const collection = await this.getCollection(parsed.owner, parsed.slug);
			return {
				uri: parsed.uri,
				op: 'cat',
				content_type: 'application/json',
				content: JSON.stringify(collection, null, 2),
			};
		}
		if (parsed.child === 'history.json') {
			const history = await this.getCollectionHistory(parsed.owner, parsed.slug);
			return {
				uri: parsed.uri,
				op: 'cat',
				content_type: 'application/json',
				content: JSON.stringify(history, null, 2),
			};
		}
		throw new Error(
			`ENOENT: no such collection child "${parsed.child}"; valid children are metadata.json, history.json, and items`
		);
	}

	private async find(params: HfNavParams, parsed: ParsedHfNavUri): Promise<HfNavEntriesResult> {
		if (parsed.kind === 'root' || parsed.kind === 'collections-root') {
			throw new Error(
				'ENOTSUP: find cannot crawl all collections; use search hf://collections with query, or scope find to hf://collections/OWNER or hf://collections/OWNER/SLUG'
			);
		}
		const filters = createFindFilters(params);
		const page = await this.traverse(parsed, {
			limit: params.limit ?? DEFAULT_LIMIT,
			maxDepth: params.max_depth ?? DEFAULT_MAX_DEPTH,
			matcher: (entry) => matchesFindFilters(entry, filters),
		});
		return entriesResult(parsed.uri, 'find', page.entries, page.truncated);
	}

	private async search(params: HfNavParams, parsed: ParsedHfNavUri): Promise<HfNavEntriesResult> {
		if (parsed.kind !== 'collections-root' && parsed.kind !== 'collection-owner') {
			throw new Error(
				'ENOTSUP: collection search is supported only on hf://collections or hf://collections/OWNER; use ls or find to inspect a selected collection'
			);
		}
		const query = params.query?.trim();
		const limit = params.limit ?? DEFAULT_LIMIT;
		const collectionLimit = parsed.kind === 'collection-owner' ? limit : Math.min(limit, GLOBAL_EXPANDED_LIMIT);
		const page = await this.listCollections({
			owner: parsed.kind === 'collection-owner' ? parsed.owner : undefined,
			query,
			sort: params.sort ?? 'trending',
			limit: collectionLimit,
			expand: parsed.kind !== 'collection-owner',
		});
		const entries = page.collections.flatMap((collection) => {
			const owner = parsed.kind === 'collection-owner' ? parsed.owner : stringValue(collection.owner?.name);
			return owner
				? [collectionSummaryToEntry(collection, owner, parsed.kind === 'collection-owner' ? '' : `${owner}/`)]
				: [];
		});
		return entriesResult(parsed.uri, 'search', entries, page.collections.length >= collectionLimit);
	}

	private async traverse(
		parsed: ParsedHfNavUri,
		options: {
			limit: number;
			maxDepth: number;
			matcher?: (entry: HfNavEntry) => boolean;
		}
	): Promise<TraversalPage> {
		if (parsed.kind === 'unsupported') {
			throw new Error('ENOTSUP: operation not supported for this path');
		}
		const matched: HfNavEntry[] = [];
		let truncated = false;

		const visit = async (current: ParsedHfNavUri, depth: number, prefix: string): Promise<boolean> => {
			if (depth >= options.maxDepth) {
				return false;
			}
			const children = await this.traversalChildren(current);
			for (const child of children) {
				const entry = prefixEntry(child, prefix);
				const isMatch = options.matcher ? options.matcher(entry) : true;
				if (isMatch) {
					if (matched.length >= options.limit) {
						truncated = true;
						return true;
					}
					matched.push(entry);
				}
				if (isTraversableEntry(entry)) {
					const childParsed = parseHfNavUri(entry.uri);
					const childPrefix = joinRelativePath(prefix, child.path);
					const stop = await visit(childParsed, depth + 1, childPrefix);
					if (stop) {
						return true;
					}
				}
			}
			return false;
		};

		await visit(parsed, 0, '');
		return { entries: matched, truncated };
	}

	private async traversalChildren(parsed: ParsedHfNavUri): Promise<HfNavEntry[]> {
		switch (parsed.kind) {
			case 'root':
			case 'collections-root':
			case 'collections-readme':
			case 'collection-owner':
			case 'collection':
				return parsed.kind === 'collections-readme'
					? []
					: (await this.lsDirect(parsed, { limit: HF_NAV_MAX_LIMIT })).entries;
			case 'collection-child':
				if (parsed.child === 'items') {
					return (await this.lsDirect(parsed, { limit: HF_NAV_MAX_LIMIT })).entries;
				}
				return [];
			case 'collection-item':
				return [];
			case 'unsupported':
				throw new Error('ENOTSUP: operation not supported for this path');
		}
	}

	private async listCollections(options: {
		owner?: string;
		query?: string;
		sort?: 'trending' | 'upvotes' | 'lastModified';
		limit: number;
		expand: boolean;
	}): Promise<CollectionListPage> {
		const url = new URL('/api/collections', this.hubUrl);
		url.searchParams.set('limit', options.limit.toString());
		url.searchParams.set('expand', options.expand ? 'true' : 'false');
		if (options.owner) {
			url.searchParams.set('owner', options.owner);
		}
		if (options.query) {
			url.searchParams.set('q', options.query);
		}
		if (options.sort) {
			url.searchParams.set('sort', options.sort);
		}
		const { response } = await safeFetch(url.toString(), {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: { headers: this.headers() },
		});
		await assertOk(response, 'collection listing');
		const body: unknown = await response.json();
		return {
			collections: Array.isArray(body) ? (body as ApiCollectionSummary[]) : [],
		};
	}

	private async getCollection(owner: string, slug: string): Promise<ApiCollectionDetail> {
		const cacheKey = `${owner}/${slug}`;
		const cached = this.collectionCache.get(cacheKey);
		if (cached) {
			return await cached;
		}
		const promise = this.fetchCollection(owner, slug);
		this.collectionCache.set(cacheKey, promise);
		try {
			return await promise;
		} catch (error) {
			this.collectionCache.delete(cacheKey);
			throw error;
		}
	}

	private async fetchCollection(owner: string, slug: string): Promise<ApiCollectionDetail> {
		const url = new URL(`/api/collections/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`, this.hubUrl);
		const { response } = await safeFetch(url.toString(), {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: { headers: this.headers() },
		});
		await assertOk(response, 'collection');
		return (await response.json()) as ApiCollectionDetail;
	}

	private async getCollectionHistory(owner: string, slug: string): Promise<unknown> {
		const url = new URL(
			`/api/collections/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/history`,
			this.hubUrl
		);
		const { response } = await safeFetch(url.toString(), {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: { headers: this.headers() },
		});
		await assertOk(response, 'collection history');
		return await response.json();
	}

	private headers(): HeadersInit {
		return {
			accept: 'application/json',
			...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
		};
	}
}

export function parseHfNavUri(uri: string): ParsedHfNavUri {
	if (!uri.startsWith('hf://')) {
		throw new Error('EINVAL: URI must start with hf://');
	}
	let path = uri.slice('hf://'.length);
	if (path === '' || path === '/') {
		return { kind: 'root', uri: 'hf://', segments: [] };
	}
	if (path.startsWith('/')) {
		throw new Error('EINVAL: URI path must not contain empty segments');
	}
	path = path.replace(/\/+$/, '');
	if (path.includes('//')) {
		throw new Error('EINVAL: URI path must not contain empty segments');
	}
	const segments = path.split('/').map((segment) => {
		try {
			const decoded = decodeURIComponent(segment);
			if (!decoded) {
				throw new Error('empty');
			}
			return decoded;
		} catch {
			throw new Error('EINVAL: invalid percent-encoding in URI segment');
		}
	});
	const canonical = `hf://${segments.map(encodeHfPathSegment).join('/')}`;
	if (segments[0] !== 'collections') {
		return { kind: 'unsupported', uri: canonical, segments };
	}
	if (segments.length === 1) {
		return { kind: 'collections-root', uri: 'hf://collections', segments: ['collections'] };
	}
	if (segments.length === 2 && segments[1] === 'README.md') {
		return { kind: 'collections-readme', uri: 'hf://collections/README.md', segments: ['collections', 'README.md'] };
	}
	if (segments.length === 2) {
		return {
			kind: 'collection-owner',
			uri: canonical,
			segments: ['collections', segments[1] ?? ''],
			owner: segments[1] ?? '',
		};
	}
	if (segments.length === 3) {
		return {
			kind: 'collection',
			uri: canonical,
			segments: ['collections', segments[1] ?? '', segments[2] ?? ''],
			owner: segments[1] ?? '',
			slug: segments[2] ?? '',
		};
	}
	if (segments.length === 4) {
		return {
			kind: 'collection-child',
			uri: canonical,
			segments: ['collections', segments[1] ?? '', segments[2] ?? '', segments[3] ?? ''],
			owner: segments[1] ?? '',
			slug: segments[2] ?? '',
			child: segments[3] ?? '',
		};
	}
	if (segments.length === 5 && segments[3] === 'items') {
		return {
			kind: 'collection-item',
			uri: canonical,
			segments: ['collections', segments[1] ?? '', segments[2] ?? '', 'items', segments[4] ?? ''],
			owner: segments[1] ?? '',
			slug: segments[2] ?? '',
			item: segments[4] ?? '',
		};
	}
	return { kind: 'unsupported', uri: canonical, segments };
}

export function formatHfNavMarkdown(result: HfNavResult, maxChars = HF_NAV_MAX_OUTPUT_CHARS): string {
	return trimMarkdownToBudget(renderHfNavMarkdown(result), maxChars);
}

function validateParams(params: HfNavParams): void {
	if (
		params.limit !== undefined &&
		(!Number.isInteger(params.limit) || params.limit < 1 || params.limit > HF_NAV_MAX_LIMIT)
	) {
		throw new Error(`EINVAL: limit must be an integer between 1 and ${HF_NAV_MAX_LIMIT.toString()}`);
	}
	if (
		params.max_depth !== undefined &&
		(!Number.isInteger(params.max_depth) || params.max_depth < 0 || params.max_depth > MAX_DEPTH)
	) {
		throw new Error(`EINVAL: max_depth must be an integer between 0 and ${MAX_DEPTH.toString()}`);
	}
	if (params.glob !== undefined && params.op !== 'ls') {
		throw new Error('EINVAL: glob applies only to ls');
	}
	const hasFindFilter =
		params.name !== undefined ||
		params.path !== undefined ||
		params.type !== undefined ||
		params.target_type !== undefined ||
		params.repo_type !== undefined;
	if (hasFindFilter && params.op !== 'find') {
		throw new Error('EINVAL: name, path, type, target_type, and repo_type apply only to find');
	}
	if (params.query !== undefined && params.op !== 'search') {
		throw new Error('EINVAL: query applies only to search');
	}
	if (params.recursive === true && params.op !== 'ls') {
		throw new Error('EINVAL: recursive applies only to ls');
	}
}

function entriesResult(
	uri: string,
	op: 'ls' | 'find' | 'search',
	entries: HfNavEntry[],
	truncated?: boolean
): HfNavEntriesResult {
	return {
		uri,
		op,
		entries,
		...(truncated ? { truncated: true, truncation_reason: 'limit' as const } : {}),
	};
}

function isTraversableEntry(entry: HfNavEntry): boolean {
	// Traversal follows only virtual containment edges represented by `uri`.
	// `link` entries are terminal, even when `target_uri` points at a navigable hf:// URI
	// such as another collection; callers can start a separate traversal at that target.
	return entry.type === 'dir' || entry.type === 'collection';
}

function collectionSummaryToEntry(collection: ApiCollectionSummary, owner: string, pathPrefix: string): HfNavEntry {
	const rawName = stringValue(collection.name) ?? stringValue(collection.slug) ?? 'unknown';
	const name = collectionSlugName(rawName, owner);
	return compactEntry({
		type: 'collection',
		name,
		path: `${pathPrefix}${name}`,
		uri: `hf://collections/${encodeHfPathSegment(owner)}/${encodeHfPathSegment(name)}`,
		title: stringValue(collection.title),
		description: stringValue(collection.description),
		private: booleanValue(collection.private),
		upvotes: numberValue(collection.upvotes),
		updated_at: stringValue(collection.lastUpdated) ?? stringValue(collection.updatedAt),
		created_at: stringValue(collection.createdAt),
	});
}

function collectionSlugName(name: string, owner: string): string {
	const ownerPrefix = `${owner}/`;
	return name.startsWith(ownerPrefix) ? name.slice(ownerPrefix.length) : name;
}

function collectionChildren(collectionUri: string): HfNavEntry[] {
	return [
		{
			type: 'file',
			name: 'metadata.json',
			path: 'metadata.json',
			uri: `${collectionUri}/metadata.json`,
			content_type: 'application/json',
		},
		{ type: 'dir', name: 'items', path: 'items', uri: `${collectionUri}/items` },
		{
			type: 'file',
			name: 'history.json',
			path: 'history.json',
			uri: `${collectionUri}/history.json`,
			content_type: 'application/json',
		},
	];
}

const COLLECTIONS_README = `# Hugging Face Collections

Collections are curated lists of Hub items, not file storage.

- Search globally: search hf://collections with query
- List an owner's collections: ls hf://collections/OWNER
- Inspect a collection: ls hf://collections/OWNER/SLUG
- Read metadata: cat hf://collections/OWNER/SLUG/metadata.json
- Read history: cat hf://collections/OWNER/SLUG/history.json
- List linked Hub items: ls hf://collections/OWNER/SLUG/items
`;

function collectionReadmeEntry(): HfNavEntry {
	return {
		type: 'file',
		name: 'README.md',
		path: 'README.md',
		uri: 'hf://collections/README.md',
		content_type: 'text/markdown',
	};
}

function collectionItemsToEntries(collection: ApiCollectionDetail, itemsUri: string): HfNavEntry[] {
	if (!Array.isArray(collection.items)) {
		return [];
	}
	const items: unknown[] = collection.items;
	return items
		.slice()
		.sort((a, b) => {
			const left = numberValue(recordValue(a, 'position')) ?? 0;
			const right = numberValue(recordValue(b, 'position')) ?? 0;
			return left - right;
		})
		.flatMap((item, index) => {
			const entry = collectionItemToEntry(item, itemsUri, index);
			return entry ? [entry] : [];
		});
}

function collectionItemToEntry(item: unknown, itemsUri: string, index: number): HfNavEntry | undefined {
	const record = isRecord(item) ? (item as ApiCollectionItemBase) : undefined;
	if (!record) {
		return undefined;
	}
	const itemType = stringValue(record.type);
	const target = itemTarget(record, itemType);
	if (!target || !itemType) {
		return undefined;
	}
	const targetId = target.id;
	const name = `${index.toString().padStart(3, '0')}-${itemType}-${safeName(targetId)}`;
	return compactEntry({
		type: 'link',
		name,
		path: name,
		uri: `${itemsUri}/${encodeHfPathSegment(name)}`,
		target_uri: target.uri,
		title: stringValue(record.title) ?? targetId,
		private: booleanValue(record.private),
		upvotes: numberValue(record.upvotes),
		updated_at:
			stringValue(record.lastModified) ??
			stringValue(record.lastUpdated) ??
			stringValue(record.updatedAt) ??
			stringValue(record.publishedAt),
		created_at: stringValue(record.createdAt),
	});
}

function itemTarget(
	item: ApiCollectionItemBase,
	itemType: string | undefined
): { id: string; uri: string; targetType: HfNavTargetType; repoType?: HfNavRepoType } | undefined {
	const id = stringValue(item.id);
	switch (itemType) {
		case 'model':
			return id ? { id, uri: `hf://models/${id}`, targetType: 'repo', repoType: 'model' } : undefined;
		case 'dataset':
			return id ? { id, uri: `hf://datasets/${id}`, targetType: 'repo', repoType: 'dataset' } : undefined;
		case 'space':
			return id ? { id, uri: `hf://spaces/${id}`, targetType: 'repo', repoType: 'space' } : undefined;
		case 'paper':
			return id ? { id, uri: `hf://papers/${id}`, targetType: 'paper' } : undefined;
		case 'bucket':
			return id ? { id, uri: `hf://buckets/${id}`, targetType: 'bucket' } : undefined;
		case 'collection': {
			const rawSlug = stringValue(item.slug);
			const owner = stringValue(item.owner?.name);
			if (!rawSlug || !owner) {
				return undefined;
			}
			const slug = collectionSlugName(rawSlug, owner);
			return {
				id: `${owner}/${slug}`,
				uri: `hf://collections/${encodeHfPathSegment(owner)}/${encodeHfPathSegment(slug)}`,
				targetType: 'collection',
			};
		}
		default:
			return undefined;
	}
}

function compactEntry(entry: HfNavEntry): HfNavEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HfNavEntry;
}

function createLsMatcher(glob: string | undefined): ((entry: HfNavEntry) => boolean) | undefined {
	if (!glob) {
		return undefined;
	}
	const matcher = picomatch(glob, { dot: true, nocase: true });
	return (entry) => matcher(entry.name) || matcher(entry.path);
}

interface FindFilters {
	name?: (value: string) => boolean;
	path?: (value: string) => boolean;
	types?: Set<HfNavEntryType>;
	targetTypes?: Set<HfNavTargetType>;
	repoTypes?: Set<HfNavRepoType>;
}

function createFindFilters(params: HfNavParams): FindFilters {
	return {
		...(params.name ? { name: picomatch(params.name, { dot: true, nocase: true }) } : {}),
		...(params.path ? { path: picomatch(params.path, { dot: true, nocase: true }) } : {}),
		...(params.type ? { types: new Set(asArray(params.type)) } : {}),
		...(params.target_type ? { targetTypes: new Set(asArray(params.target_type)) } : {}),
		...(params.repo_type ? { repoTypes: new Set(asArray(params.repo_type)) } : {}),
	};
}

function matchesFindFilters(entry: HfNavEntry, filters: FindFilters): boolean {
	if (filters.name && !filters.name(entry.name)) {
		return false;
	}
	if (filters.path && !filters.path(entry.path)) {
		return false;
	}
	if (filters.types && !filters.types.has(entry.type)) {
		return false;
	}
	const targetType = entry.target_type ?? targetTypeFromUri(entry.target_uri);
	const repoType = entry.repo_type ?? repoTypeFromUri(entry.target_uri);
	if (filters.targetTypes && (!targetType || !filters.targetTypes.has(targetType))) {
		return false;
	}
	if (filters.repoTypes && (!repoType || !filters.repoTypes.has(repoType))) {
		return false;
	}
	return true;
}

function targetTypeFromUri(uri: string | undefined): HfNavTargetType | undefined {
	if (!uri) {
		return undefined;
	}
	if (/^hf:\/\/(?:models|datasets|spaces)\//.test(uri)) {
		return 'repo';
	}
	if (uri.startsWith('hf://collections/')) {
		return 'collection';
	}
	if (uri.startsWith('hf://papers/')) {
		return 'paper';
	}
	if (uri.startsWith('hf://buckets/')) {
		return 'bucket';
	}
	return undefined;
}

function repoTypeFromUri(uri: string | undefined): HfNavRepoType | undefined {
	if (uri?.startsWith('hf://models/')) {
		return 'model';
	}
	if (uri?.startsWith('hf://datasets/')) {
		return 'dataset';
	}
	if (uri?.startsWith('hf://spaces/')) {
		return 'space';
	}
	return undefined;
}

function asArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value];
}

function prefixEntry(entry: HfNavEntry, prefix: string): HfNavEntry {
	if (!prefix) {
		return entry;
	}
	return { ...entry, path: joinRelativePath(prefix, entry.path) };
}

function joinRelativePath(prefix: string, path: string): string {
	return prefix ? `${prefix}/${path}` : path;
}

function safeName(value: string): string {
	return value.replace(/\//g, '-');
}

function encodeHfPathSegment(value: string): string {
	return encodeURIComponent(value).replace(/%2F/gi, '%2F');
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

async function assertOk(response: Response, label: string): Promise<void> {
	if (response.ok) {
		return;
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error('EACCES: collection is private or inaccessible; authenticate with a token that can access it');
	}
	if (response.status === 404) {
		throw new Error('ENOENT: no such file or directory');
	}
	throw new Error(`Hub ${label} failed with status ${response.status.toString()}: ${await response.text()}`);
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('ENOENT:');
}

function renderHfNavMarkdown(result: HfNavResult): string {
	switch (result.op) {
		case 'ls':
		case 'find':
		case 'search':
			return renderEntriesMarkdown(result);
		case 'stat':
			return renderStatMarkdown(result);
		case 'cat':
			return renderCatMarkdown(result);
	}
}

function renderEntriesMarkdown(result: HfNavEntriesResult): string {
	const lines = [`# hf_nav ${result.op}`, '', `URI: \`${escapeMarkdown(result.uri)}\``];
	if (result.op === 'search') {
		lines.push('');
	}
	lines.push('', '| Type | Path | Target | Details |', '|---|---|---|---|');
	for (const entry of result.entries) {
		lines.push(
			`| ${entryTypeAbbrev(entry.type)} | ${escapeMarkdown(entry.path)} | ${escapeMarkdown(entry.target_uri ?? entry.uri)} | ${escapeMarkdown(entryDetails(entry))} |`
		);
	}
	if (result.truncated) {
		lines.push('', result.truncation_message ?? 'Truncated: limit');
	}
	return lines.join('\n');
}

function renderStatMarkdown(result: HfNavStatResult): string {
	const lines = [
		'# hf_nav stat',
		'',
		`URI: \`${escapeMarkdown(result.uri)}\``,
		`Exists: \`${String(result.exists)}\``,
		`Type: \`${result.type}\``,
		`Path: \`${escapeMarkdown(result.path)}\``,
	];
	if (result.content_type) {
		lines.push(`Content-Type: \`${result.content_type}\``);
	}
	if (result.target_uri) {
		lines.push(`Target: \`${escapeMarkdown(result.target_uri)}\``);
	}
	return lines.join('\n');
}

function renderCatMarkdown(result: HfNavCatResult): string {
	if (result.content_type === 'text/markdown') {
		return [
			'# hf_nav cat',
			'',
			`URI: \`${escapeMarkdown(result.uri)}\``,
			`Content-Type: \`${result.content_type}\``,
			'',
			result.content,
		].join('\n');
	}
	return [
		'# hf_nav cat',
		'',
		`URI: \`${escapeMarkdown(result.uri)}\``,
		`Content-Type: \`${result.content_type}\``,
		'',
		'```json',
		result.content,
		'```',
	].join('\n');
}

function entryTypeAbbrev(type: HfNavEntryType): string {
	switch (type) {
		case 'dir':
			return 'd';
		case 'file':
			return 'f';
		case 'collection':
			return 'c';
		case 'link':
			return 'l';
	}
}

function entryDetails(entry: HfNavEntry): string {
	const details: string[] = [];
	if (entry.title) {
		details.push(`title=${entry.title}`);
	}
	if (entry.description) {
		details.push(`description=${boundedInlineText(entry.description)}`);
	}
	if (entry.upvotes !== undefined) {
		details.push(`upvotes=${entry.upvotes.toString()}`);
	}
	if (entry.private !== undefined) {
		details.push(entry.private ? 'private' : 'public');
	}
	if (entry.target_type === 'repo' && entry.repo_type && !targetUriImpliesRepoType(entry.target_uri, entry.repo_type)) {
		details.push(`repo=${entry.repo_type}`);
	} else if (entry.target_type && entry.target_type !== 'repo') {
		details.push(entry.target_type);
	}
	if (entry.content_type) {
		details.push(entry.content_type);
	}
	if (entry.updated_at) {
		details.push(`updated=${entry.updated_at}`);
	}
	if (entry.created_at) {
		details.push(`created=${entry.created_at}`);
	}
	return details.join(', ');
}

function boundedInlineText(value: string, maxLength = 240): string {
	const compact = value.replace(/\s+/g, ' ').trim();
	return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function targetUriImpliesRepoType(targetUri: string | undefined, repoType: HfNavRepoType): boolean {
	if (!targetUri) {
		return false;
	}
	switch (repoType) {
		case 'model':
			return targetUri.startsWith('hf://models/');
		case 'dataset':
			return targetUri.startsWith('hf://datasets/');
		case 'space':
			return targetUri.startsWith('hf://spaces/');
	}
}

function trimMarkdownToBudget(markdown: string, maxChars: number): string {
	if (fitsWithinCharBudget(markdown, maxChars)) {
		return markdown;
	}
	const suffix = '\n\n... Markdown view truncated. Structured content contains the full result.';
	return `${markdown.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
