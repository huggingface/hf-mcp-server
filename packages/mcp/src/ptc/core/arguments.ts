/**
 * Argument handling shared by the MCP SDK path (`advertisedInputSchema`) and `callPtcTool`.
 *
 * Models guess argument names from habit (`repo_id`, `dataset_id`, `url`, `q`). When the intended
 * argument is unambiguous we accept the alias; otherwise the validation message names the
 * valid arguments and describes any missing required one, so the next call can be corrected.
 */
import type { z } from 'zod';

type Json = Record<string, unknown>;

/** A habitual name, optionally only for values of a given form. */
interface Alias {
	name: string;
	when?: (value: unknown) => boolean;
}
type AliasSpec = string | Alias;

const FULL_URI = /^(?:hf:\/\/|https?:\/\/)/i;
const isFullUri = (value: unknown): boolean => typeof value === 'string' && FULL_URI.test(value.trim());

/** Person arguments: a tool with exactly one of these accepts the others (and the record fields) as aliases. */
const PERSON_ARGS = ['handles', 'handle', 'user', 'org', 'entity'] as const;
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

/**
 * Canonical argument -> habitual names, including the record field the value usually comes from
 * (uri, url, id). Applied only when the tool has the canonical argument, the canonical argument is
 * not given, the tool does not itself define the alias, and no other argument of the tool claims it.
 */
const ALIASES: Record<string, readonly AliasSpec[]> = {
	ref: ['repo_id', 'repo', 'repository', 'repo_ref', 'model_id', 'dataset_id', 'space_id', 'id', 'uri', 'url'],
	refs: [
		'repo_ids',
		'repos',
		'repositories',
		'model_ids',
		'ids',
		'uris',
		'urls',
		'repo_id',
		'repo',
		'model_id',
		'dataset_id',
		'space_id',
		'ref',
		'id',
		'uri',
		'url',
	],
	uri: ['url', 'file_uri', 'file_url', 'link', { name: 'ref', when: isFullUri }, { name: 'path', when: isFullUri }],
	dataset: ['dataset_id', 'repo_id', 'repo', 'dataset_name', 'ref', 'uri', 'url', 'id'],
	space: ['space_id', 'repo_id', 'repo', 'ref', 'uri', 'url', 'id'],
	collection: ['collection_id', 'slug', 'ref', 'uri', 'url', 'id'],
	query: ['q', 'search', 'search_query', 'keywords'],
	limit: ['max_results', 'top_k', 'page_size'],
	paper_ids: ['paper_id', 'arxiv_id', 'arxiv_ids', 'ids', 'uris', 'urls', 'id', 'uri', 'url'],
	paper_id: ['arxiv_id', 'paper_ids', 'arxiv_ids', 'id', 'uri', 'url'],
	...Object.fromEntries(PERSON_ARGS.map((name) => [name, PERSON_ALIASES.filter((alias) => alias !== name)])),
	job_id: ['id', 'job', 'job_url', 'url'],
	sandbox: ['sandbox_id', 'handle', 'id'],
	kind: ['repo_type'],
};

function aliasName(spec: AliasSpec): string {
	return typeof spec === 'string' ? spec : spec.name;
}

/** Canonical arguments of this tool that would take `args[name]` under the alias table. */
function claimants(shape: Record<string, z.ZodType>, args: Json, name: string): string[] {
	const out: string[] = [];
	for (const [canonical, specs] of Object.entries(ALIASES)) {
		if (!(canonical in shape) || args[canonical] !== undefined) continue;
		if (PERSON_ARGS.includes(canonical as (typeof PERSON_ARGS)[number]) && personArgCount(shape) !== 1) continue;
		const spec = specs.find((candidate) => aliasName(candidate) === name);
		if (spec && (typeof spec === 'string' || !spec.when || spec.when(args[name]))) out.push(canonical);
	}
	return out;
}

function personArgCount(shape: Record<string, z.ZodType>): number {
	return PERSON_ARGS.filter((name) => name in shape).length;
}

const REPO_KIND_PREFIX: Record<string, string> = {
	model: 'models',
	dataset: 'datasets',
	space: 'spaces',
	bucket: 'buckets',
};
const REPO_KEYS = ['ref', 'repo_id', 'repo', 'repository', 'model_id', 'dataset_id', 'space_id'];
const PATH_KEYS = ['path', 'filename', 'file_path', 'file'];
const BARE_ID = /^[\w.-]+\/[\w.-]+$/;
const IDENTIFIER = /^[A-Za-z_][\w-]{0,63}$/;

