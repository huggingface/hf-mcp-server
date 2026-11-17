/**
 * Advertised output schemas.
 *
 * The zod output schemas are our response contract: `callPtcTool` validates every result
 * against them, so they carry patterns, length caps and long field docs. Clients that render
 * `outputSchema` into the prompt (Codex, opencode, fast-agent) pay for all of that on every
 * request, and fx never shows it. So `tools/list` advertises a smaller, *open* schema derived
 * from the contract:
 *
 * - documentation and validation-only keywords are dropped (types, enums and consts stay),
 *   except the one-line continuation rules on root `returned_count`/`next_cursor`/`next_offset`;
 * - records are spelled out to `MINIMAL_DEPTH` object levels. Deeper objects become open
 *   objects, except Hub references (kept as `{kind, id, uri, url}`) and small flat objects;
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

/** Root properties whose field docs carry continuation rules the model must follow. */
const KEPT_ROOT_DOCS = new Set(['returned_count', 'next_cursor', 'next_offset']);

/** Keywords that only document or constrain values; the model needs the type, not the bounds. */
const DROPPED_KEYWORDS = new Set([
	'$schema',
	'$id',
	'description',
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

function isSmallFlat(schema: Json): boolean {
	const properties = schema.properties;
	if (!isObject(properties)) return false;
	const values = Object.values(properties);
	return values.length > 0 && values.length <= SMALL_FLAT_OBJECT && values.every(isScalarSchema);
}

function filterRequired(required: unknown, properties: Json): unknown {
	if (!Array.isArray(required)) return required;
	return required.filter((name) => typeof name === 'string' && name in properties);
}

/** `depth` = object levels already entered. */
function shrink(schema: unknown, depth: number): unknown {
	if (!isObject(schema)) return schema;

	if (isObjectSchema(schema) && depth > MINIMAL_DEPTH && !isSmallFlat(schema)) {
		if (!isReference(schema)) return { type: 'object' };
		const properties = schema.properties as Json;
		const kept: Json = {};
		for (const key of REFERENCE_KEYS) kept[key] = shrink(properties[key], depth + 1);
		return Array.isArray(schema.required)
			? { type: 'object', properties: kept, required: filterRequired(schema.required, kept) }
			: { type: 'object', properties: kept };
	}

	const out: Json = {};
	for (const [key, value] of Object.entries(schema)) {
		if (DROPPED_KEYWORDS.has(key)) continue;
		if (key === 'properties' && isObject(value)) {
			const properties: Json = {};
			for (const [name, child] of Object.entries(value)) {
				const opened = depth === 0 && OPENED_ROOT_FIELDS.has(name) && isObject(child) && child.type === 'object';
				const shrunk = opened ? { type: 'object' } : shrink(child, depth + 1);
				if (depth === 0 && KEPT_ROOT_DOCS.has(name) && isObject(child) && typeof child.description === 'string')
					properties[name] = { ...(shrunk as Json), description: child.description };
				else properties[name] = shrunk;
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
	// Maps (`record(...)`) lose their value schema; still say they are objects.
	if (isObject(schema.additionalProperties) && out.type === undefined) out.type = 'object';
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
