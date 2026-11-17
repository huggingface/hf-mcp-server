import { z } from 'zod';
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
const transformers = z.object({
	auto_model: shortText.optional(),
	pipeline_tag: shortText.optional(),
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
	author: shortText.optional().describe('Owner namespace when projected; reusable in authors_any.'),
	created_at: timestamp.optional(),
	last_modified: timestamp.optional(),
	likes: count.optional(),
	private: z.boolean().optional(),
	disabled: z.boolean().optional(),
	sha: shortText.optional(),
	tags: strings
		.optional()
		.describe(
			'Exact stored IDs reusable in tags_all/tags_any; scoped OR has stricter grammar. Absence means not supplied, not no tags.'
		),
	trending_score: z.number().optional(),
};
export const modelRecordSchema = modelReferenceSchema.extend({
	...sharedOutput,
	downloads: count.optional(),
	downloads_all_time: count.optional(),
	gated: gated.optional(),
	pipeline_tag: shortText.optional().describe('Reusable as hf_models_search.task.'),
	library_name: shortText.optional().describe('Reusable as a model libraries value.'),
	num_parameters: count
		.optional()
		.describe('Only if supplied (e.g. parameter sort). Reusable in numeric parameter filters; not an expansion.'),
	safetensors: safeTensors.optional(),
	config: config.optional(),
	transformers: transformers.optional(),
	inference_providers: z
		.array(provider)
		.max(100)
		.optional()
		.describe(
			'Listing wire format is an array, unlike some detail APIs; provider IDs can be used in providers_any if supported by its allowlist.'
		),
	base_models: z
		.object({ relation: shortText, models: z.array(modelReferenceSchema).max(5000) })
		.strict()
		.optional()
		.describe('Typed lineage references; models[].id feeds base_models_all or model ids_any.'),
	spaces: z.array(spaceReferenceSchema).max(5000).optional().describe('Related Space IDs feed hf_spaces_list.ids_any.'),
	training_datasets: z
		.array(datasetReferenceSchema)
		.max(5000)
		.optional()
		.describe(
			'Derived only from dataset:ID tags; not a complete training-data inventory. IDs feed dataset ids_any or datasets_any.'
		),
});
export const datasetRecordSchema = datasetReferenceSchema.extend({
	...sharedOutput,
	downloads: count.optional(),
	downloads_all_time: count.optional(),
	gated: gated.optional(),
	rows: count
		.optional()
		.describe(
			'datasetsServerInfo.numRows when supplied; generally only available under rows sort, not a selectable expansion.'
		),
	bytes: count.optional().describe('mainSize, repository main-branch bytes; not row count or downloaded size.'),
	description: text.optional(),
	citation: text.optional(),
	paperswithcode_id: shortText.optional(),
});
export const spaceRecordSchema = spaceReferenceSchema.extend({
	...sharedOutput,
	sdk: shortText.optional().describe('Reusable in sdks if a supported SDK.'),
	runtime: runtime
		.optional()
		.describe('Reviewed stage/hardware/replicas/timeout only. No abuse/admin fields or arbitrary runtime payload.'),
	models: z
		.array(modelReferenceSchema)
		.max(5000)
		.optional()
		.describe('Linked models; IDs feed model ids_any or Space models_any.'),
	datasets: z
		.array(datasetReferenceSchema)
		.max(5000)
		.optional()
		.describe('Linked datasets; IDs feed dataset ids_any or Space datasets_any.'),
	region: shortText.optional(),
	subdomain: shortText.optional(),
	title: shortText.optional(),
	emoji: shortText.optional(),
	short_description: text.optional(),
	ai_short_description: text.optional(),
	category: shortText
		.optional()
		.describe('Upstream AI category label; may be human-readable, not necessarily an input category slug.'),
	semantic_score: z
		.number()
		.optional()
		.describe(
			'Upstream semanticRelevancyScore, not a calibrated probability. Order is preserved; no client reranking.'
		),
});
const responseFields = {
	next_cursor: z
		.string()
		.min(1)
		.max(16384)
		.nullable()
		.describe(
			'Opaque query-bound continuation for listings. Null means no usable continuation; inspect completeness for blocked pagination. Semantic search is always unpaginated. Never treat this as a URL.'
		),
	returned_count: z.number().int().min(0).max(100).describe('Exactly items.length, not a total match count.'),
	completeness: z
		.object({
			scope: z.enum(['listing_page', 'semantic_candidates']),
			global_complete: z
				.literal(false)
				.describe(
					'No global completeness/total or snapshot guarantee. Listings can be continued; semantic results cannot be exhausted globally.'
				),
			continuation_available: z.boolean(),
			end_of_listing: z
				.boolean()
				.nullable()
				.describe(
					'True only when a listing has no next Link; null for semantic search. A next Link can lead to an empty page.'
				),
		})
		.strict(),
};
const listingFields = {
	...responseFields,
	completeness: responseFields.completeness.extend({
		scope: z.literal('listing_page'),
		end_of_listing: z.boolean().describe('True means no next Link was supplied; not a total or snapshot guarantee.'),
		unknown_owners: z
			.array(z.string())
			.optional()
			.describe('authors_any names that are no Hugging Face user or organization (check spelling).'),
	}),
};
interface ListingResult {
	items: unknown[];
	returned_count: number;
	next_cursor: string | null;
	completeness: {
		continuation_available: boolean;
		end_of_listing: boolean | null;
		pagination_blocked_reason?: 'upstream_row_sort_cursor';
	};
}
function checkListing(v: ListingResult, ctx: z.RefinementCtx): void {
	if (
		v.returned_count !== v.items.length ||
		v.completeness.continuation_available !== (v.next_cursor !== null) ||
		(v.completeness.pagination_blocked_reason
			? v.next_cursor !== null || v.completeness.end_of_listing !== null
			: v.completeness.end_of_listing !== (v.next_cursor === null))
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
		completeness: listingFields.completeness.extend({
			end_of_listing: z
				.boolean()
				.nullable()
				.describe(
					'Null when upstream row-sort pagination is blocked; never interpret a blocked cursor as the end of matching datasets.'
				),
			pagination_blocked_reason: z
				.literal('upstream_row_sort_cursor')
				.optional()
				.describe(
					'The Hub row-sort cursor can skip matching datasets. Only a bounded first page is safe; narrow filters, increase limit up to 100, or choose another sort.'
				),
		}),
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
		next_cursor: z.null().describe('Semantic candidates and the curated catalog have no continuation or refill.'),
		completeness: responseFields.completeness.extend({
			scope: z.enum(['semantic_candidates', 'curated_catalog']),
			continuation_available: z.literal(false),
			end_of_listing: z.null(),
		}),
		items: z.array(spaceRecordSchema).max(100),
		candidate_count: z
			.number()
			.int()
			.min(0)
			.max(1000)
			.describe(
				'Observed candidates in this response (semantic backend cap: 120; or curated catalog entries), not global matches.'
			),
		eligible_count: z
			.number()
			.int()
			.min(0)
			.max(1000)
			.describe(
				'Candidates left after local tag/SDK/runtime/MCP (or curated query/category) checks, before limit; above returned_count means the limit dropped some.'
			),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (
			v.returned_count !== v.items.length ||
			v.returned_count > v.eligible_count ||
			v.eligible_count > v.candidate_count
		) {
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
	transformersInfo: maybe(transformers),
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
		created_at: v.createdAt,
		last_modified: v.lastModified,
		likes: v.likes,
		private: v.private,
		disabled: v.disabled,
		sha: v.sha,
		tags: v.tags,
		trending_score: v.trendingScore,
	};
}
export function normalizeModel(value: unknown): z.infer<typeof modelRecordSchema> {
	const v = modelWire.parse(value);
	return modelRecordSchema.parse({
		...reference('model', v.id),
		...common(v),
		downloads: v.downloads,
		downloads_all_time: v.downloadsAllTime,
		gated: v.gated,
		pipeline_tag: v.pipeline_tag,
		library_name: v.library_name,
		num_parameters: v.num_parameters,
		safetensors: v.safetensors,
		config: v.config,
		transformers: v.transformersInfo,
		inference_providers: v.inferenceProviderMapping,
		base_models: v.baseModels && {
			relation: v.baseModels.relation,
			models: v.baseModels.models.map((m) => reference('model', m.id)),
		},
		spaces: v.spaces?.map((id) => reference('space', id)),
		training_datasets: v.tags
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
		downloads_all_time: v.downloadsAllTime,
		gated: v.gated,
		rows: v.datasetsServerInfo?.numRows,
		bytes: v.mainSize,
		description: v.description,
		citation: v.citation,
		paperswithcode_id: v.paperswithcode_id,
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
		short_description: v.shortDescription ?? v.cardData?.short_description,
		ai_short_description: v.ai_short_description,
		category: v.ai_category,
		semantic_score: v.semanticRelevancyScore,
	});
}
