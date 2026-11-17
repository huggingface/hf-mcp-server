import { z } from 'zod';
import { personRefSchema } from '../core/refs.js';

// SearchBuilder's grammar is not a general boolean language. In particular,
// scoped OR cannot contain slashes; top-level OR can.
export const repoIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\w.-]+(?:\/[\w.-]+)?$/)
	.refine((id) => id.split('/').every((part) => part !== '.' && part !== '..'))
	.describe('Hub repository ID, normally owner/name (reuse items[].id).');
/**
 * Input form of a repository ID selector: also accepts a returned hf:// uri or huggingface.co URL of a
 * repository (no revision or path), so items[].uri can be passed straight back (the hf:// thread).
 */
const REPO_URI_PREFIX = /^(?:hf:\/\/(?:models|datasets|spaces)\/|https:\/\/huggingface\.co\/(?:datasets\/|spaces\/)?)/;
export const repoIdInputSchema = z.preprocess(
	(value) => (typeof value === 'string' ? value.trim().replace(REPO_URI_PREFIX, '') : value),
	repoIdSchema
);
/** arXiv ID selector: also accepts hf://papers/ID or a paper page URL. */
const arxivIdInputSchema = z.preprocess(
	(value) =>
		typeof value === 'string'
			? value.trim().replace(/^(?:hf:\/\/papers\/|https:\/\/(?:huggingface\.co\/papers|arxiv\.org\/abs)\/)/, '')
			: value,
	z
		.string()
		.regex(/^\d{4}\.\d{4,5}(?:v\d+)?$/)
		.describe('arXiv ID, e.g. 2501.00001; hf://papers/ID uris are accepted.')
);
const atom = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\w.:/<>\-+]+$/)
	.refine((value) => !value.startsWith('or:'));
const scopedAtom = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\w.:\-<>]+$/)
	.refine((value) => !value.startsWith('or:'));
const list = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(50);
const facets = list(atom)
	.optional()
	.describe('AND of literal facet values; use tags_any_groups for representable OR groups.');
export const sdkSchema = z.enum(['gradio', 'docker', 'static', 'streamlit']);
export const SPACE_STAGES = [
	'NO_APP_FILE',
	'CONFIG_ERROR',
	'BUILDING',
	'BUILD_ERROR',
	'APP_STARTING',
	'RUNNING',
	'RUNNING_BUILDING',
	'RUNNING_APP_STARTING',
	'RUNTIME_ERROR',
	'DELETING',
	'STOPPED',
	'PAUSED',
	'SLEEPING',
] as const;
export const INFERENCE_PROVIDERS = [
	'baseten',
	'cohere',
	'cerebras',
	'deepinfra',
	'fal-ai',
	'featherless-ai',
	'fireworks-ai',
	'groq',
	'hf-inference',
	'novita',
	'nscale',
	'ovhcloud',
	'publicai',
	'replicate',
	'scaleway',
	'together',
	'wavespeed',
	'zai-org',
] as const;
export const LOCAL_APPS = [
	'llama.cpp',
	'lmstudio',
	'jan',
	'drawthings',
	'diffusionbee',
	'joyfusion',
	'vllm',
	'ollama',
	'mlx-lm',
	'docker-model-runner',
	'lemonade',
	'sglang',
	'unsloth',
	'pi',
	'hermes-agent',
	'atomic-chat',
	'openclaw',
] as const;
export const SPACE_CATEGORIES = [
	'image-generation',
	'video-generation',
	'text-generation',
	'language-translation',
	'speech-synthesis',
	'voice-cloning',
	'face-recognition',
	'object-detection',
	'pose-estimation',
	'text-analysis',
	'sentiment-analysis',
	'question-answering',
	'code-generation',
	'data-visualization',
	'3d-modeling',
	'image-editing',
	'background-removal',
	'image-upscaling',
	'ocr',
	'document-analysis',
	'visual-qa',
	'image-captioning',
	'chatbots',
	'text-summarization',
	'music-generation',
	'medical-imaging',
	'financial-analysis',
	'game-ai',
	'model-benchmarking',
	'fine-tuning-tools',
	'dataset-creation',
	'anomaly-detection',
	'recommendation-systems',
	'character-animation',
	'style-transfer',
	'agent-environment',
	'image',
	'other',
] as const;
/**
 * Closed vocabularies stay enums in tools/list (their values double as search vocabulary for
 * tool-search clients); input is matched case-insensitively first.
 */
