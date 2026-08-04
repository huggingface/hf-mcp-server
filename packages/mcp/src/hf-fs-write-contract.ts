import { z } from 'zod';
import { parseCommandArgs, type CommandOptionMap } from './command-args.js';

export const HF_FS_WRITE_OPERATIONS = ['put', 'rm'] as const;

export type HfFsWriteOperation = (typeof HF_FS_WRITE_OPERATIONS)[number];

export interface HfFsWriteParams {
	op: HfFsWriteOperation;
	uri: string;
	content?: string;
	base64?: boolean;
	message?: string;
	description?: string;
	branch?: string;
	create_pr?: boolean;
	parent_commit?: string;
}

export const HF_FS_WRITE_DESCRIPTION = `Write or remove files in Hugging Face repositories and buckets.

Grammar; each token below is one args array element:
  put URI [--base64] [(-m|--message) MESSAGE] [--description DESCRIPTION]
          [--branch BRANCH] [--create-pr] [--parent-commit SHA]
  rm  URI [(-m|--message) MESSAGE] [--description DESCRIPTION]
          [--branch BRANCH] [--create-pr] [--parent-commit SHA]

URI must be an hf://models|datasets|spaces|buckets/OWNER/NAME/PATH file URI.
For put, provide file data in the separate content field. Content is UTF-8 text unless --base64 is present.
Use --create-pr to propose a change when direct repository writes are unavailable or undesirable.
Branches, pull requests, descriptions, and parent commits are not supported for buckets.
A URI '@revision' and --branch are equivalent; do not specify conflicting values.
--parent-commit must be a 40-character Git commit SHA and prevents overwriting concurrent changes.
No pipes, redirects, shell expansion, or multiple commands.`;

export const HF_FS_WRITE_SCHEMA = z.object({
	cmd: z.enum(HF_FS_WRITE_OPERATIONS).describe('Command to execute.'),
	args: z.array(z.string()).describe('Command arguments; each array item is one grammar token.'),
	content: z
		.string()
		.optional()
		.describe('File content for put. UTF-8 text by default; base64 when args includes --base64.'),
});

export type HfFsWriteRequest = z.input<typeof HF_FS_WRITE_SCHEMA>;

const COMMON_FLAGS: CommandOptionMap = {
	'-m': { key: 'message', kind: 'string', nonEmpty: true },
	'--message': { key: 'message', kind: 'string', nonEmpty: true },
	'--description': { key: 'description', kind: 'string', nonEmpty: true },
	'--branch': { key: 'branch', kind: 'string', nonEmpty: true },
	'--create-pr': { key: 'create_pr', kind: 'boolean' },
	'--parent-commit': { key: 'parent_commit', kind: 'string' },
};

const FLAGS: Readonly<Record<HfFsWriteOperation, CommandOptionMap>> = {
	put: {
		...COMMON_FLAGS,
		'--base64': { key: 'base64', kind: 'boolean' },
	},
	rm: COMMON_FLAGS,
};

export function parseHfFsWriteRequest(request: HfFsWriteRequest): HfFsWriteParams {
	const { positionals, options } = parseCommandArgs(request, FLAGS[request.cmd]);
	if (positionals.length === 0) {
		throw new Error(`EINVAL: ${request.cmd} requires an hf:// file URI`);
	}

	const uri = positionals[0];
	if (!uri?.startsWith('hf://')) {
		throw new Error('EINVAL: URI must start with hf://');
	}
	if (positionals.length > 1) {
		throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${positionals[1] ?? ''}`);
	}
	const parentCommit = options.parent_commit as string | undefined;
	if (parentCommit !== undefined && !/^[0-9A-Fa-f]{40}$/.test(parentCommit)) {
		throw new Error('EINVAL: --parent-commit requires a 40-character Git commit SHA');
	}
	const params: HfFsWriteParams = {
		op: request.cmd,
		uri,
		...(request.content !== undefined ? { content: request.content } : {}),
		...(options.base64 === true ? { base64: true } : {}),
		...(typeof options.message === 'string' ? { message: options.message } : {}),
		...(typeof options.description === 'string' ? { description: options.description } : {}),
		...(typeof options.branch === 'string' ? { branch: options.branch } : {}),
		...(options.create_pr === true ? { create_pr: true } : {}),
		...(parentCommit !== undefined ? { parent_commit: parentCommit } : {}),
	};

	if (request.cmd === 'put' && request.content === undefined) {
		throw new Error('EINVAL: put requires content');
	}
	if (request.cmd === 'rm' && request.content !== undefined) {
		throw new Error('EINVAL: content is only valid with put');
	}
	return params;
}
