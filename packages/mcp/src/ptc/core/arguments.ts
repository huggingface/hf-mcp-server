/**
 * Argument handling shared by the MCP SDK path (`advertisedInputSchema`) and `callPtcTool`.
 *
 * Models guess argument names from habit (`repo_id`, `dataset_id`, `url`, `q`). When the intended
 * argument is unambiguous we accept the alias; otherwise the validation message names the
 * valid arguments and describes any missing required one, so the next call can be corrected.
 */
import type { z } from 'zod';
import { PtcError } from './errors.js';
import { REPO_KINDS, parseRef, repoUri, type ParsedRef, type RepoKind } from './refs.js';

type Json = Record<string, unknown>;

/** A habitual name, optionally only for values of a given form. */
interface Alias {
	name: string;
	when?: (value: unknown) => boolean;
}
type AliasSpec = string | Alias;

const FULL_URI = /^(?:hf:\/\/|https?:\/\/)/i;
const isFullUri = (value: unknown): boolean => typeof value === 'string' && FULL_URI.test(value.trim());

/** Lowercase without separators: maxBytes, max_bytes and MAX-BYTES compare equal. */
function looseName(name: string): string {
	return name.replace(/[_-]/g, '').toLowerCase();
}

/** Person arguments: a tool with exactly one of these accepts the others (and the record fields) as aliases. */
const PERSON_ARGS = ['handles', 'handle', 'user', 'org', 'entity'] as const;
const PERSON_LOOSE = new Set<string>(PERSON_ARGS);
const PERSON_ALIASES = [
	...PERSON_ARGS,
	'username',
	'usernames',
	'users',
	'organization',
	'orgs',
	'uri',
	'url',
	'id',
] as const;

const REPO_HABITS = ['repo_id', 'repository', 'repo_ref', 'model_id', 'dataset_id', 'space_id', 'id', 'uri', 'url'];
const REPOS_HABITS = [
	'repo_ids',
	'repositories',
	'model_ids',
	'dataset_ids',
	'space_ids',
	'ids',
	'uris',
	'urls',
	'repo_id',
	'model_id',
	'dataset_id',
	'space_id',
	'id',
	'uri',
	'url',
];

/**
 * Canonical argument -> habitual names: Python/REST habits, the record field the value usually comes from (uri,
 * url, id) and the names the PTC tools used before the camelCase rename (NAMING-SPEC R16). Canonical names match
 * a tool's argument loosely (authorsAny matches authors_any), so a habit works before and after a rename. Applied
 * only when the tool has the canonical argument, it is not given, the tool does not itself define the alias, and
 * no other argument of the tool claims it. Arguments that differ only in separators or case are mapped
 * mechanically and need no entry here.
 */
