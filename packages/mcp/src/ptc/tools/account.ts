import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { commit, downloadFile, type CommitOperation, type RepoDesignation } from '@huggingface/hub';
import { definePtcTool, DESTRUCTIVE, MUTATING, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { PtcError, ptcHttpError, toPtcError } from '../core/errors.js';
import { hubFetch } from '../core/hub-http.js';
import { fileItem, itemSchema, parseRef, refSchema, repoItem, repoUri, type RepoKind } from '../core/refs.js';
import { CreateRepoTool, type CreateRepoHardwareResult } from '../../create-repo.js';
import { HfApiError } from '../../hf-api-call.js';
import { createHfWhoamiOutput, hfWhoamiResponseSchema } from '../../whoami/index.js';
import { ptcWhoamiOutputSchema, signedOutPtcWhoamiOutput, toPtcWhoamiOutput } from '../../whoami/ptc-output.js';
import { CONFIG_GUIDANCE } from '../../utilities.js';

const ROOT: Record<RepoKind, string> = { model: 'models', dataset: 'datasets', space: 'spaces', bucket: 'buckets' };

function requireToken(ctx: PtcContext): string {
	if (!ctx.hfToken) throw new PtcError('AUTH_REQUIRED', 'a Hugging Face token is required.');
	return ctx.hfToken;
}

/** HfApiError (legacy clients) carries `status`, not `statusCode`. */
function mapError(error: unknown, subject: string): PtcError {
	if (error instanceof HfApiError) return ptcHttpError(error.status, subject);
	return toPtcError(error, subject);
}

// ------------------------------------------------------------------ hf_whoami

const whoamiInput = z.object({}).strict();

/**
 * The standard hf_whoami `authenticated` result (shared normaliser), mapped to camelCase, or a
 * signed-out record. Listed without a token. Signed out = no token, or the Hub rejected the token
 * (401). An unreachable Hub, a 5xx or a malformed response stays a typed (retryable) error rather
 * than claiming the caller is signed out. The token is never output or put in an error message.
 */
const whoamiOutput = ptcWhoamiOutputSchema;

/** Fixed text (never derived from the token or the upstream response). */
const NO_TOKEN_GUIDANCE = CONFIG_GUIDANCE;
const REJECTED_TOKEN_GUIDANCE =
	'The supplied Hugging Face token was rejected (invalid, expired or revoked). Sign in again or configure a valid token: https://hf.co/settings/mcp/';

async function whoami(ctx: PtcContext): Promise<z.input<typeof whoamiOutput>> {
	const token = ctx.hfToken;
	if (!token) return signedOutPtcWhoamiOutput(NO_TOKEN_GUIDANCE);
	const { status, data } = await hubFetch({ path: '/api/whoami-v2', subject: 'whoami', allowStatus: [401] }, ctx);
	if (status === 401) return signedOutPtcWhoamiOutput(REJECTED_TOKEN_GUIDANCE);
	const parsed = hfWhoamiResponseSchema.safeParse(data);
	if (!parsed.success) throw new PtcError('UPSTREAM_RESPONSE', 'whoami: malformed upstream response.');
	// The raw token is only read locally for its OAuth scope claim; it is never part of the output.
	const result = createHfWhoamiOutput(parsed.data, token, NO_TOKEN_GUIDANCE);
	// Unreachable with a parsed response (only a missing response yields another status); narrows the type.
	if (result.status !== 'authenticated') throw new PtcError('UPSTREAM_RESPONSE', 'whoami: unverified credential.');
	return toPtcWhoamiOutput(result);
}

// ------------------------------------------------------------------ hf_repo_create

const createInput = z
	.object({
		repo: refSchema.describe('New repository, e.g. hf://spaces/OWNER/NAME (bare OWNER/NAME = model).'),
		private: z.boolean().optional().describe("Visibility (default public, or the source's when duplicating)."),
		sdk: z
			.enum(['gradio', 'docker', 'static'])
			.optional()
			.describe('Space SDK (default static, or gradio with zero-a10g).'),
		flavor: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe('Space flavor, e.g. zero-a10g (PRO), t4-small; paid flavors bill at once.'),
		source: refSchema.optional().describe('Repository to duplicate (same type as repo) instead of creating empty.'),
	})
	.strict();

const createOutput = z
	.object({
		action: z.enum(['created', 'duplicated']),
		repo: itemSchema,
		source: itemSchema.optional(),
		sdk: z.string().optional(),
		runtime: z
			.object({
				stage: z.string().optional(),
				hardware: z.object({ requested: z.string(), current: z.string().optional() }).strict(),
				// True when read back from the Space runtime.
				confirmed: z.boolean(),
			})
			.strict()
			.optional()
			.describe('Only when flavor was set.'),
		copyStatus: z
			.object({
				pending: z.boolean(),
				numFiles: z.number().optional(),
				filesCopied: z.number().optional(),
			})
			.strict()
			.optional()
			.describe('Duplication: polled once; files may still be copying.'),
	})
	.strict();

function parseRepoRef(ref: string, field: string, defaultKind: RepoKind): { kind: RepoKind; id: string } {
	const parsed = parseRef(ref, defaultKind);
	if (parsed.path || parsed.revision) {
		throw new PtcError('INVALID_ARGUMENT', `${field} must name a repository, without a revision or file path.`);
	}
	if (!parsed.kind || !parsed.id.includes('/')) {
		throw new PtcError('INVALID_ARGUMENT', `${field} must be OWNER/NAME (include the owner).`);
	}
	return { kind: parsed.kind, id: parsed.id };
}

async function readCopyStatus(kind: RepoKind, id: string, ctx: PtcContext) {
	try {
		const { status, data } = await hubFetch(
			{ path: `/api/${ROOT[kind]}/${id}/duplicate/status`, subject: 'duplicate status', allowStatus: [404] },
			ctx
		);
		if (status !== 200 || !data || typeof data !== 'object') return undefined;
		const raw = data as { pending?: unknown; filesTotal?: unknown; filesCopied?: unknown };
		if (typeof raw.pending !== 'boolean') return undefined;
		return {
			pending: raw.pending,
			...(typeof raw.filesTotal === 'number' ? { numFiles: raw.filesTotal } : {}),
			...(typeof raw.filesCopied === 'number' ? { filesCopied: raw.filesCopied } : {}),
		};
	} catch {
		// The repository already exists; status is advisory.
		return undefined;
	}
}

function spaceRuntime(hardware: CreateRepoHardwareResult) {
	return {
		...(hardware.stage ? { stage: hardware.stage } : {}),
		hardware: { requested: hardware.requested, ...(hardware.current ? { current: hardware.current } : {}) },
		confirmed: hardware.confirmed,
	};
}

async function repoCreate(input: z.output<typeof createInput>, ctx: PtcContext): Promise<z.input<typeof createOutput>> {
	const token = requireToken(ctx);
	const source = input.source ? parseRepoRef(input.source, 'source', 'model') : undefined;
	const target = parseRepoRef(input.repo, 'repo', source?.kind ?? 'model');
	if ((input.sdk || input.flavor) && target.kind !== 'space') {
		throw new PtcError('INVALID_ARGUMENT', 'sdk and flavor are only valid for Spaces.');
	}
	if (source) {
		if (source.kind === 'bucket' || target.kind === 'bucket') {
			throw new PtcError('UNSUPPORTED', 'buckets cannot be duplicated.');
		}
		if (source.kind !== target.kind) {
			throw new PtcError(
				'INVALID_ARGUMENT',
				`source is a ${source.kind} but repo is a ${target.kind}; they must match.`
			);
		}
	}
	let result;
	try {
		result = await new CreateRepoTool(token, undefined, ctx.signal).create({
			uri: repoUri(target.kind, target.id),
			...(source ? { source_uri: repoUri(source.kind, source.id) } : {}),
			...(input.private !== undefined ? { private: input.private } : {}),
			...(input.sdk ? { sdk: input.sdk } : {}),
			...(input.flavor ? { hardware: input.flavor } : {}),
		});
	} catch (error) {
		if (error instanceof Error && /does not match the source Space sdk/.test(error.message)) {
			throw new PtcError('INVALID_ARGUMENT', 'sdk does not match the source Space SDK; omit sdk when duplicating.');
		}
		throw mapError(error, 'repository create');
	}
	const copyStatus = source ? await readCopyStatus(target.kind, target.id, ctx) : undefined;
	return {
		action: result.action,
		repo: repoItem(target.kind, target.id),
		...(source ? { source: repoItem(source.kind, source.id) } : {}),
		...(result.sdk ? { sdk: result.sdk } : {}),
		...(result.hardware ? { runtime: spaceRuntime(result.hardware) } : {}),
		...(copyStatus ? { copyStatus } : {}),
	};
}

// ------------------------------------------------------------------ hf_repo_write_files

const MAX_CHANGES = 100;
const MAX_CONTENT_CHARS = 10_000_000;
const pathSchema = z.string().trim().min(1).max(1024).describe('File path inside the repository, e.g. "src/app.py".');

const changeSchema = z.discriminatedUnion('op', [
	z
		.object({
			op: z.literal('put'),
			path: pathSchema,
			text: z.string().max(MAX_CONTENT_CHARS).optional().describe('UTF-8 file content.'),
			base64: z.string().max(MAX_CONTENT_CHARS).optional().describe('Binary file content as standard base64.'),
		})
		.strict(),
	z.object({ op: z.literal('delete'), path: pathSchema }).strict(),
	z
		.object({
			op: z.literal('move'),
			from: pathSchema.describe('Existing file path.'),
			to: pathSchema.describe('New file path.'),
		})
		.strict(),
]);

const writeInput = z
	.object({
		repo: refSchema.describe('Target repository or bucket, e.g. hf://spaces/owner/app[@branch].'),
		changes: z
			.array(changeSchema)
			.min(1)
			.max(MAX_CHANGES)
			.describe('One commit (max 100 ops): put (path, text|base64), delete (path), move.'),
		message: z.string().trim().min(1).max(500).describe('Commit title.'),
		revision: z.string().trim().min(1).max(256).optional().describe('Target branch (default main). Not for buckets.'),
		createPr: z.boolean().default(false).describe('Open a pull request instead of committing to the branch.'),
		description: z.string().max(10_000).optional().describe('Commit or pull request description.'),
		parentCommit: z
			.string()
			.regex(/^[0-9a-f]{40}$/)
			.optional()
			.describe('Fail if the branch head moved past this commit SHA (optimistic concurrency).'),
	})
	.strict();

const writeOutput = z
	.object({
		repo: itemSchema,
		revision: z.string().optional(),
		commit: z.object({ oid: z.string(), url: z.string() }).strict().optional(),
		pullRequestUrl: z.string().optional(),
		changes: z.array(
			z
				.object({
					op: z.enum(['put', 'delete', 'move']),
					path: z.string(),
					from: z.string().optional(),
					bytes: z.number().int().optional(),
					// The written file (absent for deletes).
					file: itemSchema.optional(),
				})
				.strict()
		),
	})
	.strict();

function safeRepoPath(path: string): string {
	const clean = path.replace(/^\/+/, '');
	const parts = clean.split('/');
	if (!clean || parts.some((part) => !part || part === '.' || part === '..')) {
		throw new PtcError('INVALID_ARGUMENT', `invalid file path: ${path.slice(0, 200)}`);
	}
	return clean;
}

function decodeBase64(value: string): Uint8Array {
	const compact = value.replace(/\s/g, '');
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
		throw new PtcError('INVALID_ARGUMENT', 'base64 must be valid standard base64.');
	}
	return Buffer.from(compact, 'base64');
}

