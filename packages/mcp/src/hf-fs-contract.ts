import { z } from 'zod';
import { parseCommandArgs, type CommandOptionMap } from './command-args.js';

export const HF_FS_OPERATIONS = ['ls', 'cat', 'attach', 'stat', 'find', 'search'] as const;
export const HF_FS_ENTRY_TYPES = ['file', 'dir', 'repo', 'bucket', 'collection', 'paper', 'link'] as const;
export const HF_FS_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const HF_FS_BATCH_MAX_OPERATIONS = 30;
const HF_FS_SEARCH_SORTS = [
	'createdAt',
	'downloads',
	'likes',
	'lastModified',
	'likes30d',
	'trendingScore',
	'mainSize',
	'id',
	'trending',
	'upvotes',
] as const;

export type HfFsOperation = (typeof HF_FS_OPERATIONS)[number];
export type HfFsEntryType = (typeof HF_FS_ENTRY_TYPES)[number];
export type HfFsSort = (typeof HF_FS_SEARCH_SORTS)[number];

export interface HfFsParams {
	op: HfFsOperation;
	uri: string;
	glob?: string;
	recursive?: boolean;
	entry_type?: HfFsEntryType;
	name?: string;
	path?: string;
	query?: string;
	sort?: HfFsSort;
	tags?: string[];
	space_kind?: 'mcp';
	max_bytes?: number;
	offset?: number;
	limit?: number;
}

export const HF_FS_DESCRIPTION = `When to use: Hugging Face Hub models, datasets, Spaces, collections, papers, daily papers, today's trending models, current paper leaderboard, docs, and repository files.

Examples:
  {"operations":[{"cmd":"ls","args":["hf://models/trending","--limit","10"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/trending"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/daily/latest"]}]}
  {"operations":[{"cmd":"cat","args":["hf://papers/2501.00001/paper.md"]}]}

Use hf_fs for Hugging Face Hub filesystem operations. Call it with operations, an array of {cmd, args} items; multiple operations may be submitted together.

Usage:
  {"operations":[{"cmd":"ls","args":["hf://models/org/repo"]}]}

Grammar; each string below is one args array item:
  ls     URI [--recursive] [--glob GLOB] [--type TYPE] [--sort SORT] [--limit N]
  cat    URI [--offset N] [--max-bytes N]
  attach URI [--max-bytes N]
  stat   URI
  find   URI [--name GLOB] [--path GLOB] [--type TYPE] [--limit N]
  search URI [QUERY] [--type TYPE] [--sort SORT] [--tag TAG] [--kind mcp] [--limit N]

COMMAND = ls|cat|attach|stat|find|search.
TYPE = file|dir|repo|bucket|collection|paper|link.
SORT = createdAt|downloads|likes|lastModified|likes30d|trendingScore|mainSize|id|trending|upvotes.
URI is a canonical hf:// URI. QUERY and GLOB are each one string.

Use search for resource discovery, not repository-content search; ls for a known directory, find for recursive file discovery by name/path (not file contents), stat for filesystem metadata or an uncertain target type, cat for text contents, and attach for a complete JPEG, PNG, or WebP image. When the request gives an exact text-file URI, use cat directly; do not add ls or stat first. stat does not read the contents of JSON, Markdown, or other text files.

Search scopes: hf://models[/OWNER], hf://datasets[/OWNER], hf://spaces[/OWNER], hf://collections[/OWNER], hf://papers, and hf://docs[/...]. Repository and repository-file scopes are not supported: search a resource root or owner scope to discover resources; use find for file discovery within a repository or cat for a known text file. Paper and documentation search require QUERY. --tag (repeatable) and --kind are supported only on exactly hf://spaces, not owner scopes or other roots. The only valid --kind value is mcp, which selects MCP Spaces.
Use ls hf://models/trending, hf://datasets/trending, hf://spaces/trending, or hf://papers/trending for trending listings.
hf://papers/ID is a paper directory, not paper text. Use cat hf://papers/ID/paper.md for paper text and cat hf://papers/ID/metadata.json for metadata. No preliminary listing is needed for these known paths. Use ls hf://papers/ID to discover other resources.
Omit --limit, --sort, and --type unless the request requires them. Limits and path-specific behavior are documented at hf://README.md. Issue one hf_fs call.`;

