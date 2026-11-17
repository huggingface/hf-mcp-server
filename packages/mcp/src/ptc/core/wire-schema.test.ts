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
	for (const key of ['anyOf', 'oneOf'] as const) {
		const branches = schema[key];
		if (Array.isArray(branches) && !branches.some((branch) => validates(branch, value, path) === null))
			return `${path}: no ${key} branch`;
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

function advertised(tool: (typeof PTC_TOOLS)[number]): Json {
	return advertisedOutputSchema(tool.output)['~standard'].jsonSchema.output({ target: JSON_SCHEMA_TARGET });
}

describe('advertised output schemas', () => {
	it('are open, undocumented below the root and free of validation-only keywords', () => {
		for (const tool of PTC_TOOLS) {
			const schema = advertised(tool);
			expect(schema.type, tool.name).toBe('object');
			walk(schema, (node) => {
				expect(node.additionalProperties, tool.name).toBeUndefined();
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
			const documented = Object.entries((schema.properties ?? {}) as Json).filter(
				([, child]) => isObject(child) && 'description' in child
			);
			for (const [name] of documented)
				expect(['returned_count', 'next_cursor', 'next_offset'], tool.name).toContain(name);
		}
	});

	it('stay within the tools/list byte budget', () => {
		let contract = 0;
		let listed = 0;
		for (const tool of PTC_TOOLS) {
			contract += JSON.stringify(z.toJSONSchema(tool.output, { io: 'output', target: JSON_SCHEMA_TARGET })).length;
			listed += JSON.stringify(advertised(tool)).length;
		}
		expect(listed).toBeLessThan(contract * 0.55);
		expect(listed).toBeLessThan(72_000);
	});

	it('accept everything the contract accepts, including extra and deep fields', () => {
		const contract = z.object({
			kind: z.literal('model'),
			id: z
				.string()
				.regex(/^[\w.-]+$/)
				.max(10),
			next_cursor: z.string().nullable().describe('Pass back as cursor.'),
			items: z.array(
				z.object({
					id: z.string(),
					likes: z.number().int().min(0),
					status: z.object({ stage: z.enum(['RUNNING', 'ERROR']), message: z.string().nullable() }).strict(),
					deep: z.object({ a: z.object({ b: z.string() }), c: z.array(z.object({ d: z.number() })) }).strict(),
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
			next_cursor: null,
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
		// Deep records are opened, small flat ones and references stay typed, root rules keep their doc.
		const item = ((schema.properties as Json).items as Json).items as Json;
		expect((item.properties as Json).deep).toEqual({ type: 'object' });
		expect(Object.keys(((item.properties as Json).status as Json).properties as Json)).toEqual(['stage', 'message']);
		expect(Object.keys(((item.properties as Json).ref as Json).properties as Json)).toEqual([
			'kind',
			'id',
			'uri',
			'url',
		]);
		expect(((schema.properties as Json).next_cursor as Json).description).toBe('Pass back as cursor.');
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
