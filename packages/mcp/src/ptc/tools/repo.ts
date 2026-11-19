import { z } from 'zod';
import { transformersInfoSchema } from '../listing/records.js';
import { completenessSchema } from '../core/completeness.js';
import picomatch from 'picomatch';
import { definePtcTool, PtcResult, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { PtcError, toPtcError } from '../core/errors.js';
import { hubFetch, openCursor, PtcRepoMovedError, requestPage, sealCursor } from '../core/hub-http.js';
import { fileItem, parseRef, refSchema, REPO_KINDS, repoItem, repoUri, repoUrl, type RepoKind } from '../core/refs.js';
import { assertTextFilePath, decodeTextFileContent, imageMimeTypeForPath } from '../../text-file-policy.js';

// ---------------------------------------------------------------- shared helpers

type Json = Record<string, unknown>;

const rec = (v: unknown): Json | undefined =>
	v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);
const str = (v: unknown, max = 2048): string | undefined => (typeof v === 'string' && v ? clip(v, max) : undefined);
const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
function strList(v: unknown, max = 100): string[] | undefined {
	const values = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
	const out = values.flatMap((x) => (typeof x === 'string' && x ? [clip(x, 256)] : [])).slice(0, max);
	return out.length ? out : undefined;
}
/** Drop undefined values so strict output schemas only see present fields. */
function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const encodeId = (id: string): string => id.split('/').map(encodeURIComponent).join('/');
const encodePath = (path: string): string => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const apiRoot = (kind: RepoKind, id: string): string => `/api/${kind}s/${encodeId(id)}`;
const webPrefix = (kind: RepoKind): string => (kind === 'model' ? '' : `${kind}s/`);
const VALID_ID = /^[\w.-]+(?:\/[\w.-]+)?$/;

function normalizePath(path: string): string {
	const parts = path.split('/').filter(Boolean);
	if (parts.some((p) => p === '.' || p === '..'))
		throw new PtcError('INVALID_ARGUMENT', 'paths must not contain . or ..');
	return parts.join('/');
}
const joinPath = (a: string, b: string): string => normalizePath(`${a}/${b}`);

interface Target {
	kind: RepoKind;
	id: string;
	revision?: string;
	path: string;
}