function vocabulary(values: readonly [string, ...string[]]) {
	const byLower = new Map(values.map((value) => [value.toLowerCase(), value]));
	return (value: unknown) => (typeof value === 'string' ? (byLower.get(value.trim().toLowerCase()) ?? value) : value);
}
function oneOf(values: readonly [string, ...string[]]) {
	return z.preprocess(vocabulary(values), z.enum(values));
}
function anyOf(values: readonly [string, ...string[]]) {
	const normalize = vocabulary(values);
	return z.preprocess((value) => (Array.isArray(value) ? value.map(normalize) : value), list(z.enum(values)));
}
export const relationSchema = z.enum(['base', 'adapter', 'merge', 'quantized', 'finetune']);
const limit = z.number().int().min(1).max(100).default(20).describe('Maximum items to return (default 20, max 100).');
const commonFields = [
	'author',
	'createdAt',
	'lastModified',
	'likes',
	'private',
	'disabled',
	'sha',
	'tags',
	'trendingScore',
] as const;
export const modelFields = [
	...commonFields,
	'downloads',
	'downloadsAllTime',
	'gated',
	'pipeline_tag',
	'library_name',
	'safetensors',
	'baseModels',
	'inferenceProviderMapping',
	'spaces',
	'config',
	'transformersInfo',
] as const;
export const datasetFields = [
	...commonFields,
	'downloads',
	'downloadsAllTime',
	'gated',
	'mainSize',
	'description',
	'citation',
	'paperswithcode_id',
] as const;
export const spaceFields = [
	...commonFields,
	'sdk',
	'runtime',
	'models',
	'datasets',
	'region',
	'subdomain',
	'cardData',
] as const;
export const defaultModelFields = [
	'author',
	'createdAt',
	'lastModified',
	'likes',
	'downloads',
	'gated',
	'pipeline_tag',
	'library_name',
] as const;
export const defaultDatasetFields = [
	'author',
	'createdAt',
	'lastModified',
	'likes',
	'downloads',
	'gated',
	'mainSize',
] as const;
export const defaultSpaceFields = [
	'cardData',
	'author',
	'createdAt',
	'lastModified',
	'likes',
	'sdk',
	'runtime',
	'models',
	'datasets',
] as const;
const fieldDescription = 'Fields to return instead of the defaults; kind/id/uri/url are always included.';
const common = {
	query: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.optional()
		.describe('Name/prefix search (not semantic or README text). Omit to browse.'),
	authors_any: list(personRefSchema())
		.optional()
		.describe('OR of owners: user/org names or profile uris (items[].author).'),
	ids_any: list(repoIdInputSchema).optional().describe('OR of exact repository IDs (items[].id).'),
	arxiv_ids: list(arxivIdInputSchema).optional().describe('OR of paper arXiv IDs (or hf://papers/ID uris).'),
	tags_all: list(atom)
		.optional()
		.describe('AND of exact stored tags (no commas or spaces; dataset tags are namespaced).'),
	tags_any_groups: list(list(scopedAtom))
		.optional()
		.describe('AND of OR groups of tags; values without slash, space, plus or comma.'),
	direction: z
		.enum(['asc', 'desc'])
		.default('desc')
		.describe('asc only for id, createdAt, num_parameters, rows or bytes.'),
	limit,
	cursor: z
		.string()
		.min(1)
		.max(16384)
		.optional()
		.describe('next_cursor from a previous call; keep all other arguments unchanged.'),
};
const commonSorts = ['trendingScore', 'likes', 'likes30d', 'lastModified', 'createdAt', 'id'] as const;
function checkSort(input: { sort: string; direction: string }, ctx: z.RefinementCtx): void {
	if (input.direction === 'asc' && !['createdAt', 'id', 'num_parameters', 'rows', 'bytes'].includes(input.sort)) {
		ctx.addIssue({ code: 'custom', path: ['direction'], message: 'This sort supports descending order only.' });
	}
}
const parameters = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const creation = z
	.object({ gt: date.optional(), gte: date.optional(), lt: date.optional(), lte: date.optional() })
	.strict()
	.superRefine((v, ctx) => {
		const lower = v.gt ?? v.gte;
		const upper = v.lt ?? v.lte;
		if (
			(!lower && !upper) ||
			(v.gt && v.gte) ||
			(v.lt && v.lte) ||
			(lower && upper && Date.parse(lower) >= Date.parse(upper))
		) {
			ctx.addIssue({ code: 'custom', message: 'Supply nonconflicting creation bounds with lower < upper.' });
		}
	})
	.describe('Creation date bounds (ISO date or datetime).');
