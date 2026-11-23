/**
 * Advertised output schemas.
 *
 * The zod output schemas are our response contract: `callPtcTool` validates every result
 * against them, so they carry patterns and length caps. Clients that render `outputSchema`
 * into the prompt (Codex, opencode, fast-agent) pay for all of it on every request, and fx
 * never shows it. So `tools/list` advertises a smaller, *open* schema derived from the contract:
 *
 * - field descriptions are advertised verbatim: write `.describe()` only for notes that change
 *   what a model does (caps, windows, presence, meaning, next steps); anything else is a code
 *   comment. Rules shared by every tool (uri threading, paging, completeness) live once in
 *   PTC_INSTRUCTIONS. Validation-only keywords are dropped (types, enums and consts stay);
 * - records are spelled out to `MINIMAL_DEPTH` object levels. Deeper objects become open
 *   objects, except Hub references (kept as `{kind, id, uri, url}`) and small flat objects;
 * - maps (`record(...)`) keep their value schema as `additionalProperties`, shrunk by the same
 *   depth rule as a property; maps of scalars count as small flat objects, so they stay typed
 *   at any depth (labels, socials, counts, parameters by dtype);
 * - nothing is closed (`additionalProperties: false` is removed), so every result that passes
 *   the contract also passes the advertised schema.
 *
 * Results are unchanged: `structuredContent` is still the full validated record.
 */
import type { z } from 'zod';

type Json = Record<string, unknown>;

/**
 * Object levels spelled out in full. Root fields and the records in root arrays (`items[]`)
 * are level 1; objects nested inside a record are opened unless small and flat.
 */
const MINIMAL_DEPTH = 1;

/** Root bookkeeping objects with no decision value for the caller; advertised as open objects. */
const OPENED_ROOT_FIELDS = new Set(['source', 'truncation']);

/** Deeper objects stay typed when they are this small and flat (e.g. job status, owner). */
const SMALL_FLAT_OBJECT = 6;

/** Keywords that only document or constrain values; the model needs the type, not the bounds. */
const DROPPED_KEYWORDS = new Set([
	'$schema',
	'$id',
	'title',
	'examples',
	'default',
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
	'additionalProperties',
]);

const REFERENCE_KEYS = ['kind', 'id', 'uri', 'url'];

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectSchema(schema: Json): boolean {
	return schema.type === 'object' || isObject(schema.properties) || isObject(schema.additionalProperties);
}

/** A scalar, an array of scalars, or a union of those. */
function isScalarSchema(schema: unknown): boolean {
	if (!isObject(schema)) return true;
	if (isObjectSchema(schema)) return false;
	for (const key of ['anyOf', 'oneOf', 'allOf'])
		if (Array.isArray(schema[key]) && !(schema[key] as unknown[]).every(isScalarSchema)) return false;
	if (schema.items !== undefined) return isScalarSchema(schema.items);
	return true;
}

function isReference(schema: Json): boolean {
	const properties = schema.properties;
	return isObject(properties) && REFERENCE_KEYS.every((key) => key in properties);
}

/** A map (`record(...)`) of scalars, e.g. labels, socials, counts or parameters by dtype. */
function isScalarMap(schema: unknown): boolean {
	return (
		isObject(schema) &&
		isObject(schema.additionalProperties) &&
		!(isObject(schema.properties) && Object.keys(schema.properties).length) &&
		isScalarSchema(schema.additionalProperties)
	);
}

/** Few scalar (or scalar-map) properties, or itself a scalar map: cheap to keep typed at any depth. */
function isSmallFlat(schema: Json): boolean {
	if (isScalarMap(schema)) return true;
	const properties = schema.properties;
	if (!isObject(properties)) return false;
	const values = Object.values(properties);
	return (
		values.length > 0 &&
		values.length <= SMALL_FLAT_OBJECT &&
		values.every((value) => isScalarSchema(value) || isScalarMap(value))
	);
}

