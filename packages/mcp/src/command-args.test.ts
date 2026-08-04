import { describe, expect, it } from 'vitest';
import { parseCommandArgs, type CommandOptionMap } from './command-args.js';

const OPTIONS: CommandOptionMap = {
	'-r': { key: 'recursive', kind: 'boolean' },
	'--limit': { key: 'limit', kind: 'integer' },
	'--tag': { key: 'tags', kind: 'string', repeatable: true },
	'--name': { key: 'name', kind: 'string', nonEmpty: true },
};

describe('parseCommandArgs', () => {
	it('parses positionals, aliases, integers, and repeatable options', () => {
		expect(
			parseCommandArgs(
				{
					cmd: 'find',
					args: ['find', '/work', '-r', '--limit', '10', '--tag', 'one', '--tag', 'two'],
				},
				OPTIONS
			)
		).toEqual({
			positionals: ['/work'],
			options: { recursive: true, limit: 10, tags: ['one', 'two'] },
		});
	});

	it('rejects unknown, duplicate, missing, empty, and invalid integer options', () => {
		expect(() => parseCommandArgs({ cmd: 'find', args: ['--unknown'] }, OPTIONS)).toThrow(/unexpected argument/);
		expect(() => parseCommandArgs({ cmd: 'find', args: ['-r', '-r'] }, OPTIONS)).toThrow(/duplicate option/);
		expect(() => parseCommandArgs({ cmd: 'find', args: ['--tag'] }, OPTIONS)).toThrow(/requires a value/);
		expect(() => parseCommandArgs({ cmd: 'find', args: ['--name', ''] }, OPTIONS)).toThrow(/non-empty value/);
		expect(() => parseCommandArgs({ cmd: 'find', args: ['--limit', 'many'] }, OPTIONS)).toThrow(/integer/);
	});
});