export const HF_FS_OPERATION_SCHEMA = z
	.object({
		cmd: z.enum(HF_FS_OPERATIONS).describe('Command to execute.'),
		args: z
			.array(z.string())
			.describe(
				'Command arguments. First item must be an hf:// URI, not a local path or bare filename. One argument per array item. search discovers resources, not repository contents; use root/owner discovery scopes, find for file discovery, or cat for a known text file. --tag and --kind require exactly hf://spaces; the only valid --kind value is mcp.'
			),
	})
	.strict();

export const HF_FS_SCHEMA = z
	.object({
		operations: z
			.array(HF_FS_OPERATION_SCHEMA)
			.min(1, 'Provide at least one operation')
			.max(HF_FS_BATCH_MAX_OPERATIONS, `Provide at most ${HF_FS_BATCH_MAX_OPERATIONS.toString()} operations`),
	})
	.strict();

export type HfFsOperationRequest = z.input<typeof HF_FS_OPERATION_SCHEMA>;
export type HfFsRequest = z.input<typeof HF_FS_SCHEMA>;

interface ParsedHfFsRequest {
	params: HfFsParams;
	warnings: string[];
}

const TYPE_ALIASES: Readonly<Record<string, HfFsEntryType>> = {
	f: 'file',
	d: 'dir',
	l: 'link',
	model: 'repo',
	dataset: 'repo',
	space: 'repo',
};

const LS_FLAGS: CommandOptionMap = {
	'-R': { key: 'recursive', kind: 'boolean' },
	'-r': { key: 'recursive', kind: 'boolean' },
	'-lR': { key: 'recursive', kind: 'boolean' },
	'-laR': { key: 'recursive', kind: 'boolean' },
	'--recursive': { key: 'recursive', kind: 'boolean' },
	'-l': { key: 'long', kind: 'boolean' },
	'-a': { key: 'all', kind: 'boolean' },
	'-la': { key: 'long_all', kind: 'boolean' },
	'-al': { key: 'long_all', kind: 'boolean' },
	'--long': { key: 'long', kind: 'boolean' },
	'--glob': { key: 'glob', kind: 'string' },
	'-type': { key: 'entry_type', kind: 'string' },
	'--type': { key: 'entry_type', kind: 'string' },
	'--entry-type': { key: 'entry_type', kind: 'string' },
	'--sort': { key: 'sort', kind: 'string' },
	'-limit': { key: 'limit', kind: 'integer' },
	'--limit': { key: 'limit', kind: 'integer' },
};

const CAT_FLAGS: CommandOptionMap = {
	'-max-bytes': { key: 'max_bytes', kind: 'integer' },
	'--max-bytes': { key: 'max_bytes', kind: 'integer' },
	'-offset': { key: 'offset', kind: 'integer' },
	'--offset': { key: 'offset', kind: 'integer' },
};

const ATTACH_FLAGS: CommandOptionMap = {
	'--max-bytes': { key: 'max_bytes', kind: 'integer' },
};

const FIND_FLAGS: CommandOptionMap = {
	'-R': { key: 'recursive_compat', kind: 'boolean' },
	'-r': { key: 'recursive_compat', kind: 'boolean' },
	'--recursive': { key: 'recursive_compat', kind: 'boolean' },
	'-name': { key: 'name', kind: 'string' },
	'--name': { key: 'name', kind: 'string' },
	'--glob': { key: 'name', kind: 'string' },
	'-path': { key: 'path', kind: 'string' },
	'--path': { key: 'path', kind: 'string' },
	'-type': { key: 'entry_type', kind: 'string' },
	'--type': { key: 'entry_type', kind: 'string' },
	'--entry-type': { key: 'entry_type', kind: 'string' },
	'-limit': { key: 'limit', kind: 'integer' },
	'--limit': { key: 'limit', kind: 'integer' },
};

