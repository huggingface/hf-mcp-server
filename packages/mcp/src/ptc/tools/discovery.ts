import { z } from 'zod';
import { PtcError } from '../core/errors.js';
import { hubFetch, openCursor, sealCursor } from '../core/hub-http.js';
import {
	collectionItem,
	paperItem,
	parseRef,
	personRefSchema,
	repoItem,
	type PtcItem,
	type RepoKind,
} from '../core/refs.js';
import { definePtcTool, READ_ONLY, type PtcTool } from '../core/tool.js';

// ---------------------------------------------------------------- shared helpers

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 2048): string | undefined =>
	typeof value === 'string' && value ? value.slice(0, max) : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const REPO_ID = /^[\w.-]+(?:\/[\w.-]+)?$/;
const NAME = /^[\w.-]{1,96}$/;

/** A repository (not a bucket) given as hf:// uri, owner/name or URL; yields owner/name. */
const fulltextRepoSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.transform((value, ctx) => {
		try {
			const parsed = parseRef(value);
			if (parsed.kind !== 'bucket' && parsed.id.includes('/')) return parsed.id;
		} catch {
			// reported below
		}
		ctx.addIssue({ code: 'custom', message: 'expected a repository: hf:// uri, owner/name or URL.' });
		return z.NEVER;
	});
const itemFields = {
	kind: z.string(),
	id: z.string(),
	uri: z.string().describe('hf:// URI to pass to the next tool (users/orgs: their profile URL).'),
	url: z.string().describe('Hugging Face page for humans.'),
};
const completeness = (scope: string) =>
	z
		.object({
			scope: z.literal(scope),
			global_complete: z.literal(false),
			pagination_blocked_reason: z.string().optional(),
			public_only: z.boolean().optional(),
			estimated_total_hits: z.number().optional().describe('Upstream estimate, not an exact total.'),
		})
		.strict();

function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function repoKindOf(value: unknown): Exclude<RepoKind, 'bucket'> | undefined {
	return value === 'model' || value === 'dataset' || value === 'space' ? value : undefined;
}

// ---------------------------------------------------------------- hf_trending

const trendingRecord = z
	.object({
		...itemFields,
		title: z.string().optional(),
		description: z.string().optional(),
		pipeline_tag: z.string().optional(),
		sdk: z.string().optional(),
		likes: z.number().optional(),
		downloads: z.number().optional(),
		num_parameters: z.number().optional(),
		gated: z.union([z.boolean(), z.string()]).optional(),
		private: z.boolean().optional(),
		last_modified: z.string().optional(),
	})
	.strict();

function trendingRecordOf(entry: Json): z.infer<typeof trendingRecord> | undefined {
	const kind = repoKindOf(entry.repoType);
	const data = isRecord(entry.repoData) ? entry.repoData : undefined;
	const id = str(data?.id, 256);
	if (!kind || !data || !id || !REPO_ID.test(id)) return undefined;
	const gated = data.gated;
	return compact({
		...repoItem(kind, id),
		title: str(data.title, 300),
		description: str(data.shortDescription, 500) ?? str(data.ai_short_description, 500),
		pipeline_tag: str(data.pipeline_tag, 100),
		sdk: str(data.sdk, 50),
		likes: num(data.likes),
		downloads: num(data.downloads),
		num_parameters: num(data.numParameters),
		gated: typeof gated === 'boolean' || typeof gated === 'string' ? gated : undefined,
		private: typeof data.private === 'boolean' ? data.private : undefined,
		last_modified: str(data.lastModified, 64),
	});
}