/** Parse a repository/file Ref. Bare IDs are models (the hf_fs convention); `revision` overrides the ref. */
function target(ref: string, revision?: string): Target {
	// "owner/name/path/to/file" is accepted as a model file (the hf:// shorthand).
	const shorthand = !/^[a-z]+:\/\//i.test(ref) && ref.split('/').filter(Boolean).length > 2;
	const parsed = parseRef(shorthand && !/^(models|datasets|spaces|buckets)\//.test(ref) ? `hf://${ref}` : ref, 'model');
	const kind = parsed.kind ?? 'model';
	const rev = revision ?? parsed.revision;
	if (kind === 'bucket' && rev) throw new PtcError('INVALID_ARGUMENT', 'buckets have no revisions; omit revision.');
	return { kind, id: parsed.id, path: parsed.path, ...(rev ? { revision: rev } : {}) };
}

const rev = (t: Target): string => encodeURIComponent(t.revision ?? 'main');

function resolvePath(t: Target): string {
	if (t.kind === 'bucket') return `/buckets/${encodeId(t.id)}/resolve/${encodePath(t.path)}`;
	return `/${webPrefix(t.kind)}${encodeId(t.id)}/resolve/${rev(t)}/${encodePath(t.path)}`;
}

/** Run `fn` over `values` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array<R>(values.length);
	let next = 0;
	const worker = async () => {
		while (next < values.length) {
			const index = next++;
			results[index] = await fn(values[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
	return results;
}

const itemFields = {
	id: z.string(),
	uri: z.string(),
	url: z.string(),
};
const repoRefSchema = z.object({ kind: z.enum(REPO_KINDS), ...itemFields }).strict();
const count = z.number().int().nonnegative();
type RepoRef = z.infer<typeof repoRefSchema>;
const repoRef = (kind: RepoKind, id: string): RepoRef => ({ ...repoItem(kind, id), kind });

// ---------------------------------------------------------------- file entries

const lastCommitSchema = z
	.object({ id: z.string(), title: z.string().optional(), createdAt: z.string().optional() })
	.strict();

const fileEntrySchema = z
	.object({
		kind: z.enum(['file', 'dir']),
		...itemFields,
		// From the repository or bucket root.
		path: z.string(),
		size: count.optional().describe('Bytes; folders only with includeFolderSize.'),
		lfs: z.boolean().optional(),
		xet: z.boolean().optional(),
		oid: z.string().optional(),
		lastCommit: lastCommitSchema.optional().describe('Only with expand.'),
		uploadedAt: z.string().optional(),
		lastModified: z.string().optional(),
		contentType: z.string().optional(),
	})
	.strict();
type FileEntry = z.infer<typeof fileEntrySchema>;

/** `lfsKnown: false` for sources without LFS info (paths-search): lfs is omitted (unknown), never false. */
function toEntry(t: Target, raw: unknown, lfsKnown = true): FileEntry | undefined {
	const v = rec(raw);
	const path = str(v?.path, 4096);
	if (!v || !path) return undefined;
	const type = v.type === 'directory' ? 'dir' : v.type === 'file' ? 'file' : undefined;
	if (!type) return undefined;
	const lfs = rec(v.lfs);
	const commit = rec(v.lastCommit);
	const commitId = str(commit?.id, 64);
	return compact<FileEntry>({
		...fileItem(t.kind, t.id, path, type, t.revision),
		kind: type,
		path,
		size: type === 'file' ? num(v.size) : undefined,
		lfs: t.kind === 'bucket' || type === 'dir' || (!lfsKnown && !lfs) ? undefined : Boolean(lfs),
		xet: type === 'file' && typeof v.xetHash === 'string' ? true : undefined,
		oid: str(v.oid, 128),
		lastCommit: commitId
			? compact({ id: commitId, title: str(commit?.title, 300), createdAt: str(commit?.date, 64) })
			: undefined,
		uploadedAt: str(v.uploadedAt, 64),
		lastModified: str(v.mtime, 64),
		contentType: str(v.contentType, 256),
	});
}

// ---------------------------------------------------------------- hf_repo_info

const KIND_EXPAND: Record<Exclude<RepoKind, 'bucket'>, string[]> = {
	model: [
		'author',
		'baseModels',
		'cardData',
		'childrenModelCount',
		'config',
		'createdAt',
		'disabled',
		'downloads',
		'downloadsAllTime',
		'gated',
		'gguf',
		'inferenceProviderMapping',
		'lastModified',
		'library_name',
		'likes',
		'pipeline_tag',
		'private',
		'safetensors',
		'sha',
		'spaces',
		'tags',
		'transformersInfo',
		'usedStorage',
	],
	dataset: [
		'author',
		'cardData',
		'citation',
		'createdAt',
		'description',
		'disabled',
		'downloads',
		'downloadsAllTime',
		'gated',
		'lastModified',
		'likes',
		'paperswithcode_id',
		'private',
		'sha',
		'tags',
		'usedStorage',
	],
	space: [
		'author',
		'cardData',
		'createdAt',
		'datasets',
		'disabled',
		'lastModified',
		'likes',
		'models',
		'private',
		'runtime',
		'sdk',
		'sha',
		'subdomain',
		'tags',
		'usedStorage',
	],
};

const LINK_LIMIT = 20;
const refList = z.array(repoRefSchema).max(LINK_LIMIT);

const repoInfoShape = {
	revision: z.string().optional(),
	sha: z.string().optional(),
	author: z.string().optional(),
	private: z.boolean().optional(),
	gated: z.union([z.boolean(), z.string()]).optional().describe('false, auto or manual.'),
	disabled: z.boolean().optional(),
	createdAt: z.string().optional(),
	lastModified: z.string().optional(),
	downloads: count.optional().describe('Last 30 days.'),
	downloadsAllTime: count.optional(),
	likes: count.optional(),
	tags: z.array(z.string()).max(100).optional(),
	pipelineTag: z.string().optional(),
	libraryName: z.string().optional(),
	// From the card metadata.
	license: z.string().optional(),
	languages: z.array(z.string()).max(100).optional(),
	baseModels: refList.optional().describe('First 20.'),
	// adapter, merge, quantized or finetune.
	baseModelRelation: z.string().optional(),
	datasets: refList.optional().describe('Models: declared in the card. Spaces: linked. First 20.'),
	models: refList.optional().describe('Spaces: linked models, first 20.'),
	spaces: refList.optional().describe('Models: Spaces using it, first 20. Only when requested in fields.'),
	numSpaces: count.optional().describe('Only when requested in fields.'),
	numChildModels: count.optional().describe('Fine-tunes, adapters, merges and quantizations.'),
	safetensors: z
		.object({ total: count.optional(), parameters: z.record(z.string(), count).optional() })
		.strict()
		.optional()
		.describe('Parameter counts (not bytes).'),
	gguf: z
		.object({
			total: count.optional().describe('Parameter count.'),
			architecture: z.string().optional(),
			contextLength: count.optional(),
			bosToken: z.string().optional(),
			eosToken: z.string().optional(),
		})
		.strict()
		.optional(),
	chatTemplate: z
		.string()
		.optional()
		.describe('Jinja, from GGUF or tokenizer_config.json. Only when requested in fields.'),
	chatTemplateTruncated: z.boolean().optional(),
	config: z
		.object({
			model_type: z.string().optional(),
			architectures: z.array(z.string()).max(20).optional(),
			vocab_size: count.optional(),
		})
		.strict()
		.optional(),
	transformersInfo: transformersInfoSchema.strict().optional(),
	inferenceProviders: z
		.array(
			z
				.object({
					provider: z.string(),
					providerId: z.string().optional(),
					status: z.string().optional(),
					task: z.string().optional(),
				})
				.strict()
		)
		.max(50)
		.optional(),
	usedStorage: count.optional().describe('Bytes, all revisions.'),
	description: z.string().optional(),
	citation: z.string().optional(),
	paperswithcodeId: z.string().optional(),
	prettyName: z.string().optional(),
	taskCategories: z.array(z.string()).max(50).optional(),
	sizeCategories: z.array(z.string()).max(10).optional(),
	sdk: z.string().optional(),
	title: z.string().optional(),
	emoji: z.string().optional(),
	shortDescription: z.string().optional(),
	subdomain: z.string().optional(),
	runtime: z
		.object({
			// e.g. RUNNING, SLEEPING, BUILDING, RUNTIME_ERROR, PAUSED.
			stage: z.string().optional(),
			// Flavors, e.g. cpu-basic, zero-a10g, a10g-small.
			hardware: z.object({ current: z.string().optional(), requested: z.string().optional() }).strict().optional(),
			// Seconds of inactivity before the Space sleeps.
			gcTimeout: z.number().optional(),
		})
		.strict()
		.optional(),
	size: count.optional().describe('Buckets: total bytes.'),
	numFiles: count.optional().describe('Buckets only.'),
};
type RepoInfoKey = keyof typeof repoInfoShape;
const REPO_INFO_FIELDS = Object.keys(repoInfoShape) as [RepoInfoKey, ...RepoInfoKey[]];
/** Bulky fields returned only when named in `fields`. */
const OPT_IN_FIELDS: ReadonlySet<RepoInfoKey> = new Set([
	'chatTemplate',
	'chatTemplateTruncated',
	'spaces',
	'numSpaces',
]);
const DEFAULT_FIELDS = REPO_INFO_FIELDS.filter((field) => !OPT_IN_FIELDS.has(field));

/** Upstream expand keys each output field is projected from (intersected with KIND_EXPAND). */
const CARD = 'cardData';
const FIELD_EXPAND: Record<RepoInfoKey, readonly string[]> = {
	revision: [],
	sha: ['sha'],
	author: ['author'],
	private: ['private'],
	gated: ['gated'],
	disabled: ['disabled'],
	createdAt: ['createdAt'],
	lastModified: ['lastModified'],
	downloads: ['downloads'],
	downloadsAllTime: ['downloadsAllTime'],
	likes: ['likes'],
	tags: ['tags'],
	pipelineTag: ['pipeline_tag', CARD],
	libraryName: ['library_name', CARD],
	license: [CARD],
	languages: [CARD],
	baseModels: ['baseModels', CARD],
	baseModelRelation: ['baseModels', CARD],
	datasets: ['datasets', CARD],
	models: ['models'],
	spaces: ['spaces'],
	numSpaces: ['spaces'],
	numChildModels: ['childrenModelCount'],
	safetensors: ['safetensors'],
	gguf: ['gguf'],
	// The Hub parses the template from the GGUF header or tokenizer_config.json.
	chatTemplate: ['gguf', 'config'],
	chatTemplateTruncated: ['gguf', 'config'],
	config: ['config'],
	transformersInfo: ['transformersInfo'],
	inferenceProviders: ['inferenceProviderMapping'],
	usedStorage: ['usedStorage'],
	description: ['description'],
	citation: ['citation'],
	paperswithcodeId: ['paperswithcode_id'],
	prettyName: [CARD],
	taskCategories: [CARD],
	sizeCategories: [CARD],
	sdk: ['sdk', CARD],
	title: [CARD],
	emoji: [CARD],
	shortDescription: [CARD],
	subdomain: ['subdomain'],
	runtime: ['runtime'],
	size: [],
	numFiles: [],
};

const repoInfoSchema = z
	.object({
		kind: z.enum(REPO_KINDS),
		...itemFields,
		redirectedFrom: z.string().optional().describe('Previous repository ID when a rename redirect was followed.'),
		...repoInfoShape,
	})
	.strict();
type RepoInfo = z.infer<typeof repoInfoSchema>;

const ITEM_ERRORS = ['not_found', 'auth_required', 'gated', 'invalid', 'upstream_error'] as const;
const itemErrorSchema = z
	.object({ ref: z.string(), error: z.object({ code: z.enum(ITEM_ERRORS), message: z.string() }).strict() })
	.strict();

function itemError(ref: string, error: unknown): z.infer<typeof itemErrorSchema> {
	const e = toPtcError(error, ref.slice(0, 200));
	const code: (typeof ITEM_ERRORS)[number] =
		e.code === 'NOT_FOUND'
			? 'not_found'
			: e.code === 'AUTH_REQUIRED' || e.code === 'FORBIDDEN'
				? 'auth_required'
				: e.code === 'INVALID_ARGUMENT'
					? 'invalid'
					: 'upstream_error';
	return { ref: ref.slice(0, 2048), error: { code, message: e.message } };
}

function refs(kind: RepoKind, values: unknown): RepoRef[] | undefined {
	const ids = strList(values, 1000)?.filter((id) => VALID_ID.test(id) && !id.split('/').includes('..'));
	return ids?.length ? ids.slice(0, LINK_LIMIT).map((id) => repoRef(kind, id)) : undefined;
}

function providers(value: unknown): RepoInfo['inferenceProviders'] {
	// The detail endpoint returns an object keyed by provider; listings return an array.
	const entries = Array.isArray(value)
		? value.map((v) => [str(rec(v)?.provider, 100), rec(v)] as const)
		: Object.entries(rec(value) ?? {}).map(([k, v]) => [k, rec(v)] as const);
	const out = entries.flatMap(([provider, v]) =>
		provider
			? [
					compact({
						provider: clip(provider, 100),
						providerId: str(v?.providerId, 256),
						status: str(v?.status, 64),
						task: str(v?.task, 100),
					}),
				]
			: []
	);
	return out.length ? out.slice(0, 50) : undefined;
}

/** Templates are a few KB; a cap keeps 20-repo calls bounded. */
const CHAT_TEMPLATE_MAX = 16_000;

/** The Hub parses the template out of GGUF headers and tokenizer_config.json (string or named list). */
function chatTemplate(value: unknown): { chatTemplate?: string; chatTemplateTruncated?: true } {
	const named = Array.isArray(value)
		? value.map((entry) => rec(entry)).find((entry) => entry?.name === 'default')?.template
		: value;
	if (typeof named !== 'string' || !named) return {};
	return named.length > CHAT_TEMPLATE_MAX
		? { chatTemplate: named.slice(0, CHAT_TEMPLATE_MAX), chatTemplateTruncated: true }
		: { chatTemplate: named };
}

function transformersInfo(value: Json | undefined): RepoInfo['transformersInfo'] {
	if (!value) return undefined;
	const info = compact({
		autoModel: str(value.auto_model, 200),
		pipelineTag: str(value.pipeline_tag, 100),
		processor: str(value.processor, 200),
	});
	return Object.keys(info).length ? info : undefined;
}

function projectRepo(kind: RepoKind, id: string, revision: string | undefined, v: Json): RepoInfo {
	const card = rec(v.cardData) ?? {};
	const safetensors = rec(v.safetensors);
	const gguf = rec(v.gguf);
	const config = rec(v.config);
	const runtime = rec(v.runtime);
	const hardware = rec(runtime?.hardware);
	const baseModels = rec(v.baseModels);
	const lineage = Array.isArray(baseModels?.models) ? baseModels.models.map((m) => rec(m)?.id) : card.base_model;
	const byDtype = Object.entries(rec(safetensors?.parameters) ?? {}).flatMap(([k, n]) =>
		num(n) === undefined ? [] : [[k.slice(0, 64), num(n) as number] as const]
	);
	const license = strList(card.license, 10)?.join(', ') ?? strList(card.license_name, 1)?.[0];
	const info: RepoInfo = {
		// The primary identity keeps the requested revision so the uri round-trips to the same snapshot.
		kind,
		id,
		uri: repoUri(kind, id, revision),
		url: repoUrl(kind, id, revision),
		revision,
		sha: str(v.sha, 64),
		author: str(v.author, 256),
		private: bool(v.private),
		gated: typeof v.gated === 'boolean' || typeof v.gated === 'string' ? v.gated : undefined,
		disabled: bool(v.disabled),
		createdAt: str(v.createdAt, 64),
		lastModified: str(v.lastModified, 64),
		downloads: num(v.downloads),
		downloadsAllTime: num(v.downloadsAllTime),
		likes: num(v.likes),
		tags: strList(v.tags, 100),
		pipelineTag: str(v.pipeline_tag ?? card.pipeline_tag, 100),
		libraryName: str(v.library_name ?? card.library_name, 100),
		license,
		languages: strList(card.language, 100),
		baseModels: kind === 'model' ? refs('model', lineage) : undefined,
		baseModelRelation: str(baseModels?.relation, 64) ?? str(card.base_model_relation, 64),
		datasets:
			kind === 'space' ? refs('dataset', v.datasets) : kind === 'model' ? refs('dataset', card.datasets) : undefined,
		models: kind === 'space' ? refs('model', v.models) : undefined,
		spaces: kind === 'model' ? refs('space', v.spaces) : undefined,
		numSpaces: kind === 'model' && Array.isArray(v.spaces) ? v.spaces.length : undefined,
		numChildModels: num(v.childrenModelCount),
		safetensors:
			safetensors && (num(safetensors.total) !== undefined || byDtype.length)
				? compact({
						total: num(safetensors.total),
						parameters: byDtype.length ? Object.fromEntries(byDtype.slice(0, 20)) : undefined,
					})
				: undefined,
		gguf: gguf
			? compact({
					total: num(gguf.total),
					architecture: str(gguf.architecture, 100),
					contextLength: num(gguf.context_length),
					bosToken: str(gguf.bos_token, 256),
					eosToken: str(gguf.eos_token, 256),
				})
			: undefined,
		config:
			config && (config.model_type || config.architectures || num(config.vocab_size) !== undefined)
				? compact({
						model_type: str(config.model_type, 100),
						architectures: strList(config.architectures, 20),
						vocab_size: num(config.vocab_size),
					})
				: undefined,
		...chatTemplate(gguf?.chat_template ?? rec(config?.tokenizer_config)?.chat_template),
		transformersInfo: transformersInfo(rec(v.transformersInfo)),
		inferenceProviders: providers(v.inferenceProviderMapping),
		usedStorage: num(v.usedStorage),
		description: str(v.description, 2000),
		citation: str(v.citation, 2000),
		paperswithcodeId: str(v.paperswithcode_id, 200),
		prettyName: str(card.pretty_name, 300),
		taskCategories: strList(card.task_categories, 50),
		sizeCategories: strList(card.size_categories, 10),
		sdk: str(v.sdk ?? (kind === 'space' ? card.sdk : undefined), 64),
		title: str(card.title, 300),
		emoji: str(card.emoji, 32),
		shortDescription: str(card.short_description, 500),
		subdomain: str(v.subdomain, 256),
		runtime: runtime
			? compact({
					stage: str(runtime.stage, 64),
					hardware: hardware
						? compact({ current: str(hardware.current, 64), requested: str(hardware.requested, 64) })
						: undefined,
					gcTimeout: typeof runtime.gcTimeout === 'number' ? runtime.gcTimeout : undefined,
				})
			: undefined,
		size: num(v.size),
		numFiles: num(v.totalFiles),
	};
	return compact(info);
}

async function fetchRepo(
	kind: RepoKind,
	id: string,
	revision: string | undefined,
	fields: readonly RepoInfoKey[],
	ctx: PtcContext,
	allowMissing: boolean,
	followed = false
): Promise<RepoInfo | undefined> {
	const subject = `${kind} ${id}`;
	if (kind === 'bucket') {
		const res = await hubFetch(
			{ path: `/api/buckets/${encodeId(id)}`, subject, allowStatus: allowMissing ? [401, 404] : [] },
			ctx
		);
		return res.status === 200 ? projectRepo(kind, id, undefined, rec(res.data) ?? {}) : undefined;
	}
	// Expand only what the requested fields need: unrequested chat templates and Space lists stay upstream.
	const wanted = new Set(fields.flatMap((field) => FIELD_EXPAND[field]));
	const params = new URLSearchParams();
	for (const field of KIND_EXPAND[kind]) if (wanted.has(field)) params.append('expand', field);
	const path = `${apiRoot(kind, id)}${revision ? `/revision/${encodeURIComponent(revision)}` : ''}`;
	let res;
	try {
		// Anonymous calls get 401 for missing repos too, so 401 counts as "not this kind" during auto-detection.
		res = await hubFetch({ path, params, subject, allowStatus: allowMissing ? [401, 404] : [] }, ctx);
	} catch (error) {
		// A renamed or transferred repository: report it under its current id (one hop) with redirectedFrom.
		if (error instanceof PtcRepoMovedError && error.kind === kind && !followed) {
			const resolved = await fetchRepo(kind, error.to, revision, fields, ctx, allowMissing, true);
			return resolved ? { ...resolved, redirectedFrom: error.from } : undefined;
		}
		throw error;
	}
	if (res.status !== 200) return undefined;
	const data = rec(res.data);
	if (!data) throw new PtcError('UPSTREAM_RESPONSE', `${subject}: malformed upstream data.`);
	return projectRepo(kind, id, revision, data);
}

async function repoInfo(
	ref: string,
	kind: RepoKind | undefined,
	revision: string | undefined,
	fields: readonly RepoInfoKey[],
	ctx: PtcContext
): Promise<RepoInfo> {
	const parsed = parseRef(ref, kind);
	const rev = revision ?? parsed.revision;
	if (parsed.kind === 'bucket' && rev) throw new PtcError('INVALID_ARGUMENT', 'buckets have no revisions.');
	if (parsed.kind) {
		try {
			return (await fetchRepo(parsed.kind, parsed.id, rev, fields, ctx, false)) as RepoInfo;
		} catch (error) {
			if (error instanceof PtcError && error.code === 'AUTH_REQUIRED' && !ctx.hfToken) {
				throw new PtcError('NOT_FOUND', `${parsed.kind} ${parsed.id} not found (or private: authenticate).`);
			}
			throw error;
		}
	}
	for (const candidate of ['model', 'dataset', 'space'] as const) {
		const found = await fetchRepo(candidate, parsed.id, rev, fields, ctx, true);
		if (found) return found;
	}
	throw new PtcError(
		'NOT_FOUND',
		`${parsed.id} not found as a model, dataset or Space (or not visible to this token). For buckets pass hf://buckets/${parsed.id}.`
	);
}

const repoInfoTool = definePtcTool({
	name: 'hf_repo_info',
	family: 'repo',
	title: 'Inspect Hugging Face repositories',
	description:
		'Inspect Hugging Face repository metadata (details, statistics, access status) by ID, URI or URL. Get available details for models, datasets, Spaces or storage buckets: model card metadata including license, base models and training datasets; gated/private status, downloads, likes, parameter counts, GGUF summary, storage size and, on request, chat template. Space details include SDK, runtime stage and hardware. Select the metadata to return for up to 20 repositories per call.',
	input: z
		.object({
			repos: z
				.array(refSchema)
				.min(1)
				.max(20)
				.describe('Up to 20 repositories: returned uris (hf://...), owner/name IDs or URLs.'),
			kind: z
				.enum(REPO_KINDS)
				.optional()
				.describe('Kind for bare IDs. Omit to auto-detect model, then dataset, then Space.'),
			revision: z.string().min(1).max(256).optional().describe('Branch, tag or commit for every repo (not buckets).'),
			fields: z
				.array(z.enum(REPO_INFO_FIELDS))
				.max(REPO_INFO_FIELDS.length)
				.optional()
				.describe('Fields beyond kind/id/uri/url. Default: all but chatTemplate, spaces, numSpaces.'),
		})
		.strict(),
	output: z
		.object({
			items: z
				.array(z.union([repoInfoSchema, itemErrorSchema]))
				.max(20)
				.describe('One per requested repo, in order: a record or {ref, error}.'),
			returnedCount: count,
			errorCount: count,
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const fields = input.fields ?? DEFAULT_FIELDS;
		const keep = new Set<string>(['kind', 'id', 'uri', 'url', ...fields]);
		// A truncated template must never be shown without its truncation flag.
		if (keep.has('chatTemplate')) keep.add('chatTemplateTruncated');
		const items = await mapLimit(input.repos, 5, async (ref) => {
			try {
				const info = await repoInfo(ref, input.kind, input.revision, fields, ctx);
				return Object.fromEntries(Object.entries(info).filter(([k]) => keep.has(k))) as RepoInfo;
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				return itemError(ref, error);
			}
		});
		return { items, returnedCount: items.length, errorCount: items.filter((i) => 'error' in i).length };
	},
});

// ---------------------------------------------------------------- hf_repo_list_files

const MAX_SCAN_PAGES = 10;
const PATH_SEARCH_LIMIT = 100;

const cursorState = z.object({ c: z.string().max(8192).optional(), s: z.number().int().min(0) }).strict();
type CursorState = z.infer<typeof cursorState>;

function decodeState(raw: string | undefined): CursorState | undefined {
	if (raw === undefined) return undefined;
	try {
		return cursorState.parse(JSON.parse(raw));
	} catch {
		throw new PtcError('INVALID_CURSOR', 'invalid cursor; reuse the original arguments.');
	}
}

interface Filters {
	base: string;
	type?: 'file' | 'dir';
	glob?: string;
	pathContains?: string;
}

function matcher(f: Filters): (entry: FileEntry) => boolean {
	// Patterns without a slash match the file name at any depth (e.g. *.gguf); others match the path below `path`.
	// (picomatch's `basename` option breaks patterns containing a slash, so the basename is taken here.)
	const pattern = f.glob ? picomatch(f.glob, { dot: true }) : undefined;
	const anyDepth = !!f.glob && !f.glob.includes('/');
	const glob = pattern && ((p: string) => pattern(anyDepth ? p.slice(p.lastIndexOf('/') + 1) : p));
	const needle = f.pathContains?.toLowerCase();
	return (entry) => {
		if (f.type && entry.kind !== f.type) return false;
		if (needle && !entry.path.toLowerCase().includes(needle)) return false;
		const relative = f.base && entry.path.startsWith(`${f.base}/`) ? entry.path.slice(f.base.length + 1) : entry.path;
		return glob ? glob(relative) : true;
	};
}

const listOutput = z
	.object({
		repo: repoRefSchema,
		revision: z.string().optional(),
		path: z.string(),
		items: z.array(fileEntrySchema).max(1000),
		returnedCount: count,
		nextCursor: z.string().nullable(),
		completeness: completenessSchema({
			total: count
				.optional()
				.describe('pathContains: matches upstream, files and folders; only the first 100 are returned.'),
		}),
	})
	.strict();

/** The path index returns no sizes: fill them from paths-info (one request; best effort). */
async function addSizes(t: Target, items: FileEntry[], ctx: PtcContext): Promise<void> {
	const files = items.filter((e) => e.kind === 'file' && e.size === undefined);
	if (!files.length) return;
	try {
		const res = await hubFetch(
			{
				method: 'POST',
				path: `${apiRoot(t.kind, t.id)}/paths-info/${rev(t)}`,
				body: { paths: files.map((e) => e.path), expand: false },
				subject: `${t.kind} ${t.id} paths`,
			},
			ctx
		);
		if (!Array.isArray(res.data)) return;
		const sizes = new Map<string, number>();
		for (const raw of res.data) {
			const entry = toEntry(t, raw);
			if (entry?.size !== undefined) sizes.set(entry.path, entry.size);
		}
		for (const e of files) {
			const size = sizes.get(e.path);
			if (size !== undefined) e.size = size;
		}
	} catch (error) {
		if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
	}
}

async function pathIndexSearch(
	t: Target,
	f: Filters,
	limit: number,
	ctx: PtcContext
): Promise<z.input<typeof listOutput> | undefined> {
	const res = await hubFetch(
		{
			path: `${apiRoot(t.kind, t.id)}/paths-search/${rev(t)}`,
			params: new URLSearchParams({ q: (f.pathContains ?? '').slice(0, 256) }),
			subject: 'path search',
			allowStatus: [404, 501, 503],
		},
		ctx
	);
	const data = rec(res.data);
	if (res.status !== 200 || !data || !Array.isArray(data.entries)) return undefined;
	const match = matcher({ ...f, pathContains: undefined });
	const all = data.entries
		.map((raw) => toEntry(t, raw, false))
		.filter((e): e is FileEntry => !!e && (!f.base || e.path.startsWith(`${f.base}/`)) && match(e));
	const items = all.slice(0, limit);
	await addSizes(t, items, ctx);
	const total = num(data.totalMatches);
	return {
		repo: repoRef(t.kind, t.id),
		...(t.revision ? { revision: t.revision } : {}),
		path: f.base,
		items,
		returnedCount: items.length,
		nextCursor: null,
		completeness: compact({
			hasMore: all.length > limit || (total ?? 0) > data.entries.length,
			truncated: all.length > limit || (total ?? 0) > data.entries.length || undefined,
			reason: all.length > limit || (total ?? 0) > data.entries.length ? ('items_cap' as const) : undefined,
			total,
		}),
	};
}

const listFilesTool = definePtcTool({
	name: 'hf_repo_list_files',
	family: 'repo',
	title: 'List files in a Hugging Face repository',
	description:
		'List Hugging Face repository files and folders (file tree, weights, checkpoints) by folder or revision. Browse models, datasets, Spaces or storage buckets, optionally recursively, and filter by glob such as *.gguf or *.safetensors, path substring or entry type. Returns paths, file sizes, LFS/Xet flags and file URIs. Path-index searches return only the first 100 matches. See hf_repo_read_text.',
	input: z
		.object({
			repo: refSchema.describe('Repository or bucket (hf:// uri preferred; a uri with a path lists that folder).'),
			path: z.string().max(4096).default('').describe('Folder inside the repository, relative to repo ("" = root).'),
			revision: z
				.string()
				.min(1)
				.max(256)
				.optional()
				.describe('Branch, tag or commit id (hf_repo_history items[].id); not buckets.'),
			recursive: z.boolean().default(false).describe('Include all nested files and folders (implied by glob).'),
			glob: z
				.string()
				.min(1)
				.max(512)
				.optional()
				.describe('Glob, e.g. "*.gguf" (any depth) or "onnx/**/*.onnx" (from path).'),
			pathContains: z
				.string()
				.min(1)
				.max(256)
				.optional()
				.describe('Path substring, searched repository-wide (first 100 matches).'),
			kind: z.enum(['file', 'dir']).optional().describe('Only files or only folders (items[].kind).'),
			expand: z.boolean().default(false).describe('Add last commit info per entry (repositories only; slower).'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.default(200)
				.describe('Maximum entries to return (default 200, max 1000).'),
			cursor: z.string().max(16384).optional().describe('nextCursor from a previous call with the same arguments.'),
		})
		.strict(),
	output: listOutput,
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const t = target(input.repo, input.revision);
		if (t.kind === 'bucket' && input.expand)
			throw new PtcError('INVALID_ARGUMENT', 'expand is not supported for buckets.');
		const filters: Filters = {
			base: joinPath(t.path, input.path),
			...(input.kind ? { type: input.kind } : {}),
			...(input.glob ? { glob: input.glob } : {}),
			...(input.pathContains ? { pathContains: input.pathContains } : {}),
		};
		if (filters.pathContains && t.kind !== 'bucket' && !input.cursor) {
			const indexed = await pathIndexSearch(t, filters, Math.min(input.limit, PATH_SEARCH_LIMIT), ctx);
			if (indexed) return indexed;
		}

		// Globs match at any depth below `path` (basename patterns) or relative to it, so they always scan recursively.
		const recursive = input.recursive || Boolean(filters.pathContains || filters.glob);
		const binding = [
			'hf_repo_list_files',
			t.kind,
			t.id,
			t.revision ?? null,
			filters,
			recursive,
			input.expand,
			input.limit,
		];
		const opened = decodeState(openCursor(input.cursor, binding, ctx));
		const upstreamMax = input.expand ? 100 : 1000;
		const filtering = Boolean(filters.glob || filters.pathContains || filters.type);
		const pageSize = filtering ? upstreamMax : Math.min(input.limit, upstreamMax);
		const treeBase =
			t.kind === 'bucket' ? `/api/buckets/${encodeId(t.id)}/tree` : `${apiRoot(t.kind, t.id)}/tree/${rev(t)}`;
		const path = filters.base ? `${treeBase}/${encodePath(filters.base)}` : treeBase;
		// Send exactly what the endpoint echoes in its Link header (the pagination guard compares them):
		// bucket trees drop expand and always echo sort=path&direction=asc when those are sent.
		const params =
			t.kind === 'bucket'
				? new URLSearchParams({ recursive: String(recursive), limit: String(pageSize), sort: 'path', direction: 'asc' })
				: new URLSearchParams({ recursive: String(recursive), expand: String(input.expand), limit: String(pageSize) });

		const match = matcher(filters);
		const items: FileEntry[] = [];
		let state: CursorState = opened ?? { s: 0 };
		let next: CursorState | null = null;
		for (let pages = 0; ; pages++) {
			if (pages >= MAX_SCAN_PAGES) {
				next = state;
				break;
			}
			// requestPage maps upstream statuses to sanitized PtcErrors (NOT_FOUND, AUTH_REQUIRED, ...).
			const page = await requestPage(path, params, state.c, ctx, pageSize);
			let i = state.s;
			for (; i < page.rows.length && items.length < input.limit; i++) {
				const entry = toEntry(t, page.rows[i]);
				if (entry && match(entry)) items.push(entry);
			}
			if (i < page.rows.length) {
				next = { ...(state.c ? { c: state.c } : {}), s: i };
				break;
			}
			if (!page.nextCursor) break;
			state = { c: page.nextCursor, s: 0 };
			if (items.length >= input.limit) {
				next = state;
				break;
			}
		}
		return {
			repo: repoRef(t.kind, t.id),
			...(t.revision ? { revision: t.revision } : {}),
			path: filters.base,
			items,
			returnedCount: items.length,
			nextCursor: next ? sealCursor(binding, ctx, JSON.stringify(next)) : null,
			completeness: { hasMore: next !== null },
		};
	},
});

// ---------------------------------------------------------------- hf_repo_paths_info

const MAX_FOLDER_SIZES = 50;

/** Throw NOT_FOUND unless the repository (at its revision) or bucket is visible: a one-entry tree read. */
async function assertVisible(t: Target, ctx: PtcContext): Promise<void> {
	const subject = `${t.kind} ${t.id}${t.revision ? `@${t.revision}` : ''}`;
	const res = await hubFetch(
		{
			path: t.kind === 'bucket' ? `/api/buckets/${encodeId(t.id)}/tree` : `${apiRoot(t.kind, t.id)}/tree/${rev(t)}`,
			params: new URLSearchParams({ limit: '1' }),
			subject,
			allowStatus: [401, 404],
		},
		ctx
	);
	if (res.status === 404) throw new PtcError('NOT_FOUND', `${subject} not found (or not visible to this token).`);
	if (res.status === 401) {
		// Anonymous calls get 401 for missing and private repositories alike.
		throw new PtcError(
			ctx.hfToken ? 'AUTH_REQUIRED' : 'NOT_FOUND',
			ctx.hfToken ? `${subject}: authentication required.` : `${subject} not found (or private: authenticate).`
		);
	}
}

const pathsInfoTool = definePtcTool({
	name: 'hf_repo_paths_info',
	family: 'repo',
	title: 'Check paths in a Hugging Face repository',
	description:
		'Check whether known file and folder paths exist in a repository or bucket, like stat. Returns entry type, file size, LFS/Xet flags and missing or invisible paths. Repository options add last-commit details and recursive folder size. Accepts up to 2,000 supplied paths per call.',
	input: z
		.object({
			repo: refSchema.describe('Repository or bucket. A path in the uri is checked too.'),
			paths: z
				.array(z.string().max(4096))
				.max(2000)
				.default([])
				.describe('Paths from the repository root (max 2000), e.g. ["config.json", "onnx"].'),
			revision: z
				.string()
				.min(1)
				.max(256)
				.optional()
				.describe('Branch, tag or commit id (hf_repo_history items[].id); not buckets.'),
			expand: z.boolean().default(false).describe('Add last commit info (repositories only).'),
			includeFolderSize: z
				.boolean()
				.default(false)
				.describe(`Compute recursive byte totals for up to ${String(MAX_FOLDER_SIZES)} folders (repositories only).`),
		})
		.strict(),
	output: z
		.object({
			repo: repoRefSchema,
			revision: z.string().optional(),
			items: z.array(fileEntrySchema).max(2001).describe('Existing paths, in request order.'),
			missing: z.array(z.string()).max(2001),
			returnedCount: count,
			warnings: z.array(z.string()).max(10).optional(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const t = target(input.repo, input.revision);
		const requested = [...new Set([...(t.path ? [t.path] : []), ...input.paths.map(normalizePath)])];
		if (!requested.length) throw new PtcError('INVALID_ARGUMENT', 'provide at least one path.');
		if (requested.length > 2000) throw new PtcError('INVALID_ARGUMENT', 'at most 2,000 paths per call.');
		const warnings: string[] = [];
		if (t.kind === 'bucket' && input.expand)
			throw new PtcError('INVALID_ARGUMENT', 'expand is not supported for buckets.');

		const files = requested.filter(Boolean);
		const found = new Map<string, FileEntry>();
		if (files.length) {
			const res = await hubFetch(
				{
					method: 'POST',
					path:
						t.kind === 'bucket'
							? `/api/buckets/${encodeId(t.id)}/paths-info`
							: `${apiRoot(t.kind, t.id)}/paths-info/${rev(t)}`,
					body: t.kind === 'bucket' ? { paths: files } : { paths: files, expand: input.expand },
					subject: `${t.kind} ${t.id} paths`,
				},
				ctx
			);
			if (!Array.isArray(res.data)) throw new PtcError('UPSTREAM_RESPONSE', 'paths info: malformed upstream data.');
			for (const raw of res.data) {
				const entry = toEntry(t, raw);
				if (entry) found.set(entry.path, entry);
			}
		}
		if (requested.includes('')) {
			// paths-info succeeding already proves the repository and revision are visible; otherwise check
			// before reporting the root, so a missing repo, bucket or revision is never stat'ed as a folder.
			if (!files.length) await assertVisible(t, ctx);
			found.set('', { ...fileItem(t.kind, t.id, '', 'dir', t.revision), kind: 'dir', path: '' });
		}

		const entries = requested.flatMap((p) => (found.has(p) ? [found.get(p) as FileEntry] : []));
		if (input.includeFolderSize) {
			const dirs = entries.filter((e) => e.kind === 'dir');
			if (t.kind === 'bucket') {
				if (dirs.length)
					warnings.push('Folder sizes are not available for buckets; see hf_repo_info for the bucket total.');
			} else {
				if (dirs.length > MAX_FOLDER_SIZES)
					warnings.push(`Folder sizes computed for the first ${String(MAX_FOLDER_SIZES)} folders only.`);
				await mapLimit(dirs.slice(0, MAX_FOLDER_SIZES), 5, async (dir) => {
					const res = await hubFetch(
						{
							// The root must have no trailing slash: `/treesize/main/` answers 302.
							path: `${apiRoot(t.kind, t.id)}/treesize/${rev(t)}${dir.path ? `/${encodePath(dir.path)}` : ''}`,
							subject: 'folder size',
						},
						ctx
					);
					const size = num(rec(res.data)?.size);
					if (size !== undefined) dir.size = size;
				});
			}
		}
		return {
			repo: repoRef(t.kind, t.id),
			...(t.revision ? { revision: t.revision } : {}),
			items: entries,
			missing: requested.filter((p) => !found.has(p)),
			returnedCount: entries.length,
			...(warnings.length ? { warnings } : {}),
		};
	},
});

// ---------------------------------------------------------------- hf_repo_read_text

const MAX_UTF8_EXTRA = 3;

function requireFile(uri: string): Target {
	const trimmed = uri.trim();
	if (/^(?:hf:\/\/docs(?:\/|$)|https?:\/\/(?:www\.)?huggingface\.co\/(?:docs|\.well-known)\/)/i.test(trimmed)) {
		throw new PtcError('INVALID_ARGUMENT', 'documentation URIs and URLs are read with hf_docs_read, not hf_repo_read_text.');
	}
	const t = target(uri);
	if (!t.path) {
		throw new PtcError('INVALID_ARGUMENT', 'uri must point to a file, e.g. hf://models/owner/name/README.md.');
	}
	return t;
}

function textPolicyError(path: string, error: unknown): PtcError {
	const reason =
		error instanceof Error && /NUL|UTF-8|control/.exec(error.message)
			? 'content is not UTF-8 text'
			: 'binary file type';
	const hint = imageMimeTypeForPath(path) ? 'use hf_repo_read_image' : 'use hf_repo_paths_info for metadata';
	return new PtcError('UNSUPPORTED', `${path}: ${reason}; ${hint}.`);
}

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x80 && byte <= 0xbf;

const readTextTool = definePtcTool({
	name: 'hf_repo_read_text',
	family: 'repo',
	title: 'Read a text file from a Hugging Face repository',
	description:
		'Read Hugging Face repository text files (README, model card, dataset card) by file URI or URL. Open LICENSE, config.json, tokenizer settings, chat templates or source code from a model, dataset, Space or storage bucket. Returns text content and byte offsets, with nextOffset for continuation through a bounded byte window. See hf_repo_list_files.',
	input: z
		.object({
			uri: refSchema.describe('File uri (items[].uri of hf_repo_list_files) or a huggingface.co blob URL.'),
			offset: z.number().int().min(0).default(0).describe('Byte offset to start from (use nextOffset to continue).'),
			maxBytes: z
				.number()
				.int()
				.min(1)
				.max(80_000)
				.default(20_000)
				.describe('Maximum bytes to read (default 20000, max 80000).'),
		})
		.strict(),
	output: z
		.object({
			kind: z.literal('file'),
			...itemFields,
			path: z.string(),
			content: z.string(),
			offset: count.describe('Adjusted to a UTF-8 character boundary.'),
			bytes: count,
			size: count.optional().describe('Whole file, bytes.'),
			truncated: z.boolean().describe('More content follows (nextOffset).'),
			nextOffset: count.nullable(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const t = requireFile(input.uri);
		try {
			assertTextFilePath(t.path);
		} catch (error) {
			throw textPolicyError(t.path, error);
		}
		const windowStart = Math.max(0, input.offset - MAX_UTF8_EXTRA);
		const windowEnd = input.offset + input.maxBytes + MAX_UTF8_EXTRA; // exclusive
		const res = await hubFetch(
			{
				path: resolvePath(t),
				headers: { accept: '*/*', range: `bytes=${String(windowStart)}-${String(windowEnd - 1)}` },
				as: 'bytes',
				followRedirects: true,
				allowStatus: [416],
				maxBytes: windowEnd - windowStart,
				subject: `file ${t.path}`,
			},
			ctx
		);
		const totalHeader = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
		let bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array();
		let start = windowStart;
		if (res.status === 200) bytes = bytes.slice(windowStart, windowEnd); // range ignored: whole (small) file
		const total = totalHeader ? Number(totalHeader) : res.status === 200 ? (res.data as Uint8Array).length : undefined;
		const item = { ...fileItem(t.kind, t.id, t.path, 'file', t.revision), kind: 'file' as const, path: t.path };
		if (res.status === 416 || bytes.length === 0 || input.offset >= start + bytes.length) {
			return compact({
				...item,
				content: '',
				offset: input.offset,
				bytes: 0,
				size: total,
				truncated: false,
				nextOffset: null,
			});
		}
		// Align both ends to UTF-8 character boundaries inside the fetched window.
		let from = input.offset - start;
		while (from > 0 && isContinuation(bytes[from])) from -= 1;
		const eof = total !== undefined ? start + bytes.length >= total : bytes.length < windowEnd - windowStart;
		let to = Math.min(input.offset + input.maxBytes - start, bytes.length);
		while (to < bytes.length && isContinuation(bytes[to])) to += 1;
		const slice = bytes.slice(from, to);
		let content: string;
		try {
			content = decodeTextFileContent(t.path, slice);
		} catch (error) {
			throw textPolicyError(t.path, error);
		}
		start += from;
		const end = start + slice.length;
		const truncated = to < bytes.length || !eof;
		return compact({
			...item,
			content,
			offset: start,
			bytes: slice.length,
			size: total,
			truncated,
			nextOffset: truncated ? end : null,
		});
	},
});

// ---------------------------------------------------------------- hf_repo_read_image

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function sniffImage(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	return undefined;
}

const readImageTool = definePtcTool({
	name: 'hf_repo_read_image',
	family: 'repo',
	title: 'Show an image from a Hugging Face repository',
	description:
		'Show a repository or bucket image (PNG, JPEG, WebP) by file URI: charts, diagrams or screenshots. Returns image content with file metadata including MIME type and byte size; images exceeding the chosen size cap, at most 8 MiB, are rejected.',
	input: z
		.object({
			uri: refSchema.describe('Image file uri ending in .jpg, .jpeg, .png or .webp.'),
			maxBytes: z
				.number()
				.int()
				.min(1)
				.max(IMAGE_MAX_BYTES)
				.default(IMAGE_MAX_BYTES)
				.describe('Reject images larger than this many bytes (max 8 MiB).'),
		})
		.strict(),
	output: z
		.object({
			kind: z.literal('file'),
			...itemFields,
			path: z.string(),
			mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
			bytes: count,
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const t = requireFile(input.uri);
		const mimeType = imageMimeTypeForPath(t.path);
		if (!mimeType) {
			throw new PtcError('UNSUPPORTED', `${t.path}: only .jpg, .jpeg, .png and .webp images are supported.`);
		}
		let data: Uint8Array;
		try {
			const res = await hubFetch(
				{
					path: resolvePath(t),
					headers: { accept: '*/*' },
					as: 'bytes',
					followRedirects: true,
					maxBytes: input.maxBytes,
					timeoutMs: 30_000,
					subject: `file ${t.path}`,
				},
				ctx
			);
			data = res.data instanceof Uint8Array ? res.data : new Uint8Array();
		} catch (error) {
			if (error instanceof PtcError && /size budget/.test(error.message)) {
				throw new PtcError('INVALID_ARGUMENT', `${t.path}: image is larger than ${String(input.maxBytes)} bytes.`);
			}
			throw error;
		}
		if (sniffImage(data) !== mimeType) {
			throw new PtcError('UPSTREAM_RESPONSE', `${t.path}: content is not a valid ${mimeType} image.`);
		}
		const structured = {
			...fileItem(t.kind, t.id, t.path, 'file', t.revision),
			kind: 'file' as const,
			path: t.path,
			mimeType,
			bytes: data.length,
		};
		return new PtcResult(structured, [
			{ type: 'image', data: Buffer.from(data).toString('base64'), mimeType },
			{ type: 'text', text: JSON.stringify(structured) },
		]);
	},
});

// ---------------------------------------------------------------- hf_repo_history

const MAX_REFS = 500;

const historyItemSchema = z
	.object({
		kind: z.enum(['commit', 'branch', 'tag', 'convert', 'pull_request']),
		...itemFields,
		title: z.string().optional(),
		message: z.string().optional(),
		authors: z.array(z.string()).max(20).optional(),
		createdAt: z.string().optional(),
		ref: z.string().optional().describe('Full git ref, e.g. refs/pr/3; usable as revision.'),
		targetCommit: z.string().optional(),
	})
	.strict();
type HistoryItem = z.infer<typeof historyItemSchema>;

const historyTool = definePtcTool({
	name: 'hf_repo_history',
	family: 'repo',
	title: 'Hugging Face repository commits and refs',
	description:
		"Show repository history (commits, branches, tags) for a model, dataset or Space. Choose a revision's commits with authors, dates and messages, or list branches, tags, converted refs and optional pull-request refs. Results are paged for commits or capped at 500 refs.",
	input: z
		.object({
			repo: refSchema.describe('Repository: returned uri (a file uri works), owner/name or URL; no buckets.'),
			mode: z.enum(['commits', 'refs']).default('commits').describe('commits: history; refs: branches/tags/PRs.'),
			revision: z
				.string()
				.min(1)
				.max(256)
				.optional()
				.describe('Branch, tag or commit to list history from (default: main).'),
			includePrs: z.boolean().default(false).describe('refs mode: include pull-request refs.'),
			limit: z.number().int().min(1).max(200).default(50).describe('Commits per page (default 50, max 200).'),
			cursor: z.string().max(4096).optional().describe('nextCursor from a previous call with the same arguments.'),
		})
		.strict(),
	output: z
		.object({
			repo: repoRefSchema,
			mode: z.enum(['commits', 'refs']),
			items: z.array(historyItemSchema).max(MAX_REFS),
			returnedCount: count,
			nextCursor: z.string().nullable(),
			completeness: completenessSchema({
				total: count.optional().describe('Commits on this revision.'),
			}),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const t = target(input.repo, input.revision);
		if (t.kind === 'bucket') throw new PtcError('UNSUPPORTED', 'buckets have no commit history or refs.');
		const base = apiRoot(t.kind, t.id);
		const subject = `${t.kind} ${t.id}`;
		const revisioned = (kind: HistoryItem['kind'], name: string, revision: string, extra: Partial<HistoryItem>) =>
			compact<HistoryItem>({
				kind,
				id: name,
				uri: repoUri(t.kind, t.id, revision),
				url: repoUrl(t.kind, t.id, revision),
				...extra,
			});

		if (input.mode === 'refs') {
			const res = await hubFetch(
				{ path: `${base}/refs`, params: new URLSearchParams(input.includePrs ? { include_prs: '1' } : {}), subject },
				ctx
			);
			const data = rec(res.data) ?? {};
			const groups: [HistoryItem['kind'], unknown][] = [
				['branch', data.branches],
				['tag', data.tags],
				['convert', data.converts],
				['pull_request', data.pullRequests],
			];
			const all = groups.flatMap(([kind, list]) =>
				(Array.isArray(list) ? list : []).flatMap((raw) => {
					const r = rec(raw);
					const name = str(r?.name, 256);
					const ref = str(r?.ref, 300);
					if (!name) return [];
					const revision = (kind === 'branch' || kind === 'tag' ? name : ref) ?? name;
					return [revisioned(kind, name, revision, { ref, targetCommit: str(r?.targetCommit, 64) })];
				})
			);
			const items = all.slice(0, MAX_REFS);
			return {
				repo: repoRef(t.kind, t.id),
				mode: 'refs' as const,
				items,
				returnedCount: items.length,
				nextCursor: null,
				completeness:
					all.length > MAX_REFS
						? {
								hasMore: true,
								truncated: true,
								reason: 'items_cap' as const,
								hint: `More than ${String(MAX_REFS)} refs exist.`,
							}
						: { hasMore: false },
			};
		}

		const binding = ['hf_repo_history', t.kind, t.id, t.revision ?? 'main', input.limit];
		const page = Number(openCursor(input.cursor, binding, ctx) ?? '0');
		const res = await hubFetch(
			{
				path: `${base}/commits/${rev(t)}`,
				params: new URLSearchParams({ p: String(page), limit: String(input.limit) }),
				subject,
			},
			ctx
		);
		if (!Array.isArray(res.data)) throw new PtcError('UPSTREAM_RESPONSE', 'commits: malformed upstream data.');
		const items = res.data.slice(0, input.limit).flatMap((raw) => {
			const c = rec(raw);
			const sha = str(c?.id, 64);
			if (!c || !sha) return [];
			const authors = Array.isArray(c.authors)
				? c.authors.flatMap((a) => {
						const user = str(rec(a)?.user, 100);
						return user ? [user] : [];
					})
				: [];
			return [
				compact({
					kind: 'commit' as const,
					id: sha,
					uri: repoUri(t.kind, t.id, sha),
					url: `https://huggingface.co/${webPrefix(t.kind)}${encodeId(t.id)}/commit/${encodeURIComponent(sha)}`,
					title: str(c.title, 500),
					message: str(c.message, 2000),
					authors: authors.length ? authors.slice(0, 20) : undefined,
					createdAt: str(c.date, 64),
				}),
			];
		});
		const totalHeader = res.headers.get('x-total-count');
		const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
		const hasNext =
			total !== undefined
				? (page + 1) * input.limit < total
				: /rel="?next"?/.test(res.headers.get('link') ?? '') || res.data.length >= input.limit;
		return {
			repo: repoRef(t.kind, t.id),
			mode: 'commits' as const,
			items,
			returnedCount: items.length,
			nextCursor: hasNext && items.length ? sealCursor(binding, ctx, String(page + 1)) : null,
			completeness: compact({ hasMore: hasNext && items.length > 0, total }),
		};
	},
});

/** Repository and bucket inspection: info, files, paths, text/image reads, history. */
export const REPO_TOOLS: readonly PtcTool[] = [
	repoInfoTool,
	listFilesTool,
	pathsInfoTool,
	readTextTool,
	readImageTool,
	historyTool,
];