export const modelsInputSchema = z
	.object({
		...common,
		sort: z.enum([...commonSorts, 'downloads', 'num_parameters']).default('trendingScore'),
		fields: z.array(z.enum(modelFields)).max(50).optional().describe(fieldDescription),
		task: atom.optional().describe('Single pipeline tag, e.g. text-generation.'),
		libraries: facets.describe('AND of bare model library tags, e.g. transformers or diffusers.'),
		languages: facets.describe('AND of bare model language tags, e.g. en.'),
		licenses: facets.describe('AND of licenses, e.g. apache-2.0.'),
		gated: z.boolean().optional().describe('True matches auto/manual gating; false matches ungated.'),
		providers_any: anyOf(INFERENCE_PROVIDERS)
			.optional()
			.describe('OR of inference providers, e.g. groq; not with any_provider/inference.'),
		any_provider: z.literal(true).optional().describe('Require any live provider; inference_provider=all.'),
		inference: z
			.enum(['warm', 'cold', 'frozen'])
			.optional()
			.describe('warm: any live provider; cold/frozen: no provider.'),
		parameters_min: parameters.optional(),
		parameters_max: parameters.optional(),
		parameters_exact: list(parameters).optional().describe('OR of exact parameter counts (numbers, not "7B" strings).'),
		created_at: creation.optional(),
		base_model_relations: list(relationSchema).optional().describe('OR of lineage relations (base is a heuristic).'),
		base_models_all: list(repoIdInputSchema).optional().describe('AND of base_model:ID tags. Reuse model items[].id.'),
		base_model_relation: z
			.enum(['adapter', 'merge', 'quantized', 'finetune'])
			.optional()
			.describe('Relation for base_models_all, e.g. quantized.'),
		datasets_any: list(repoIdInputSchema).optional().describe('OR of linked training dataset IDs.'),
		apps_any: anyOf(LOCAL_APPS).optional().describe('OR of supported local apps, e.g. llama.cpp, ollama or vllm.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if ([v.providers_any, v.any_provider, v.inference].filter((x) => x !== undefined).length > 1)
			ctx.addIssue({ code: 'custom', message: 'Choose only one provider/inference selector.' });
		if (v.parameters_min !== undefined && v.parameters_max !== undefined && v.parameters_min > v.parameters_max)
			ctx.addIssue({ code: 'custom', message: 'parameters_min must not exceed parameters_max.' });
		if (v.base_model_relation && !v.base_models_all)
			ctx.addIssue({ code: 'custom', message: 'base_model_relation requires base_models_all.' });
	});
export const datasetsInputSchema = z
	.object({
		...common,
		sort: z
			.enum([...commonSorts, 'downloads', 'rows', 'bytes'])
			.default('trendingScore')
			.describe('Sort key; rows returns the first page only (no cursor).'),
		fields: z.array(z.enum(datasetFields)).max(50).optional().describe(fieldDescription),
		gated: z.boolean().optional(),
		task_categories: facets.describe('AND of task categories, e.g. text-classification.'),
		size_categories: facets.describe('AND of size buckets, e.g. 1K<n<10K.'),
		modalities: facets.describe('AND of modality values, e.g. text or image; compiled as modality:VALUE.'),
		formats: facets.describe('AND of format values, e.g. parquet; compiled as format:VALUE.'),
		libraries: facets.describe('AND of dataset libraries, e.g. pandas.'),
		languages: facets.describe('AND of language codes, e.g. en.'),
		licenses: facets.describe('AND of licenses, e.g. apache-2.0.'),
		dataset_type: z
			.enum(['benchmark', 'agent-traces', 'rl-environment'])
			.optional()
			.describe('Only official benchmarks, agent traces or RL environments.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if (v.sort === 'rows' && v.cursor) {
			ctx.addIssue({
				code: 'custom',
				path: ['cursor'],
				message:
					'Row-sort pagination is unavailable because upstream cursors skip datasets. Omit cursor for a bounded first page or choose another sort.',
			});
		}
	});
export const spacesListInputSchema = z
	.object({
		...common,
		sort: z.enum(commonSorts).default('trendingScore'),
		fields: z.array(z.enum(spaceFields)).max(50).optional().describe(fieldDescription),
		sdks: list(sdkSchema).optional().describe('OR of SDKs; streamlit is deprecated.'),
		stages_any: anyOf(SPACE_STAGES).optional().describe('OR of runtime stages, e.g. RUNNING, SLEEPING or BUILD_ERROR.'),
		running_only: z.boolean().optional().describe('Only running Spaces; not with stages_any.'),
		hardware_current_any: list(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[\w-]+$/)
		)
			.optional()
			.describe('OR of concrete public Space hardware flavors, not cpu/gpu/zerogpu categories.'),
		hardware_requested_any: list(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[\w-]+$/)
		)
			.optional()
			.describe('OR of requested hardware flavors, e.g. zero-a10g (may differ from current).'),
		models_any: list(repoIdInputSchema).optional().describe('OR of linked model IDs from hf_models_search items[].id.'),
		datasets_any: list(repoIdInputSchema)
			.optional()
			.describe('OR of linked dataset IDs from hf_datasets_search items[].id.'),
		mcp_only: z
			.boolean()
			.default(false)
			.describe('Require the stored mcp-server tag; this is not a live MCP health check.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if (v.running_only && v.stages_any)
			ctx.addIssue({ code: 'custom', message: 'running_only and stages_any cannot be combined.' });
	});
