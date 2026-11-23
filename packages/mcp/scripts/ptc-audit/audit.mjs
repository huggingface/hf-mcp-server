/**
 * Static PTC audit: naming consistency, envelopes, reference records, description pointers and
 * the producer -> consumer graph. Pure functions over normalized tools (see schema-walk.mjs).
 */
import { normalizedSignature } from './schema-walk.mjs';
import {
	CONCEPTS,
	CONSUMERS,
	FREE_INPUTS,
	IDENTIFIER_NAME,
	KIND_TO_TYPE,
	OPEN_KIND_RECORDS,
	SCALAR_PRODUCERS,
	effectiveTypes,
	producerTypes,
} from './rules.mjs';

/** NAMING-SPEC R1: every key is camelCase; snake_case names are findings. */
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const loose = (s) => s.replace(/[_-]/g, '').toLowerCase();
/** Opaque upstream data (config.json keys) keeps its own names (R1.4). */
const OPAQUE_PATH = /(^|\.)config\./;

function finding(check, severity, tool, path, message, extra = {}) {
	return { check, severity, tool, path, message, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

export function nameInventory(tools) {
	const concepts = [];
	for (const concept of CONCEPTS) {
		const byName = {};
		for (const tool of tools) {
			const sides = concept.side === 'both' ? ['inputs', 'outputs'] : [concept.side === 'in' ? 'inputs' : 'outputs'];
			for (const side of sides)
				for (const f of tool[side]) {
					if (!concept.names.test(f.name)) continue;
					if (concept.pathFilter && !concept.pathFilter(f)) continue;
					(byName[f.name] ??= new Set()).add(
						`${tool.name}${side === 'inputs' ? '(' : ':'}${f.path}${side === 'inputs' ? ')' : ''}`
					);
				}
		}
		const names = Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, [...v].sort()]));
		concepts.push({
			id: concept.id,
			side: concept.side,
			preferred: concept.preferred,
			distinct: Object.keys(names).length,
			names,
		});
	}
	return concepts;
}

// ---------------------------------------------------------------------------------------------
// Naming checks
// ---------------------------------------------------------------------------------------------

export function checkNaming(tools) {
	const out = [];
	for (const tool of tools) {
		for (const f of [...tool.inputs, ...tool.outputs]) {
			if (SNAKE.test(f.name) && !OPAQUE_PATH.test(f.path))
				out.push(
					finding('snake_case_name', 'should', tool.name, `${f.side}:${f.path}`, `property "${f.name}" is snake_case`, {
						fix: `rename to ${camel(f.name)}`,
					})
				);
		}
		// field-name vocabularies must use the camelCase field names
		for (const f of tool.inputs) {
			const snakeValues = [...f.enum].filter((v) => typeof v === 'string' && SNAKE.test(v));
			if (snakeValues.length && ['sort', 'fields'].includes(f.name))
				out.push(
					finding(
						'snake_case_enum',
						'should',
						tool.name,
						`in:${f.path}`,
						`${f.name} values in snake_case: ${snakeValues.join(', ')}`,
						{ fix: `use ${snakeValues.map(camel).join(', ')} (snake stays an input alias)` }
					)
				);
		}
	}
	return out;
}

