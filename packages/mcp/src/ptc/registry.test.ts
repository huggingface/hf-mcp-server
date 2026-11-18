import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PTC_FAMILIES, PTC_INSTRUCTIONS, PTC_TOOLS, PTC_TOOL_NAMES, ptcToolsForAccess } from './index.js';

describe('PTC registry', () => {
	it('has unique hf_ names, known families and strict object schemas', () => {
		expect(new Set(PTC_TOOL_NAMES).size).toBe(PTC_TOOLS.length);
		for (const tool of PTC_TOOLS) {
			expect(tool.name).toMatch(/^hf_[a-z0-9_]+$/);
			expect(PTC_FAMILIES).toContain(tool.family);
			expect(z.toJSONSchema(tool.input, { io: 'input' }).type).toBe('object');
			expect(z.toJSONSchema(tool.output, { io: 'output' }).type).toBe('object');
		}
	});

	it('keeps descriptions within the tool-search bands (pipeline-generated, reviewed)', () => {
		for (const tool of PTC_TOOLS) {
			expect(tool.description.length, tool.name).toBeGreaterThanOrEqual(150);
			expect(tool.description.length, tool.name).toBeLessThanOrEqual(700);
			if (tool.family === 'sandbox') expect(tool.description, tool.name).toMatch(/^Sandbox:/);
		}
	});

	it('never mixes read-only with destructive annotations, and only lists writes for write access', () => {
		for (const tool of PTC_TOOLS) {
			expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint, tool.name).toBe(false);
			if (!tool.annotations.readOnlyHint && tool.name !== 'hf_space_invoke')
				expect(tool.access, tool.name).toBe('write');
		}
		const anonymous = ptcToolsForAccess('anonymous');
		expect(anonymous.every((tool) => tool.access === 'anonymous')).toBe(true);
		expect(ptcToolsForAccess('write')).toHaveLength(PTC_TOOLS.length);
	});

	it('keeps the server instructions to one rule-only line without tool names', () => {
		// Fits the 250-char first line Codex 0.167+ shows as world state (INSTRUCTIONS-RESEARCH.md P1).
		expect(PTC_INSTRUCTIONS.length).toBeLessThanOrEqual(250);
		expect(PTC_INSTRUCTIONS).not.toContain('\n');
		expect(PTC_INSTRUCTIONS).not.toMatch(/\bhf_/);
		for (const term of ['uri', 'nextCursor', 'nextOffset', 'returnedCount']) expect(PTC_INSTRUCTIONS).toContain(term);
	});

	it('states the completeness rules output schemas no longer repeat per field', () => {
		// Blocked paging (hf_datasets_search row_sort_cursor: nextCursor null, hasMore true, no truncated) must
		// not read as the end of the list; truncated means a continuation will never return the rest.
		const [, completeness = ''] = PTC_INSTRUCTIONS.split('completeness:');
		expect(completeness).toMatch(/\bhasMore with null cursor = paging blocked\b/);
		expect(completeness).toMatch(/\btruncated = results no page returns\b/);
		expect(completeness).toMatch(/see reason, hint/);
	});
	it('keeps input field docs short and every input schema under the Codex 5,000-byte compaction limit', () => {
		// Codex keeps only these keywords of an MCP input schema and drops every argument doc once
		// the compact JSON exceeds 5,000 bytes; stay clearly below it.
		const kept = [
			'type',
			'description',
			'enum',
			'items',
			'properties',
			'required',
			'additionalProperties',
			'anyOf',
			'oneOf',
			'allOf',
		];
		const project = (node: unknown): unknown => {
			if (Array.isArray(node)) return node.map(project);
			if (typeof node !== 'object' || node === null) return node;
			const source = node as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			if ('const' in source) out.enum = [source.const];
			for (const key of kept) {
				if (!(key in source)) continue;
				const value = source[key];
				out[key] =
					key === 'properties'
						? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, project(v)]))
						: project(value);
			}
			return out;
		};
		const docs = (node: unknown, found: string[]): string[] => {
			if (Array.isArray(node)) node.forEach((child) => docs(child, found));
			else if (typeof node === 'object' && node !== null) {
				for (const [key, value] of Object.entries(node)) {
					if (key === 'description' && typeof value === 'string') found.push(value);
					else docs(value, found);
				}
			}
			return found;
		};
		for (const tool of PTC_TOOLS) {
			const schema = z.toJSONSchema(tool.input, { io: 'input', target: 'draft-2020-12' });
			for (const doc of docs(schema.properties, [])) expect(doc.length, `${tool.name}: ${doc}`).toBeLessThanOrEqual(80);
			expect(JSON.stringify(project(schema)).length, tool.name).toBeLessThan(4_900);
		}
	});

	it('uses the camelCase envelope and the completeness core on every tool (NAMING-SPEC R7, R14)', () => {
		const snake = /_/;
		const completenessKeys = (node: unknown, found: string[][]): string[][] => {
			if (Array.isArray(node)) node.forEach((child) => completenessKeys(child, found));
			else if (typeof node === 'object' && node !== null) {
				const props = (node as { properties?: Record<string, unknown> }).properties;
				const completeness = props?.completeness as { properties?: Record<string, unknown> } | undefined;
				if (completeness?.properties) found.push(Object.keys(completeness.properties));
				for (const value of Object.values(node)) completenessKeys(value, found);
			}
			return found;
		};
		for (const tool of PTC_TOOLS) {
			const schema = z.toJSONSchema(tool.output, { io: 'output', target: 'draft-2020-12', unrepresentable: 'any' });
			const root = Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
			for (const key of root.filter((name) => /^(next|returned)/i.test(name)))
				expect(key, `${tool.name}.${key}`).not.toMatch(snake);
			for (const keys of completenessKeys(schema, [])) {
				expect(keys, tool.name).toContain('hasMore');
				for (const key of keys) expect(key, `${tool.name}.completeness.${key}`).not.toMatch(snake);
				for (const gone of ['scope', 'global_complete', 'continuation_available', 'end_of_listing'])
					expect(keys, tool.name).not.toContain(gone);
			}
		}
	});
});
