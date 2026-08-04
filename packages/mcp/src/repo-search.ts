import { z } from 'zod';
import { HfApiCall } from './hf-api-call.js';
import { fitsWithinCharBudget, formatDate, formatNumber, maxCharsForTokenBudget } from './utilities.js';
import type { ToolResult } from './types/tool-result.js';

const TAGS_TO_RETURN = 20;
const TOKEN_CAP = 12_500;
const CHARS_PER_TOKEN = 3;
const MAX_OUTPUT_CHARS = maxCharsForTokenBudget(TOKEN_CAP, CHARS_PER_TOKEN);

const REPO_TYPES = ['model', 'dataset', 'space'] as const;
export type RepoType = (typeof REPO_TYPES)[number];

const REPO_TYPE_LABELS: Record<RepoType, string> = {
	model: 'Models',
	dataset: 'Datasets',
	space: 'Spaces',
};

const DEFAULT_REPO_TYPES: RepoType[] = ['model', 'dataset'];

export const REPO_SEARCH_TOOL_CONFIG = {
	name: 'hub_repo_search',
	description:
		'Search Hugging Face repositories with a shared query interface. ' +
		'You can target models, datasets, spaces, or aggregate across multiple repo types in one call. ' +
		'Include links to repositories in your response.',
	schema: z.object({
		query: z
			.string()
			.optional()
			.describe('Search term. Leave blank and specify sort + limit to browse trending or recent repositories.'),
		repo_types: z
			.array(z.enum(REPO_TYPES))
			.min(1)
			.max(3)
			.optional()
			.default(DEFAULT_REPO_TYPES)
			.describe(
				'Repository types to search. Defaults to ["model", "dataset"]. space uses keyword search via /api/spaces.'
			),
		author: z
			.string()
			.optional()
			.describe("Organization or user namespace to filter by (e.g. 'google', 'meta-llama', 'huggingface')."),
		filters: z
			.array(z.string())
			.optional()
			.describe(
				'Optional hub filter tags. Applied to each selected repo type (e.g. ["text-generation"], ["language:en"], ["mcp-server"]).'
			),
		sort: z
			.enum(['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified'])
			.optional()
			.describe('Sort order (descending): trendingScore, downloads, likes, createdAt, lastModified'),
		limit: z
			.number()
			.min(1)
			.max(100)
			.optional()
			.default(20)
			.describe('Maximum number of results to return per selected repo type'),
	}),
	annotations: {
		title: 'Repo Search',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

export type RepoSearchParams = z.infer<typeof REPO_SEARCH_TOOL_CONFIG.schema>;

interface RepoApiParams {
	search?: string;
	author?: string;
	filter?: string;
	sort?: string;
	direction?: string;
	limit?: string;
}

interface RepoResultBase {
	id: string;
	author?: string | null;
	likes?: number;
	downloads?: number;
	trendingScore?: number;
	private?: boolean;
	tags?: string[];
	createdAt?: string;
	lastModified?: string | null;
}

interface ModelRepoResult extends RepoResultBase {
	pipeline_tag?: string;
	library_name?: string;
}

interface DatasetRepoResult extends RepoResultBase {
	description?: string;
	gated?: boolean;
}

interface SpaceRepoResult extends RepoResultBase {
	title?: string | null;
	emoji?: string | null;
	sdk?: string;
	shortDescription?: string;
	ai_short_description?: string;
	disabled?: boolean | null;
}

type RepoSearchResult = ModelRepoResult | DatasetRepoResult | SpaceRepoResult;

interface RepoSearchBatchResult {
	repoType: RepoType;
	results: RepoSearchResult[];
}

/**
 * Service for searching Hugging Face repositories with shared parameters.
 *
 * Uses listing endpoints:
 * - /api/models
 * - /api/datasets
 * - /api/spaces
 */
export class RepoSearchTool extends HfApiCall<Record<string, string>, unknown> {
	constructor(hfToken?: string) {
		super('https://huggingface.co/api', hfToken);
	}

	async searchWithParams(params: Partial<RepoSearchParams>): Promise<ToolResult> {
		try {
			const repoTypes = normalizeRepoTypes(params.repo_types);
			const apiParams = this.toApiParams(params);

			const searchBatches = await Promise.all(
				repoTypes.map(async (repoType): Promise<RepoSearchBatchResult> => {
					const results = await this.searchByType(repoType, apiParams);
					return { repoType, results };
				})
			);

			const totalResults = searchBatches.reduce((sum, batch) => sum + batch.results.length, 0);
			if (totalResults === 0) {
				return {
					formatted: `No repositories found for the given criteria.`,
					totalResults: 0,
					resultsShared: 0,
				};
			}

			return formatSearchResults(searchBatches, params, repoTypes);
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Failed to search repositories: ${error.message}`, { cause: error });
			}
			throw error;
		}
	}

	private toApiParams(params: Partial<RepoSearchParams>): RepoApiParams {
		const apiParams: RepoApiParams = {};

		if (params.query) {
			apiParams.search = params.query;
		}
		if (params.author) {
			apiParams.author = params.author;
		}
		if (params.filters && params.filters.length > 0) {
			apiParams.filter = params.filters.join(',');
		}
		if (params.sort) {
			apiParams.sort = params.sort;
			apiParams.direction = '-1';
		}
		if (params.limit) {
			apiParams.limit = params.limit.toString();
		}

		return apiParams;
	}

	private async searchByType(repoType: RepoType, params: RepoApiParams): Promise<RepoSearchResult[]> {
		const endpoint = repoType === 'model' ? 'models' : repoType === 'dataset' ? 'datasets' : 'spaces';
		const url = new URL(`${this.apiUrl}/${endpoint}`);

		if (params.search !== undefined) {
			url.searchParams.set('search', params.search);
		}
		if (params.author !== undefined) {
			url.searchParams.set('author', params.author);
		}
		if (params.filter !== undefined) {
			url.searchParams.set('filter', params.filter);
		}
		if (params.sort !== undefined) {
			url.searchParams.set('sort', params.sort);
		}
		if (params.direction !== undefined) {
			url.searchParams.set('direction', params.direction);
		}
		if (params.limit !== undefined) {
			url.searchParams.set('limit', params.limit);
		}

		return this.fetchFromApi<RepoSearchResult[]>(url);
	}
}

function normalizeRepoTypes(repoTypes: RepoType[] | undefined): RepoType[] {
	if (!repoTypes || repoTypes.length === 0) {
		return [...DEFAULT_REPO_TYPES];
	}

	const seen = new Set<RepoType>();
	const normalized: RepoType[] = [];

	for (const repoType of repoTypes) {
		if (!seen.has(repoType)) {
			seen.add(repoType);
			normalized.push(repoType);
		}
	}

	return normalized.length > 0 ? normalized : [...DEFAULT_REPO_TYPES];
}

function formatSearchResults(
	searchBatches: RepoSearchBatchResult[],
	params: Partial<RepoSearchParams>,
	repoTypes: RepoType[]
): ToolResult {
	const lines: string[] = [];
	const totalResults = searchBatches.reduce((sum, batch) => sum + batch.results.length, 0);
	let resultsShared = 0;
	let truncated = false;

	const tryAppendLines = (nextLines: string[]): boolean => {
		const candidate = [...lines, ...nextLines].join('\n');
		if (!fitsWithinCharBudget(candidate, MAX_OUTPUT_CHARS)) {
			return false;
		}

		lines.push(...nextLines);
		return true;
	};

	const searchTerms: string[] = [];
	if (params.query) searchTerms.push(`query "${params.query}"`);
	if (params.author) searchTerms.push(`author "${params.author}"`);
	if (params.filters && params.filters.length > 0) searchTerms.push(`filters [${params.filters.join(', ')}]`);
	if (params.sort) searchTerms.push(`sorted by ${params.sort} (descending)`);

	const repoTypesText = repoTypes.map((repoType) => REPO_TYPE_LABELS[repoType].toLowerCase()).join(', ');
	const searchDesc = searchTerms.length > 0 ? ` matching ${searchTerms.join(', ')}` : '';
	if (!tryAppendLines([`Found ${totalResults.toString()} repositories across ${repoTypesText}${searchDesc}.`, ''])) {
		truncated = true;
	}

	outer: for (const batch of searchBatches) {
		if (truncated) {
			break;
		}

		const sectionLabel = REPO_TYPE_LABELS[batch.repoType];
		if (!tryAppendLines([`## ${sectionLabel} (${batch.results.length.toString()})`, ''])) {
			truncated = true;
			break;
		}

		if (batch.results.length === 0) {
			if (!tryAppendLines([`No ${sectionLabel.toLowerCase()} matched this query.`, ''])) {
				truncated = true;
				break;
			}
			continue;
		}

		for (const result of batch.results) {
			const repoLines: string[] = [];
			appendRepoResult(repoLines, batch.repoType, result);

			if (!tryAppendLines(repoLines)) {
				truncated = true;
				break outer;
			}

			resultsShared += 1;
		}
	}

	if (truncated) {
		const truncationLines = [
			'',
			`⚠️ Results truncated at approximately ${TOKEN_CAP.toLocaleString()} tokens (${MAX_OUTPUT_CHARS.toLocaleString()} characters).`,
			`Included ${resultsShared.toString()} of ${totalResults.toString()} repositories. Narrow the query, reduce limit, or filter repo_types to see more.`,
		];

		while (lines.length > 0 && !fitsWithinCharBudget([...lines, ...truncationLines].join('\n'), MAX_OUTPUT_CHARS)) {
			lines.pop();
		}

		if (fitsWithinCharBudget([...lines, ...truncationLines].join('\n'), MAX_OUTPUT_CHARS)) {
			lines.push(...truncationLines);
		}
	}

	return {
		formatted: lines.join('\n'),
		totalResults,
		resultsShared,
	};
}

function appendRepoResult(lines: string[], repoType: RepoType, result: RepoSearchResult): void {
	const heading = repoType === 'space' ? getSpaceHeading(result) : result.id;
	lines.push(`### ${heading}`);
	lines.push('');

	if (repoType === 'dataset') {
		const dataset = result as DatasetRepoResult;
		if (dataset.description) {
			const trimmed = dataset.description.substring(0, 200);
			lines.push(`${trimmed}${dataset.description.length > 200 ? '...' : ''}`);
			lines.push('');
		}
	}

	if (repoType === 'space') {
		const space = result as SpaceRepoResult;
		const description = space.shortDescription || space.ai_short_description;
		if (description) {
			lines.push(description);
			lines.push('');
		}
	}

	const info: string[] = [];
	if (result.author) info.push(`**Author:** ${result.author}`);

	if (repoType === 'model') {
		const model = result as ModelRepoResult;
		if (model.pipeline_tag) info.push(`**Task:** ${model.pipeline_tag}`);
		if (model.library_name) info.push(`**Library:** ${model.library_name}`);
	}

	if (repoType === 'space') {
		const space = result as SpaceRepoResult;
		if (space.sdk) info.push(`**SDK:** ${space.sdk}`);
	}

	if (typeof result.downloads === 'number') info.push(`**Downloads:** ${formatNumber(result.downloads)}`);
	if (typeof result.likes === 'number') info.push(`**Likes:** ${result.likes.toString()}`);
	if (typeof result.trendingScore === 'number') info.push(`**Trending Score:** ${result.trendingScore.toString()}`);

	if (info.length > 0) {
		lines.push(info.join(' | '));
		lines.push('');
	}

	if (result.tags && result.tags.length > 0) {
		lines.push(`**Tags:** ${result.tags.slice(0, TAGS_TO_RETURN).join(', ')}`);
		if (result.tags.length > TAGS_TO_RETURN) {
			lines.push(`*and ${(result.tags.length - TAGS_TO_RETURN).toString()} more...*`);
		}
		lines.push('');
	}

	const status: string[] = [];
	if (result.private) status.push('🔐 Private');
	if (repoType === 'dataset' && (result as DatasetRepoResult).gated) status.push('🔒 Gated');
	if (repoType === 'space' && (result as SpaceRepoResult).disabled) status.push('⛔ Disabled');

	if (status.length > 0) {
		lines.push(status.join(' | '));
		lines.push('');
	}

	if (result.createdAt) {
		lines.push(`**Created:** ${formatDate(result.createdAt)}`);
	}
	if (result.lastModified && result.lastModified !== result.createdAt) {
		lines.push(`**Last Modified:** ${formatDate(result.lastModified)}`);
	}

	lines.push(`**Link:** [${getRepoLink(repoType, result.id)}](${getRepoLink(repoType, result.id)})`);
	lines.push('');
	lines.push('---');
	lines.push('');
}

function getSpaceHeading(result: RepoSearchResult): string {
	const space = result as SpaceRepoResult;
	const title = space.title?.trim();
	if (title && title.length > 0) {
		return `${title} (\`${result.id}\`)`;
	}
	return result.id;
}

function getRepoLink(repoType: RepoType, id: string): string {
	if (repoType === 'dataset') {
		return `https://hf.co/datasets/${id}`;
	}
	if (repoType === 'space') {
		return `https://hf.co/spaces/${id}`;
	}
	return `https://hf.co/${id}`;
}
