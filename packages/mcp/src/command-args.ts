interface CommandRequest<Command extends string = string> {
	cmd: Command;
	args: string[];
}

interface CommandOption {
	key: string;
	kind: 'boolean' | 'integer' | 'string';
	nonEmpty?: boolean;
	repeatable?: boolean;
}

export type CommandOptionMap = Readonly<Record<string, CommandOption>>;
type ParsedCommandOption = boolean | number | string | string[];

interface ParsedCommandArgs {
	positionals: string[];
	options: Record<string, ParsedCommandOption>;
}

export function parseCommandArgs(request: CommandRequest, definitions: CommandOptionMap): ParsedCommandArgs {
	const args = request.args[0] === request.cmd ? request.args.slice(1) : request.args;
	const positionals: string[] = [];
	const options: Record<string, ParsedCommandOption> = {};

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		const definition = token === undefined ? undefined : definitions[token];
		if (!definition) {
			if (token?.startsWith('-')) {
				throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${token}`);
			}
			if (token !== undefined) {
				positionals.push(token);
			}
			continue;
		}

		if (!definition.repeatable && options[definition.key] !== undefined) {
			throw new Error(`EINVAL: duplicate option for ${definition.key}: ${token}`);
		}
		if (definition.kind === 'boolean') {
			options[definition.key] = true;
			continue;
		}

		const value = args[index + 1];
		if (value === undefined) {
			throw new Error(`EINVAL: ${token} requires a value`);
		}
		index += 1;

		if (definition.kind === 'integer') {
			if (!/^-?\d+$/.test(value)) {
				throw new Error(`EINVAL: ${token} requires an integer`);
			}
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed)) {
				throw new Error(`EINVAL: ${token} requires a safe integer`);
			}
			options[definition.key] = parsed;
			continue;
		}

		if (definition.nonEmpty && value.length === 0) {
			throw new Error(`EINVAL: ${token} requires a non-empty value`);
		}
		if (definition.repeatable) {
			const current = options[definition.key];
			options[definition.key] = [...(Array.isArray(current) ? current : []), value];
		} else {
			options[definition.key] = value;
		}
	}

	return { positionals, options };
}