const ALIASES: Record<string, readonly AliasSpec[]> = {
	// Subjects (R4).
	repo: ['ref', ...REPO_HABITS],
	repos: ['refs', 'repo', 'ref', ...REPOS_HABITS],
	uri: [
		'url',
		'file_uri',
		'file_url',
		'link',
		{ name: 'ref', when: isFullUri },
		{ name: 'repo', when: isFullUri },
		{ name: 'path', when: isFullUri },
	],
	dataset: ['dataset_id', 'repo_id', 'repo', 'dataset_name', 'ref', 'uri', 'url', 'id'],
	space: ['space_id', 'repo_id', 'repo', 'ref', 'uri', 'url', 'id'],
	collection: ['collection_id', 'slug', 'ref', 'uri', 'url', 'id'],
	discussion: ['ref', 'repo', 'repo_id', 'discussion_id', 'uri', 'url', 'id'],
	papers: ['paper_ids', 'paper_id', 'paper', 'arxiv_id', 'arxiv_ids', 'ids', 'uris', 'urls', 'id', 'uri', 'url'],
	paper: ['paper_id', 'arxiv_id', 'paper_ids', 'papers', 'arxiv_ids', 'id', 'uri', 'url'],
	job: ['job_id', 'id', 'job_url', 'url'],
	sandbox: ['sandbox_id', 'handle', 'id'],
	...Object.fromEntries(PERSON_ARGS.map((name) => [name, PERSON_ALIASES.filter((alias) => alias !== name)])),
	// Paging and text (R7).
	query: ['q', 'search', 'search_query', 'keywords'],
	limit: ['max_results', 'top_k', 'page_size', 'length', 'comments_limit'],
	// Filters (R5, R6, R11): Python/REST habits and pre-rename names.
	authorsAny: ['author', 'authors', 'owner', 'owners'],
	ownersAny: ['owners', 'owner', 'author'],
	idsAny: ['ids', 'repo_ids'],
	papersAny: ['arxiv_ids', 'arxiv_id', 'paper_ids', 'papers'],
	tagsAll: ['tags', 'filter', 'filters'],
	task: ['pipeline_tag'],
	librariesAll: ['libraries', 'library', 'library_name'],
	languagesAll: ['languages', 'language'],
	licensesAll: ['licenses', 'license'],
	taskCategoriesAll: ['task_categories', 'task_category'],
	sizeCategoriesAll: ['size_categories', 'size_category'],
	modalitiesAll: ['modalities', 'modality'],
	formatsAll: ['formats', 'format'],
	providersAny: ['providers', 'provider', 'inference_provider'],
	datasetsAny: ['datasets', 'trained_dataset'],
	modelsAny: ['models'],
	numParametersMin: ['parameters_min', 'min_parameters'],
	numParametersMax: ['parameters_max', 'max_parameters'],
	numParametersAny: ['parameters_exact', 'num_parameters'],
	baseModelRelationsAny: ['base_model_relations'],
	sdksAny: ['sdks', 'sdk'],
	stagesAny: ['stages', 'stage'],
	kindsAny: ['kinds', 'types'],
	typesAny: ['types', 'type'],
	kind: ['type'],
	catalog: ['kind'],
	submittedBy: ['submitter'],
	flavor: ['hardware'],
	includePrs: ['include_pull_requests'],
};
const ALIAS_INDEX = new Map(Object.entries(ALIASES).map(([canonical, specs]) => [looseName(canonical), specs]));

function aliasName(spec: AliasSpec): string {
	return typeof spec === 'string' ? spec : spec.name;
}

function aliasesFor(canonical: string): readonly AliasSpec[] {
	return ALIAS_INDEX.get(looseName(canonical)) ?? [];
}

/** True when the tool has an argument equal to `name` up to separators and case. */
function inShapeLoosely(shape: Record<string, z.ZodType>, name: string): boolean {
	const key = looseName(name);
	return Object.keys(shape).some((arg) => looseName(arg) === key);
}

/** Arguments of this tool that would take `args[name]` under the alias table. */
function claimants(shape: Record<string, z.ZodType>, args: Json, name: string): string[] {
	const out: string[] = [];
	for (const canonical of Object.keys(shape)) {
		if (args[canonical] !== undefined) continue;
		if (PERSON_LOOSE.has(canonical) && personArgCount(shape) !== 1) continue;
		const spec = aliasesFor(canonical).find((candidate) => looseName(aliasName(candidate)) === looseName(name));
		if (spec && (typeof spec === 'string' || !spec.when || spec.when(args[name]))) out.push(canonical);
	}
	return out;
}

function personArgCount(shape: Record<string, z.ZodType>): number {
	return PERSON_ARGS.filter((name) => name in shape).length;
}

/** Argument names that subject-qualify bare repository IDs with an explicit kind. */
const REPO_ARGS = ['ref', 'refs', 'repo', 'repos', 'dataset', 'space'];

const REPO_KEYS = ['ref', 'repo_id', 'repo', 'repository', 'model_id', 'dataset_id', 'space_id'];
const PATH_KEYS = ['path', 'filename', 'file_path', 'file'];
/** owner/name, or a legacy single-segment ID (gpt2, squad) for kinds that have them. */
const BARE_ID = /^[\w.-]+\/[\w.-]+$/;
const LEGACY_ID = /^[\w.-]+$/;
const IDENTIFIER = /^[A-Za-z_][\w-]{0,63}$/;