function filterRequired(required: unknown, properties: Json): unknown {
	if (!Array.isArray(required)) return required;
	return required.filter((name) => typeof name === 'string' && name in properties);
}

/** An object advertised without its fields; its own description (if any) is still advertised. */
function openObject(schema: Json): Json {
	return typeof schema.description === 'string'
		? { type: 'object', description: schema.description }
		: { type: 'object' };
}

/** `depth` = object levels already entered. */
function shrink(schema: unknown, depth: number): unknown {
	if (!isObject(schema)) return schema;

	if (isObjectSchema(schema) && depth > MINIMAL_DEPTH && !isSmallFlat(schema)) {
		if (!isReference(schema)) return openObject(schema);
		const properties = schema.properties as Json;
		const kept: Json = {};
		for (const key of REFERENCE_KEYS) kept[key] = shrink(properties[key], depth + 1);
		return {
			...openObject(schema),
			properties: kept,
			...(Array.isArray(schema.required) ? { required: filterRequired(schema.required, kept) } : {}),
		};
	}

	const out: Json = {};
	for (const [key, value] of Object.entries(schema)) {
		if (DROPPED_KEYWORDS.has(key)) continue;
		if (key === 'properties' && isObject(value)) {
			const properties: Json = {};
			for (const [name, child] of Object.entries(value)) {
				const opened = depth === 0 && OPENED_ROOT_FIELDS.has(name) && isObject(child) && child.type === 'object';
				properties[name] = opened ? openObject(child) : shrink(child, depth + 1);
			}
			out.properties = properties;
		} else if (key === 'items') {
			// Array items sit at the array's own level, so items[] records are as visible as their array.
			out.items = Array.isArray(value) ? value.map((item) => shrink(item, depth)) : shrink(value, depth);
		} else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
			out[key] = value.map((branch) => shrink(branch, depth));
		} else {
			out[key] = value;
		}
	}
	if (isObject(out.properties) && Array.isArray(out.required))
		out.required = filterRequired(out.required, out.properties);
	// Maps (`record(...)`) keep their value schema, shrunk like a property one level down;
	// `additionalProperties: false` (closed records) is never advertised.
	if (isObject(schema.additionalProperties)) {
		const value = shrink(schema.additionalProperties, depth + 1);
		if (isObject(value) && Object.keys(value).length) out.additionalProperties = value;
		out.type ??= 'object';
	}
	return out;
}

/** The advertised form of an output JSON Schema (pure; exported for tests and tooling). */
export function advertisedOutputJsonSchema(contract: Json): Json {
	return shrink(contract, 0) as Json;
}

/** The target the MCP SDK requests when it converts schemas for `tools/list`. */
export const JSON_SCHEMA_TARGET = 'draft-2020-12';

type StandardProps = z.ZodType['~standard'];

/** Standard Schema accepted by the MCP SDK as an `outputSchema`. */
export interface AdvertisedSchema {
	readonly '~standard': StandardProps;
}

const ADVERTISED = new WeakMap<z.ZodType, AdvertisedSchema>();

/**
 * A Standard Schema to register as a tool's `outputSchema`: it validates with the zod contract
 * and converts to the advertised JSON Schema. Cached per contract, so `tools/list` stays cheap.
 */
export function advertisedOutputSchema(contract: z.ZodType): AdvertisedSchema {
	const cached = ADVERTISED.get(contract);
	if (cached) return cached;
	const standard = contract['~standard'];
	let json: Json | undefined;
	const toJson = (): Json => {
		json ??= advertisedOutputJsonSchema(standard.jsonSchema.output({ target: JSON_SCHEMA_TARGET }));
		return json;
	};
	const schema: AdvertisedSchema = {
		'~standard': {
			version: standard.version,
			vendor: standard.vendor,
			validate: (value: unknown) => standard.validate(value),
			jsonSchema: { input: toJson, output: toJson },
		},
	};
	ADVERTISED.set(contract, schema);
	return schema;
}
