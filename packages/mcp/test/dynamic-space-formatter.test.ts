import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { analyzeSchemaComplexity } from '../src/space/utils/schema-validator.js';
import { formatParameters } from '../src/space/utils/parameter-formatter.js';

function example(tool: Tool, space = 'org/space') {
	const output = formatParameters(analyzeSchemaComplexity(tool), space);
	const block = /```json\n([\s\S]*?)\n```/.exec(output)?.[1];
	expect(block).toBeDefined();
	const request = JSON.parse(block!) as {
		operation: string;
		space_name: string;
		tool_name: string;
		parameters: string;
	};
	return { output, request, parameters: JSON.parse(request.parameters) as Record<string, unknown> };
}

describe('actual dynamic_space parameter formatter', () => {
	it('serializes the entire request and preserves native values and all escaping through both JSON layers', () => {
		const escaped = 'quotes " slash \\ newline\n tab\t unicode 雪';
		const url = 'https://example.com/file%20name.jpg?q=%22x%22&path=a\\b#fragment';
		const values = {
			text: escaped,
			zero: 0,
			decimal: 1.25,
			no: false,
			nil: null,
			list: [1, false, escaped],
			object: { text: escaped, enabled: true },
			url,
		};
		const tool: Tool = {
			name: escaped,
			inputSchema: {
				type: 'object',
				properties: Object.fromEntries(
					Object.entries(values).map(([name, value]) => [
						name,
						{
							type: name === 'list' ? 'array' : name === 'object' ? 'object' : 'string',
							...(name === 'object' ? { properties: { text: { type: 'string' }, enabled: { type: 'boolean' } } } : {}),
							default: value,
						},
					])
				),
				required: Object.keys(values),
			},
		};
		const result = example(tool, escaped);
		expect(result.parameters).toEqual(values);
		expect(result.request).toMatchObject({ operation: 'invoke', tool_name: escaped, space_name: escaped });
	});

	it.each(['string', 'number', 'boolean', 'null', 'array', 'object'] as const)('preserves %s enum values', (kind) => {
		const value = { string: 'a"b\\c\n', number: 0, boolean: false, null: null, array: [1, 2], object: { x: 1 } }[kind];
		const result = example({
			name: 'run',
			inputSchema: {
				type: 'object',
				properties: { choice: { enum: [value, 'other'] } },
				required: ['choice'],
			},
		});
		expect(result.parameters.choice).toEqual(value);
		expect(result.output).toContain('**Allowed values:**');
	});

	it('uses native primitive placeholders, empty arrays/objects, and unquoted file URLs', () => {
		const result = example({
			name: 'run',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string' },
					count: { type: 'integer' },
					number: { type: 'number' },
					enabled: { type: 'boolean' },
					strings: { type: 'array', items: { type: 'string' } },
					numbers: { type: 'array', items: { type: 'number' } },
					flags: { type: 'array', items: { type: 'boolean' } },
					config: { type: 'object', properties: { key: { type: 'string' } } },
					image: { type: 'object', title: 'FileData' },
				},
				required: ['text', 'count', 'number', 'enabled', 'strings', 'numbers', 'flags', 'config', 'image'],
			},
		});
		expect(result.parameters).toEqual({
			text: 'example value',
			count: 42,
			number: 42,
			enabled: true,
			strings: [],
			numbers: [],
			flags: [],
			config: {},
			image: 'https://example.com/file.jpg',
		});
		expect(result.output).toContain('not full JSON Schema');
	});

	it('shows required parameters first, includes only two optional examples, and prefers defaults over enums', () => {
		const result = example({
			name: 'run',
			inputSchema: {
				type: 'object',
				properties: {
					z: { type: 'boolean', default: false },
					a: { enum: ['first', 'second'], default: 'second' },
					omitted: { type: 'number', default: 1 },
					required: { type: 'string' },
				},
				required: ['required'],
			},
		});
		expect(result.parameters).toEqual({ required: 'example value', z: false, a: 'second' });
		expect(result.output.indexOf('### required [REQUIRED]')).toBeLessThan(result.output.indexOf('### a [OPTIONAL]'));
		expect(result.output).toContain('**Default:** false');
	});

	it('emits a parseable empty request for a tool without parameters', () => {
		expect(example({ name: 'empty', inputSchema: { type: 'object' } }).parameters).toEqual({});
	});
});