/** `fields` / `sort` values must name output properties of the returned records. */
export function checkVocabularyMatchesOutput(tools) {
	const out = [];
	for (const tool of tools) {
		const recordNames = new Set(
			tool.outputs.filter((f) => /^items(\[\])?\.[^.]+$/.test(f.path) || f.depth === 1).map((f) => f.name)
		);
		for (const argName of ['fields', 'sort', 'include']) {
			const arg = tool.inputs.find((f) => f.name === argName);
			if (!arg) continue;
			for (const value of arg.enum) {
				if (typeof value !== 'string') continue;
				if (recordNames.has(value)) continue;
				const s = [...recordNames].find((name) => loose(name) === loose(value));
				const bucket = s ? 'case_only' : 'renamed_or_absent';
				if (argName === 'sort' && ['asc', 'desc', 'recent', 'trending'].includes(value)) continue;
				if (argName === 'include' && bucket === 'renamed_or_absent' && recordNames.has(value)) continue;
				out.push(
					finding(
						'vocabulary_vs_output',
						bucket === 'case_only' ? 'should' : 'info',
						tool.name,
						`in:${argName}=${value}`,
						bucket === 'case_only'
							? `${argName} value "${value}" returns output field "${s}"`
							: `${argName} value "${value}" has no output field of that name`,
						{ bucket, output_name: bucket === 'case_only' ? s : undefined }
					)
				);
			}
		}
	}
	return out;
}

/** The same property name with different JSON types across tools. */
export function checkTypeConflicts(tools) {
	const byName = new Map();
	for (const tool of tools)
		for (const f of [...tool.inputs, ...tool.outputs]) {
			const sig = normalizedSignature(f.types);
			if (sig === 'any') continue;
			const entry = byName.get(f.name) ?? new Map();
			const list = entry.get(sig) ?? [];
			list.push(`${tool.name}${f.side === 'in' ? '(' : ':'}${f.path}${f.side === 'in' ? ')' : ''}`);
			entry.set(sig, list);
			byName.set(f.name, entry);
		}
	const out = [];
	for (const [name, sigs] of byName) {
		if (sigs.size < 2) continue;
		// in/out pairs where the input is a string ref and the output is the resolved record are by design
		const variants = Object.fromEntries(
			[...sigs].map(([sig, where]) => [
				sig,
				where.slice(0, 8).concat(where.length > 8 ? [`… +${where.length - 8}`] : []),
			])
		);
		const kinds = [...sigs.keys()];
		const scalarVsArray =
			kinds.some((k) => k.startsWith('array')) && kinds.some((k) => !k.includes('array') && !k.includes('object'));
		const objectVsScalar =
			kinds.some((k) => k.includes('object')) &&
			kinds.some((k) => /^(string|number|boolean)(\|(string|number|boolean))*$/.test(k));
		out.push(
			finding(
				'type_conflict',
				scalarVsArray || objectVsScalar ? 'should' : 'info',
				'*',
				name,
				`"${name}" has ${sigs.size} shapes: ${kinds.join(' / ')}`,
				{
					variants,
				}
			)
		);
	}
	return out.sort((a, b) =>
		a.severity === b.severity ? a.path.localeCompare(b.path) : a.severity === 'should' ? -1 : 1
	);
}