/** Aliases that name the repository kind themselves (dataset_id is a dataset, whatever the tool's default). */
const ALIAS_KIND: Record<string, RepoKind> = {
	modelid: 'model',
	modelids: 'model',
	datasetid: 'dataset',
	datasetids: 'dataset',
	spaceid: 'space',
	spaceids: 'space',
};

function kindFromAlias(key: string): RepoKind | undefined {
	return ALIAS_KIND[looseName(key)];
}

const REPO_TYPE_ERROR = 'repo_type must be one of model, dataset, space or bucket (plural or any case accepted).';

/** model/models/Model/MODELS -> model; undefined when the value is not a repository kind. */
function repoKindOf(value: unknown): RepoKind | undefined {
	if (typeof value !== 'string') return undefined;
	const lower = value.trim().toLowerCase();
	const singular = lower.endsWith('s') ? lower.slice(0, -1) : lower;
	return (REPO_KINDS as readonly string[]).includes(singular) ? (singular as RepoKind) : undefined;
}

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	for (let i = 0; i < 5; i++) {
		const def = (current as { def?: { type?: string; innerType?: z.ZodType; in?: z.ZodType; out?: z.ZodType } }).def;
		if (!def) break;
		if ((def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType)
			current = def.innerType;
		else if (def.type === 'pipe' && def.in) {
			// z.preprocess is a pipe from a transform: the shape is on the out side.
			const inType = (def.in as { def?: { type?: string } }).def?.type;
			current = inType === 'transform' && def.out ? def.out : def.in;
		} else break;
	}
	return current;
}

function isArraySchema(schema: z.ZodType | undefined): boolean {
	return schema !== undefined && (unwrap(schema) as { def?: { type?: string } }).def?.type === 'array';
}

/** Options of a closed string enum (after optional/default/pipe), else undefined. */
function enumOptions(schema: z.ZodType | undefined): string[] | undefined {
	if (!schema) return undefined;
	const def = (unwrap(schema) as { def?: { type?: string; entries?: Record<string, unknown> } }).def;
	if (def?.type !== 'enum' || !def.entries) return undefined;
	const options = Object.values(def.entries);
	return options.every((option): option is string => typeof option === 'string') ? options : undefined;
}

/** Element schema of an array argument, else undefined. */
function arrayElement(schema: z.ZodType | undefined): z.ZodType | undefined {
	if (!schema) return undefined;
	const def = (unwrap(schema) as { def?: { type?: string; element?: z.ZodType } }).def;
	return def?.type === 'array' ? def.element : undefined;
}

/**
 * Old and Hub vocabulary for `fields`/`sort` values whose record field has another name (NAMING-SPEC R3). A value
 * maps only when every target is an option of the argument's enum, so it is inert for tools without them.
 */
const VALUE_ALIASES: Record<string, readonly string[]> = {
	inferenceprovidermapping: ['inferenceProviders'],
	numparameters: ['numParameters'],
	rows: ['numRows'],
	bytes: ['mainSize'],
	parameters: ['safetensors'],
	automodel: ['transformersInfo'],
	transformers: ['transformersInfo'],
	spacescount: ['numSpaces'],
	childrenmodelcount: ['numChildModels'],
	totalfiles: ['numFiles'],
	trainingdatasets: ['datasets'],
	carddata: ['title', 'emoji', 'shortDescription'],
};

/**
 * The canonical enum options for `value`: exact; else equal up to case and separators (last_modified ->
 * lastModified); else a vocabulary alias (VALUE_ALIASES); else, for repository-kind enums, the singular of a
 * plural. Anything else is returned unchanged for zod to reject.
 */
function canonicalOptions(options: string[], value: unknown): unknown[] {
	if (typeof value !== 'string' || options.includes(value)) return [value];
	const loose = looseName(value.trim());
	const match = options.find((option) => looseName(option) === loose);
	if (match !== undefined) return [match];
	const mapped = VALUE_ALIASES[loose];
	if (mapped && mapped.every((option) => options.includes(option))) return [...mapped];
	const kind = repoKindOf(value);
	return [kind && options.includes(kind) ? kind : value];
}

