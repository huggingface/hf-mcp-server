import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PTC_TOOLS } from '../index.js';
import { JSON_SCHEMA_TARGET, advertisedOutputJsonSchema, advertisedOutputSchema } from './wire-schema.js';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validator for the keyword subset the advertised schemas use. Returns the first failure path. */
function validates(schema: unknown, value: unknown, path = '$'): string | null {
	if (!isObject(schema)) return null;
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => validates(branch, value, path) === null))
		return `${path}: no anyOf branch`;
	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter((branch) => validates(branch, value, path) === null).length;
		if (matches !== 1) return `${path}: ${String(matches)} oneOf branches match`;
	}
	if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${path}: const`;
	if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
		return `${path}: enum`;
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const actual =
			value === null
				? 'null'
				: Array.isArray(value)
					? 'array'
					: typeof value === 'number'
						? Number.isInteger(value)
							? 'integer'
							: 'number'
						: typeof value;
		const ok = types.some((type) => type === actual || (type === 'number' && actual === 'integer'));
		if (!ok) return `${path}: type ${actual} not ${types.join('|')}`;
	}
	if (isObject(value)) {
		if (Array.isArray(schema.required))
			for (const name of schema.required) if (!(name in value)) return `${path}.${String(name)}: required`;
		if (schema.additionalProperties === false && isObject(schema.properties))
			for (const name of Object.keys(value)) if (!(name in schema.properties)) return `${path}.${name}: additional`;
		if (isObject(schema.properties))
			for (const [name, child] of Object.entries(schema.properties))
				if (name in value) {
					const failure = validates(child, value[name], `${path}.${name}`);
					if (failure) return failure;
				}
		if (isObject(schema.additionalProperties))
			for (const [name, child] of Object.entries(value))
				if (!isObject(schema.properties) || !(name in schema.properties)) {
					const failure = validates(schema.additionalProperties, child, `${path}.${name}`);
					if (failure) return failure;
				}
	}
	if (Array.isArray(value) && schema.items !== undefined)
		for (const [index, item] of value.entries()) {
			const failure = validates(schema.items, item, `${path}[${index}]`);
			if (failure) return failure;
		}
	return null;
}

function walk(schema: unknown, visit: (node: Json) => void): void {
	if (Array.isArray(schema)) for (const item of schema) walk(item, visit);
	else if (isObject(schema)) {
		visit(schema);
		for (const value of Object.values(schema)) walk(value, visit);
	}
}

/** Every `description` string in a schema, one entry per occurrence. */
function descriptions(schema: unknown): string[] {
	const found: string[] = [];
	walk(schema, (node) => {
		if (typeof node.description === 'string') found.push(node.description);
	});
	return found;
}

/** Size on the wire: UTF-8 bytes of the string, or of the compact JSON of anything else. */
function utf8Bytes(value: unknown): number {
	return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

/** Description per visible schema path: `.name` property, `[]` array items, `|n` union branch, `{}` map values. */
function annotations(schema: unknown, path = '$', out = new Map<string, string>()): Map<string, string> {
	if (!isObject(schema)) return out;
	if (typeof schema.description === 'string') out.set(path, schema.description);
	if (isObject(schema.properties))
		for (const [name, child] of Object.entries(schema.properties)) annotations(child, `${path}.${name}`, out);
	if (schema.items !== undefined) annotations(schema.items, `${path}[]`, out);
	if (isObject(schema.additionalProperties)) annotations(schema.additionalProperties, `${path}{}`, out);
	for (const key of ['anyOf', 'oneOf', 'allOf'])
		if (Array.isArray(schema[key]))
			(schema[key] as unknown[]).forEach((branch, index) => annotations(branch, `${path}|${String(index)}`, out));
	return out;
}

/**
 * Documented fields deliberately not advertised in one tool, where the same record is spelled out elsewhere:
 * - a Hub reference is reduced to {kind, id, uri, url}, so profile organizations[] drop role (advertised in
 *   hf_org_members and hf_follow_graph);
 * - hf_sandbox_status processes are opened below MINIMAL_DEPTH; their parent says where items[].id goes, and the
 *   process record is spelled out in hf_sandbox_exec and hf_sandbox_kill.
 */
const INTENTIONALLY_OPENED = [
	'hf_profile_get $.items[]|0.organizations[].role',
	'hf_sandbox_status $.processes.items[].id',
	'hf_sandbox_status $.processes.items[].command',
];

function advertised(tool: (typeof PTC_TOOLS)[number]): Json {
	return advertisedOutputSchema(tool.output)['~standard'].jsonSchema.output({ target: JSON_SCHEMA_TARGET });
}

describe('advertised output schemas', () => {
	it('are open and free of validation-only keywords', () => {
		for (const tool of PTC_TOOLS) {
			const schema = advertised(tool);
			expect(schema.type, tool.name).toBe('object');
			walk(schema, (node) => {
				// Open: never `false`; maps keep a value schema.
				if (node.additionalProperties !== undefined) expect(isObject(node.additionalProperties), tool.name).toBe(true);
				for (const [key, value] of Object.entries(node)) expect(value, `${tool.name} ${key}`).not.toBeUndefined();
				for (const keyword of [
					'$schema',
					'pattern',
					'format',
					'minLength',
					'maxLength',
					'minimum',
					'maximum',
					'maxItems',
				])
					expect(node[keyword], `${tool.name} ${keyword}`).toBeUndefined();
				if (Array.isArray(node.required) && isObject(node.properties))
					for (const name of node.required)
						expect(node.properties, `${tool.name} required ${String(name)}`).toHaveProperty(String(name));
			});
		}
	});

	it('advertise each written description verbatim on the same field', () => {
		for (const tool of PTC_TOOLS) {
			const written = annotations(z.toJSONSchema(tool.output, { io: 'output', target: JSON_SCHEMA_TARGET }));
			const sent = annotations(advertised(tool));
			for (const [path, text] of written) {
				if (sent.has(path)) expect(sent.get(path), `${tool.name} ${path}`).toBe(text);
				else
					expect(INTENTIONALLY_OPENED, `${tool.name} ${path}: describe the parent or use a code comment`).toContain(
						`${tool.name} ${path}`
					);
			}
		}
	});

	it('advertise every output field description that is written somewhere (no dead prose)', () => {
		// A shared record may be opened in one tool and spelled out in another (e.g. people in
		// hf_profile_get organizations[] vs hf_org_members items[]): each text must be sent somewhere.
		const written = new Set(
			PTC_TOOLS.flatMap((tool) =>
				descriptions(z.toJSONSchema(tool.output, { io: 'output', target: JSON_SCHEMA_TARGET }))
			)
		);
		const sent = new Set(PTC_TOOLS.flatMap((tool) => descriptions(advertised(tool))));
		const dead = [...written].filter((text) => !sent.has(text));
		expect(dead, 'describe opened fields in code comments, or document the parent').toEqual([]);
	});

	it('keep the golden caveats and none of the removed boilerplate', () => {
		const field = (name: string, ...path: string[]): Json => {
			let node = advertised(PTC_TOOLS.find((tool) => tool.name === name) as (typeof PTC_TOOLS)[number]);
			for (const key of path) node = (key === '[]' ? node.items : (node.properties as Json)[key]) as Json;
			return node;
		};
		expect(field('hf_profile_get', 'items', '[]').anyOf).toBeDefined();
		const profile = (field('hf_profile_get', 'items', '[]').anyOf as Json[])[0] as Json;
		expect(((profile.properties as Json).organizations as Json).description).toMatch(/first 100/i);
		expect(field('hf_repo_info', 'items', '[]').anyOf).toBeDefined();
		const repo = ((field('hf_repo_info', 'items', '[]').anyOf as Json[])[0] as Json).properties as Json;
		expect((repo.baseModels as Json).description).toMatch(/first 20/i);
		expect((repo.downloads as Json).description).toMatch(/30 days/);
		expect((repo.chatTemplate as Json).description).toMatch(/only when requested in fields/i);
		expect(field('hf_models_search', 'items', '[]', 'numParameters').description).toMatch(/GGUF/);
		expect(field('hf_hub_lookup', 'numByKind').description).toBeDefined();

		const sent = JSON.stringify(PTC_TOOLS.map(advertised));
		for (const boilerplate of [
			'MAX_SAFE_INTEGER',
			'as returned by upstream',
			'not fabricated',
			'No snapshot or total guarantee',
			'no continuation will return',
			'Canonical Hugging Face repository page',
			'usable by Hub filesystem/inspection tools',
			'Hub repository ID, normally owner/name',
			'pass verbatim to other',
			'Human-facing huggingface.co page',
			'never a total',
		])
			expect(sent).not.toContain(boilerplate);
	});

	it('count UTF-8 bytes, not UTF-16 code units', () => {
		expect('…'.length).toBe(1);
		expect(utf8Bytes('…')).toBe(3);
		expect(utf8Bytes({ description: 'é' })).toBe(JSON.stringify({ description: 'é' }).length + 1);
	});

	it('stay within the tools/list byte budget, descriptions included', () => {
		let listed = 0;
		let documented = 0;
		for (const tool of PTC_TOOLS) {
			const schema = advertised(tool);
			listed += utf8Bytes(schema);
			for (const text of descriptions(schema)) documented += utf8Bytes(text);
		}
		// Curated 2026-11-18: 53 tools, about 70,000 UTF-8 bytes advertised, of which about 6,500 are descriptions.
		expect(listed).toBeLessThan(76_000);
		expect(documented).toBeLessThan(8_000);
	});

	it('accept everything the contract accepts, including extra and deep fields', () => {
		const contract = z.object({
			kind: z.literal('model'),
			id: z
				.string()
				.regex(/^[\w.-]+$/)
				.max(10),
			nextCursor: z.string().nullable().describe('Pass back as cursor.'),
			items: z.array(
				z.object({
					id: z.string(),
					likes: z.number().int().min(0),
					status: z.object({ stage: z.enum(['RUNNING', 'ERROR']), message: z.string().nullable() }).strict(),
					deep: z
						.object({ a: z.object({ b: z.string() }), c: z.array(z.object({ d: z.number() })) })
						.strict()
						.describe('Opened, but its own doc is sent.'),
					ref: z.object({
						kind: z.literal('space'),
						id: z.string(),
						uri: z.string(),
						url: z.string(),
						extra: z.object({ y: z.string() }),
					}),
					map: z.record(z.string(), z.number()),
				})
			),
			union: z.union([z.object({ x: z.string() }).strict(), z.object({ error: z.string() }).strict()]),
		});
		const value = {
			kind: 'model',
			id: 'a',
			nextCursor: null,
			items: [
				{
					id: 'x',
					likes: 3,
					status: { stage: 'RUNNING', message: null },
					deep: { a: { b: 'q' }, c: [{ d: 1 }] },
					ref: {
						kind: 'space',
						id: 'o/s',
						uri: 'hf://spaces/o/s',
						url: 'https://huggingface.co/spaces/o/s',
						extra: { y: 'e' },
					},
					map: { bf16: 1 },
				},
			],
			union: { error: 'nope' },
		};
		expect(contract.safeParse(value).success).toBe(true);
		const schema = advertisedOutputJsonSchema(z.toJSONSchema(contract, { io: 'output', target: JSON_SCHEMA_TARGET }));
		expect(validates(schema, value)).toBeNull();
		// Deep records are opened, small flat ones and references stay typed, descriptions are kept.
		const item = ((schema.properties as Json).items as Json).items as Json;
		expect((item.properties as Json).deep).toEqual({ type: 'object', description: 'Opened, but its own doc is sent.' });
		expect(Object.keys(((item.properties as Json).status as Json).properties as Json)).toEqual(['stage', 'message']);
		expect(Object.keys(((item.properties as Json).ref as Json).properties as Json)).toEqual([
			'kind',
			'id',
			'uri',
			'url',
		]);
		expect(((schema.properties as Json).nextCursor as Json).description).toBe('Pass back as cursor.');
	});

	it('keep the value schema of maps', () => {
		const lookup = advertised(PTC_TOOLS.find((tool) => tool.name === 'hf_hub_lookup') as (typeof PTC_TOOLS)[number]);
		const properties = lookup.properties as Json;
		expect(properties.numByKind).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
		const items = properties.items as Json;
		expect(items.type).toBe('array');
		expect((items.items as Json).type).toBe('object');
		expect(validates(lookup, { items: [{ kind: 'model' }], returnedCount: 1, numByKind: { model: 1 } })).toBe(
			'$.items[0].id: required'
		);
		expect(validates(lookup, { items: [], returnedCount: 0, numByKind: { model: 'many' } })).toBe(
			'$.numByKind.model: type string not number'
		);

		const contract = z.object({
			items: z.array(
				z.object({
					socials: z.record(z.string(), z.string()),
					safetensors: z.object({ total: z.number(), parameters: z.record(z.string(), z.number()) }),
					deep: z.object({ a: z.record(z.string(), z.object({ b: z.object({ c: z.string() }) })) }),
				})
			),
			labels: z.record(z.string(), z.enum(['a', 'b'])),
			closed: z.object({ x: z.string() }).strict(),
		});
		const schema = advertisedOutputJsonSchema(z.toJSONSchema(contract, { io: 'output', target: JSON_SCHEMA_TARGET }));
		const item = ((schema.properties as Json).items as Json).items as Json;
		const itemProps = item.properties as Json;
		expect(itemProps.socials).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
		expect(((itemProps.safetensors as Json).properties as Json).parameters).toEqual({
			type: 'object',
			additionalProperties: { type: 'number' },
		});
		expect(itemProps.deep).toEqual({ type: 'object' });
		expect((schema.properties as Json).labels).toEqual({
			type: 'object',
			additionalProperties: { type: 'string', enum: ['a', 'b'] },
		});
		expect(((schema.properties as Json).closed as Json).additionalProperties).toBeUndefined();
	});

	it('test validator: oneOf needs exactly one matching branch', () => {
		const schema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
		expect(validates(schema, 1.5)).toBeNull();
		expect(validates(schema, 1)).toBe('$: 2 oneOf branches match');
		expect(validates(schema, 'x')).toBe('$: 0 oneOf branches match');
	});

	it('validate results with the zod contract', () => {
		const contract = PTC_TOOLS.find((candidate) => candidate.name === 'hf_whoami')?.output;
		if (!contract) throw new Error('hf_whoami missing');
		const standard = advertisedOutputSchema(contract)['~standard'];
		const result = standard.validate({ nonsense: true }) as { issues?: unknown[] };
		expect(result.issues?.length).toBeGreaterThan(0);
		expect(advertisedOutputSchema(contract)).toBe(advertisedOutputSchema(contract));
	});
});