const SEARCH_FLAGS: CommandOptionMap = {
	'--query': { key: 'query', kind: 'string' },
	'-type': { key: 'entry_type', kind: 'string' },
	'--type': { key: 'entry_type', kind: 'string' },
	'--entry-type': { key: 'entry_type', kind: 'string' },
	'--sort': { key: 'sort', kind: 'string' },
	'--tag': { key: 'tags', kind: 'string', repeatable: true },
	'--kind': { key: 'space_kind', kind: 'string' },
	'-limit': { key: 'limit', kind: 'integer' },
	'--limit': { key: 'limit', kind: 'integer' },
};

const FLAGS: Readonly<Record<HfFsOperation, CommandOptionMap>> = {
	ls: LS_FLAGS,
	cat: CAT_FLAGS,
	attach: ATTACH_FLAGS,
	stat: {},
	find: FIND_FLAGS,
	search: SEARCH_FLAGS,
};

export function parseHfFsRequest(request: HfFsOperationRequest): ParsedHfFsRequest {
	const { positionals, options } = parseCommandArgs(request, FLAGS[request.cmd]);
	if (positionals.length === 0) {
		throw new Error(`EINVAL: ${request.cmd} requires an hf:// URI`);
	}

	let uri = normalizeHfFsUri(positionals[0] ?? '');
	if (!uri?.startsWith('hf://')) {
		throw new Error('EINVAL: URI must start with hf://');
	}
	if ((request.cmd === 'cat' || request.cmd === 'stat') && positionals.length === 2) {
		uri = joinUriPath(uri, positionals[1] ?? '');
	}
	const expectedPositionals =
		request.cmd === 'search' ? Number.POSITIVE_INFINITY : request.cmd === 'cat' || request.cmd === 'stat' ? 2 : 1;
	if (positionals.length > expectedPositionals) {
		throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${positionals[expectedPositionals] ?? ''}`);
	}
	const positionalQuery = request.cmd === 'search' ? positionals.slice(1).join(' ').trim() : undefined;
	if (positionalQuery && options.query !== undefined) {
		throw new Error('EINVAL: duplicate option for query: --query');
	}

	const entryType = options.entry_type as string | undefined;
	const params: HfFsParams = {
		op: request.cmd,
		uri,
		...(options.recursive === true ? { recursive: true } : {}),
		...(typeof options.glob === 'string' ? { glob: options.glob } : {}),
		...(entryType !== undefined ? { entry_type: TYPE_ALIASES[entryType] ?? (entryType as HfFsEntryType) } : {}),
		...(typeof options.name === 'string' ? { name: options.name } : {}),
		...(typeof options.path === 'string' ? { path: options.path } : {}),
		...(typeof options.query === 'string'
			? { query: options.query }
			: positionalQuery
				? { query: positionalQuery }
				: {}),
		...(typeof options.sort === 'string' ? { sort: options.sort as HfFsSort } : {}),
		...(Array.isArray(options.tags) ? { tags: options.tags } : {}),
		...(typeof options.space_kind === 'string' ? { space_kind: options.space_kind as HfFsParams['space_kind'] } : {}),
		...(typeof options.max_bytes === 'number' ? { max_bytes: options.max_bytes } : {}),
		...(typeof options.offset === 'number' ? { offset: options.offset } : {}),
		...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
	};
	const normalizationWarnings = normalizeParsedParams(params);
	validateParsedParams(params);
	const softened = softenParsedParams(params);
	return { params: softened.params, warnings: [...normalizationWarnings, ...softened.warnings] };
}

function normalizeHfFsUri(value: string): string {
	if (/^(?:models|datasets|spaces|buckets|collections|papers|docs)(?:\/|$)/.test(value)) {
		return `hf://${value.replace(/\/+$/, '')}`;
	}
	if (!/^https?:\/\//i.test(value)) {
		return value;
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return value;
	}
	if (
		url.protocol !== 'https:' ||
		!['huggingface.co', 'www.huggingface.co'].includes(url.hostname) ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		return value;
	}

	const segments = url.pathname.split('/').filter(Boolean);
	if (segments.length === 0) {
		return 'hf://';
	}
	const first = segments[0] ?? '';
	if (['models', 'datasets', 'spaces', 'buckets', 'collections', 'papers', 'docs'].includes(first)) {
		return normalizeTypedHfWebPath(segments);
	}
	const isRepoFileUrl = segments.length >= 4 && ['blob', 'resolve', 'tree'].includes(segments[2] ?? '');
	if (segments.length !== 2 && !isRepoFileUrl) {
		return value;
	}
	if (
		[
			'api',
			'collections',
			'datasets',
			'docs',
			'join',
			'login',
			'models',
			'new',
			'organizations',
			'papers',
			'pricing',
			'search',
			'settings',
			'spaces',
		].includes(first)
	) {
		return value;
	}
	return normalizeRepoWebPath('models', segments);
}

