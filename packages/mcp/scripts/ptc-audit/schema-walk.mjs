/**
 * Schema walking for the PTC audit. Works on plain JSON Schema (zod toJSONSchema output or a live
 * tools/list), so the same checks run against the built registry and a running server.
 *
 * A "field" is one property at one path: { tool, side, path, name, parent, types, enum, description,
 * required, siblingKind }. Union branches (anyOf/oneOf/allOf) are merged per path.
 */

const COMPOSITES = ['anyOf', 'oneOf', 'allOf'];

function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON types of a schema node, flattened over unions; arrays are reported as `array<inner>`. */
export function typeSignature(schema) {
	if (!isObject(schema)) return new Set(['any']);
	const out = new Set();
	for (const key of COMPOSITES)
		if (Array.isArray(schema[key])) for (const branch of schema[key]) for (const t of typeSignature(branch)) out.add(t);
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	for (const t of types) {
		if (t === 'array') {
			const inner = [...typeSignature(schema.items ?? {})].filter((x) => x !== 'null').sort();
			out.add(`array<${inner.join('|') || 'any'}>`);
		} else out.add(t);
	}
	if (!types.length && schema.const !== undefined) out.add(schema.const === null ? 'null' : typeof schema.const);
	if (!types.length && Array.isArray(schema.enum)) for (const v of schema.enum) out.add(v === null ? 'null' : typeof v);
	if (!types.length && (isObject(schema.properties) || isObject(schema.additionalProperties))) out.add('object');
	return out;
}

/** Normalized signature for cross-tool comparison: integer == number, null dropped. */
export function normalizedSignature(types) {
	const out = new Set();
	for (const t of types) {
		if (t === 'null' || t === 'any') continue;
		out.add(t.replace(/integer/g, 'number'));
	}
	return [...out].sort().join('|') || 'any';
}

function enumValues(schema, acc = new Set()) {
	if (!isObject(schema)) return acc;
	if (Array.isArray(schema.enum)) for (const v of schema.enum) if (v !== null) acc.add(v);
	if (schema.const !== undefined && schema.const !== null) acc.add(schema.const);
	for (const key of COMPOSITES) if (Array.isArray(schema[key])) for (const b of schema[key]) enumValues(b, acc);
	if (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array')))
		enumValues(schema.items, acc);
	return acc;
}

function description(schema) {
	if (!isObject(schema)) return undefined;
	if (typeof schema.description === 'string') return schema.description;
	for (const key of COMPOSITES)
		if (Array.isArray(schema[key]))
			for (const b of schema[key]) {
				const d = description(b);
				if (d) return d;
			}
	return undefined;
}

/** Object branches of a node (unions and arrays of objects are unwrapped). */
function objectBranches(schema, acc = []) {
	if (!isObject(schema)) return acc;
	for (const key of COMPOSITES) if (Array.isArray(schema[key])) for (const b of schema[key]) objectBranches(b, acc);
	if (isObject(schema.properties) || isObject(schema.additionalProperties)) acc.push(schema);
	return acc;
}

function arrayItems(schema, acc = []) {
	if (!isObject(schema)) return acc;
	for (const key of COMPOSITES) if (Array.isArray(schema[key])) for (const b of schema[key]) arrayItems(b, acc);
	if (schema.items) acc.push(schema.items);
	return acc;
}

/**
 * Walk one tool side. Returns fields keyed by path (merged over union branches) and the object
 * nodes seen ("records"), each with its path and property names.
 */
export function walkSide(tool, side, root) {
	const fields = new Map();
	const records = [];
	const visit = (schema, path, depth) => {
		if (depth > 12) return;
		for (const obj of objectBranches(schema)) {
			const props = isObject(obj.properties) ? obj.properties : {};
			const required = new Set(Array.isArray(obj.required) ? obj.required : []);
			const kindValues = props.kind ? [...enumValues(props.kind)] : [];
			records.push({ tool, side, path, props: Object.keys(props), kindValues, schema: obj });
			for (const [name, child] of Object.entries(props)) {
				const childPath = path ? `${path}.${name}` : name;
				const prev = fields.get(childPath);
				const types = typeSignature(child);
				const values = enumValues(child);
				if (prev) {
					for (const t of types) prev.types.add(t);
					for (const v of values) prev.enum.add(v);
					prev.required = prev.required && required.has(name);
					prev.description ??= description(child);
				} else {
					fields.set(childPath, {
						tool,
						side,
						path: childPath,
						name,
						parent: path,
						types,
						enum: values,
						description: description(child),
						required: required.has(name),
						siblingKind: kindValues,
						depth: childPath.split('.').length,
					});
				}
				visit(child, childPath, depth + 1);
				for (const item of arrayItems(child)) visit(item, `${childPath}[]`, depth + 1);
			}
			if (isObject(obj.additionalProperties)) {
				const childPath = path ? `${path}.*` : '*';
				visit(obj.additionalProperties, childPath, depth + 1);
				for (const item of arrayItems(obj.additionalProperties)) visit(item, `${childPath}[]`, depth + 1);
			}
		}
		if (!path) for (const item of arrayItems(schema)) visit(item, '[]', depth + 1);
	};
	visit(root, '', 0);
	return { fields: [...fields.values()], records };
}

/** Normalize a tool list (registry or live) into the shape the audit consumes. */
export function normalizeTools(tools) {
	return tools.map((t) => {
		const input = walkSide(t.name, 'in', t.inputSchema);
		const output = walkSide(t.name, 'out', t.outputSchema);
		return {
			name: t.name,
			family: t.family,
			access: t.access,
			description: t.description ?? '',
			inputSchema: t.inputSchema,
			outputSchema: t.outputSchema,
			inputs: input.fields,
			outputs: output.fields,
			inputRecords: input.records,
			outputRecords: output.records,
		};
	});
}