export const spacesSearchInputSchema = z
	.object({
		query: z
			.string()
			.trim()
			.min(1)
			.max(250)
			.optional()
			.describe('What the Space should do, in plain words (semantic search).'),
		category: oneOf(SPACE_CATEGORIES)
			.optional()
			.describe('Space category slug, e.g. image-generation, chatbots or ocr.'),
		sdks: list(sdkSchema).optional().describe('OR of SDKs; sent as repeated sdk parameters, never CSV.'),
		tags_any: list(atom).optional().describe('OR of tags, ANDed with the other filters.'),
		include_non_running: z.boolean().default(false).describe('Also return Spaces that are not running.'),
		mcp_only: z.boolean().default(false).describe('Only Spaces tagged mcp-server (not a health check).'),
		limit,
		source: z
			.enum(['hub', 'curated'])
			.default('hub')
			.describe("hub: Hub search; curated: this server's curated Space list, if configured."),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.source === 'curated') {
			if (v.sdks || v.tags_any || v.mcp_only)
				ctx.addIssue({ code: 'custom', message: 'sdks, tags_any and mcp_only are not supported with source curated.' });
			return;
		}
		if (!v.query && !v.category) ctx.addIssue({ code: 'custom', message: 'query or category is required.' });
	});

export type ModelsInput = z.infer<typeof modelsInputSchema>;
export type DatasetsInput = z.infer<typeof datasetsInputSchema>;
export type SpacesListInput = z.infer<typeof spacesListInputSchema>;
export type SpacesSearchInput = z.infer<typeof spacesSearchInputSchema>;
