import { quote as shellQuote } from 'shell-quote';
import type { UvArgs } from '../types.js';

export const UV_DEFAULT_IMAGE = 'ghcr.io/astral-sh/uv:python3.12-bookworm';

type UvCommandOptions = Pick<UvArgs, 'with_deps' | 'python' | 'script_args'>;
type UvCommandLikeArgs = Pick<UvArgs, 'script' | 'with_deps' | 'python' | 'script_args'>;

function buildUvCommand(script: string, args: UvCommandOptions): string[] {
	const parts: string[] = ['uv', 'run'];

	if (args.with_deps && args.with_deps.length > 0) {
		for (const dep of args.with_deps) {
			parts.push('--with', dep);
		}
	}

	if (args.python) {
		parts.push('-p', args.python);
	}

	parts.push(script);

	if (args.script_args && args.script_args.length > 0) {
		parts.push(...args.script_args);
	}

	return parts;
}

function wrapInlineScript(script: string, args: UvCommandOptions): string {
	const encoded = Buffer.from(script, 'utf-8').toString('base64');
	const baseCommand = shellQuote(buildUvCommand('-', args));
	return `echo "${encoded}" | base64 -d | ${baseCommand}`;
}

export function resolveUvCommand(args: UvCommandLikeArgs): string[] {
	const options: UvCommandOptions = {
		with_deps: args.with_deps,
		python: args.python,
		script_args: args.script_args,
	};
	const scriptSource = args.script;

	if (scriptSource.startsWith('http://') || scriptSource.startsWith('https://')) {
		return buildUvCommand(scriptSource, options);
	}

	if (isScriptPath(scriptSource)) {
		return buildUvCommand(scriptSource, options);
	}

	return ['/bin/sh', '-lc', wrapInlineScript(scriptSource, options)];
}

/**
 * A script path inside the image or a mounted volume: one token of path characters ending in .py
 * (train.py, /data/scripts/run.py). Anything else, including single-line code such as
 * print("hi") or import os; print(os.getcwd()), is inline source.
 */
function isScriptPath(script: string): boolean {
	return /^[\w~./-]+\.py$/.test(script);
}