const SINGULAR_OK = new Set([
	'include',
	'command',
	'history',
	'media',
	'missing',
	'schema',
	'timeline',
	'killed',
	'tags_any_groups',
	'tagsAnyGroups',
]);
export function checkPlurality(tools) {
	const out = [];
	for (const tool of tools)
		for (const f of [...tool.inputs, ...tool.outputs]) {
			const isArray = [...f.types].some((t) => t.startsWith('array'));
			const onlyArray = [...f.types].every((t) => t.startsWith('array') || t === 'null');
			if (isArray && onlyArray && !/(s|_any|_all|_groups|_ids|data|Any|All|Groups|Ids)$/.test(f.name))
				out.push(
					finding(
						'singular_array',
						SINGULAR_OK.has(f.name) ? 'info' : 'should',
						tool.name,
						`${f.side}:${f.path}`,
						`array "${f.name}" has a singular name`
					)
				);
		}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Envelope / pagination checks
// ---------------------------------------------------------------------------------------------

export function checkEnvelopes(tools) {
	const out = [];
	for (const tool of tools) {
		const ins = new Map(tool.inputs.filter((f) => f.depth === 1).map((f) => [f.name, f]));
		const outs = new Map(tool.outputs.filter((f) => f.depth === 1).map((f) => [f.name, f]));
		const nextCursor = outs.get('nextCursor');
		const cursorUsable = nextCursor && [...nextCursor.types].some((t) => t === 'string');
		if (ins.has('cursor') && !nextCursor)
			out.push(finding('cursor_pairing', 'must', tool.name, 'in:cursor', 'cursor input but no root nextCursor output'));
		if (cursorUsable && !ins.has('cursor'))
			out.push(
				finding(
					'cursor_pairing',
					'must',
					tool.name,
					'out:nextCursor',
					'nextCursor can be a string but the tool has no cursor input'
				)
			);
		const nextOffset = outs.get('nextOffset');
		if (nextOffset && !ins.has('offset'))
			out.push(finding('offset_pairing', 'must', tool.name, 'out:nextOffset', 'nextOffset output but no offset input'));
		// A listing may take offset as a starting row and continue by cursor only (NAMING-SPEC R7).
		if (ins.has('offset') && !nextOffset && !nextCursor)
			out.push(finding('offset_pairing', 'should', tool.name, 'in:offset', 'offset input but no nextOffset output'));
		if (ins.has('offset') && ins.has('cursor'))
			out.push(
				finding(
					'two_continuations',
					'should',
					tool.name,
					'in:offset+cursor',
					'both offset and cursor continue the same listing'
				)
			);
		// list-shaped roots
		const rootArrays = tool.outputs.filter(
			(f) =>
				f.depth === 1 &&
				[...f.types].some((t) => t === 'array<object>') &&
				![
					'history',
					'timeline',
					'files',
					'warnings',
					'hints',
					'unavailable',
					'columns',
					'comments',
					'volumes',
					'changes',
					'media',
					'orgs',
					'schema',
					'splits',
				].includes(f.name)
		);
		for (const f of rootArrays)
			if (f.name !== 'items')
				out.push(
					finding('list_not_items', 'info', tool.name, `out:${f.name}`, `primary list is "${f.name}", not "items"`)
				);
		const hasItems = outs.has('items');
		if (hasItems && !outs.has('returnedCount'))
			out.push(
				finding('returned_count_missing', 'should', tool.name, 'out:returnedCount', 'items without returnedCount')
			);
		const rc = outs.get('returnedCount');
		if (rc && [...rc.types].includes('number') && !rc.types.has('integer'))
			out.push(
				finding(
					'returned_count_type',
					'info',
					tool.name,
					'out:returnedCount',
					'returnedCount typed number (others integer)'
				)
			);
		const isList = hasItems || ins.has('cursor');
		if (isList && !ins.has('limit'))
			out.push(
				finding(
					'limit_missing',
					'info',
					tool.name,
					'in:limit',
					`list tool without limit (has: ${[...ins.keys()].filter((k) => /limit|length|tail|max/.test(k)).join(', ') || 'none'})`
				)
			);
		if (outs.has('results') && !outs.has('items'))
			out.push(
				finding(
					'list_not_items',
					'should',
					tool.name,
					'out:results',
					'results grouped in an object keyed by type, not items[]'
				)
			);
	}
	return out;
}

/** Records that carry part of the kind/id/uri/url thread. */
export function checkReferenceRecords(tools) {
	const out = [];
	for (const tool of tools)
		for (const r of tool.outputRecords) {
			const p = new Set(r.props);
			const thread = ['kind', 'id', 'uri', 'url'].filter((k) => p.has(k));
			if (thread.length === 0 || thread.length === 4) continue;
			if (thread.length === 1 && (thread[0] === 'url' || thread[0] === 'id')) continue;
			out.push(
				finding(
					'partial_reference',
					thread.includes('uri') ? 'should' : 'info',
					tool.name,
					`out:${r.path || '(root)'}`,
					`record has ${thread.join('/')} but not ${['kind', 'id', 'uri', 'url'].filter((k) => !p.has(k)).join('/')}`
				)
			);
		}
	return out;
}

/** Error entry shapes inside batch results. */
export function checkErrorEntries(tools) {
	const shapes = [];
	for (const tool of tools)
		for (const r of tool.outputRecords) {
			if (!r.props.includes('error')) continue;
			const errField = tool.outputs.find((f) => f.path === (r.path ? `${r.path}.error` : 'error'));
			shapes.push({
				tool: tool.name,
				path: r.path,
				props: r.props.slice().sort(),
				error: errField ? normalizedSignature(errField.types) : '?',
			});
		}
	const distinct = new Set(shapes.map((s) => `${s.props.join(',')}|${s.error}`));
	return distinct.size > 1
		? [
				finding('error_entry_shape', 'should', '*', 'items[] error entries', `${distinct.size} error-entry shapes`, {
					shapes,
				}),
			]
		: [];
}

// ---------------------------------------------------------------------------------------------
// Description pointers
// ---------------------------------------------------------------------------------------------

export function checkPointers(tools) {
	const out = [];
	const byName = new Map(tools.map((t) => [t.name, t]));
	const rank = { anonymous: 0, authenticated: 1, write: 2 };
	const texts = [];
	for (const tool of tools) {
		texts.push({ tool, where: 'description', text: tool.description });
		for (const f of [...tool.inputs, ...tool.outputs])
			if (f.description) texts.push({ tool, where: `${f.side}:${f.path}`, text: f.description });
	}
	for (const { tool, where, text } of texts) {
		for (const m of text.matchAll(/\bhf_[a-z_]+\*?/g)) {
			const name = m[0];
			if (name.endsWith('_*') || name.endsWith('*')) {
				const prefix = name.replace(/\*$/, '');
				if (![...byName.keys()].some((n) => n.startsWith(prefix)))
					out.push(finding('pointer_unknown_tool', 'must', tool.name, where, `mentions ${name}: no tool matches`));
				continue;
			}
			if (name === 'hf_repo_' || name === 'hf_sandbox_') continue;
			const target = byName.get(name);
			if (!target) {
				if (!/^hf_(token|fs)$/.test(name) && !['hf_repo_', 'hf_sandbox_'].includes(name))
					out.push(
						finding(
							'pointer_unknown_tool',
							name === 'hf_TOKEN' ? 'info' : 'must',
							tool.name,
							where,
							`mentions ${name}: no such tool`
						)
					);
				continue;
			}
			if (tool.access && target.access && rank[target.access] > rank[tool.access])
				out.push(
					finding(
						'pointer_access',
						'info',
						tool.name,
						where,
						`points to ${name} (${target.access}) from a ${tool.access} tool: absent for weaker tokens`
					)
				);
		}
		for (const m of text.matchAll(/\b(hf_[a-z_]+)\.([a-z_]+)\b/g)) {
			const target = byName.get(m[1]);
			if (target && !target.inputs.some((f) => f.depth === 1 && f.name === m[2]))
				out.push(
					finding('pointer_unknown_arg', 'must', tool.name, where, `mentions ${m[1]}.${m[2]}: no such argument`)
				);
		}
		for (const m of text.matchAll(/pass (?:it )?as [`"]?([a-z_]+)[`"]? to (?:the other )?(hf_[a-z_]+\*?)/gi)) {
			const prefix = m[2].replace(/\*$/, '').replace(/_$/, '');
			const targets = tools.filter((t) => t.name === m[2] || t.name.startsWith(`${prefix}_`));
			if (targets.length && !targets.some((t) => t.inputs.some((f) => f.depth === 1 && f.name === m[1])))
				out.push(
					finding('pointer_unknown_arg', 'must', tool.name, where, `says pass as ${m[1]} to ${m[2]}: no such argument`)
				);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Producer -> consumer graph
// ---------------------------------------------------------------------------------------------

function recordTypes(tool, record) {
	const key = `${tool.name}:${record.path}`;
	if (OPEN_KIND_RECORDS[key]) return { types: OPEN_KIND_RECORDS[key], source: 'override' };
	const mapped = record.kindValues.map((k) => KIND_TO_TYPE[k]).filter(Boolean);
	if (mapped.length) return { types: [...new Set(mapped)], source: 'kind' };
	return { types: [], source: 'unknown' };
}

/** Every identifier the outputs produce, with resource type and value form. */
export function collectProducers(tools) {
	const producers = [];
	const covered = new Set();
	for (const tool of tools) {
		for (const r of tool.outputRecords) {
			const p = new Set(r.props);
			if (!(p.has('id') || p.has('uri')) || !p.has('kind')) continue;
			const { types, source } = recordTypes(tool, r);
			for (const form of ['id', 'uri', 'url']) {
				if (!p.has(form)) continue;
				const path = r.path ? `${r.path}.${form}` : form;
				covered.add(`${tool.name}:${path}`);
				producers.push({ tool: tool.name, path, record: r.path, form, types, typeSource: source });
			}
			if (p.has('kind')) covered.add(`${tool.name}:${r.path ? `${r.path}.kind` : 'kind'}`);
		}
		for (const f of tool.outputs) {
			const key = `${tool.name}:${f.path}`;
			if (/^hf_jobs?_\w+:(.*\.)?kind$/.test(key) && [...f.enum].some((v) => v === 'job' || v === 'scheduled_job')) {
				for (const v of f.enum)
					producers.push({
						tool: tool.name,
						path: f.path,
						form: `kind=${v}`,
						types: ['job_kind'],
						typeSource: 'scalar',
					});
				covered.add(key);
				continue;
			}
			if (covered.has(key)) continue;
			const rule = SCALAR_PRODUCERS.find((r) => r.match.test(key));
			if (!rule) continue;
			covered.add(key);
			producers.push({ tool: tool.name, path: f.path, form: rule.form, types: rule.type, typeSource: 'scalar' });
		}
	}
	return { producers, covered };
}

export function unclassifiedIdentifiers(tools, covered) {
	const out = [];
	for (const tool of tools)
		for (const f of tool.outputs) {
			if (!IDENTIFIER_NAME.test(f.name)) continue;
			if ([...f.types].every((t) => t === 'object' || t === 'null')) continue;
			const key = `${tool.name}:${f.path}`;
			if (covered.has(key)) continue;
			if (/(^|\.)(kind|mime_type|content_type|path|name)$/.test(f.path) && !/^(id|uri|url)$/.test(f.name)) {
				// path/name of a record already covered by its id/uri are fine
				const parent = f.parent ? `${tool.name}:${f.parent}.id` : `${tool.name}:id`;
				const parentUri = f.parent ? `${tool.name}:${f.parent}.uri` : `${tool.name}:uri`;
				if (covered.has(parent) || covered.has(parentUri)) continue;
			}
			out.push(
				finding(
					'unclassified_identifier',
					'info',
					tool.name,
					`out:${f.path}`,
					`identifier-like output not in the producer tables`
				)
			);
		}
	return out;
}

export function unclassifiedInputs(tools) {
	const out = [];
	const consumerKeys = new Set(CONSUMERS.map((c) => `${c.tool}.${c.arg}`));
	for (const tool of tools)
		for (const f of tool.inputs) {
			if (f.depth !== 1) continue;
			const key = `${tool.name}.${f.name}`;
			if (consumerKeys.has(key) || FREE_INPUTS.has(key) || FREE_INPUTS.has(f.name)) continue;
			out.push(
				finding(
					'unclassified_input',
					'info',
					tool.name,
					`in:${f.name}`,
					'input is neither a consumer nor a free value in rules.mjs'
				)
			);
		}
	for (const c of CONSUMERS) {
		const tool = tools.find((t) => t.name === c.tool);
		if (!tool || !tool.inputs.some((f) => f.depth === 1 && f.name === c.arg))
			out.push(finding('stale_rule', 'must', c.tool, `in:${c.arg}`, 'CONSUMERS entry names a missing tool/argument'));
	}
	return out;
}

/** Edges between producers and consumers that share a resource type. */
export function buildGraph(tools, producers) {
	const present = new Set(tools.map((t) => t.name));
	const consumers = CONSUMERS.filter((c) => present.has(c.tool)).map((c) => ({
		...c,
		key: `${c.tool}.${c.label ?? c.arg}`,
		linkTypes: effectiveTypes(c),
	}));
	const edges = [];
	for (const p of producers)
		for (const c of consumers) {
			const types = ['id'].includes(p.form) ? p.types : producerTypes(p.types);
			let shared = types.filter((t) => c.linkTypes.includes(t));
			// continuations only feed the tool that produced them
			if (p.tool !== c.tool) shared = shared.filter((t) => t !== 'cursor' && t !== 'offset');
			if (!shared.length) continue;
			edges.push({
				from: `${p.tool}:${p.path}`,
				fromTool: p.tool,
				form: p.form,
				to: c.key,
				toTool: c.tool,
				arg: c.arg,
				types: shared,
			});
		}
	const producedTypes = new Set(producers.flatMap((p) => p.types));
	const consumedTypes = new Set(consumers.flatMap((c) => c.types));
	const orphans = consumers
		.map((c) => ({ consumer: c.key, missing: c.types.filter((t) => !producedTypes.has(t)), types: c.types }))
		.filter((o) => o.missing.length === o.types.length);
	const deadTypes = [...producedTypes].filter((t) => !consumedTypes.has(t)).sort();
	const deadEnds = deadTypes.map((t) => ({
		type: t,
		producers: producers.filter((p) => p.types.includes(t)).map((p) => `${p.tool}:${p.path}`),
	}));
	return { consumers, edges, orphans, deadEnds };
}

export function mermaidFamilies(tools, edges, accepted) {
	const family = new Map(tools.map((t) => [t.name, t.family ?? 'other']));
	const pairs = new Map();
	for (const e of edges) {
		const status = accepted(e);
		if (status === 'rejected') continue;
		const a = family.get(e.fromTool);
		const b = family.get(e.toTool);
		const key = `${a}|${b}`;
		const entry = pairs.get(key) ?? { a, b, links: new Set() };
		entry.links.add(`${e.fromTool}->${e.toTool}`);
		pairs.set(key, entry);
	}
	const lines = ['flowchart LR'];
	for (const { a, b, links } of [...pairs.values()].sort((x, y) => `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`))) {
		if (a === b) lines.push(`  ${a} -- ${links.size} --> ${a}`);
		else lines.push(`  ${a} -- ${links.size} --> ${b}`);
	}
	return lines.join('\n');
}

export function mermaidTools(edges, filter) {
	const pairs = new Map();
	for (const e of edges) {
		if (!filter(e)) continue;
		const key = `${e.fromTool}|${e.toTool}`;
		const entry = pairs.get(key) ?? new Set();
		entry.add(e.arg);
		pairs.set(key, entry);
	}
	const lines = ['flowchart LR'];
	for (const [key, args] of [...pairs].sort()) {
		const [a, b] = key.split('|');
		lines.push(`  ${a} -->|${[...args].join(', ')}| ${b}`);
	}
	return lines.join('\n');
}

export function runStatic(tools) {
	const { producers, covered } = collectProducers(tools);
	const graph = buildGraph(tools, producers);
	return {
		inventory: nameInventory(tools),
		findings: [
			...checkNaming(tools),
			...checkVocabularyMatchesOutput(tools),
			...checkTypeConflicts(tools),
			...checkPlurality(tools),
			...checkEnvelopes(tools),
			...checkReferenceRecords(tools),
			...checkErrorEntries(tools),
			...checkPointers(tools),
			...unclassifiedIdentifiers(tools, covered),
			...unclassifiedInputs(tools),
		],
		producers,
		graph,
	};
}
