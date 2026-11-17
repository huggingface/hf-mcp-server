import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { repoIdSchema } from './schemas.js';

export type RepoKind = 'model' | 'dataset' | 'space';
const text = z.string().max(100000);
const shortText = z.string().max(2048);
const count = z
	.number()
	.nonnegative()
	.multipleOf(1)
	.describe(
		'Nonnegative integer as returned by upstream JSON; values above Number.MAX_SAFE_INTEGER may be approximate.'
	);
const strings = z.array(shortText).max(5000);
const timestamp = z.string().max(64).describe('Upstream timestamp, normally ISO 8601; not fabricated when absent.');
const gated = z.union([z.boolean(), z.enum(['auto', 'manual'])]);
function referenceFields(kind: RepoKind) {
	const idPattern = String.raw`[\w.-]+(?:/[\w.-]+)?`;
	return {
		id: repoIdSchema,
		uri: z
			.string()
			.regex(new RegExp(`^hf://${kind}s/${idPattern}$`))
			.describe(`Canonical hf://${kind}s/ID; usable by Hub filesystem/inspection tools.`),
		url: z
			.url()
			.regex(new RegExp(`^https://huggingface\\.co/${kind === 'model' ? '' : `${kind}s/`}${idPattern}$`))
			.describe('Canonical Hugging Face repository page, not an execution endpoint.'),
	};
}
export const modelReferenceSchema = z.object({ kind: z.literal('model'), ...referenceFields('model') }).strict();
export const datasetReferenceSchema = z.object({ kind: z.literal('dataset'), ...referenceFields('dataset') }).strict();
export const spaceReferenceSchema = z.object({ kind: z.literal('space'), ...referenceFields('space') }).strict();
export type RepoReference =
	z.infer<typeof modelReferenceSchema> | z.infer<typeof datasetReferenceSchema> | z.infer<typeof spaceReferenceSchema>;