function unwrap(schema: z.ZodType): z.ZodType {
	let current = schema;
	for (let i = 0; i < 5; i++) {
		const def = (current as { def?: { type?: string; innerType?: z.ZodType; in?: z.ZodType } }).def;
		if (!def) break;
		if ((def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType)
			current = def.innerType;
		else if (def.type === 'pipe' && def.in) current = def.in;
		else break;
	}
	return current;
}

function isArraySchema(schema: z.ZodType | undefined): boolean {
	return schema !== undefined && (unwrap(schema) as { def?: { type?: string } }).def?.type === 'array';
}

function shapeOf(input: z.ZodObject): Record<string, z.ZodType> {
	return input.shape;
}

/** hf://KINDS/OWNER/NAME for a bare ID and a known kind; anything else is returned unchanged. */
function qualify(value: unknown, kind: unknown, aliasKey?: string): unknown {
	if (typeof value !== 'string' || !BARE_ID.test(value.trim())) return value;
	const inferred =
		typeof kind === 'string'
			? kind
			: aliasKey === 'dataset_id'
				? 'dataset'
				: aliasKey === 'space_id'
					? 'space'
					: undefined;
	const prefix = inferred ? REPO_KIND_PREFIX[inferred] : undefined;
	return prefix ? `hf://${prefix}/${value.trim()}` : value;
}

/**
 * Rename unambiguous habitual argument names to the tool's own. Pure: returns a new object, or
 * the input when nothing applies. Never invents values.
 */
export function normalizePtcArguments(input: z.ZodObject, raw: unknown): unknown {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
	const shape = shapeOf(input);
	const args: Json = { ...(raw as Json) };
	let changed = false;

	// {repo_id, path} for a tool that takes a single file uri: build the uri.
	if ('uri' in shape && !('path' in shape) && !('ref' in shape) && args.uri === undefined) {
		const repoKey = REPO_KEYS.find((key) => typeof args[key] === 'string');
		const pathKey = PATH_KEYS.find((key) => typeof args[key] === 'string');
		if (repoKey && pathKey) {
			const repo = String(qualify(args[repoKey], args.repo_type ?? args.kind, repoKey));
			const base = repo.startsWith('hf://') ? repo : BARE_ID.test(repo) ? `hf://models/${repo}` : undefined;
			if (base) {
				args.uri = `${base.replace(/\/+$/, '')}/${String(args[pathKey]).replace(/^\/+/, '')}`;
				for (const key of [repoKey, pathKey, 'repo_type']) if (!(key in shape)) delete args[key];
				changed = true;
			}
		}
	}

	for (const [canonical, specs] of Object.entries(ALIASES)) {
		if (!(canonical in shape) || args[canonical] !== undefined) continue;
		const alias = specs
			.map(aliasName)
			.find(
				(name) => !(name in shape) && args[name] !== undefined && claimants(shape, args, name).join() === canonical
			);
		if (!alias) continue;
		let value = args[alias];
		// A repository kind given separately (repo_type) qualifies a bare owner/name when the tool has no kind.
		if (
			(canonical === 'ref' || canonical === 'refs' || canonical === 'dataset' || canonical === 'space') &&
			!('kind' in shape)
		) {
			value = Array.isArray(value)
				? value.map((item) => qualify(item, args.repo_type, alias))
				: qualify(value, args.repo_type, alias);
			if (args.repo_type !== undefined && !('repo_type' in shape)) delete args.repo_type;
		}
		if (isArraySchema(shape[canonical])) {
			if (!Array.isArray(value)) value = [value];
		} else if (Array.isArray(value) && value.length === 1) value = value[0];
		args[canonical] = value;
		delete args[alias];
		changed = true;
	}
	// repo_type next to an already-named repository argument, for a tool without kind.
	if (args.repo_type !== undefined && !('repo_type' in shape) && !('kind' in shape)) {
		const target = ['ref', 'refs', 'dataset', 'space'].find((key) => key in shape && args[key] !== undefined);
		if (target) {
			const value = args[target];
			args[target] = Array.isArray(value)
				? value.map((item) => qualify(item, args.repo_type))
				: qualify(value, args.repo_type);
			delete args.repo_type;
			changed = true;
		}
	}
	return changed ? args : raw;
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
				const args = normalizePtcArguments(input, value === undefined ? {} : value);
				const parsed = input.safeParse(args);
				if (parsed.success) return { value: parsed.data };
				return { issues: ptcInputIssueMessages(input, parsed.error, args).map((message) => ({ message })) };
			},
			jsonSchema: { input: toJson, output: toJson },
		},
	};
	ADVERTISED.set(input, schema);
	return schema;
}
