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
const repoIdInputSchema = z.preprocess(
	(value) => (typeof value === 'string' ? value.trim().replace(REPO_URI_PREFIX, '') : value),
	repoIdSchema
);
/**
 * Anchored paper reference: bare ID[vN], arxiv:ID, hf://papers/ID, huggingface.co/papers/ID or
 * arxiv.org/abs|pdf/ID. The version is dropped: the Hub stores and filters unversioned IDs.
 */
export const PAPER_REF =
	/^(?:hf:\/\/papers\/|arxiv:|https?:\/\/(?:www\.)?(?:(?:huggingface|hf)\.co\/papers|arxiv\.org\/(?:abs|pdf))\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i;
/** arXiv ID selector: also accepts hf://papers/ID or a paper page URL. */
const arxivIdInputSchema = z.preprocess(
	(value) => (typeof value === 'string' ? (PAPER_REF.exec(value.trim())?.[1] ?? value) : value),
	z
		.string()
		.regex(/^\d{4}\.\d{4,5}$/)
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
	.describe('AND of literal facet values; use tagsAnyGroups for representable OR groups.');
const sdkSchema = z.enum(['gradio', 'docker', 'static', 'streamlit']);
const SPACE_STAGES = [
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
const INFERENCE_PROVIDERS = [
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
const LOCAL_APPS = [
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
const SPACE_CATEGORIES = [
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
const relationSchema = z.enum(['base', 'adapter', 'merge', 'quantized', 'finetune']);
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
const modelFields = [
	...commonFields,
	'downloads',
	'downloadsAllTime',
	'gated',
	'pipelineTag',
	'libraryName',
	'safetensors',
	'baseModels',
	'inferenceProviders',
	'spaces',
	'datasets',
	'config',
	'transformersInfo',
] as const;
const datasetFields = [
	...commonFields,
	'downloads',
	'downloadsAllTime',
	'gated',
	'mainSize',
	'description',
	'citation',
	'paperswithcodeId',
] as const;
const spaceFields = [
	...commonFields,
	'sdk',
	'runtime',
	'models',
	'datasets',
	'region',
	'subdomain',
	'title',
	'emoji',
	'shortDescription',
] as const;
export const defaultModelFields = [
	'author',
	'createdAt',
	'lastModified',
	'likes',
	'downloads',
	'gated',
	'pipelineTag',
	'libraryName',
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
	'title',
	'emoji',
	'shortDescription',
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
	authorsAny: list(personRefSchema())
		.optional()
		.describe('OR of owners: user/org names or profile uris (items[].author).'),
	idsAny: list(repoIdInputSchema).optional().describe('OR of exact repository IDs (items[].id).'),
	papersAny: list(arxivIdInputSchema).optional().describe('OR of paper arXiv IDs (or hf://papers/ID uris).'),
	tagsAll: list(atom)
		.optional()
		.describe('AND of exact stored tags (no commas or spaces; dataset tags are namespaced).'),
	tagsAnyGroups: list(list(scopedAtom))
		.optional()
		.describe('AND of OR groups of tags; values without slash, space, plus or comma.'),
	direction: z
		.enum(['asc', 'desc'])
		.default('desc')
		.describe('asc only for id, createdAt, numParameters, numRows or mainSize.'),
	limit,
	cursor: z
		.string()
		.min(1)
		.max(16384)
		.optional()
		.describe('nextCursor from a previous call (same args); full scans take 100s of pages.'),
};
const commonSorts = ['trendingScore', 'likes', 'likes30d', 'lastModified', 'createdAt', 'id'] as const;
function checkSort(input: { sort: string; direction: string }, ctx: z.RefinementCtx): void {
	if (input.direction === 'asc' && !['createdAt', 'id', 'numParameters', 'numRows', 'mainSize'].includes(input.sort)) {
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
		sort: z.enum([...commonSorts, 'downloads', 'numParameters']).default('trendingScore'),
		fields: z.array(z.enum(modelFields)).max(50).optional().describe(fieldDescription),
		task: atom.optional().describe('Single pipeline tag, e.g. text-generation.'),
		librariesAll: facets.describe('AND of bare model library tags, e.g. transformers or diffusers.'),
		languagesAll: facets.describe('AND of bare model language tags, e.g. en.'),
		licensesAll: facets.describe('AND of licenses, e.g. apache-2.0.'),
		gated: z.boolean().optional().describe('True matches auto/manual gating; false matches ungated.'),
		providersAny: anyOf(INFERENCE_PROVIDERS)
			.optional()
			.describe('OR of inference providers, e.g. groq; not with anyProvider/inference.'),
		anyProvider: z.literal(true).optional().describe('Require any live provider; inference_provider=all.'),
		inference: z
			.enum(['warm', 'cold', 'frozen'])
			.optional()
			.describe('warm: any live provider; cold/frozen: no provider.'),
		numParametersMin: parameters.optional(),
		numParametersMax: parameters.optional(),
		numParametersAny: list(parameters).optional().describe('OR of exact parameter counts (numbers, not "7B" strings).'),
		createdAt: creation.optional(),
		baseModelRelationsAny: list(relationSchema).optional().describe('OR of lineage relations (base is a heuristic).'),
		baseModelsAll: list(repoIdInputSchema).optional().describe('AND of base_model:ID tags. Reuse model items[].id.'),
		baseModelRelation: z
			.enum(['adapter', 'merge', 'quantized', 'finetune'])
			.optional()
			.describe('Relation for baseModelsAll, e.g. quantized.'),
		datasetsAny: list(repoIdInputSchema).optional().describe('OR of linked training dataset IDs.'),
		appsAny: anyOf(LOCAL_APPS).optional().describe('OR of supported local apps, e.g. llama.cpp, ollama or vllm.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if ([v.providersAny, v.anyProvider, v.inference].filter((x) => x !== undefined).length > 1)
			ctx.addIssue({ code: 'custom', message: 'Choose only one provider/inference selector.' });
		if (v.numParametersMin !== undefined && v.numParametersMax !== undefined && v.numParametersMin > v.numParametersMax)
			ctx.addIssue({ code: 'custom', message: 'numParametersMin must not exceed numParametersMax.' });
		if (v.baseModelRelation && !v.baseModelsAll)
			ctx.addIssue({ code: 'custom', message: 'baseModelRelation requires baseModelsAll.' });
	});
export const datasetsInputSchema = z
	.object({
		...common,
		sort: z
			.enum([...commonSorts, 'downloads', 'numRows', 'mainSize'])
			.default('trendingScore')
			.describe('Sort key; numRows returns the first page only (no cursor).'),
		fields: z.array(z.enum(datasetFields)).max(50).optional().describe(fieldDescription),
		gated: z.boolean().optional(),
		taskCategoriesAll: facets.describe('AND of task categories, e.g. text-classification.'),
		sizeCategoriesAll: facets.describe('AND of size buckets, e.g. 1K<n<10K.'),
		modalitiesAll: facets.describe('AND of modality values, e.g. text or image; compiled as modality:VALUE.'),
		formatsAll: facets.describe('AND of format values, e.g. parquet; compiled as format:VALUE.'),
		librariesAll: facets.describe('AND of dataset libraries, e.g. pandas.'),
		languagesAll: facets.describe('AND of language codes, e.g. en.'),
		licensesAll: facets.describe('AND of licenses, e.g. apache-2.0.'),
		datasetType: z
			.enum(['benchmark', 'agent-traces', 'rl-environment'])
			.optional()
			.describe('Only official benchmarks, agent traces or RL environments.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if (v.sort === 'numRows' && v.cursor) {
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
		sdksAny: list(sdkSchema).optional().describe('OR of SDKs; streamlit is deprecated.'),
		stagesAny: anyOf(SPACE_STAGES).optional().describe('OR of runtime stages, e.g. RUNNING, SLEEPING or BUILD_ERROR.'),
		runningOnly: z.boolean().optional().describe('Only running Spaces; not with stagesAny.'),
		hardwareCurrentAny: list(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[\w-]+$/)
		)
			.optional()
			.describe('OR of concrete public Space hardware flavors, not cpu/gpu/zerogpu categories.'),
		hardwareRequestedAny: list(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[\w-]+$/)
		)
			.optional()
			.describe('OR of requested hardware flavors, e.g. zero-a10g (may differ from current).'),
		modelsAny: list(repoIdInputSchema).optional().describe('OR of linked model IDs from hf_models_search items[].id.'),
		datasetsAny: list(repoIdInputSchema)
			.optional()
			.describe('OR of linked dataset IDs from hf_datasets_search items[].id.'),
		mcpOnly: z
			.boolean()
			.default(false)
			.describe('Require the stored mcp-server tag; this is not a live MCP health check.'),
	})
	.strict()
	.superRefine((v, ctx) => {
		checkSort(v, ctx);
		if (v.runningOnly && v.stagesAny)
			ctx.addIssue({ code: 'custom', message: 'runningOnly and stagesAny cannot be combined.' });
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
		sdksAny: list(sdkSchema).optional().describe('OR of SDKs; sent as repeated sdk parameters, never CSV.'),
		tagsAny: list(atom).optional().describe('OR of tags, ANDed with the other filters.'),
		includeNonRunning: z.boolean().default(false).describe('Also return Spaces that are not running.'),
		mcpOnly: z.boolean().default(false).describe('Only Spaces tagged mcp-server (not a health check).'),
		limit,
		source: z
			.enum(['hub', 'curated'])
			.default('hub')
			.describe("hub: Hub search; curated: this server's curated Space list, if configured."),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.source === 'curated') {
			if (v.sdksAny || v.tagsAny || v.mcpOnly)
				ctx.addIssue({
					code: 'custom',
					message: 'sdksAny, tagsAny and mcpOnly are not supported with source curated.',
				});
			return;
		}
		if (!v.query && !v.category) ctx.addIssue({ code: 'custom', message: 'query or category is required.' });
	});

export type ModelsInput = z.infer<typeof modelsInputSchema>;
export type DatasetsInput = z.infer<typeof datasetsInputSchema>;
export type SpacesListInput = z.infer<typeof spacesListInputSchema>;
export type SpacesSearchInput = z.infer<typeof spacesSearchInputSchema>;