function normalizeTypedHfWebPath(segments: string[]): string {
	const type = segments[0] ?? '';
	if (type === 'models' && segments.length >= 3) {
		return normalizeRepoWebPath(type, segments.slice(1));
	}
	if (['datasets', 'spaces'].includes(type) && segments.length >= 3) {
		return normalizeRepoWebPath(type, segments.slice(1));
	}
	if (type === 'buckets' && segments.length >= 4 && segments[3] === 'resolve') {
		return `hf://buckets/${[segments[1], segments[2], ...segments.slice(4)].join('/')}`;
	}
	return `hf://${segments.join('/')}`;
}

function normalizeRepoWebPath(type: string, segments: string[]): string {
	if (segments.length < 2) {
		return `hf://${type}/${segments.join('/')}`;
	}
	const [owner, repo, route, revision, ...path] = segments;
	if (route === 'blob' || route === 'resolve' || route === 'tree') {
		if (!revision) {
			return `hf://${type}/${owner}/${repo}`;
		}
		const repoWithRevision = revision === 'main' ? repo : `${repo}@${revision}`;
		return `hf://${type}/${[owner, repoWithRevision, ...path].join('/')}`;
	}
	if (segments.length > 2) {
		return `https://huggingface.co/${type === 'models' ? '' : `${type}/`}${segments.join('/')}`;
	}
	return `hf://${type}/${segments.join('/')}`;
}

function normalizeParsedParams(params: HfFsParams): string[] {
	if (
		params.op === 'ls' &&
		params.sort === 'trending' &&
		/^hf:\/\/(?:models|datasets|spaces|papers)$/.test(params.uri)
	) {
		if (params.recursive || params.glob) {
			throw new Error('EINVAL: --sort trending does not support recursive or glob listing options');
		}
		const source = params.uri;
		params.uri = `${source}/trending`;
		delete params.sort;
		return [`Treated --sort trending on ${source} as ${params.uri}.`];
	}
	return [];
}