export function reference(kind: RepoKind, id: string): RepoReference {
	const path = id.split('/').map(encodeURIComponent).join('/');
	return {
		kind,
		id,
		uri: `hf://${kind}s/${path}`,
		url: `https://huggingface.co/${kind === 'model' ? '' : `${kind}s/`}${path}`,
	};
}
const hardware = z.object({ current: shortText.nullable().optional(), requested: shortText.nullable().optional() });
const runtime = z.object({
	stage: shortText.optional().describe('Upstream stage; open string for future stages, not evidence of MCP health.'),
	hardware: hardware.optional(),
	replicas: z
		.object({
			current: count.nullable().optional(),
			requested: z
				.union([count, z.literal('auto')])
				.nullable()
				.optional(),
		})
		.optional(),
	gcTimeout: z.number().nonnegative().nullable().optional(),
});
const safeTensors = z.object({
	total: count.optional().describe('Total safetensors parameters, not bytes.'),
	parameters: z
		.record(z.string().max(64), count)
		.optional()
		.describe('Parameter counts by dtype; dtype keys are an open vocabulary.'),
});
const config = z.object({
	model_type: shortText.optional(),
	architectures: z.array(shortText).max(100).optional(),
	is_encoder_decoder: z.boolean().optional(),
	tokenizer_config: z.object({ tokenizer_class: shortText.optional() }).optional(),
});
const transformersWire = z.object({
	auto_model: shortText.optional(),
	pipeline_tag: shortText.optional(),
	processor: shortText.optional(),
});
export const transformersInfoSchema = z.object({
	autoModel: shortText.optional(),
	pipelineTag: shortText.optional(),
	processor: shortText.optional(),
});
const provider = z.object({
	provider: shortText,
	providerId: shortText.optional(),
	status: shortText.optional(),
	task: shortText.optional(),
	type: shortText.optional(),
	isModelAuthor: z.boolean().optional(),
});
const sharedOutput = {
	author: shortText.optional().describe('Owner namespace when projected; reusable in authorsAny.'),
	createdAt: timestamp.optional(),
	lastModified: timestamp.optional(),
	likes: count.optional(),
	private: z.boolean().optional(),
	disabled: z.boolean().optional(),
	sha: shortText.optional(),
	tags: strings
		.optional()
		.describe(
			'Exact stored IDs reusable in tagsAll/tagsAny; scoped OR has stricter grammar. Absence means not supplied, not no tags.'
		),
	trendingScore: z.number().optional(),
};
export const modelRecordSchema = modelReferenceSchema.extend({
	...sharedOutput,
	downloads: count.optional(),
	downloadsAllTime: count.optional(),
	gated: gated.optional(),
	pipelineTag: shortText.optional().describe('Reusable as hf_models_search.task.'),
	libraryName: shortText.optional().describe('Reusable as a model librariesAll value.'),
	numParameters: count
		.optional()
		.describe('Only if supplied (e.g. parameter sort). Reusable in numeric parameter filters; not an expansion.'),
	safetensors: safeTensors.optional(),
	config: config.optional(),
	transformersInfo: transformersInfoSchema.optional(),
	inferenceProviders: z
		.array(provider)
		.max(100)
		.optional()
		.describe('Provider mappings; provider IDs can be used in providersAny if supported by its allowlist.'),
	baseModels: z
		.array(modelReferenceSchema)
		.max(5000)
		.optional()
		.describe('Typed lineage references; ids feed baseModelsAll or model idsAny.'),
	baseModelRelation: shortText.optional().describe('Relation to baseModels, e.g. quantized.'),
	spaces: z.array(spaceReferenceSchema).max(5000).optional().describe('Related Space IDs feed hf_spaces_list.idsAny.'),
	datasets: z
		.array(datasetReferenceSchema)
		.max(5000)
		.optional()
		.describe(
			'Derived only from dataset:ID tags; not a complete training-data inventory. IDs feed dataset idsAny or datasetsAny.'
		),
});
export const datasetRecordSchema = datasetReferenceSchema.extend({
	...sharedOutput,
	downloads: count.optional(),
	downloadsAllTime: count.optional(),
	gated: gated.optional(),
	numRows: count
		.optional()
		.describe('Dataset Viewer row count when supplied; generally only under numRows sort, not a selectable field.'),
	mainSize: count.optional().describe('Repository main-branch bytes; not row count or downloaded size.'),
	description: text.optional(),
	citation: text.optional(),
	paperswithcodeId: shortText.optional(),
});
export const spaceRecordSchema = spaceReferenceSchema.extend({
	...sharedOutput,
	sdk: shortText.optional().describe('Reusable in sdksAny if a supported SDK.'),
	runtime: runtime
		.optional()
		.describe('Reviewed stage/hardware/replicas/timeout only. No abuse/admin fields or arbitrary runtime payload.'),
	models: z
		.array(modelReferenceSchema)
		.max(5000)
		.optional()
		.describe('Linked models; IDs feed model idsAny or Space modelsAny.'),
	datasets: z
		.array(datasetReferenceSchema)
		.max(5000)
		.optional()
		.describe('Linked datasets; IDs feed dataset idsAny or Space datasetsAny.'),
	region: shortText.optional(),
	subdomain: shortText.optional(),
	title: shortText.optional(),
	emoji: shortText.optional(),
	shortDescription: text.optional(),
	aiShortDescription: text.optional(),
	category: shortText
		.optional()
		.describe('Upstream AI category label; may be human-readable, not necessarily an input category slug.'),
	semanticScore: z
		.number()
		.optional()
		.describe(
			'Upstream semanticRelevancyScore, not a calibrated probability. Order is preserved; no client reranking.'
		),
});
const responseFields = {
	nextCursor: z
		.string()
		.min(1)
		.max(16384)
		.nullable()
		.describe(
			'Opaque query-bound continuation for listings. Null means no usable continuation; inspect completeness for blocked pagination. Semantic search is always unpaginated. Never treat this as a URL.'
		),
	returnedCount: z.number().int().min(0).max(100).describe('Exactly items.length, not a total match count.'),
	completeness: completenessSchema(),
};
const listingFields = {
	...responseFields,
	completeness: completenessSchema({
		unknownOwners: z
			.array(z.string())
			.optional()
			.describe('authorsAny names that are no Hugging Face user or organization (check spelling).'),
	}),
};
interface ListingResult {
	items: unknown[];
	returnedCount: number;
	nextCursor: string | null;
	completeness: { hasMore: boolean; reason?: string };
}
function checkListing(v: ListingResult, ctx: z.RefinementCtx): void {
	if (
		v.returnedCount !== v.items.length ||
		(v.nextCursor !== null && !v.completeness.hasMore) ||
		(v.nextCursor === null && v.completeness.hasMore && !v.completeness.reason)
	) {
		ctx.addIssue({ code: 'custom', message: 'Count and continuation metadata must agree with this page.' });
	}
}
export const modelsOutputSchema = z
	.object({
		...listingFields,
		items: z.array(modelRecordSchema).max(100),
	})
	.strict()
	.superRefine(checkListing);