const hfTrending = definePtcTool({
	name: 'hf_trending',
	family: 'discovery',
	title: 'Hugging Face trending feed',
	description:
		"Show Hugging Face's curated trending feed of hot models, datasets and Spaces. Browse the mixed feed or select one repository kind. Returns repository IDs, page links and hf:// URIs, with metadata such as likes or downloads when supplied; bounded to 20 items without paging. See hf_models_search.",
	input: z
		.object({
			kind: z
				.enum(['all', 'model', 'dataset', 'space'])
				.default('all')
				.describe('Repository kind; "all" mixes models, datasets and Spaces.'),
			limit: z.number().int().min(1).max(20).default(20).describe('Items to return (upstream maximum 20).'),
		})
		.strict(),
	output: z
		.object({
			items: z.array(trendingRecord).max(20),
			returned_count: z.number().int(),
			next_cursor: z.null(),
			completeness: completeness('bounded_feed'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const params = new URLSearchParams({ type: input.kind, limit: String(input.limit) });
		const { data } = await hubFetch({ path: '/api/trending', params, subject: 'trending feed' }, ctx);
		if (!isRecord(data) || !Array.isArray(data.recentlyTrending)) {
			throw new PtcError('UPSTREAM_RESPONSE', 'trending feed: unexpected upstream response.');
		}
		const items = records(data.recentlyTrending)
			.flatMap((entry) => trendingRecordOf(entry) ?? [])
			.slice(0, input.limit);
		return {
			items,
			returned_count: items.length,
			next_cursor: null,
			completeness: {
				scope: 'bounded_feed' as const,
				global_complete: false as const,
				pagination_blocked_reason: 'The trending feed is a single list of at most 20 items.',
			},
		};
	},
});

// ---------------------------------------------------------------- hf_repo_fulltext_search

const FULLTEXT_EXCERPT = 400;
const fulltextHit = z
	.object({
		...itemFields,
		file: z.string().optional().describe('File the match was found in (normally README.md).'),
		file_uri: z.string().optional().describe('hf:// URI of the matched file, for hf_repo_read_text.'),
		excerpt: z.string().optional().describe('Plain-text snippet around the match, truncated.'),
		likes: z.number().optional(),
		tags: z.array(z.string()).max(100).optional(),
		updated_at: z.string().optional(),
	})
	.strict();

function excerptOf(formatted: unknown): string | undefined {
	const parts = isRecord(formatted) ? records(formatted.fileContent) : [];
	if (!parts.length) return undefined;
	const firstHit = parts.findIndex((part) => part.type === 'highlight');
	let before = '';
	let after = '';
	parts.forEach((part, index) => {
		const text = typeof part.text === 'string' ? part.text : '';
		if (firstHit > 0 && index < firstHit) before += text;
		else after += text;
	});
	const clean = (value: string) => value.replace(/\s+/g, ' ');
	const lead = clean(before).slice(-120);
	const text = `${lead.length < clean(before).length ? '…' : ''}${lead}${clean(after)}`.trim();
	return text.length > FULLTEXT_EXCERPT ? `${text.slice(0, FULLTEXT_EXCERPT - 1).trimEnd()}…` : text || undefined;
}

function fulltextHitOf(hit: Json): z.infer<typeof fulltextHit> | undefined {
	const kind = repoKindOf(hit.type);
	const id = str(hit.name, 256);
	if (!kind || !id || !REPO_ID.test(id)) return undefined;
	const file = str(hit.fileName, 1000);
	const updated = num(hit.updatedAt);
	const tags = typeof hit.tags === 'string' ? hit.tags.split(',').map((tag) => tag.trim()) : undefined;
	return compact({
		...repoItem(kind, id),
		file,
		file_uri: file ? `${repoItem(kind, id).uri}/${file.split('/').map(encodeURIComponent).join('/')}` : undefined,
		excerpt: excerptOf(hit.formatted),
		likes: num(hit.likes),
		tags: tags?.filter(Boolean).slice(0, 100),
		updated_at: updated !== undefined ? new Date(updated).toISOString() : str(hit.updatedAt, 64),
	});
}

const fulltextInput = z
	.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(250)
			.describe('Phrase to find in README/card text, e.g. "trained on SEC filings".'),
		kinds: z
			.array(z.enum(['model', 'dataset', 'space']))
			.min(1)
			.max(3)
			.optional()
			.describe('Restrict to these repository kinds; default all.'),
		owners: z
			.array(personRefSchema())
			.min(1)
			.max(10)
			.optional()
			.describe('Only repositories of these users/orgs (names or profile uris; max 10).'),
		repo_ids: z
			.array(fulltextRepoSchema)
			.min(1)
			.max(10)
			.optional()
			.describe('Only these repositories (items[].uri or owner/name); ORed with owners, max 10.'),
		limit: z.number().int().min(1).max(100).default(20).describe('Hits per page (max 100).'),
		cursor: z.string().max(4096).optional().describe('next_cursor from a previous call with the same arguments.'),
	})
	.strict();