function validateParsedParams(params: HfFsParams): void {
	if (params.op === 'search' && !params.query && !searchAllowsEmptyQuery(params.uri)) {
		throw new Error('EINVAL: search requires a positional query or --query');
	}
	if (params.op === 'search' && !validSearchUri(params.uri)) {
		throw new Error(
			'EINVAL: search requires hf://models|datasets|spaces[/OWNER], hf://collections[/OWNER], any hf://docs scope, or exactly hf://papers. Repository and repository-file scopes are not supported: search a resource root or owner scope to discover resources; use find for file discovery by name/path (not file contents) or cat for a known text file.'
		);
	}
	if (params.entry_type !== undefined && !HF_FS_ENTRY_TYPES.includes(params.entry_type)) {
		throw new Error(`EINVAL: invalid entry type: ${params.entry_type}. Use --type file for files.`);
	}
	if (params.sort !== undefined && !HF_FS_SEARCH_SORTS.includes(params.sort)) {
		throw new Error(`EINVAL: invalid sort: ${params.sort}`);
	}
	const spaceKind: string | undefined = params.space_kind;
	if (spaceKind !== undefined && spaceKind !== 'mcp') {
		throw new Error(`EINVAL: invalid Space kind: ${spaceKind}. Supported kinds: mcp`);
	}
	if (params.tags !== undefined) {
		if (params.tags.some((tag) => tag.length === 0 || tag.length > 100)) {
			throw new Error('EINVAL: Space tags must contain between 1 and 100 characters');
		}
		if (params.tags.length > 20) {
			throw new Error('EINVAL: at most 20 Space tags may be specified');
		}
	}
	if (
		(params.tags !== undefined || params.space_kind !== undefined) &&
		(params.op !== 'search' || params.uri !== 'hf://spaces')
	) {
		throw new Error(
			'EINVAL: --tag and --kind are supported only with search hf://spaces (exact root, not owner scopes or other roots); remove these filters for owner-scope discovery'
		);
	}
	if (
		params.max_bytes !== undefined &&
		(params.op === 'attach'
			? params.max_bytes < 1 || params.max_bytes > HF_FS_ATTACH_MAX_BYTES
			: params.max_bytes < 0 || params.max_bytes > 80_000)
	) {
		throw new Error(
			params.op === 'attach'
				? `EINVAL: attach max_bytes must be between 1 and ${HF_FS_ATTACH_MAX_BYTES.toString()}`
				: 'EINVAL: max_bytes must be between 0 and 80000'
		);
	}
	if (params.offset !== undefined && params.offset < 0) {
		throw new Error('EINVAL: offset must be non-negative');
	}
	if (params.limit !== undefined) {
		const max = params.op === 'search' ? 1000 : isRepoTrendingUri(params.uri) ? 20 : 10_000;
		if (params.limit < 1 || params.limit > max) {
			throw new Error(`EINVAL: limit must be between 1 and ${max.toString()} for this command`);
		}
	}
}

function joinUriPath(uri: string, path: string): string {
	return `${uri.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function searchAllowsEmptyQuery(uri: string): boolean {
	return /^hf:\/\/(?:models|datasets|spaces|collections)(?:\/[^/]+)?$/.test(uri);
}

function softenParsedParams(params: HfFsParams): ParsedHfFsRequest {
	const warnings: string[] = [];
	if (!isRepoTrendingUri(params.uri) || params.op !== 'ls') {
		return { params, warnings };
	}

	// Tolerate safe, unambiguous model-generated variants without weakening command semantics.
	if (params.sort === 'trending' || params.sort === 'trendingScore') {
		warnings.push(`Ignored --sort ${params.sort} because ${params.uri} already implies trending order.`);
		delete params.sort;
	}
	if (params.entry_type === 'repo') {
		warnings.push(`Ignored --type repo because ${params.uri} contains only repositories.`);
		delete params.entry_type;
	}
	return { params, warnings };
}

function validSearchUri(uri: string): boolean {
	if (uri === 'hf://papers') {
		return true;
	}
	if (uri === 'hf://docs' || uri.startsWith('hf://docs/')) {
		return true;
	}
	return /^hf:\/\/(?:models|datasets|spaces|collections)(?:\/[^/]+)?$/.test(uri) && !isRepoTrendingUri(uri);
}

export function isRepoTrendingUri(uri: string): boolean {
	return /^hf:\/\/(?:models|datasets|spaces)\/trending$/.test(uri);
}