function blobOf(bytes: Uint8Array): Blob {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new Blob([buffer]);
}

/** `.../discussions/N` -> `refs/pr/N`, the revision holding a pull request's content. */
function prRevision(pullRequestUrl: string | undefined): string | undefined {
	const match = pullRequestUrl ? /\/discussions\/(\d+)(?:[/?#]|$)/.exec(pullRequestUrl) : null;
	return match ? `refs/pr/${match[1] ?? ''}` : undefined;
}

/** downloadFile has no abortSignal option; bind the caller's signal through its fetch hook instead. */
function signalFetch(signal: AbortSignal): typeof globalThis.fetch {
	return (url, init) =>
		globalThis.fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

interface CommitBase {
	accessToken: string;
	repo: RepoDesignation;
	title: string;
	description?: string;
	branch?: string;
	isPullRequest?: boolean;
	parentCommit?: string;
	abortSignal?: AbortSignal;
}

/**
 * Buckets have no atomic commit: the SDK uploads adds, reports per-file add failures as progress
 * events, then runs the deletes anyway and only throws at the end. A move (add `to`, delete `from`)
 * could then delete its source with no copy. Apply the adds first and run the deletes only when
 * every add succeeded.
 */
async function bucketCommit(params: CommitBase, operations: CommitOperation[]): Promise<void> {
	const adds = operations.filter((op) => op.operation !== 'delete');
	const deletes = operations.filter((op) => op.operation === 'delete');
	if (adds.length > 0) {
		try {
			await commit({ ...params, operations: adds });
		} catch (error) {
			const failed = error instanceof Error ? /^Failed to upload (\d+) file/.exec(error.message) : null;
			const prefix = deletes.length > 0 ? 'nothing was deleted: ' : '';
			if (failed) {
				throw new PtcError(
					'UPSTREAM_RESPONSE',
					`bucket upload failed for ${failed[1] ?? 'some'} file(s); ${prefix}other uploads in this call may have been applied.`,
					true
				);
			}
			const mapped = mapError(error, 'bucket upload');
			throw deletes.length > 0
				? new PtcError(mapped.code, `${mapped.message} Nothing was deleted.`, mapped.retryable)
				: mapped;
		}
	}
	if (deletes.length > 0) {
		try {
			await commit({ ...params, operations: deletes });
		} catch (error) {
			const mapped = mapError(error, 'bucket delete');
			throw adds.length > 0
				? new PtcError(
						mapped.code,
						`${mapped.message} Uploads in this call were applied; moved sources may remain.`,
						mapped.retryable
					)
				: mapped;
		}
	}
}

async function writeFiles(input: z.output<typeof writeInput>, ctx: PtcContext): Promise<z.input<typeof writeOutput>> {
	const accessToken = requireToken(ctx);
	const parsed = parseRef(input.repo, 'model');
	const kind = parsed.kind ?? 'model';
	if (parsed.path) throw new PtcError('INVALID_ARGUMENT', 'repo must name a repository; put file paths in changes.');
	if (input.revision && parsed.revision && input.revision !== parsed.revision) {
		throw new PtcError('INVALID_ARGUMENT', 'revision conflicts with the @revision in repo; pass only one.');
	}
	const revision = input.revision ?? parsed.revision;
	if (kind === 'bucket' && (revision || input.createPr || input.description !== undefined || input.parentCommit)) {
		throw new PtcError('INVALID_ARGUMENT', 'buckets have no branches, pull requests, descriptions or parent commits.');
	}
	const repo: RepoDesignation = { type: kind, name: parsed.id };
	const operations: CommitOperation[] = [];
	const summary: z.input<typeof writeOutput>['changes'] = [];
	const touched = new Set<string>();
	const claim = (path: string) => {
		if (touched.has(path)) throw new PtcError('INVALID_ARGUMENT', `path appears in more than one change: ${path}`);
		touched.add(path);
	};

	for (const change of input.changes) {
		if (change.op === 'put') {
			const path = safeRepoPath(change.path);
			claim(path);
			if ((change.text === undefined) === (change.base64 === undefined)) {
				throw new PtcError('INVALID_ARGUMENT', `put ${path}: pass exactly one of text or base64.`);
			}
			const bytes =
				change.text !== undefined ? new TextEncoder().encode(change.text) : decodeBase64(change.base64 ?? '');
			operations.push({ operation: 'addOrUpdate', path, content: blobOf(bytes) });
			summary.push({ op: 'put', path, bytes: bytes.byteLength });
		} else if (change.op === 'delete') {
			const path = safeRepoPath(change.path);
			claim(path);
			operations.push({ operation: 'delete', path });
			summary.push({ op: 'delete', path });
		} else {
			const from = safeRepoPath(change.from);
			const to = safeRepoPath(change.to);
			claim(from);
			claim(to);
			// Lazy blob: content is streamed from the Hub into the commit, not buffered here.
			let blob: Blob | null;
			try {
				blob = await downloadFile({
					repo,
					path: from,
					accessToken,
					...(revision ? { revision } : {}),
					...(ctx.signal ? { fetch: signalFetch(ctx.signal) } : {}),
				});
			} catch (error) {
				throw mapError(error, `move source ${from}`);
			}
			if (!blob) throw new PtcError('NOT_FOUND', `move source not found: ${from}`);
			operations.push({ operation: 'addOrUpdate', path: to, content: blob });
			operations.push({ operation: 'delete', path: from });
			summary.push({ op: 'move', path: to, from, bytes: blob.size });
		}
	}

	const commitParams: CommitBase = {
		accessToken,
		repo,
		title: input.message,
		...(input.description !== undefined ? { description: input.description } : {}),
		...(revision ? { branch: revision } : {}),
		...(input.createPr ? { isPullRequest: true } : {}),
		...(input.parentCommit ? { parentCommit: input.parentCommit } : {}),
		...(ctx.signal ? { abortSignal: ctx.signal } : {}),
	};
	let output;
	if (kind === 'bucket') {
		await bucketCommit(commitParams, operations);
	} else {
		try {
			// Repository commits are atomic: a move's add and delete land together or not at all.
			output = await commit({ ...commitParams, operations });
		} catch (error) {
			throw mapError(error, 'commit');
		}
	}
	// Written files live on the PR ref (or the target branch), not main: reference them there so read-after-write works.
	const fileRevision = input.createPr ? (prRevision(output?.pullRequestUrl) ?? output?.commit?.oid) : revision;
	// Without a PR ref or commit (unexpected), omit file references rather than point at main.
	for (const change of summary) {
		if (change.op !== 'delete' && (fileRevision || !input.createPr))
			change.file = fileItem(kind, parsed.id, change.path, 'file', fileRevision);
	}
	return {
		repo: repoItem(kind, parsed.id),
		...(revision ? { revision } : {}),
		...(output?.commit ? { commit: { oid: output.commit.oid, url: output.commit.url } } : {}),
		...(output?.pullRequestUrl ? { pullRequestUrl: output.pullRequestUrl } : {}),
		changes: summary,
	};
}

/** Account and repository writes: whoami, create/duplicate, write files. */
export const ACCOUNT_TOOLS: readonly PtcTool[] = [
	definePtcTool({
		name: 'hf_whoami',
		family: 'account',
		title: 'Who am I on Hugging Face',
		description:
			'Check whether you are signed in to Hugging Face and as whom: signedIn, username (account.name), Hub account ID, type, profile URL and PRO status. Returns organization memberships (organizations[].name is the handle) with role, plan, access restrictions and resource groups, plus the credential: token role and fine-grained permissions, OAuth scopes and expiry, or app token entities. Signed out (no or rejected token): null account and credential, with sign-in guidance. Use account.name as the owner for my models, datasets or Spaces. The token value stays hidden.',
		input: whoamiInput,
		output: whoamiOutput,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (_input, ctx) => whoami(ctx),
	}),
	definePtcTool({
		name: 'hf_repo_create',
		family: 'account',
		title: 'Create or duplicate a Hugging Face repository',
		description:
			'Create Hugging Face repositories (model, dataset, Space) or a storage bucket by owner and name. Duplicate an existing model, dataset or Space into the same repository type. Choose public or private visibility, a Gradio, Docker or static app SDK, and optional Space GPU hardware. Returns the repository ID, URI and URL. Paid Space hardware bills the owner from creation.',
		input: createInput,
		output: createOutput,
		access: 'write',
		annotations: MUTATING,
		run: (input, ctx) => repoCreate(input, ctx),
	}),
	definePtcTool({
		name: 'hf_repo_write_files',
		family: 'account',
		title: 'Write, move or delete files in a repository',
		description:
			'Upload and save files to a model, dataset or Space repository or storage bucket. Create, overwrite, rename, move or delete paths using text or base64 content. Repository changes can target a branch or open a pull request. Overwriting replaces file content; deleting removes files.',
		input: writeInput,
		output: writeOutput,
		access: 'write',
		annotations: DESTRUCTIVE,
		run: (input, ctx) => writeFiles(input, ctx),
	}),
];