const hfRepoFulltextSearch = definePtcTool({
	name: 'hf_repo_fulltext_search',
	family: 'discovery',
	title: 'Full-text search in Hugging Face repo READMEs',
	description:
		"Search Hugging Face README text (model cards, dataset cards) for phrases with full-text matching. Find content such as 'trained on SEC filings' across models, datasets and Spaces. Narrow by repository kind and an owner-or-repository selection. Results identify matching repositories and can include matched-file links and text excerpts. Public repositories only.",
	input: fulltextInput,
	output: z
		.object({
			items: z.array(fulltextHit).max(100),
			returned_count: z.number().int(),
			next_cursor: z.string().nullable(),
			completeness: completeness('fulltext_page'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const filter = [...(input.owners ?? []), ...(input.repo_ids ?? [])];
		if (filter.length > 10) throw new PtcError('INVALID_ARGUMENT', 'owners + repo_ids: at most 10 values in total.');
		const binding = ['hf_repo_fulltext_search', input.query, input.kinds ?? [], filter, input.limit];
		const skip = Number(openCursor(input.cursor, binding, ctx) ?? '0');
		const params = new URLSearchParams({ q: input.query, limit: String(input.limit) });
		if (skip > 0) params.set('skip', String(skip));
		for (const kind of input.kinds ?? []) params.append('type', kind);
		if (filter.length) params.set('filter', filter.join(','));
		const { data } = await hubFetch({ path: '/api/search/full-text', params, subject: 'full-text search' }, ctx);
		if (!isRecord(data) || !Array.isArray(data.hits)) {
			throw new PtcError('UPSTREAM_RESPONSE', 'full-text search: unexpected upstream response.');
		}
		const hits = records(data.hits);
		const items = hits.flatMap((hit) => fulltextHitOf(hit) ?? []).slice(0, input.limit);
		const estimated = num(data.estimatedTotalHits);
		const more = hits.length >= input.limit && (estimated === undefined || skip + hits.length < estimated);
		return {
			items,
			returned_count: items.length,
			next_cursor: more ? sealCursor(binding, ctx, String(skip + hits.length)) : null,
			completeness: compact({
				scope: 'fulltext_page' as const,
				global_complete: false as const,
				public_only: true,
				estimated_total_hits: estimated,
			}),
		};
	},
});

// ---------------------------------------------------------------- hf_hub_lookup

const LOOKUP_TYPES = ['model', 'dataset', 'space', 'user', 'org', 'paper', 'collection', 'bucket'] as const;
type LookupType = (typeof LOOKUP_TYPES)[number];
const RESPONSE_KEY: Record<LookupType, string> = {
	model: 'models',
	dataset: 'datasets',
	space: 'spaces',
	user: 'users',
	org: 'orgs',
	paper: 'papers',
	collection: 'collections',
	bucket: 'buckets',
};
const lookupItem = z.object({ ...itemFields, title: z.string().optional(), private: z.boolean().optional() }).strict();
type LookupItem = z.infer<typeof lookupItem>;

function profileItem(kind: 'user' | 'org', name: string): PtcItem {
	const url = `https://huggingface.co/${name}`;
	return { kind, id: name, uri: url, url };
}

function lookupItemOf(type: LookupType, entry: Json): LookupItem | undefined {
	const privateFlag = typeof entry.private === 'boolean' ? entry.private : undefined;
	switch (type) {
		case 'model':
		case 'dataset':
		case 'space':
		case 'bucket': {
			const id = str(entry.id, 256);
			return id && REPO_ID.test(id) ? compact({ ...repoItem(type, id), private: privateFlag }) : undefined;
		}
		case 'user':
		case 'org': {
			const name = str(type === 'user' ? entry.user : entry.name, 96);
			return name && NAME.test(name)
				? compact({ ...profileItem(type, name), title: str(entry.fullname, 200) })
				: undefined;
		}
		case 'paper': {
			// quicksearch puts the arXiv ID in _id and the title in id.
			const id = str(entry._id, 32);
			return id && /^\d{4}\.\d{4,5}$/.test(id)
				? compact({ ...paperItem(id), title: str(entry.id, 500)?.replace(/\s+/g, ' ') })
				: undefined;
		}
		case 'collection': {
			const slug = str(entry._id, 300);
			return slug && /^[\w.-]+\/[\w.-]+$/.test(slug)
				? compact({ ...collectionItem(slug), title: str(entry.title, 300) })
				: undefined;
		}
	}
}

const hfHubLookup = definePtcTool({
	name: 'hf_hub_lookup',
	family: 'discovery',
	title: 'Resolve names to exact Hugging Face IDs',
	description:
		'Resolve a partial or fuzzy name to an exact ID across models, datasets, Spaces, users, organizations, papers, collections and buckets. Returns best-first matches grouped by type, with hf:// URIs or profile URLs and upstream counts where reported. Results are capped per type.',
	input: z
		.object({
			query: z.string().trim().min(1).max(250).describe('Partial or fuzzy name to look up.'),
			types: z
				.array(z.enum(LOOKUP_TYPES))
				.min(1)
				.max(LOOKUP_TYPES.length)
				.optional()
				.describe('Result types to include; default all.'),
			limit: z.number().int().min(1).max(20).default(5).describe('Maximum matches per type (max 20).'),
		})
		.strict(),
	output: z
		.object({
			results: z
				.partialRecord(z.enum(LOOKUP_TYPES), z.array(lookupItem).max(20))
				.describe('Matches per requested type, best first.'),
			counts: z
				.partialRecord(z.enum(LOOKUP_TYPES), z.number())
				.describe('Upstream match counts per type, where reported.'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const types: readonly LookupType[] = input.types ? [...new Set(input.types)] : LOOKUP_TYPES;
		const params = new URLSearchParams({ q: input.query, limit: String(input.limit) });
		for (const type of types) params.append('type', type);
		const { data } = await hubFetch({ path: '/api/quicksearch', params, subject: 'quick search' }, ctx);
		if (!isRecord(data)) throw new PtcError('UPSTREAM_RESPONSE', 'quick search: unexpected upstream response.');
		const results: Partial<Record<LookupType, LookupItem[]>> = {};
		const counts: Partial<Record<LookupType, number>> = {};
		for (const type of types) {
			const key = RESPONSE_KEY[type];
			results[type] = records(data[key])
				.flatMap((entry) => lookupItemOf(type, entry) ?? [])
				.slice(0, input.limit);
			const count = num(data[`${key}Count`]);
			if (count !== undefined) counts[type] = count;
		}
		return { results, counts };
	},
});

// ---------------------------------------------------------------- hf_filter_values

const filterValue = z
	.object({
		id: z.string().describe('Exact value to pass as a filter (e.g. "license:mit", "text-generation").'),
		label: z.string().optional(),
		sub_type: z.string().optional(),
		libraries: z.array(z.string()).max(50).optional().describe('tasks only: libraries supporting this task.'),
	})
	.strict();
const filterGroup = z
	.object({
		group: z.string(),
		values: z.array(filterValue),
		returned_count: z.number().int(),
		available_count: z.number().int().describe('Values upstream returned for this group before query/limit.'),
		truncated: z.boolean(),
	})
	.strict();

function filterValueOf(entry: Json, withLibraries: boolean): z.infer<typeof filterValue> | undefined {
	const id = str(entry.id, 256);
	if (!id) return undefined;
	const libraries = withLibraries && Array.isArray(entry.libraries) ? entry.libraries : undefined;
	return compact({
		id,
		label: str(entry.label, 256),
		sub_type: str(entry.subType, 100),
		libraries: libraries?.filter((lib): lib is string => typeof lib === 'string').slice(0, 50),
	});
}

const hfFilterValues = definePtcTool({
	name: 'hf_filter_values',
	family: 'discovery',
	title: 'Allowed Hugging Face search filter values',
	description:
		'List exact filter values and tag IDs by group: model task, library, license, language or region; dataset modality, format, size bucket or task category. Also returns the pipeline task catalog. Filter IDs and labels by text; results include per-group counts and truncation flags.',
	input: z
		.object({
			kind: z
				.enum(['model_tags', 'dataset_tags', 'tasks'])
				.describe('model_tags/dataset_tags: tag values by group; tasks: pipeline tasks.'),
			group: z
				.string()
				.trim()
				.regex(/^[a-z_]{1,40}$/)
				.optional()
				.describe('Tag group, e.g. library, license, language, task_categories. Omit for all.'),
			query: z
				.string()
				.trim()
				.min(1)
				.max(100)
				.optional()
				.describe('Case-insensitive substring matched against value id and label.'),
			limit: z.number().int().min(1).max(1000).default(100).describe('Maximum values per group (max 1000).'),
		})
		.strict(),
	output: z.object({ kind: z.string(), groups: z.array(filterGroup).max(50) }).strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const needle = input.query?.toLowerCase();
		const matches = (value: z.infer<typeof filterValue>) =>
			!needle || value.id.toLowerCase().includes(needle) || (value.label?.toLowerCase().includes(needle) ?? false);
		const group = (name: string, entries: Json[], withLibraries = false): z.infer<typeof filterGroup> => {
			const all = entries.flatMap((entry) => filterValueOf(entry, withLibraries) ?? []).filter(matches);
			const values = all.slice(0, input.limit);
			return {
				group: name,
				values,
				returned_count: values.length,
				available_count: entries.length,
				truncated: all.length > values.length,
			};
		};
		if (input.kind === 'tasks') {
			if (input.group) throw new PtcError('INVALID_ARGUMENT', 'group is not used with kind="tasks".');
			const { data } = await hubFetch({ path: '/api/tasks', subject: 'task catalog' }, ctx);
			if (!isRecord(data)) throw new PtcError('UPSTREAM_RESPONSE', 'task catalog: unexpected upstream response.');
			return { kind: input.kind, groups: [group('tasks', Object.values(data).filter(isRecord), true)] };
		}
		const path = input.kind === 'model_tags' ? '/api/models-tags-by-type' : '/api/datasets-tags-by-type';
		const params = input.group ? new URLSearchParams({ type: input.group }) : undefined;
		const { data } = await hubFetch({ path, params, subject: 'filter values' }, ctx);
		if (!isRecord(data)) throw new PtcError('UPSTREAM_RESPONSE', 'filter values: unexpected upstream response.');
		const groups = Object.entries(data)
			.filter(([name]) => !input.group || name === input.group)
			.slice(0, 50)
			.map(([name, entries]) => group(name, records(entries)));
		return { kind: input.kind, groups };
	},
});

// ---------------------------------------------------------------- hf_hardware_flavors

const flavor = z
	.object({
		name: z.string().describe('Flavor ID to pass as hardware/flavor (e.g. "a10g-small").'),
		pretty_name: z.string().optional(),
		cpu: z.string().optional(),
		ram: z.string().optional(),
		ephemeral_storage: z.string().optional(),
		accelerator: z
			.object({
				type: z.string().optional(),
				model: z.string().optional(),
				manufacturer: z.string().optional(),
				quantity: z.string().optional(),
				vram: z.string().optional(),
			})
			.strict()
			.nullable(),
		unit_cost_usd: z.number().optional(),
		unit_label: z.string().optional(),
	})
	.strict();

function flavorOf(entry: Json): z.infer<typeof flavor> | undefined {
	const name = str(entry.name, 100);
	if (!name) return undefined;
	const acc = isRecord(entry.accelerator) ? entry.accelerator : undefined;
	const text = (value: unknown) => (typeof value === 'number' ? String(value) : str(value, 100));
	return compact({
		name,
		pretty_name: str(entry.prettyName, 200),
		cpu: text(entry.cpu),
		ram: text(entry.ram),
		ephemeral_storage: text(entry.ephemeralStorage),
		accelerator: acc
			? compact({
					type: text(acc.type),
					model: text(acc.model),
					manufacturer: text(acc.manufacturer),
					quantity: text(acc.quantity),
					vram: text(acc.vram),
				})
			: null,
		unit_cost_usd: num(entry.unitCostUSD),
		unit_label: str(entry.unitLabel, 50),
	});
}

const hfHardwareFlavors = definePtcTool({
	name: 'hf_hardware_flavors',
	family: 'discovery',
	title: 'Hugging Face GPU/CPU hardware flavors and prices',
	description:
		'List Hugging Face hardware flavors (GPU, CPU compute tiers) for Jobs or Spaces. Returns flavor IDs with accelerator model, GPU memory (VRAM), CPU, RAM, disk and USD cost per time unit when supplied. Use the Jobs catalog for sandbox flavor selection too. GPU examples include T4, L4 and A100; the live catalog governs flavors and prices.',
	input: z
		.object({
			scope: z
				.enum(['spaces', 'jobs'])
				.default('jobs')
				.describe('Catalog: "jobs" (flavor for Jobs/sandboxes) or "spaces" (Space hardware).'),
		})
		.strict(),
	output: z
		.object({ scope: z.enum(['spaces', 'jobs']), items: z.array(flavor).max(200), returned_count: z.number().int() })
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const { data } = await hubFetch({ path: `/api/${input.scope}/hardware`, subject: 'hardware catalog' }, ctx);
		if (!Array.isArray(data))
			throw new PtcError('UPSTREAM_RESPONSE', 'hardware catalog: unexpected upstream response.');
		const items = records(data)
			.flatMap((entry) => flavorOf(entry) ?? [])
			.slice(0, 200);
		return { scope: input.scope, items, returned_count: items.length };
	},
});

// ---------------------------------------------------------------- hf_buckets_list

const bucketRecord = z
	.object({
		...itemFields,
		private: z.boolean().optional(),
		size: z.number().optional().describe('Total stored bytes.'),
		total_files: z.number().optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
	})
	.strict();

const hfBucketsList = definePtcTool({
	name: 'hf_buckets_list',
	family: 'discovery',
	title: 'List Hugging Face storage buckets',
	description:
		'List storage buckets (object storage, mutable file stores) owned by a user or organization, optionally matching a bucket name. Returns IDs and hf:// URIs, with stored bytes and file counts when supplied. Results may be truncated locally without paging; narrow the name filter.',
	input: z
		.object({
			owner: personRefSchema('User or org owning the buckets: name or profile uri.'),
			query: z.string().trim().min(1).max(100).optional().describe('Case-insensitive substring of the bucket name.'),
			limit: z.number().int().min(1).max(500).default(100).describe('Maximum buckets returned (max 500).'),
		})
		.strict(),
	output: z
		.object({
			items: z.array(bucketRecord).max(500),
			returned_count: z.number().int(),
			next_cursor: z.null(),
			completeness: completeness('owner_buckets'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const params = new URLSearchParams();
		// Upstream `search` is a case-insensitive regex: escape to keep substring semantics.
		if (input.query) params.set('search', input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		const { data } = await hubFetch(
			{ path: `/api/buckets/${encodeURIComponent(input.owner)}`, params, subject: 'bucket listing' },
			ctx
		);
		if (!Array.isArray(data)) throw new PtcError('UPSTREAM_RESPONSE', 'bucket listing: unexpected upstream response.');
		const all = records(data).flatMap((entry) => {
			const id = str(entry.id, 256);
			if (!id || !REPO_ID.test(id)) return [];
			return [
				compact({
					...repoItem('bucket', id),
					private: typeof entry.private === 'boolean' ? entry.private : undefined,
					size: num(entry.size),
					total_files: num(entry.totalFiles),
					created_at: str(entry.createdAt, 64),
					updated_at: str(entry.updatedAt, 64),
				}),
			];
		});
		const items = all.slice(0, input.limit);
		return {
			items,
			returned_count: items.length,
			next_cursor: null,
			completeness: compact({
				scope: 'owner_buckets' as const,
				global_complete: false as const,
				pagination_blocked_reason:
					all.length > items.length
						? `Truncated to limit=${String(input.limit)}; the upstream listing has no pagination, so narrow with query.`
						: undefined,
			}),
		};
	},
});

/** Hub discovery beyond the listings: trending feed, README full-text search, fuzzy lookup, filter values, hardware flavors, buckets. */
export const DISCOVERY_TOOLS: readonly PtcTool[] = [
	hfTrending,
	hfRepoFulltextSearch,
	hfHubLookup,
	hfFilterValues,
	hfHardwareFlavors,
	hfBucketsList,
];
