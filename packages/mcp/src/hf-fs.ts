import { z } from 'zod';
import {
	HUB_URL,
	downloadFile,
	datasetInfo,
	HubApiError,
	listDatasets,
	listFiles,
	listModels,
	listSpaces,
	modelInfo,
	pathsInfo,
	spaceInfo,
} from '@huggingface/hub';
import type {
	DatasetEntry,
	ListFileEntry,
	ModelEntry,
	PathInfo,
	RepoType as HubRepoType,
	SpaceEntry,
} from '@huggingface/hub';
import picomatch from 'picomatch';

type RepoType = Exclude<HubRepoType, 'kernel'>;
interface RepoDesignation {
	name: string;
	type: RepoType;
}

import { safeFetch } from './network/safe-fetch.js';
import { createHuggingFaceHubPolicy } from './network/url-policy.js';
import { assertTextFilePath, decodeTextFileContent } from './text-file-policy.js';
import { escapeMarkdown, fitsWithinCharBudget, formatBytes, maxCharsForTokenBudget } from './utilities.js';
import { HF_NAV_MAX_LIMIT, HfNavTool, type HfNavEntry, type HfNavParams, type HfNavResult } from './hf-nav.js';
import { catGuidance, isRootGuidanceUri, statGuidance } from './hf-fs-guidance.js';
import { HfFsPaperProvider, isPaperUri, paperListingOrder } from './hf-fs-papers.js';
import { HfFsDocsProvider, isDocsUri } from './hf-fs-docs.js';
import {
	HF_FS_DESCRIPTION,
	HF_FS_ENTRY_TYPES,
	HF_FS_OPERATIONS,
	HF_FS_SCHEMA,
	isRepoTrendingUri,
	parseHfFsRequest,
	type HfFsEntryType,
	type HfFsParams,
	type HfFsRequest,
	type HfFsSort,
} from './hf-fs-contract.js';

const HF_FS_STAT_TYPES = ['namespace', 'repo', 'dir', 'file', 'collection', 'paper', 'link', 'missing'] as const;
const HF_URI_TYPES = ['models', 'datasets', 'spaces', 'buckets', 'collections', 'papers'] as const;
const HF_REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const;
const SPECIAL_REFS_REVISION_RE = /^refs\/(?:convert\/[\w.-]+|pr\/\d+)/;
const UNSUPPORTED_RAW_SLASH_REVISION_RE = /^refs\/(?:heads|tags)\//;
const DEFAULT_LS_LIMIT = 1000;
const MAX_LS_LIMIT = 10_000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_TRENDING_LIMIT = 20;
const DEFAULT_CAT_MAX_BYTES = 20_000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_UTF8_SEQUENCE_BYTES = 4;
export const HF_FS_MAX_OUTPUT_TOKENS = 20_000;
export const HF_FS_MAX_OUTPUT_CHARS = maxCharsForTokenBudget(HF_FS_MAX_OUTPUT_TOKENS, APPROX_CHARS_PER_TOKEN);
const MAX_CAT_BYTES = HF_FS_MAX_OUTPUT_CHARS;

export const HF_FILES_FLAG = 'hf_files' as const;