function canonicalOption(options: string[], value: unknown): unknown {
	const [first] = canonicalOptions(options, value);
	return first;
}

function shapeOf(input: z.ZodObject): Record<string, z.ZodType> {
	return input.shape;
}

/**
 * hf://KINDS/ID for a bare ID and a known kind; anything else is returned unchanged.
 * The kind comes from an explicit repo_type/kind, else from a kind-carrying alias (dataset_id).
 */
function qualify(value: unknown, kind: RepoKind | undefined, aliasKey?: string): unknown {
	if (typeof value !== 'string') return value;
	const id = value.trim();
	const inferred = kind ?? (aliasKey ? kindFromAlias(aliasKey) : undefined);
	if (!inferred) return value;
	const legacyOk = inferred === 'model' || inferred === 'dataset';
	if (!BARE_ID.test(id) && !(legacyOk && LEGACY_ID.test(id))) return value;
	return repoUri(inferred, id);
}

/**
 * Rename unambiguous habitual argument names to the tool's own and canonicalize enum values
 * (case-insensitive; plural repository kinds). Pure: returns a new object, or the input when
 * nothing applies. Never invents values. Throws INVALID_ARGUMENT for an unknown repo_type,
 * because silently dropping it would default a bare ID to a model.
 */
export function normalizePtcArguments(input: z.ZodObject, raw: unknown): unknown {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
	const shape = shapeOf(input);
	const args: Json = { ...(raw as Json) };
	let changed = false;

	// Mechanical: a key equal to exactly one argument up to separators and case (max_bytes -> maxBytes).
	for (const key of Object.keys(args)) {
		if (key in shape) continue;
		const loose = looseName(key);
		if (loose === 'repotype' && key !== 'repo_type' && args.repo_type === undefined && !inShapeLoosely(shape, key)) {
			args.repo_type = args[key];
			delete args[key];
			changed = true;
			continue;
		}
		const matches = Object.keys(shape).filter((arg) => looseName(arg) === loose);
		if (matches.length !== 1) continue;
		const [canonical] = matches as [string];
		if (args[canonical] !== undefined) continue;
		args[canonical] = args[key];
		delete args[key];
		changed = true;
	}

	// repo_type (a habit from huggingface_hub) is validated and normalized to the singular kind.
	let repoType: RepoKind | undefined;
	if (args.repo_type !== undefined && !('repo_type' in shape)) {
		repoType = repoKindOf(args.repo_type);
		if (!repoType) throw new PtcError('INVALID_ARGUMENT', REPO_TYPE_ERROR);
		// A tool whose kind argument takes repository kinds receives it there.
		const kindOptions = enumOptions(shape.kind);
		if (kindOptions?.includes(repoType)) {
			const current = args.kind === undefined ? undefined : canonicalOption(kindOptions, args.kind);
			if (current !== undefined && current !== repoType)
				throw new PtcError('INVALID_ARGUMENT', 'repo_type and kind disagree; pass only kind.');
			args.kind = repoType;
			delete args.repo_type;
			changed = true;
		} else if (args.repo_type !== repoType) {
			args.repo_type = repoType;
			changed = true;
		}
	}
	// Explicit kinds qualify bare IDs only for tools without a repository-kind argument (else the tool applies
	// kind). hf_repo_list_files has a kind argument for file|dir, which is not a repository kind.
	const repoKindArg = enumOptions(shape.kind)?.some((option) => (REPO_KINDS as readonly string[]).includes(option));
	const qualifyKind = repoKindArg ? undefined : repoType;

	// {repo_id, path} for a tool that takes a single file uri: build the uri.
	if ('uri' in shape && !('path' in shape) && !('ref' in shape) && !('repo' in shape) && args.uri === undefined) {
		const stringKeys = Object.keys(args).filter((key) => typeof args[key] === 'string');
		const repoKey = REPO_KEYS.map((name) => stringKeys.find((key) => looseName(key) === looseName(name))).find(
			(key) => key !== undefined
		);
		const pathKey = PATH_KEYS.find((key) => typeof args[key] === 'string');
		if (repoKey && pathKey) {
			const uri = fileUri(
				String(args[repoKey]),
				repoType ?? repoKindOf(args.kind) ?? kindFromAlias(repoKey),
				String(args[pathKey])
			);
			if (uri) {
				args.uri = uri;
				for (const key of [repoKey, pathKey, 'repo_type']) if (!(key in shape)) delete args[key];
				changed = true;
			}
		}
	}

	for (const canonical of Object.keys(shape)) {
		if (args[canonical] !== undefined) continue;
		const alias = aliasesFor(canonical)
			.map(aliasName)
			.map((name) => Object.keys(args).find((key) => looseName(key) === looseName(name)))
			.find(
				(name): name is string =>
					name !== undefined &&
					!(name in shape) &&
					args[name] !== undefined &&
					claimants(shape, args, name).join() === canonical
			);
		if (!alias) continue;
		let value = args[alias];
		if (REPO_ARGS.includes(canonical)) {
			value = Array.isArray(value)
				? value.map((item) => qualify(item, qualifyKind, alias))
				: qualify(value, qualifyKind, alias);
			if (qualifyKind && args.repo_type !== undefined) delete args.repo_type;
		}
		if (isArraySchema(shape[canonical])) {
			if (!Array.isArray(value)) value = [value];
		} else if (Array.isArray(value) && value.length === 1) value = value[0];
		args[canonical] = value;
		delete args[alias];
		changed = true;
	}
	// repo_type next to an already-named repository argument, for a tool without kind.
	if (qualifyKind && args.repo_type !== undefined) {
		const target = REPO_ARGS.find((key) => key in shape && args[key] !== undefined);
		if (target) {
			const value = args[target];
			args[target] = Array.isArray(value)
				? value.map((item) => qualify(item, qualifyKind))
				: qualify(value, qualifyKind);
			delete args.repo_type;
			changed = true;
		}
	}

	// Enum values match case-insensitively (sort: "Downloads"), for scalar and array arguments.
	for (const [name, schema] of Object.entries(shape)) {
		const value = args[name];
		if (value === undefined) continue;
		const scalar = enumOptions(schema);
		if (scalar) {
			const next = canonicalOption(scalar, value);
			if (next !== value) {
				args[name] = next;
				changed = true;
			}
			continue;
		}
		const element = enumOptions(arrayElement(schema));
		// A single value for a list argument is wrapped (languagesAll: "en").
		const list = isArraySchema(schema) && !Array.isArray(value) && typeof value === 'string' ? [value] : value;
		if (element && Array.isArray(list)) {
			const next = list.flatMap((item) => canonicalOptions(element, item));
			if (list !== value || next.length !== list.length || next.some((item, index) => item !== list[index])) {
				args[name] = [...new Set(next)];
				changed = true;
			}
		} else if (list !== value) {
			args[name] = list;
			changed = true;
		}
	}
	return changed ? args : raw;
}