export const datasetsOutputSchema = z
	.object({
		...listingFields,
		items: z.array(datasetRecordSchema).max(100),
	})
	.strict()
	.superRefine(checkListing);
export const spacesListOutputSchema = z
	.object({
		...listingFields,
		items: z.array(spaceRecordSchema).max(100),
	})
	.strict()
	.superRefine(checkListing);
export const spacesSearchOutputSchema = z
	.object({
		...responseFields,
		nextCursor: z.null().describe('Semantic candidates and the curated catalog have no continuation or refill.'),
		items: z.array(spaceRecordSchema).max(100),
		candidateCount: z
			.number()
			.int()
			.min(0)
			.max(1000)
			.describe(
				'Observed candidates in this response (semantic backend cap: 120; or curated catalog entries), not global matches.'
			),
		eligibleCount: z
			.number()
			.int()
			.min(0)
			.max(1000)
			.describe(
				'Candidates left after local tag/SDK/runtime/MCP (or curated query/category) checks, before limit; above returnedCount means the limit dropped some.'
			),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.returnedCount !== v.items.length || v.returnedCount > v.eligibleCount || v.eligibleCount > v.candidateCount) {
			ctx.addIssue({ code: 'custom', message: 'Observed candidate, eligible and returned counts must agree.' });
		}
	});

export type PtcModelRecord = z.infer<typeof modelRecordSchema>;
export type PtcDatasetRecord = z.infer<typeof datasetRecordSchema>;
export type PtcSpaceRecord = z.infer<typeof spaceRecordSchema>;
export type PtcModelsSearchResult = z.infer<typeof modelsOutputSchema>;
export type PtcDatasetsSearchResult = z.infer<typeof datasetsOutputSchema>;
export type PtcSpacesListResult = z.infer<typeof spacesListOutputSchema>;
export type PtcSpacesSearchResult = z.infer<typeof spacesSearchOutputSchema>;