export const HF_FS_TOOL_CONFIG = {
	name: 'hf_fs',
	// human discovery
	title:
		'Hugging Face Hub: Find, use and view models, datasets, spaces, buckets, papers, documentation and collections. ' +
		'Get daily papers reports, and browse trending content. ',
	// model discovery
	description: HF_FS_DESCRIPTION,
	schema: HF_FS_SCHEMA,
	outputSchema: createHfFsOutputSchema(),
	annotations: {
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

export type { HfFsEntryType, HfFsOperation, HfFsParams, HfFsRequest } from './hf-fs-contract.js';

function createHfFsOutputSchema() {
	const entrySchema = z.object({
		type: z.enum(HF_FS_ENTRY_TYPES),
		path: z.string(),
		uri: z.string().optional(),
		name: z.string().optional(),
		target_uri: z.string().optional(),
		repo_type: z.enum(HF_REPO_TYPES).optional(),
		size: z.number().optional(),
		total_files: z.number().optional(),
		lfs: z.boolean().optional(),
		private: z.boolean().optional(),
		gated: z.union([z.literal(false), z.enum(['auto', 'manual'])]).optional(),
		likes: z.number().optional(),
		downloads: z.number().optional(),
		task: z.string().optional(),
		library: z.string().optional(),
		tags: z.array(z.string()).optional(),
		trending_score: z.number().optional(),
		sdk: z.string().optional(),
		title: z.string().optional(),
		category: z.string().optional(),
		semantic_relevance: z.number().optional(),
		anchor: z.string().optional(),
		description: z.string().optional(),
		upvotes: z.number().optional(),
		created_at: z.string().optional(),
		published_at: z.string().optional(),
		daily_papers_date: z.string().optional(),
		daily_papers_uri: z.string().optional(),
		url: z.string().optional(),
		arxiv_url: z.string().optional(),
		observed_at: z.string().optional(),
		updated_at: z.string().optional(),
		content_type: z.enum(['application/json', 'text/markdown']).optional(),
	});

	return z.object({
		uri: z.string(),
		op: z.enum(HF_FS_OPERATIONS),
		entries: z.array(entrySchema).optional(),
		path: z.string().optional(),
		content: z.string().optional(),
		content_type: z.enum(['application/json', 'text/markdown']).optional(),
		section: z.string().optional(),
		bytes: z.number().optional(),
		exists: z.boolean().optional(),
		type: z.enum(HF_FS_STAT_TYPES).optional(),
		namespace: z.string().optional(),
		size: z.number().optional(),
		lfs: z.boolean().optional(),
		target_uri: z.string().optional(),
		published_at: z.string().optional(),
		daily_papers_date: z.string().optional(),
		daily_papers_uri: z.string().optional(),
		url: z.string().optional(),
		arxiv_url: z.string().optional(),
		truncated: z.boolean().optional(),
		truncation_reason: z.enum(['entry_limit', 'max_bytes', 'limit', 'provider_limit']).optional(),
		truncation_message: z.string().optional(),
		next_offset: z.number().optional(),
		warnings: z.array(z.string()).optional(),
	});
}

function normalizedLsLimit(limit: number | undefined): number {
	return limit === undefined ? DEFAULT_LS_LIMIT : limit;
}

function normalizedSearchLimit(limit: number | undefined): number {
	return limit === undefined ? DEFAULT_SEARCH_LIMIT : Math.min(limit, MAX_SEARCH_LIMIT);
}

function normalizedCatMaxBytes(maxBytes: number | undefined): number {
	return maxBytes === undefined ? DEFAULT_CAT_MAX_BYTES : maxBytes === 0 ? MAX_CAT_BYTES : maxBytes;
}

function validateHfFsParams(params: HfFsParams): void {
	if (
		params.limit !== undefined &&
		(!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_LS_LIMIT)
	) {
		throw new Error(`EINVAL: limit must be an integer between 1 and ${MAX_LS_LIMIT.toString()}`);
	}
	if (params.glob !== undefined && params.op !== 'ls') {
		throw new Error(`EINVAL: glob is not valid for ${params.op}; glob applies only to ls`);
	}
	if (params.query !== undefined && params.op !== 'search') {
		throw new Error(`EINVAL: query is not valid for ${params.op}; query applies only to search`);
	}
	if (params.recursive === true && params.op !== 'ls') {
		throw new Error(`EINVAL: recursive is not valid for ${params.op}; recursive applies only to ls`);
	}
	if ((params.name !== undefined || params.path !== undefined) && params.op !== 'find') {
		throw new Error(`EINVAL: name and path are not valid for ${params.op}; they apply only to find`);
	}
	if (params.op === 'search' && !params.query?.trim() && !searchAllowsEmptyQuery(params.uri)) {
		throw new Error('EINVAL: search requires query');
	}
}

function isNavigationUri(uri: string): boolean {
	return uri === 'hf://collections' || uri.startsWith('hf://collections/');
}

function searchAllowsEmptyQuery(uri: string): boolean {
	return /^hf:\/\/(?:models|datasets|spaces|collections)(?:\/[^/]+)?$/.test(uri);
}

function isRootUri(uri: string): boolean {
	return uri === 'hf://' || uri === 'hf:///';
}

function toNavParams(params: HfFsParams): HfNavParams {
	const navEntryType = navCompatibleEntryType(params.entry_type);
	const navLimit = params.limit === undefined ? undefined : Math.min(normalizedLsLimit(params.limit), HF_NAV_MAX_LIMIT);
	const navParams: HfNavParams = {
		op: params.op,
		uri: params.uri,
		...(params.glob !== undefined ? { glob: params.glob } : {}),
		...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
		...(params.name !== undefined ? { name: params.name } : {}),
		...(params.path !== undefined ? { path: params.path } : {}),
		...(params.op === 'find' && navEntryType !== undefined ? { type: navEntryType } : {}),
		...(params.query !== undefined ? { query: params.query } : {}),
		...(navLimit !== undefined ? { limit: navLimit } : {}),
	};
	if (params.sort === 'trending' || params.sort === 'upvotes' || params.sort === 'lastModified') {
		navParams.sort = params.sort;
	}
	return navParams;
}

function navResultToFsResult(result: HfNavResult): HfFsResult {
	switch (result.op) {
		case 'ls':
		case 'find':
		case 'search':
			return {
				uri: result.uri,
				op: result.op,
				entries: result.entries.map(navEntryToFsEntry),
				...(result.truncated ? { truncated: true, truncation_reason: 'limit' as const } : {}),
				...(result.truncation_message ? { truncation_message: result.truncation_message } : {}),
			};
		case 'stat':
			return {
				uri: result.uri,
				op: 'stat',
				exists: result.exists,
				type: result.type,
				path: result.path,
				...(result.content_type ? { content_type: result.content_type } : {}),
				...(result.target_uri ? { target_uri: result.target_uri } : {}),
			};
		case 'cat': {
			const bytes = new TextEncoder().encode(result.content).byteLength;
			return {
				uri: result.uri,
				op: 'cat',
				path: hfUriPath(result.uri),
				content: result.content,
				content_type: result.content_type,
				bytes,
				truncated: false,
			};
		}
	}
}

function navEntryToFsEntry(entry: HfNavEntry): HfFsEntry {
	return compactEntry({
		type: entry.type,
		path: entry.path,
		uri: entry.uri,
		name: entry.name,
		target_uri: entry.target_uri,
		...(entry.type === 'link' ? {} : { repo_type: entry.repo_type }),
		private: entry.private,
		title: entry.title,
		description: entry.description,
		upvotes: entry.upvotes,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		content_type: entry.content_type,
	});
}

function compactEntry(entry: HfFsEntry): HfFsEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HfFsEntry;
}

function hfUriPath(uri: string): string {
	return uri.startsWith('hf://') ? uri.slice('hf://'.length).replace(/^\/+/, '') : uri;
}

function navCompatibleEntryType(entryType: HfFsParams['entry_type']): HfNavParams['type'] | undefined {
	if (entryType === 'file' || entryType === 'dir' || entryType === 'collection' || entryType === 'link') {
		return entryType;
	}
	return undefined;
}

function repoSearchSort(sort: HfFsSort | undefined): RepoSearchSort | undefined {
	if (sort === 'trending' || sort === 'upvotes') {
		return 'trendingScore';
	}
	return sort;
}

export interface HfFsEntry {
	type: HfFsEntryType;
	path: string;
	uri?: string;
	name?: string;
	target_uri?: string;
	repo_type?: RepoType;
	size?: number;
	total_files?: number;
	lfs?: boolean;
	private?: boolean;
	gated?: false | 'auto' | 'manual';
	likes?: number;
	downloads?: number;
	task?: string;
	library?: string;
	tags?: string[];
	trending_score?: number;
	sdk?: string;
	title?: string;
	category?: string;
	semantic_relevance?: number;
	anchor?: string;
	description?: string;
	upvotes?: number;
	created_at?: string;
	published_at?: string;
	daily_papers_date?: string;
	daily_papers_uri?: string;
	url?: string;
	arxiv_url?: string;
	observed_at?: string;
	updated_at?: string;
	content_type?: HfFsContentType;
}

export type HfFsContentType = 'application/json' | 'text/markdown';

export interface HfFsLsResult {
	uri: string;
	op: 'ls' | 'find' | 'search';
	entries: HfFsEntry[];
	truncated?: boolean;
	truncation_reason?: 'entry_limit' | 'limit' | 'provider_limit';
	truncation_message?: string;
	next_offset?: number;
	warnings?: string[];
}

export interface HfFsCatResult {
	uri: string;
	op: 'cat';
	path: string;
	content: string;
	content_type?: HfFsContentType;
	section?: string;
	bytes: number;
	truncated: boolean;
	truncation_reason?: 'max_bytes';
	truncation_message?: string;
	next_offset?: number;
}

export interface HfFsStatResult {
	uri: string;
	op: 'stat';
	exists: boolean;
	type: 'namespace' | 'repo' | 'dir' | 'file' | 'collection' | 'paper' | 'link' | 'missing';
	path: string;
	content_type?: HfFsContentType;
	namespace?: string;
	size?: number;
	lfs?: boolean;
	target_uri?: string;
	published_at?: string;
	daily_papers_date?: string;
	daily_papers_uri?: string;
	url?: string;
	arxiv_url?: string;
}

export type HfFsResult = (HfFsLsResult | HfFsCatResult | HfFsStatResult) & { warnings?: string[] };

export type ParsedHfUri = ParsedNamespaceHfUri | ParsedRepoHfUri;

export interface ParsedNamespaceHfUri {
	kind: 'namespace';
	repoType: RepoType;
	namespace?: string;
	path: '';
}

type RepoSearchSort = Exclude<HfFsSort, 'trending' | 'upvotes'>;

export interface ParsedRepoHfUri {
	kind: 'repo';
	repo: RepoDesignation;
	repoType: RepoType;
	repoId: string;
	namespace: string;
	revision?: string;
	path: string;
}

interface ApiBucketEntry {
	_id: string;
	id: string;
	author: string;
	private: boolean;
	createdAt: string;
	updatedAt: string;
	size: number;
	totalFiles: number;
	repoType: 'bucket';
	cdnRegions?: string[];
	resourceGroup?: { id: string; name: string };
}

interface SemanticSpaceSearchHit {
	id: string;
	private?: boolean;
	likes?: number;
	sdk?: string;
	title?: string;
	shortDescription?: string;
	ai_short_description?: string;
	ai_category?: string;
	trendingScore?: number;
	semanticRelevancyScore?: number;
	tags?: string[];
	createdAt?: string;
	lastModified?: string;
}

export class HfFsTool {
	private readonly accessToken?: string;
	private readonly hubUrl?: string;
	private readonly paperProvider: HfFsPaperProvider;
	private readonly docsProvider: HfFsDocsProvider;

	constructor(hfToken?: string, hubUrl?: string) {
		this.accessToken = hfToken;
		this.hubUrl = hubUrl;
		this.paperProvider = new HfFsPaperProvider(hfToken, hubUrl, async (params) => await this.runCanonical(params));
		this.docsProvider = new HfFsDocsProvider(hubUrl);
	}

	async run(request: HfFsRequest | HfFsParams): Promise<HfFsResult> {
		if ('op' in request) {
			return await this.runCanonical(request);
		}
		const parsed = parseHfFsRequest(request);
		const result = await this.runCanonical(parsed.params);
		return parsed.warnings.length === 0 ? result : { ...result, warnings: parsed.warnings };
	}

	async runCanonical(params: HfFsParams): Promise<HfFsResult> {
		validateHfFsParams(params);
		if (isRootGuidanceUri(params.uri)) {
			return await this.runRootGuidance(params);
		}
		if (isRepoTrendingUri(params.uri)) {
			return await this.runRepoTrending(params);
		}
		if (isPaperUri(params.uri)) {
			return await this.paperProvider.run(params);
		}
		if (isDocsUri(params.uri)) {
			return await this.docsProvider.run(params);
		}
		if (isNavigationUri(params.uri)) {
			return await this.runNavigation(params);
		}
		switch (params.op) {
			case 'ls':
				return await this.ls(params);
			case 'cat':
				return await this.cat(params);
			case 'stat':
				return await this.stat(params);
			case 'find':
				return await this.find(params);
			case 'search':
				return await this.search(params);
		}
		throw new Error('ENOTSUP: unsupported hf_fs operation');
	}

	private async runRootGuidance(params: HfFsParams): Promise<HfFsResult> {
		switch (params.op) {
			case 'cat':
				return await catGuidance(
					'root',
					'hf://README.md',
					'README.md',
					params.offset ?? 0,
					normalizedCatMaxBytes(params.max_bytes)
				);
			case 'stat':
				return await statGuidance('root', 'hf://README.md', 'README.md');
			case 'ls':
			case 'find':
			case 'search':
				throw new Error('ENOTDIR: not a directory');
		}
	}

	private async runRepoTrending(params: HfFsParams): Promise<HfFsResult> {
		switch (params.op) {
			case 'ls':
				return await this.listRepoTrending(params);
			case 'stat':
				return {
					uri: params.uri,
					op: 'stat',
					exists: true,
					type: 'dir',
					path: 'trending',
				};
			case 'cat':
				throw new Error(`EISDIR: ${params.uri} is a directory`);
			case 'find':
				throw new Error(`ENOTSUP: find is not supported on ${params.uri}; use ls`);
			case 'search':
				throw new Error(
					`ENOTSUP: search is not supported on ${params.uri}; search its resource root with --sort trendingScore`
				);
		}
	}

	private async listRepoTrending(params: HfFsParams): Promise<HfFsLsResult> {
		if (params.sort !== undefined && params.sort !== 'trending' && params.sort !== 'trendingScore') {
			throw new Error(`EINVAL: ${params.uri} does not accept another sort`);
		}
		if (params.limit !== undefined && (params.limit < 1 || params.limit > DEFAULT_TRENDING_LIMIT)) {
			throw new Error(`EINVAL: trending limit must be between 1 and ${DEFAULT_TRENDING_LIMIT.toString()}`);
		}

		const repoType = trendingRepoType(params.uri);
		const limit = params.limit ?? DEFAULT_TRENDING_LIMIT;
		const url = new URL('/api/trending', this.hubUrl ?? HUB_URL);
		url.searchParams.set('type', repoType);
		url.searchParams.set('limit', limit.toString());
		const { response } = await safeFetch(url, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: {
				headers: {
					accept: 'application/json',
					...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
				},
			},
		});
		if (!response.ok) {
			throw new Error(`Trending listing failed with status ${response.status.toString()}: ${await response.text()}`);
		}

		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.recentlyTrending)) {
			throw new Error('Trending listing returned an invalid response');
		}
		const entries = body.recentlyTrending.flatMap((item) => trendingItemToEntry(item, repoType));
		return {
			uri: params.uri,
			op: 'ls',
			entries: params.entry_type === undefined || params.entry_type === 'repo' ? entries.slice(0, limit) : [],
		};
	}

	private async runNavigation(params: HfFsParams): Promise<HfFsResult> {
		const tool = new HfNavTool(this.accessToken, this.hubUrl);
		const result = navResultToFsResult(await tool.run(toNavParams(params)));
		if (!params.entry_type || !('entries' in result)) {
			return result;
		}
		return {
			...result,
			entries: result.entries.filter((entry) => entry.type === params.entry_type),
		};
	}

	private async ls(params: HfFsParams): Promise<HfFsLsResult> {
		if (isRootUri(params.uri)) {
			return {
				uri: 'hf://',
				op: 'ls',
				entries: [
					{
						type: 'file',
						path: 'README.md',
						name: 'README.md',
						uri: 'hf://README.md',
						content_type: 'text/markdown',
					},
					...['models', 'datasets', 'spaces', 'buckets', 'collections', 'papers', 'docs'].map((name) => ({
						type: 'dir' as const,
						path: name,
						name,
						uri: `hf://${name}`,
					})),
				],
			};
		}
		if (isRepoDiscoveryRoot(params.uri)) {
			if (params.sort !== undefined) {
				throw new Error(`EINVAL: sort is not supported on ${params.uri}; list ${params.uri}/trending instead`);
			}
			if (params.recursive) {
				throw new Error(`ENOTSUP: recursive ls is not supported on ${params.uri}`);
			}
			const entry: HfFsEntry = {
				type: 'dir',
				path: 'trending',
				name: 'trending',
				uri: `${params.uri}/trending`,
				description: `Browse the 20 currently trending ${params.uri.slice('hf://'.length)}.`,
			};
			return {
				uri: params.uri,
				op: 'ls',
				entries:
					(params.entry_type === undefined || params.entry_type === 'dir') &&
					(params.glob === undefined || picomatch(params.glob, { dot: true })('trending'))
						? [entry]
						: [],
			};
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			return await this.lsNamespace(params, parsed);
		}
		if (params.sort !== undefined) {
			throw new Error(`EINVAL: sort is not supported for repository file listings: ${params.uri}`);
		}

		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		for await (const file of listFiles({
			repo: parsed.repo,
			path: parsed.path || undefined,
			recursive: params.recursive ?? false,
			expand: false,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		})) {
			const entry = toHfFsEntry(file);
			if (!entry) {
				continue;
			}
			if (params.entry_type && entry.type !== params.entry_type) {
				continue;
			}
			if (matcher && !matcher(relativeEntryPath(parsed.path, entry.path))) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(params.uri, entries, truncated, truncated ? 'entry_limit' : undefined);
	}

	private async find(params: HfFsParams): Promise<HfFsLsResult> {
		if (isRootUri(params.uri)) {
			throw new Error('ENOTSUP: find is not supported for the global hf:// root.');
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			return await this.findNamespace(params, parsed);
		}

		if (parsed.path) {
			const stat = await this.stat(params);
			if (stat.exists && stat.type === 'file') {
				const filters = createFindFilters(params);
				const entry = statResultToFindEntry(stat);
				const matchedEntries =
					(params.offset ?? 0) === 0 && matchesFindFilters(entry, parentPath(parsed.path), filters) ? [entry] : [];
				return buildEntriesResult(params.uri, 'find', matchedEntries, false);
			}
		}

		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const filters = createFindFilters(params);
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		for await (const file of listFiles({
			repo: parsed.repo,
			path: parsed.path || undefined,
			recursive: true,
			expand: false,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		})) {
			const entry = toHfFsEntry(file);
			if (!entry || !matchesFindFilters(entry, parsed.path, filters)) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildEntriesResult(params.uri, 'find', entries, truncated, truncated ? 'entry_limit' : undefined);
	}

	private async search(params: HfFsParams): Promise<HfFsLsResult> {
		if (isRootUri(params.uri)) {
			throw new Error(
				'ENOTSUP: search requires a scoped discovery root such as hf://models, hf://datasets, or hf://collections.'
			);
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'repo') {
			throw new Error(
				'ENOTSUP: search is supported on discovery roots or owner namespaces, not repository file paths.'
			);
		}
		if (parsed.repoType === 'bucket') {
			throw new Error('ENOTSUP: bucket search is not supported.');
		}
		if (params.entry_type !== undefined && params.entry_type !== 'repo') {
			return {
				uri: params.uri,
				op: 'search',
				entries: [],
			};
		}

		const query = params.query?.trim();

		const limit = normalizedSearchLimit(params.limit);
		if (
			parsed.repoType === 'space' &&
			!parsed.namespace &&
			(Boolean(query) || params.tags !== undefined || params.space_kind !== undefined)
		) {
			return await this.searchSemanticSpaces(params, limit);
		}
		const fetchLimit = limit + 1;
		const entries: HfFsEntry[] = [];
		for await (const entry of this.searchRepoEntries(parsed.repoType, {
			query,
			owner: parsed.namespace,
			sort: repoSearchSort(params.sort),
			limit: fetchLimit,
		})) {
			if (entries.length >= limit) {
				return {
					uri: params.uri,
					op: 'search',
					entries,
					truncated: true,
					truncation_reason: 'limit',
				};
			}
			entries.push(entry);
		}

		return {
			uri: params.uri,
			op: 'search',
			entries,
		};
	}

	private async searchSemanticSpaces(params: HfFsParams, limit: number): Promise<HfFsLsResult> {
		if ((params.query?.length ?? 0) > 250) {
			throw new Error('EINVAL: Space semantic search query must not exceed 250 characters');
		}
		const url = new URL('/api/spaces/semantic-search', this.hubUrl ?? HUB_URL);
		url.searchParams.set('q', params.query ?? '');
		const tags = new Set(params.tags ?? []);
		if (params.space_kind === 'mcp') tags.add('mcp-server');
		for (const tag of tags) url.searchParams.append('filter', tag);

		const { response } = await safeFetch(url.toString(), {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: {
				headers: {
					accept: 'application/json',
					...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
				},
			},
		});
		if (!response.ok) {
			throw new Error(
				`Space semantic search failed with status ${response.status.toString()}: ${await response.text()}`
			);
		}

		const hits = sortSemanticSpaceHits(
			((await response.json()) as SemanticSpaceSearchHit[]).filter((hit) =>
				[...tags].every((tag) => hit.tags?.includes(tag))
			),
			params.sort
		);
		return {
			uri: params.uri,
			op: 'search',
			entries: hits.slice(0, limit).map(semanticSpaceToEntry),
			...(hits.length > limit ? { truncated: true, truncation_reason: 'limit' as const } : {}),
		};
	}

	private async cat(params: HfFsParams): Promise<HfFsCatResult> {
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			throw new Error('cat requires a URI that points to a file path, not a namespace.');
		}
		if (!parsed.path) {
			throw new Error('cat requires a URI that points to a file path.');
		}

		const stat = await this.stat(params);
		if (!stat.exists) {
			throw new Error(`File does not exist: ${parsed.path}`);
		}
		if (stat.type !== 'file') {
			throw new Error(`cat requires a file path, got ${stat.type}: ${parsed.path}`);
		}
		assertTextFilePath(parsed.path);

		const blob = await downloadFile({
			repo: parsed.repo,
			path: parsed.path,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		});
		if (!blob) {
			throw new Error(`File does not exist: ${parsed.path}`);
		}

		const offset = params.offset ?? 0;
		const maxBytes = normalizedCatMaxBytes(params.max_bytes);
		const end = Math.min(offset + maxBytes, blob.size);
		const range = await decodeTextFileByteRange(parsed.path, blob, offset, end);
		const truncated = range.end < blob.size;

		return {
			uri: params.uri,
			op: 'cat',
			path: parsed.path,
			content: range.content,
			bytes: range.bytes,
			truncated,
			...(truncated ? { truncation_reason: 'max_bytes', next_offset: range.end } : {}),
		};
	}

	private async stat(params: HfFsParams): Promise<HfFsStatResult> {
		if (isRootUri(params.uri)) {
			return {
				uri: params.uri,
				op: 'stat',
				exists: true,
				type: 'dir',
				path: '',
			};
		}
		const parsed = parseHfFsUri(params.uri);
		if (parsed.kind === 'namespace') {
			const namespace = this.resolveNamespace(parsed);
			return {
				uri: params.uri,
				op: 'stat',
				exists: true,
				type: 'namespace',
				path: '',
				namespace,
			};
		}

		if (!parsed.path) {
			return await this.statRepoRoot(params.uri, parsed);
		}

		const [path] = await pathsInfo({
			repo: parsed.repo,
			paths: [parsed.path],
			expand: true,
			...(parsed.revision ? { revision: parsed.revision } : {}),
			...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
			...(this.accessToken ? { accessToken: this.accessToken } : {}),
		});
		if (!path) {
			return {
				uri: params.uri,
				op: 'stat',
				exists: false,
				type: 'missing',
				path: parsed.path,
			};
		}

		const type = toStatType(path);
		return {
			uri: params.uri,
			op: 'stat',
			exists: true,
			type,
			path: path.path,
			...(type === 'file' ? optionalSize(path.size) : {}),
			...(type === 'file' ? optionalLfs(path) : {}),
		};
	}

	private async statRepoRoot(uri: string, parsed: ParsedRepoHfUri): Promise<HfFsStatResult> {
		const exists = await this.repoRootExists(parsed);
		return {
			uri,
			op: 'stat',
			exists,
			type: exists ? 'repo' : 'missing',
			path: '',
		};
	}

	private async repoRootExists(parsed: ParsedRepoHfUri): Promise<boolean> {
		try {
			switch (parsed.repoType) {
				case 'model':
					await modelInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'dataset':
					await datasetInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'space':
					await spaceInfo({
						name: parsed.repoId,
						...(parsed.revision ? { revision: parsed.revision } : {}),
						...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
						...(this.accessToken ? { accessToken: this.accessToken } : {}),
						fetch: this.safeHubFetch,
					});
					return true;
				case 'bucket':
					return await this.bucketExists(parsed.repoId);
			}
		} catch (error) {
			if (isNotFoundError(error)) {
				return false;
			}
			throw error;
		}
	}

	private readonly safeHubFetch: typeof fetch = async (url, requestInit) => {
		const safeUrl = typeof url === 'string' || url instanceof URL ? url : url.url;
		const { response } = await safeFetch(safeUrl, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit,
		});
		return response;
	};

	private async bucketExists(repoId: string): Promise<boolean> {
		const [namespace] = repoId.split('/');
		if (!namespace) {
			return false;
		}

		for await (const bucket of this.listBuckets(namespace)) {
			if (bucket.id === repoId) {
				return true;
			}
		}
		return false;
	}

	private async lsNamespace(params: HfFsParams, parsed: ParsedNamespaceHfUri): Promise<HfFsLsResult> {
		const namespace = this.resolveNamespace(parsed);
		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		const namespaceFetchLimit = matcher ? undefined : limit + offset + 1;
		for await (const entry of this.listNamespaceEntries(
			parsed.repoType,
			namespace,
			namespaceFetchLimit,
			repoSearchSort(params.sort)
		)) {
			if (params.entry_type && entry.type !== params.entry_type) {
				continue;
			}
			if (matcher && !matcher(relativeNamespaceEntryPath(namespace, entry.path))) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildLsResult(params.uri, entries, truncated, truncated ? 'entry_limit' : undefined);
	}

	private async findNamespace(params: HfFsParams, parsed: ParsedNamespaceHfUri): Promise<HfFsLsResult> {
		const namespace = this.resolveNamespace(parsed);
		const offset = params.offset ?? 0;
		const limit = normalizedLsLimit(params.limit);
		const filters = createFindFilters(params);
		const entries: HfFsEntry[] = [];
		let matchedCount = 0;
		let truncated = false;

		for await (const entry of this.listNamespaceEntries(parsed.repoType, namespace)) {
			if (!matchesFindFilters(entry, namespace, filters)) {
				continue;
			}

			if (matchedCount < offset) {
				matchedCount += 1;
				continue;
			}

			if (entries.length >= limit) {
				truncated = true;
				break;
			}

			entries.push(entry);
			matchedCount += 1;
		}

		return buildEntriesResult(params.uri, 'find', entries, truncated, truncated ? 'entry_limit' : undefined);
	}

	private resolveNamespace(parsed: ParsedNamespaceHfUri): string {
		if (parsed.namespace) {
			return parsed.namespace;
		}
		throw new Error(
			`Listing ${uriTypeForRepoType(parsed.repoType)} requires an explicit owner. Use hf://${uriTypeForRepoType(
				parsed.repoType
			)}/<owner>.`
		);
	}

	private async *listNamespaceEntries(
		repoType: RepoType,
		namespace: string,
		limit?: number,
		sort: RepoSearchSort = 'lastModified'
	): AsyncGenerator<HfFsEntry> {
		switch (repoType) {
			case 'model':
				for await (const model of listModels({
					search: { owner: namespace },
					sort,
					...(limit === undefined ? {} : { limit }),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield modelToEntry(model);
				}
				return;
			case 'dataset':
				for await (const dataset of listDatasets({
					search: { owner: namespace },
					sort,
					...(limit === undefined ? {} : { limit }),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield datasetToEntry(dataset);
				}
				return;
			case 'space':
				for await (const space of listSpaces({
					search: { owner: namespace },
					sort,
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield spaceToEntry(space);
				}
				return;
			case 'bucket':
				for await (const bucket of this.listBuckets(namespace)) {
					yield bucketToEntry(bucket);
				}
				return;
		}
	}

	private async *searchRepoEntries(
		repoType: Exclude<RepoType, 'bucket'>,
		options: { query?: string; owner?: string; sort?: RepoSearchSort; limit: number }
	): AsyncGenerator<HfFsEntry> {
		switch (repoType) {
			case 'model':
				for await (const model of listModels({
					search: {
						...(options.query ? { query: options.query } : {}),
						...(options.owner ? { owner: options.owner } : {}),
					},
					...(options.sort ? { sort: options.sort } : {}),
					limit: options.limit,
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield modelToEntry(model);
				}
				return;
			case 'dataset':
				for await (const dataset of listDatasets({
					search: {
						...(options.query ? { query: options.query } : {}),
						...(options.owner ? { owner: options.owner } : {}),
					},
					...(options.sort ? { sort: options.sort } : {}),
					limit: options.limit,
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield datasetToEntry(dataset);
				}
				return;
			case 'space':
				for await (const space of listSpaces({
					search: {
						...(options.query ? { query: options.query } : {}),
						...(options.owner ? { owner: options.owner } : {}),
					},
					...(options.sort ? { sort: options.sort } : {}),
					...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
					...(this.accessToken ? { accessToken: this.accessToken } : {}),
				})) {
					yield spaceToEntry(space);
				}
				return;
		}
	}

	private async *listBuckets(namespace: string): AsyncGenerator<ApiBucketEntry> {
		const url = `${this.hubUrl ?? HUB_URL}/api/buckets/${encodeURIComponent(namespace)}`;
		const { response } = await safeFetch(url, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: {
				headers: {
					accept: 'application/json',
					...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
				},
			},
		});
		if (!response.ok) {
			throw new Error(`Bucket listing failed with status ${response.status.toString()}: ${await response.text()}`);
		}

		const buckets = (await response.json()) as ApiBucketEntry[];
		for (const bucket of buckets) {
			yield bucket;
		}
	}
}

export function formatHfFsResult(result: HfFsResult): string {
	return JSON.stringify(result, null, 2);
}

export function formatHfFsMarkdown(result: HfFsResult, maxChars = HF_FS_MAX_OUTPUT_CHARS): string {
	const markdown = renderHfFsMarkdown(result);
	const withWarnings = result.warnings?.length
		? `${markdown}\n\n## Warnings\n\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}`
		: markdown;
	return trimMarkdownToBudget(withWarnings, maxChars);
}

function renderHfFsMarkdown(result: HfFsResult): string {
	switch (result.op) {
		case 'ls':
		case 'find':
		case 'search':
			return renderLsMarkdown(result);
		case 'cat':
			return renderCatMarkdown(result);
		case 'stat':
			return renderStatMarkdown(result);
	}
}

function renderLsMarkdown(result: HfFsLsResult): string {
	const lines = [`# hf_fs ${result.op}`, ``, `URI: ${inlineCode(result.uri)}`];
	const order = paperListingOrder(result);
	if (order === 'trending') {
		lines.push('', 'Order: Hugging Face global trending rank (not total upvotes)');
	} else if (order === 'daily-batch') {
		lines.push('', 'Order: Daily Papers batch upvotes, then feed placement');
	}
	lines.push('', `| Type | Path | URI | Target | Details |`, `|---|---|---|---|---|`);
	for (const entry of result.entries) {
		lines.push(
			`| ${escapeMarkdown(entry.type)} | ${escapeMarkdown(entry.path)} | ${escapeMarkdown(entry.uri ?? '')} | ${escapeMarkdown(entry.target_uri ?? '')} | ${escapeMarkdown(entryDetails(entry))} |`
		);
	}
	if (result.entries.some((entry) => entry.type === 'link')) {
		lines.push(
			'',
			'Links resolve during direct operations but are not followed by recursive ls or find. Results use the canonical Target URI.'
		);
	}
	if (result.truncated) {
		lines.push('', result.truncation_message ?? `Result truncated: ${result.truncation_reason ?? 'limit'}.`);
	}
	return lines.join('\n');
}

function renderCatMarkdown(result: HfFsCatResult): string {
	const lines = [
		`# hf_fs cat`,
		``,
		`URI: ${inlineCode(result.uri)}`,
		`Path: ${inlineCode(result.path)}`,
		...(result.section ? [`Section: ${inlineCode(result.section)}`] : []),
		...(result.content_type ? [`Content-Type: ${inlineCode(result.content_type)}`] : []),
		`Bytes: ${result.bytes.toString()}`,
		``,
	];
	lines.push(result.content);
	if (result.truncated) {
		lines.push(
			'',
			result.truncation_message ?? `Content truncated. Resume with offset ${String(result.next_offset ?? 0)}.`
		);
	}
	return lines.join('\n');
}

function renderStatMarkdown(result: HfFsStatResult): string {
	const lines = [
		`# hf_fs stat`,
		``,
		`- URI: ${inlineCode(result.uri)}`,
		`- Exists: ${result.exists ? 'yes' : 'no'}`,
		`- Type: ${inlineCode(result.type)}`,
		`- Path: ${inlineCode(result.path)}`,
	];
	if (result.namespace) {
		lines.push(`- Namespace: ${inlineCode(result.namespace)}`);
	}
	if (result.size !== undefined) {
		lines.push(`- Size: ${formatBytes(result.size)}`);
	}
	if (result.lfs !== undefined) {
		lines.push(`- LFS: ${result.lfs ? 'yes' : 'no'}`);
	}
	if (result.target_uri) {
		lines.push(`- Target: ${inlineCode(result.target_uri)}`);
	}
	if (result.content_type) {
		lines.push(`- Content-Type: ${inlineCode(result.content_type)}`);
	}
	if (result.published_at) {
		lines.push(`- Published: ${result.published_at}`);
	}
	if (result.daily_papers_date) {
		lines.push(`- Daily Papers date: ${result.daily_papers_date}`);
	}
	if (result.daily_papers_uri) {
		lines.push(`- Daily Papers cohort: ${inlineCode(result.daily_papers_uri)}`);
	}
	if (result.url) {
		lines.push(`- Web: ${result.url}`);
	}
	if (result.arxiv_url) {
		lines.push(`- arXiv: ${result.arxiv_url}`);
	}
	return lines.join('\n');
}

function entryDetails(entry: HfFsEntry): string {
	const details = [
		entry.repo_type ? `repo=${entry.repo_type}` : undefined,
		entry.private === undefined ? undefined : entry.private ? 'private' : 'public',
		entry.gated ? `gated=${entry.gated}` : undefined,
		entry.lfs === undefined ? undefined : entry.lfs ? 'lfs' : 'non-lfs',
		entry.total_files === undefined ? undefined : `files=${entry.total_files.toString()}`,
		entry.likes === undefined ? undefined : `likes=${entry.likes.toString()}`,
		entry.downloads === undefined ? undefined : `downloads=${entry.downloads.toString()}`,
		entry.size === undefined ? undefined : `size=${formatBytes(entry.size)}`,
		entry.task ? `task=${entry.task}` : undefined,
		entry.library ? `library=${entry.library}` : undefined,
		entry.tags?.length ? `tags=${entry.tags.join(',')}` : undefined,
		entry.trending_score === undefined ? undefined : `trending score=${entry.trending_score.toString()}`,
		entry.sdk ? `sdk=${entry.sdk}` : undefined,
		entry.title ? `title=${entry.title}` : undefined,
		entry.category ? `category=${entry.category}` : undefined,
		entry.semantic_relevance === undefined
			? undefined
			: `semantic relevance=${(entry.semantic_relevance * 100).toFixed(1)}%`,
		entry.anchor ? `anchor=${entry.anchor}` : undefined,
		entry.description
			? entry.type === 'paper'
				? `summary=${boundedInlineText(entry.description)}`
				: entry.description
			: undefined,
		entry.upvotes === undefined ? undefined : `upvotes=${entry.upvotes.toString()}`,
		entry.updated_at ? `updated=${entry.updated_at}` : undefined,
		entry.created_at ? `created=${entry.created_at}` : undefined,
		entry.published_at ? `published=${entry.published_at}` : undefined,
		entry.daily_papers_date ? `daily papers=${entry.daily_papers_date}` : undefined,
		entry.daily_papers_uri ? `daily papers uri=${entry.daily_papers_uri}` : undefined,
		entry.url ? `web=${entry.url}` : undefined,
		entry.arxiv_url ? `arXiv=${entry.arxiv_url}` : undefined,
		entry.observed_at ? `observed=${entry.observed_at}` : undefined,
		entry.content_type ? `content type=${entry.content_type}` : undefined,
	].filter((detail): detail is string => detail !== undefined);
	return details.join(', ');
}

function boundedInlineText(value: string, maxLength = 240): string {
	const compact = value.replace(/\s+/g, ' ').trim();
	return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function trimMarkdownToBudget(markdown: string, maxChars: number): string {
	if (fitsWithinCharBudget(markdown, maxChars)) {
		return markdown;
	}

	const suffix = `\n\n_Markdown view truncated to fit the hf_fs output budget of approximately ${HF_FS_MAX_OUTPUT_TOKENS.toString()} tokens. structuredContent contains the full returned result._`;
	if (suffix.length >= maxChars) {
		return suffix.slice(0, maxChars);
	}
	return `${markdown.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
}

function inlineCode(value: string): string {
	return `\`${value.replace(/`/g, '\\`')}\``;
}

interface DecodedTextByteRange {
	content: string;
	bytes: number;
	start: number;
	end: number;
}

async function decodeTextFileByteRange(
	filePath: string,
	blob: Blob,
	offset: number,
	end: number
): Promise<DecodedTextByteRange> {
	if (offset >= blob.size || end <= offset) {
		return { content: '', bytes: 0, start: offset, end: offset };
	}

	const windowStart = Math.max(0, offset - (MAX_UTF8_SEQUENCE_BYTES - 1));
	const windowEnd = Math.min(blob.size, end + (MAX_UTF8_SEQUENCE_BYTES - 1));
	const windowBytes = new Uint8Array(await blob.slice(windowStart, windowEnd).arrayBuffer());
	const byteAt = (absoluteOffset: number): number | undefined => windowBytes[absoluteOffset - windowStart];

	let rangeStart = offset;
	while (rangeStart > windowStart && isUtf8ContinuationByte(byteAt(rangeStart))) {
		rangeStart -= 1;
	}

	let rangeEnd = end;
	while (rangeEnd < blob.size && rangeEnd < windowEnd && isUtf8ContinuationByte(byteAt(rangeEnd))) {
		rangeEnd += 1;
	}

	const bytes = windowBytes.slice(rangeStart - windowStart, rangeEnd - windowStart);
	const content = decodeTextFileContent(filePath, bytes);
	return { content, bytes: bytes.byteLength, start: rangeStart, end: rangeEnd };
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof HubApiError && error.statusCode === 404;
}

function buildLsResult(
	uri: string,
	entries: HfFsEntry[],
	truncated: boolean,
	truncationReason?: HfFsLsResult['truncation_reason']
): HfFsLsResult {
	return buildEntriesResult(uri, 'ls', entries, truncated, truncationReason);
}

function buildEntriesResult(
	uri: string,
	op: HfFsLsResult['op'],
	entries: HfFsEntry[],
	truncated: boolean,
	truncationReason?: HfFsLsResult['truncation_reason']
): HfFsLsResult {
	return {
		uri,
		op,
		entries,
		...(truncated
			? {
					truncated,
					truncation_reason: truncationReason,
					truncation_message:
						'Result truncated after reaching the entry limit. Rerun with a larger --limit, up to 10000.',
				}
			: {}),
	};
}

interface FindFilters {
	entryType?: HfFsEntryType;
	nameMatcher?: (value: string) => boolean;
	pathMatcher?: (value: string) => boolean;
}

function createFindFilters(params: HfFsParams): FindFilters {
	return {
		...(params.entry_type ? { entryType: params.entry_type } : {}),
		...(params.name ? { nameMatcher: picomatch(params.name, { dot: true }) } : {}),
		...(params.path ? { pathMatcher: picomatch(params.path, { dot: true }) } : {}),
	};
}

function matchesFindFilters(entry: HfFsEntry, basePath: string, filters: FindFilters): boolean {
	if (filters.entryType && entry.type !== filters.entryType) {
		return false;
	}
	const relativePath = relativeEntryPath(basePath, entry.path);
	if (filters.nameMatcher && !filters.nameMatcher(basename(entry.path))) {
		return false;
	}
	if (filters.pathMatcher && !filters.pathMatcher(relativePath)) {
		return false;
	}
	return true;
}

function statResultToFindEntry(stat: HfFsStatResult): HfFsEntry {
	return {
		type: 'file',
		path: stat.path,
		...optionalSize(stat.size),
		...(stat.lfs === undefined ? {} : { lfs: stat.lfs }),
	};
}

function parentPath(path: string): string {
	const slashIndex = path.lastIndexOf('/');
	return slashIndex === -1 ? '' : path.slice(0, slashIndex);
}

function basename(path: string): string {
	const slashIndex = path.lastIndexOf('/');
	return slashIndex === -1 ? path : path.slice(slashIndex + 1);
}

export function parseHfFsUri(uri: string): ParsedHfUri {
	if (!uri.startsWith('hf://')) {
		throw new Error('URI must start with hf://.');
	}

	const location = uri.slice('hf://'.length).replace(/^\/+|\/+$/g, '');
	if (!location) {
		throw new Error('Missing repository or bucket type in URI.');
	}
	if (location.includes('//')) {
		throw new Error('URI path must not contain empty segments.');
	}

	const slashIndex = location.indexOf('/');
	const prefix = slashIndex === -1 ? location : location.slice(0, slashIndex);
	const body = slashIndex === -1 ? '' : location.slice(slashIndex + 1);
	const repoType = parseUriType(prefix);

	if (repoType === 'collection') {
		throw new Error('Collection URIs are handled by the navigation layer.');
	}

	if (repoType === 'bucket') {
		return parseBucketUri(body, repoType);
	}
	return parseRepoUri(body, repoType);
}

function parseUriType(prefix: string): RepoType | 'collection' {
	if (!isHfUriType(prefix)) {
		throw new Error(`Invalid URI type '${prefix}'. Must be one of ${HF_URI_TYPES.join(', ')}.`);
	}

	switch (prefix) {
		case 'models':
			return 'model';
		case 'datasets':
			return 'dataset';
		case 'spaces':
			return 'space';
		case 'buckets':
			return 'bucket';
		case 'collections':
			return 'collection';
		case 'papers':
			throw new Error('Paper URIs are handled by the papers provider.');
	}
}

function parseBucketUri(body: string, repoType: RepoType): ParsedHfUri {
	if (!body) {
		return { kind: 'namespace', repoType, path: '' };
	}
	const parts = body.split('/', 3);
	if (parts.length === 1) {
		const namespace = parts[0];
		if (!namespace) {
			throw new Error(`Bucket owner must not be empty.`);
		}
		return { kind: 'namespace', repoType, namespace: decodeSegment(namespace), path: '' };
	}
	if (!parts[0] || !parts[1]) {
		throw new Error(`Bucket id must be 'owner/name', got '${body}'.`);
	}
	const repoId = `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
	if (repoId.includes('@')) {
		throw new Error("Bucket URIs do not support a revision marker ('@').");
	}
	const path = parts.length > 2 ? decodePath(body.split('/').slice(2).join('/')) : '';
	return {
		kind: 'repo',
		repo: { type: repoType, name: repoId },
		repoType,
		repoId,
		namespace: decodeSegment(parts[0]),
		path,
	};
}

function parseRepoUri(body: string, repoType: RepoType): ParsedHfUri {
	if (!body) {
		return { kind: 'namespace', repoType, path: '' };
	}
	const atIndex = body.indexOf('@');
	let repoId: string;
	let revision: string | undefined;
	let path: string;

	const namespaceOnly = !body.includes('/') && atIndex === -1;
	if (namespaceOnly) {
		return { kind: 'namespace', repoType, namespace: decodeSegment(body), path: '' };
	}

	if (atIndex !== -1 && body.slice(0, atIndex).split('/').length === 2) {
		repoId = decodeRepoId(body.slice(0, atIndex));
		const revAndPath = body.slice(atIndex + 1);
		const parsedRevision = splitRevisionAndPath(revAndPath);
		revision = decodeURIComponent(parsedRevision.revision);
		path = decodePath(parsedRevision.path);
		if (!revision) {
			throw new Error("Revision after '@' must not be empty.");
		}
	} else {
		const parts = body.split('/', 3);
		if (parts.length < 2 || !parts[0] || !parts[1]) {
			throw new Error(`Repository id must be 'owner/name', got '${body}'.`);
		}
		repoId = `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
		path = parts.length > 2 ? decodePath(body.split('/').slice(2).join('/')) : '';
	}

	return {
		kind: 'repo',
		repo: { type: repoType, name: repoId },
		repoType,
		repoId,
		namespace: repoId.split('/')[0] ?? '',
		...(revision ? { revision } : {}),
		path,
	};
}

function splitRevisionAndPath(revAndPath: string): { revision: string; path: string } {
	const specialRefMatch = SPECIAL_REFS_REVISION_RE.exec(revAndPath);
	if (specialRefMatch) {
		const revision = specialRefMatch[0];
		return {
			revision,
			path: revAndPath.slice(revision.length).replace(/^\//, ''),
		};
	}

	if (UNSUPPORTED_RAW_SLASH_REVISION_RE.test(revAndPath)) {
		throw new Error(
			"Revision names containing '/' must be percent-encoded in hf:// URIs unless they are refs/pr/N or refs/convert/NAME. For example, use refs%2Fheads%2Ffeature instead of refs/heads/feature."
		);
	}

	const slashIndex = revAndPath.indexOf('/');
	if (slashIndex === -1) {
		return { revision: revAndPath, path: '' };
	}
	return {
		revision: revAndPath.slice(0, slashIndex),
		path: revAndPath.slice(slashIndex + 1),
	};
}

function decodeRepoId(value: string): string {
	const parts = value.split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Repository id must be 'owner/name', got '${value}'.`);
	}
	return `${decodeSegment(parts[0])}/${decodeSegment(parts[1])}`;
}

function decodePath(path: string): string {
	if (!path) {
		return '';
	}
	return path.split('/').map(decodeSegment).join('/');
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new Error(`Invalid percent-encoding in URI segment '${segment}'.`);
	}
}

function isHfUriType(value: string): value is (typeof HF_URI_TYPES)[number] {
	return (HF_URI_TYPES as readonly string[]).includes(value);
}

function toHfFsEntry(file: ListFileEntry): HfFsEntry | null {
	const type = toEntryType(file.type);
	if (!type) {
		return null;
	}
	return {
		type,
		path: file.path,
		...(type === 'file' ? optionalSize(file.size) : {}),
		...(type === 'file' ? optionalLfs(file) : {}),
		...(type === 'file' ? optionalUpdatedAt(file.uploadedAt ?? file.lastCommit?.date) : {}),
	};
}

function toEntryType(type: ListFileEntry['type']): HfFsEntryType | null {
	if (type === 'file') {
		return 'file';
	}
	if (type === 'directory') {
		return 'dir';
	}
	return null;
}

function toStatType(path: PathInfo): HfFsStatResult['type'] {
	if (path.type === 'file') {
		return 'file';
	}
	if (path.type === 'directory') {
		return 'dir';
	}
	return 'missing';
}

function optionalSize(size: number | undefined): { size?: number } {
	return typeof size === 'number' && Number.isFinite(size) ? { size } : {};
}

function optionalLfs(file: Pick<ListFileEntry, 'lfs' | 'xetHash'>): { lfs?: boolean } {
	return file.lfs || file.xetHash ? { lfs: Boolean(file.lfs) } : {};
}

function optionalUpdatedAt(value: string | undefined): { updated_at?: string } {
	return value ? { updated_at: value } : {};
}

function modelToEntry(model: ModelEntry): HfFsEntry {
	return {
		type: 'repo',
		path: model.name,
		uri: `hf://models/${model.name}`,
		repo_type: 'model',
		private: model.private,
		gated: model.gated,
		likes: model.likes,
		downloads: model.downloads,
		...(model.task ? { task: model.task } : {}),
		updated_at: model.updatedAt.toISOString(),
	};
}

function datasetToEntry(dataset: DatasetEntry): HfFsEntry {
	return {
		type: 'repo',
		path: dataset.name,
		uri: `hf://datasets/${dataset.name}`,
		repo_type: 'dataset',
		private: dataset.private,
		gated: dataset.gated,
		likes: dataset.likes,
		downloads: dataset.downloads,
		updated_at: dataset.updatedAt.toISOString(),
	};
}

function semanticSpaceToEntry(space: SemanticSpaceSearchHit): HfFsEntry {
	return {
		type: 'repo',
		path: space.id,
		uri: `hf://spaces/${space.id}`,
		repo_type: 'space',
		...(space.private === undefined ? {} : { private: space.private }),
		...(space.likes === undefined ? {} : { likes: space.likes }),
		...(space.tags ? { tags: space.tags } : {}),
		...(space.trendingScore === undefined ? {} : { trending_score: space.trendingScore }),
		...(space.sdk ? { sdk: space.sdk } : {}),
		...(space.title ? { title: space.title } : {}),
		...(space.ai_category ? { category: space.ai_category } : {}),
		...(space.semanticRelevancyScore === undefined ? {} : { semantic_relevance: space.semanticRelevancyScore }),
		...(space.shortDescription || space.ai_short_description
			? { description: space.shortDescription ?? space.ai_short_description }
			: {}),
		...(space.lastModified ? { updated_at: space.lastModified } : {}),
		...(space.createdAt ? { created_at: space.createdAt } : {}),
	};
}

function sortSemanticSpaceHits(hits: SemanticSpaceSearchHit[], sort: HfFsSort | undefined): SemanticSpaceSearchHit[] {
	if (!sort) return hits;
	const value = (hit: SemanticSpaceSearchHit): number => {
		switch (sort) {
			case 'likes':
				return hit.likes ?? 0;
			case 'trending':
			case 'trendingScore':
				return hit.trendingScore ?? 0;
			case 'createdAt':
				return Date.parse(hit.createdAt ?? '') || 0;
			case 'lastModified':
				return Date.parse(hit.lastModified ?? '') || 0;
			default:
				return hit.semanticRelevancyScore ?? 0;
		}
	};
	return [...hits].sort((left, right) => value(right) - value(left));
}

function spaceToEntry(space: SpaceEntry): HfFsEntry {
	return {
		type: 'repo',
		path: space.name,
		uri: `hf://spaces/${space.name}`,
		repo_type: 'space',
		private: space.private,
		likes: space.likes,
		...(space.sdk ? { sdk: space.sdk } : {}),
		updated_at: space.updatedAt.toISOString(),
	};
}

function bucketToEntry(bucket: ApiBucketEntry): HfFsEntry {
	return {
		type: 'bucket',
		path: bucket.id,
		uri: `hf://buckets/${bucket.id}`,
		repo_type: 'bucket',
		private: bucket.private,
		size: bucket.size,
		total_files: bucket.totalFiles,
		created_at: bucket.createdAt,
		updated_at: bucket.updatedAt,
	};
}

type TrendingRepoType = 'model' | 'dataset' | 'space';

function trendingRepoType(uri: string): TrendingRepoType {
	if (uri === 'hf://models/trending') return 'model';
	if (uri === 'hf://datasets/trending') return 'dataset';
	if (uri === 'hf://spaces/trending') return 'space';
	throw new Error(`EINVAL: unsupported trending URI: ${uri}`);
}

function trendingItemToEntry(item: unknown, expectedType: TrendingRepoType): HfFsEntry[] {
	if (!isRecord(item) || item.repoType !== expectedType || !isRecord(item.repoData)) {
		return [];
	}
	const data = item.repoData;
	if (typeof data.id !== 'string') {
		return [];
	}

	const uriType = uriTypeForRepoType(expectedType);
	return [
		compactEntry({
			type: 'repo',
			path: data.id,
			uri: `hf://${uriType}/${data.id}`,
			repo_type: expectedType,
			private: optionalBooleanValue(data.private),
			gated: optionalGatedValue(data.gated),
			likes: optionalNumberValue(data.likes),
			downloads: optionalNumberValue(data.downloads),
			task: optionalStringValue(data.pipeline_tag),
			tags: optionalStringArray(data.tags),
			trending_score: optionalNumberValue(data.trendingScore),
			sdk: optionalStringValue(data.sdk),
			title: optionalStringValue(data.title),
			description: optionalStringValue(data.shortDescription) ?? optionalStringValue(data.ai_short_description),
			created_at: optionalStringValue(data.createdAt),
			updated_at: optionalStringValue(data.lastModified),
		}),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function optionalStringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function optionalNumberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBooleanValue(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function optionalGatedValue(value: unknown): HfFsEntry['gated'] {
	return value === false || value === 'auto' || value === 'manual' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : undefined;
}

function isRepoDiscoveryRoot(uri: string): boolean {
	return uri === 'hf://models' || uri === 'hf://datasets' || uri === 'hf://spaces';
}

function relativeEntryPath(basePath: string, entryPath: string): string {
	if (!basePath) {
		return entryPath;
	}
	if (entryPath === basePath) {
		return '';
	}
	const prefix = `${basePath}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

function relativeNamespaceEntryPath(namespace: string, entryPath: string): string {
	const prefix = `${namespace}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

function uriTypeForRepoType(repoType: RepoType): (typeof HF_URI_TYPES)[number] {
	switch (repoType) {
		case 'model':
			return 'models';
		case 'dataset':
			return 'datasets';
		case 'space':
			return 'spaces';
		case 'bucket':
			return 'buckets';
	}
}