/** A file uri from a repository argument and a path, or undefined when the repository is not a Ref. */
function fileUri(repo: string, kind: RepoKind | undefined, path: string): string | undefined {
	let parsed: ParsedRef;
	try {
		parsed = parseRef(repo, kind ?? 'model');
	} catch {
		return undefined;
	}
	const clean = path.replace(/^\/+/, '');
	if (!parsed.kind || !clean) return undefined;
	return repoUri(parsed.kind, parsed.id, parsed.revision, parsed.path ? `${parsed.path}/${clean}` : clean);
}

function describeOf(schema: z.ZodType | undefined): string | undefined {
	let current = schema;
	for (let i = 0; current && i < 5; i++) {
		if (current.description) return current.description;
		const def = (current as { def?: { innerType?: z.ZodType } }).def;
		current = def?.innerType;
	}
	return undefined;
}

/** Caller-facing messages. Echo argument *names* only when they are plain identifiers; never values. */
export function ptcInputIssueMessages(input: z.ZodObject, error: z.ZodError, args: unknown): string[] {
	const shape = shapeOf(input);
	const valid = Object.keys(shape);
	const given = typeof args === 'object' && args !== null ? (args as Json) : {};
	const unknown: string[] = [];
	const messages: string[] = [];
	for (const issue of error.issues) {
		if (issue.code === 'unrecognized_keys') {
			const names = issue.keys.filter((key) => IDENTIFIER.test(key));
			const label = names.length
				? `Unknown ${names.length > 1 ? 'arguments' : 'argument'} ${names.map((key) => `"${key}"`).join(', ')}`
				: 'Unknown argument';
			unknown.push(`${label} (valid arguments: ${valid.join(', ')})`);
			continue;
		}
		const top = issue.path[0];
		if (issue.path.length === 1 && typeof top === 'string' && given[top] === undefined && top in shape) {
			const doc = describeOf(shape[top]);
			messages.push(`Missing required argument "${top}"${doc ? `: ${doc.replace(/\.$/, '')}` : ''}`);
			continue;
		}
		const path = issue.path.length ? `${issue.path.map(String).join('.')}: ` : '';
		messages.push(`${path}${issue.message}`);
	}
	// Unknown names first: they usually explain the missing required argument that follows.
	return [...new Set([...unknown, ...messages])];
}