// Wire schemas strip unknown fields, including privileged runtime data. Known
// fields are checked rather than turning malformed responses into empty success.
// Null optional metadata is treated as absent, not asserted to have a value.
const maybe = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
const sharedWire = {
	id: repoIdSchema,
	author: maybe(shortText),
	createdAt: maybe(timestamp),
	lastModified: maybe(timestamp),
	likes: maybe(count),
	private: maybe(z.boolean()),
	disabled: maybe(z.boolean()),
	sha: maybe(shortText),
	tags: maybe(strings),
	trendingScore: maybe(z.number()),
};
const modelWire = z.object({
	...sharedWire,
	downloads: maybe(count),
	downloadsAllTime: maybe(count),
	gated: maybe(gated),
	pipeline_tag: maybe(shortText),
	library_name: maybe(shortText),
	num_parameters: maybe(count),
	safetensors: maybe(safeTensors),
	config: maybe(config),
	transformersInfo: maybe(transformersWire),
	inferenceProviderMapping: maybe(z.array(provider).max(100)),
	baseModels: maybe(z.object({ relation: shortText, models: z.array(z.object({ id: repoIdSchema })).max(5000) })),
	spaces: maybe(z.array(repoIdSchema).max(5000)),
});
const datasetWire = z.object({
	...sharedWire,
	downloads: maybe(count),
	downloadsAllTime: maybe(count),
	gated: maybe(gated),
	mainSize: maybe(count),
	datasetsServerInfo: maybe(z.object({ numRows: maybe(count) })),
	description: maybe(text),
	citation: maybe(text),
	paperswithcode_id: maybe(shortText),
});
const spaceWire = z.object({
	...sharedWire,
	sdk: maybe(shortText),
	runtime: maybe(runtime),
	models: maybe(z.array(repoIdSchema).max(5000)),
	datasets: maybe(z.array(repoIdSchema).max(5000)),
	region: maybe(shortText),
	subdomain: maybe(shortText),
	cardData: maybe(z.object({ title: maybe(shortText), emoji: maybe(shortText), short_description: maybe(text) })),
	title: maybe(shortText),
	emoji: maybe(shortText),
	shortDescription: maybe(text),
	ai_short_description: maybe(text),
	ai_category: maybe(shortText),
	semanticRelevancyScore: maybe(z.number()),
});
const _commonWireSchema = z.object(sharedWire);
function common(v: z.infer<typeof _commonWireSchema>) {
	return {
		author: v.author,
		createdAt: v.createdAt,
		lastModified: v.lastModified,
		likes: v.likes,
		private: v.private,
		disabled: v.disabled,
		sha: v.sha,
		tags: v.tags,
		trendingScore: v.trendingScore,
	};
}
/** Hub transformersInfo (snake keys) -> the camelCase record shape. */
export function transformersInfoOf(
	value: z.infer<typeof transformersWire> | undefined
): z.infer<typeof transformersInfoSchema> | undefined {
	return value && { autoModel: value.auto_model, pipelineTag: value.pipeline_tag, processor: value.processor };
}
export function normalizeModel(value: unknown): z.infer<typeof modelRecordSchema> {
	const v = modelWire.parse(value);
	return modelRecordSchema.parse({
		...reference('model', v.id),
		...common(v),
		downloads: v.downloads,
		downloadsAllTime: v.downloadsAllTime,
		gated: v.gated,
		pipelineTag: v.pipeline_tag,
		libraryName: v.library_name,
		numParameters: v.num_parameters,
		safetensors: v.safetensors,
		config: v.config,
		transformersInfo: transformersInfoOf(v.transformersInfo),
		inferenceProviders: v.inferenceProviderMapping,
		baseModels: v.baseModels?.models.map((m) => reference('model', m.id)),
		baseModelRelation: v.baseModels?.relation,
		spaces: v.spaces?.map((id) => reference('space', id)),
		datasets: v.tags
			?.filter((tag) => tag.startsWith('dataset:'))
			.map((tag) => repoIdSchema.safeParse(tag.slice('dataset:'.length)))
			.filter((id) => id.success)
			.map((id) => reference('dataset', id.data)),
	});
}
export function normalizeDataset(value: unknown): z.infer<typeof datasetRecordSchema> {
	const v = datasetWire.parse(value);
	return datasetRecordSchema.parse({
		...reference('dataset', v.id),
		...common(v),
		downloads: v.downloads,
		downloadsAllTime: v.downloadsAllTime,
		gated: v.gated,
		numRows: v.datasetsServerInfo?.numRows,
		mainSize: v.mainSize,
		description: v.description,
		citation: v.citation,
		paperswithcodeId: v.paperswithcode_id,
	});
}
export function normalizeSpace(value: unknown): z.infer<typeof spaceRecordSchema> {
	const v = spaceWire.parse(value);
	return spaceRecordSchema.parse({
		...reference('space', v.id),
		...common(v),
		sdk: v.sdk,
		runtime: v.runtime,
		models: v.models?.map((id) => reference('model', id)),
		datasets: v.datasets?.map((id) => reference('dataset', id)),
		region: v.region,
		subdomain: v.subdomain,
		title: v.title ?? v.cardData?.title,
		emoji: v.emoji ?? v.cardData?.emoji,
		shortDescription: v.shortDescription ?? v.cardData?.short_description,
		aiShortDescription: v.ai_short_description,
		category: v.ai_category,
		semanticScore: v.semanticRelevancyScore,
	});
}