/** Constraint keywords: enforced server-side by zod (with actionable errors), noise in every client rendering. */
const INPUT_VALIDATION_KEYWORDS = new Set([
	'$schema',
	'pattern',
	'format',
	'minLength',
	'maxLength',
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minItems',
	'maxItems',
	'uniqueItems',
	'minProperties',
	'maxProperties',
	'propertyNames',
]);

/**
 * The input schema as listed in tools/list: types, enums, consts, defaults, required and docs only.
 * Keywords are dropped only in schema positions, never as property names.
 */
function cleanInputJsonSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(cleanInputJsonSchema);
	if (typeof node !== 'object' || node === null) return node;
	const out: Json = {};
	for (const [key, value] of Object.entries(node as Json)) {
		if (INPUT_VALIDATION_KEYWORDS.has(key)) continue;
		if ((key === 'properties' || key === '$defs') && typeof value === 'object' && value !== null) {
			out[key] = Object.fromEntries(
				Object.entries(value as Json).map(([name, child]) => [name, cleanInputJsonSchema(child)])
			);
		} else out[key] = cleanInputJsonSchema(value);
	}
	return out;
}

type StandardProps = z.ZodObject['~standard'];

/** Standard Schema accepted by the MCP SDK as an `inputSchema`. */
export interface AdvertisedInputSchema {
	readonly '~standard': StandardProps;
}

const ADVERTISED = new WeakMap<z.ZodObject, AdvertisedInputSchema>();

/**
 * The tool's input as registered with the SDK: accepts habitual argument names, reports actionable
 * validation messages, and lists a clean JSON Schema. Validation is still the zod contract.
 */
export function advertisedInputSchema(input: z.ZodObject): AdvertisedInputSchema {
	const cached = ADVERTISED.get(input);
	if (cached) return cached;
	const standard = input['~standard'];
	let json: Json | undefined;
	const toJson = (): Json => {
		json ??= cleanInputJsonSchema(standard.jsonSchema.input({ target: 'draft-2020-12' })) as Json;
		return json;
	};
	const schema: AdvertisedInputSchema = {
		'~standard': {
			version: standard.version,
			vendor: standard.vendor,
			validate: (value: unknown) => {
				let args: unknown;
				try {
					args = normalizePtcArguments(input, value === undefined ? {} : value);
				} catch (error) {
					if (error instanceof PtcError) return { issues: [{ message: error.message }] };
					throw error;
				}
				const parsed = input.safeParse(args);
				// Return the normalized *input*, not parsed.data: callers (the SDK handler) pass it on to
				// callPtcTool, which parses again, and a transform need not be idempotent (e.g. a uri that
				// parses to {id, kind}).
				if (parsed.success) return { value: args as Record<string, unknown> };
				return { issues: ptcInputIssueMessages(input, parsed.error, args).map((message) => ({ message })) };
			},
			jsonSchema: { input: toJson, output: toJson },
		},
	};
	ADVERTISED.set(input, schema);
	return schema;
}
