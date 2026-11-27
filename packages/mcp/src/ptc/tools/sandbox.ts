import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { HfApiError } from '../../hf-api-call.js';
import { JobsApiClient } from '../../jobs/api-client.js';
import { parseTimeout, parseVolumes } from '../../jobs/commands/utils.js';
import { redactSensitiveText } from '../../jobs/jobs-output.js';
import type { JobInfo, JobVolume } from '../../jobs/types.js';
import {
	HfSandboxTool,
	formatSandboxHandle,
	type SandboxCreateResult,
	type SandboxExecResult,
	type SandboxFsEntry,
	type SandboxHandle,
	type SandboxJobsClient,
	type SandboxProcess,
	type SandboxRpcClient,
	type SandboxStatusResult,
} from '../../sandbox-tool.js';
import { PtcError, ptcHttpError, toPtcError } from '../core/errors.js';
import { openCursor, sealCursor } from '../core/hub-http.js';
import { parseRef, personRefSchema, refSchema, repoUri, repoUrl } from '../core/refs.js';
import { definePtcTool, DESTRUCTIVE, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';

/*
 * Sandboxes are dedicated HF Jobs running sbx-server (see ../../sandbox-tool.ts). The handle is
 * opaque (hfsb2:NAMESPACE:JOB_ID), not an hf:// uri; sandbox paths are local POSIX paths.
 * Lifecycle (create/status/terminate) goes through the legacy HfSandboxTool; exec, kill and the
 * filesystem call the same SandboxRpcClient through a thin subclass, with structured params.
 */

const MAX_FOREGROUND_TIMEOUT = 55;
const DEFAULT_EXEC_TIMEOUT = 30;
const MAX_LIFETIME_SECONDS = 24 * 3600;
const MAX_OUTPUT_CHARS = 40_000;
const DEFAULT_READ_BYTES = 20_000;
const MAX_READ_BYTES = 80_000;
const LIST_PAGE_SIZE = 500;
const MAX_PROCESSES = 200;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Client: the legacy tool plus structured access to its protected RPC plumbing
// ---------------------------------------------------------------------------

export interface SandboxDeps {
	/** Test seam: Jobs API client (production: JobsApiClient with the request token). */
	jobsClient?: (ctx: PtcContext) => SandboxJobsClient;
	/** Test seam: sbx-server RPC client (production: the legacy HTTP client). */
	rpcClient?: SandboxRpcClient;
}

/** Shortest caller-supplied env value we redact; shorter values (1, true, cpu) are not secrets and would mangle output. */
const MIN_REDACT_LENGTH = 4;

class PtcSandboxClient extends HfSandboxTool {
	readonly handle: SandboxHandle;
	/** Credentials and caller secrets that must never appear in diagnostics (longest first when applied). */
	private readonly secrets = new Set<string>();

	private readonly signal?: AbortSignal;

	constructor(ctx: PtcContext, sandbox: string | undefined, jobs?: SandboxJobsClient, rpc?: SandboxRpcClient) {
		// Jobs API and sbx-server calls both follow the request signal.
		super(ctx.hfToken, true, ctx.username, jobs ?? new JobsApiClient(ctx.hfToken, ctx.username, ctx.signal), rpc);
		this.signal = ctx.signal;
		this.handle = sandbox === undefined ? { namespace: '', jobId: '' } : this.parseHandle(sandbox);
		this.addSecret(ctx.hfToken);
	}

	get id(): string {
		return formatSandboxHandle(this.handle);
	}

	addSecret(value: string | undefined, minLength = 1): void {
		if (value && value.length >= minLength) this.secrets.add(value);
	}

	/** Remember the sbx-server token derived from the job (status calls connect inside the legacy tool). */
	rememberJob(job: JobInfo): void {
		try {
			this.addSecret(this.connectionFromJob(this.handle, job).sandboxToken);
		} catch {
			// Not a valid sandbox job; the legacy status call reports that.
		}
	}

	/** Redact diagnostics (stdout/stderr, commands, messages). Requested file contents are never passed here. */
	redact(text: string): string {
		return redactSensitiveText(
			text,
			[...this.secrets].sort((a, b) => b.length - a.length)
		);
	}

	private async conn() {
		const conn = await this.connect(this.handle);
		this.addSecret(conn.sandboxToken);
		return this.signal ? { ...conn, signal: this.signal } : conn;
	}

	async exec(command: string, opts: ExecOptions, onProgress?: (message: string) => Promise<void>) {
		const conn = await this.conn();
		const request = { command: ['/bin/sh', '-lc', command], workdir: opts.workdir, stdin: opts.stdin, env: opts.env };
		if (opts.detach) {
			return this.rpcClient.execDetached(conn, {
				...request,
				...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
				...(opts.tag !== undefined ? { tag: opts.tag } : {}),
			});
		}
		return this.rpcClient.exec(
			conn,
			{ ...request, timeout: opts.timeout ?? DEFAULT_EXEC_TIMEOUT },
			{
				onProgress: async (p) => onProgress?.(p.message ?? p.event),
				// Bounded while streaming; redacted before any cut (output and progress).
				maxOutputChars: MAX_OUTPUT_CHARS,
				redact: (text) => this.redact(text),
			}
		);
	}

	async processes(): Promise<SandboxProcess[]> {
		return this.rpcClient.listProcesses(await this.conn());
	}

	async killProcess(processId: string): Promise<void> {
		await this.rpcClient.killProcess(await this.conn(), processId);
	}

	async stat(path: string): Promise<SandboxFsEntry | null> {
		return this.rpcClient.statPath(await this.conn(), path);
	}

	async list(path: string): Promise<SandboxFsEntry[]> {
		return this.rpcClient.listDir(await this.conn(), path);
	}

	async read(path: string, offset: number, length: number): Promise<Buffer> {
		return this.rpcClient.readFile(await this.conn(), { path, offset, length });
	}

	async write(path: string, data: Buffer): Promise<void> {
		await this.rpcClient.writeFile(await this.conn(), { path, data });
	}

	async remove(path: string, recursive: boolean): Promise<void> {
		await this.rpcClient.deletePath(await this.conn(), { path, recursive });
	}

	async mkdir(path: string): Promise<void> {
		await this.rpcClient.mkdir(await this.conn(), path);
	}
}

interface ExecOptions {
	workdir?: string;
	stdin?: string;
	env?: Record<string, string>;
	timeout?: number;
	detach: boolean;
	tag?: string;
}

function requireToken(ctx: PtcContext): void {
	if (!ctx.hfToken) {
		throw new PtcError('AUTH_REQUIRED', 'Hugging Face sandboxes need a token with write access (they run HF Jobs).');
	}
}

const SAFE_LEGACY_MESSAGE =
	/^(Invalid sandbox handle.*|Bare job id needs a namespace.*|namespace contains unsupported characters\.|job id in handle contains unsupported characters\.|Sandbox name must be .*|Job \S+ is not a current sandbox.*|Sandbox job is missing a valid .*|Invalid timeout format.*|Invalid volume.*)$/s;

/** Legacy sandbox errors are plain Errors; keep our own validation messages, sanitize the rest. */
function sandboxError(error: unknown, subject: string): PtcError {
	if (error instanceof PtcError) return error;
	if (error instanceof HfApiError) return ptcHttpError(error.status, subject);
	const message = error instanceof Error ? error.message : '';
	const rpc = /^Sandbox RPC \S+ failed with (\d{3})/.exec(message);
	if (rpc) return ptcHttpError(Number(rpc[1]), subject);
	if (SAFE_LEGACY_MESSAGE.test(message)) return new PtcError('INVALID_ARGUMENT', message.slice(0, 300));
	if (message === 'connection lost while running command') {
		return new PtcError('UPSTREAM_UNAVAILABLE', `${subject}: connection lost while running the command.`, true);
	}
	return toPtcError(error, subject);
}

/** A request aborted mid-call surfaces as CANCELLED, not as whatever the interrupted fetch threw. */
function withCancellation(tool: PtcTool): PtcTool {
	return {
		...tool,
		run: async (input, ctx) => {
			try {
				return await tool.run(input, ctx);
			} catch (error) {
				if (ctx.signal?.aborted) throw new PtcError('CANCELLED', `${tool.name}: request cancelled.`, true);
				throw error;
			}
		},
	};
}

async function guarded<T>(subject: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw sandboxError(error, subject);
	}
}

function progressRelay(ctx: PtcContext, redact: (text: string) => string): (message: string) => Promise<void> {
	let step = 0;
	return async (message) => {
		step += 1;
		try {
			await ctx.onProgress?.({ progress: step, message: redact(message).slice(0, 200) });
		} catch {
			// Progress is advisory.
		}
	};
}

// ---------------------------------------------------------------------------
// Shared schemas and records
// ---------------------------------------------------------------------------

const sandboxInput = z.string().trim().min(1).max(200).describe('Sandbox handle from hf_sandbox_create (or a job id).');

const sandboxPath = z
	.string()
	.min(1)
	.max(4096)
	.refine((p) => p.startsWith('/'), 'must be an absolute path')
	.describe('Absolute POSIX path inside the sandbox, e.g. /tmp/out.txt (not an hf:// uri).');

const sandboxRecord = {
	kind: z.literal('sandbox'),
	id: z.string().describe('Pass as sandbox to the hf_sandbox_* tools.'),
	// Job page on huggingface.co.
	url: z.string(),
	namespace: z.string(),
	jobId: z.string(),
};

function sandboxFields(handle: SandboxHandle) {
	return {
		kind: 'sandbox' as const,
		id: formatSandboxHandle(handle),
		url: `https://huggingface.co/jobs/${handle.namespace}/${handle.jobId}`,
		namespace: handle.namespace,
		jobId: handle.jobId,
	};
}

const volumeSchema = z
	.object({
		kind: z.enum(['model', 'dataset', 'space', 'bucket']),
		id: z.string(),
		uri: z.string(),
		url: z.string(),
		mountPath: z.string(),
		readOnly: z.boolean(),
		path: z.string().nullable(),
		revision: z.string().nullable(),
	})
	.strict();

function volumeRecord(volume: JobVolume): z.input<typeof volumeSchema> {
	const path = volume.path ?? '';
	return {
		kind: volume.type,
		id: volume.source,
		uri: repoUri(volume.type, volume.source, volume.revision, path),
		url: repoUrl(volume.type, volume.source, volume.revision, path, true),
		mountPath: volume.mountPath,
		// Jobs mounts default to read-write when readOnly is unset.
		readOnly: volume.readOnly === true,
		path: volume.path ?? null,
		revision: volume.revision ?? null,
	};
}

const processSchema = z
	.object({
		kind: z.literal('process'),
		id: z.string().describe('Pass to hf_sandbox_kill.'),
		pid: z.number().int().nullable(),
		tag: z.string().nullable(),
		command: z.string().nullable().describe('Preview: first 500 characters.'),
		running: z.boolean().nullable(),
		exitCode: z.number().int().nullable(),
		startedAt: z.string().nullable(),
	})
	.strict();

function commandText(cmd: unknown): string | null {
	let text: string | null = null;
	if (typeof cmd === 'string') text = cmd;
	else if (Array.isArray(cmd)) {
		const parts = cmd.map(String);
		text = parts[0] === '/bin/sh' && parts[1] === '-lc' && parts.length === 3 ? (parts[2] ?? '') : parts.join(' ');
	}
	return text;
}

function processRecord(proc: SandboxProcess, redact: (text: string) => string): z.input<typeof processSchema> {
	const command = commandText(proc.cmd);
	return {
		kind: 'process',
		id: String(proc.id),
		pid: typeof proc.pid === 'number' ? proc.pid : null,
		tag: proc.tag ?? null,
		// Redact before truncating: a cut secret would no longer match and its prefix would leak.
		command: command === null ? null : redact(command).slice(0, 500),
		running: typeof proc.running === 'boolean' ? proc.running : null,
		exitCode: typeof proc.exit_code === 'number' ? proc.exit_code : null,
		startedAt: typeof proc.started_at_ms === 'number' ? new Date(proc.started_at_ms).toISOString() : null,
	};
}

const entrySchema = z
	.object({
		kind: z.enum(['file', 'dir', 'symlink']),
		id: z.string().describe('Absolute path.'),
		name: z.string(),
		size: z.number(),
		lastModified: z.string().nullable(),
		mode: z.string(),
	})
	.strict();

function entryRecord(entry: SandboxFsEntry): z.input<typeof entrySchema> {
	return {
		kind: entry.type,
		id: entry.path,
		name: entry.name,
		size: entry.size,
		lastModified: typeof entry.mtime_ms === 'number' ? new Date(entry.mtime_ms).toISOString() : null,
		mode: entry.mode,
	};
}

function tail(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	return { text: text.slice(text.length - MAX_OUTPUT_CHARS), truncated: true };
}

const UTF8_LOOKAHEAD = 3;

function utf8Length(lead: number): number {
	return lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}

/**
 * Cut a text window from `window` (maxBytes plus lookahead) on UTF-8 character boundaries:
 * skip continuation bytes at a mid-character start, drop a trailing partial character, and when
 * maxBytes is smaller than the first character, return that whole character so reads always progress.
 */
function utf8Window(
	window: Buffer,
	maxBytes: number,
	midFile: boolean,
	atEof: boolean
): { skip: number; data: Buffer } {
	let skip = 0;
	if (midFile) {
		while (skip < UTF8_LOOKAHEAD && skip < window.length && ((window[skip] ?? 0) & 0xc0) === 0x80) skip += 1;
	}
	const rest = window.subarray(skip);
	let data = rest.subarray(0, maxBytes);
	if (rest.length > data.length || !atEof) {
		data = data.subarray(0, data.length - incompleteUtf8Tail(data));
		if (!data.length) data = rest.subarray(0, utf8Length(rest[0] ?? 0));
	}
	return { skip, data };
}

/** Bytes at the end of `data` that start an incomplete UTF-8 sequence (0 when the chunk ends cleanly). */
function incompleteUtf8Tail(data: Buffer): number {
	for (let back = 1; back <= Math.min(3, data.length); back += 1) {
		const byte = data[data.length - back] ?? 0;
		if ((byte & 0xc0) === 0x80) continue; // continuation byte
		const need = utf8Length(byte);
		return need > back ? back : 0;
	}
	return 0;
}

function validateLifetime(lifetime: string): void {
	let seconds: number;
	try {
		seconds = parseTimeout(lifetime);
	} catch {
		throw new PtcError('INVALID_ARGUMENT', 'lifetime must look like 30m, 2h or a number of seconds.');
	}
	if (seconds <= 0 || seconds > MAX_LIFETIME_SECONDS) {
		throw new PtcError('INVALID_ARGUMENT', 'lifetime must be between 1 second and 24h.');
	}
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

const createInput = z
	.object({
		image: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.default('python:3.12')
			.describe('Docker image, e.g. python:3.12 or pytorch/pytorch:latest.'),
		flavor: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.default('cpu-basic')
			.describe('Flavor (hf_hardware_flavors items[].id), e.g. cpu-basic, t4-small, h100.'),
		lifetime: z
			.string()
			.trim()
			.min(1)
			.max(16)
			.default('1h')
			.describe('Idle lifetime, e.g. 30m or 2h (max 24h; billed while running).'),
		name: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/)
			.optional()
			.describe('Friendly name (1-63 letters, digits, hyphens). Generated when omitted.'),
		namespace: personRefSchema('User or org that owns and pays (name or profile uri; default: you).').optional(),
		volumes: z
			.array(z.string().min(1).max(1024))
			.max(20)
			.optional()
			.describe('FUSE mounts (repos ro, buckets rw): "hf://datasets/o/d[@rev][/dir]:/mnt:ro".'),
		bucket: refSchema.optional().describe('Bucket uri (hf_buckets_list items[].uri) to mount read-write at /data.'),
		forwardHfToken: z.boolean().default(false).describe('Expose your token in the sandbox as the HF_TOKEN secret.'),
		resourceGroupId: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.describe('Organization resource group to run in; requires namespace.'),
	})
	.strict();

const createOutput = z
	.object({
		...sandboxRecord,
		name: z.string(),
		serverUrl: z.string().describe('Needs the sandbox token: use the hf_sandbox_* tools.'),
		volumes: z.array(volumeSchema),
		ready: z.boolean().describe('False if still starting after ~10 s: check hf_sandbox_status.'),
		hfTokenForwarded: z.boolean(),
	})
	.strict();

const statusInput = z.object({ sandbox: sandboxInput }).strict();

const statusOutput = z
	.object({
		...sandboxRecord,
		name: z.string().nullable(),
		serverUrl: z.string(),
		// Job stage, e.g. RUNNING, COMPLETED, CANCELED, ERROR.
		stage: z.string(),
		stageMessage: z.string().nullable(),
		// True when sbx-server answered its health check.
		healthy: z.boolean(),
		healthError: z.string().nullable(),
		flavor: z.string().nullable(),
		image: z.string().nullable(),
		createdAt: z.string().nullable(),
		// Idle lifetime requested at creation.
		idleLifetimeSeconds: z.number().nullable(),
		volumes: z.array(volumeSchema),
		processes: z
			.object({
				items: z.array(processSchema),
				returnedCount: z.number().int(),
				nextCursor: z.null(),
				completeness: completenessSchema({
					// False when processes could not be listed (sandbox not healthy).
					available: z.boolean(),
				}),
			})
			.strict()
			.describe('Detached processes only; items[].id goes to hf_sandbox_kill.'),
	})
	.strict();

const terminateInput = statusInput;
const terminateOutput = z.object({ ...sandboxRecord, terminated: z.literal(true) }).strict();

const execInput = z
	.object({
		sandbox: sandboxInput,
		command: z
			.string()
			.min(1)
			.max(100_000)
			.describe('Shell command, run with /bin/sh -lc (pipes, redirects and && work).'),
		workdir: sandboxPath.optional().describe('Absolute working directory inside the sandbox.'),
		env: z
			.record(z.string().regex(ENV_NAME), z.string().max(32_768))
			.optional()
			.describe('Extra environment variables for this command only (never echoed back).'),
		stdin: z.string().max(1_000_000).optional().describe('Text written to the command stdin (never echoed back).'),
		timeout: z
			.number()
			.int()
			.min(1)
			.max(86_400)
			.optional()
			.describe(
				`Seconds. Foreground: default ${String(DEFAULT_EXEC_TIMEOUT)}, max ${String(MAX_FOREGROUND_TIMEOUT)}. Detached: none unless set.`
			),
		detach: z.boolean().default(false).describe('Run in the background and return the process id at once.'),
		tag: z.string().min(1).max(64).optional().describe('Label for a detached process (usable with hf_sandbox_kill).'),
	})
	.strict();

const execOutput = z
	.object({
		sandbox: z.string(),
		detached: z.boolean(),
		exitCode: z.number().int().nullable().describe('Null when killed by a signal, timed out, or detached.'),
		signal: z.union([z.number(), z.string()]).nullable(),
		timedOut: z.boolean(),
		durationMs: z.number().nullable(),
		stdout: z.string().describe(`Last ${String(MAX_OUTPUT_CHARS)} characters.`),
		stderr: z.string().describe(`Last ${String(MAX_OUTPUT_CHARS)} characters.`),
		stdoutTruncated: z.boolean(),
		stderrTruncated: z.boolean(),
		process: processSchema.nullable().describe('When detached.'),
	})
	.strict();

const killInput = z
	.object({
		sandbox: sandboxInput,
		process: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.describe('Process id from hf_sandbox_exec/status, or a tag (kills all matches).'),
	})
	.strict();

const killOutput = z
	.object({
		sandbox: z.string(),
		matchedBy: z.enum(['id', 'tag']),
		killed: z.array(processSchema),
		returnedCount: z.number().int(),
	})
	.strict();

const fsReadInput = z
	.object({
		sandbox: sandboxInput,
		path: sandboxPath,
		op: z
			.enum(['read', 'list', 'stat'])
			.default('read')
			.describe('read: byte range; list: directory entries; stat: type, size, mode.'),
		offset: z.number().int().min(0).default(0).describe('read: byte offset to start from (use nextOffset).'),
		maxBytes: z
			.number()
			.int()
			.min(1)
			.max(MAX_READ_BYTES)
			.default(DEFAULT_READ_BYTES)
			.describe(`read: bytes to return (max ${String(MAX_READ_BYTES)}).`),
		encoding: z.enum(['text', 'base64']).default('text').describe('read: text (UTF-8) or base64 for binary files.'),
		cursor: z.string().max(2048).optional().describe('list: nextCursor from a previous call with the same path.'),
	})
	.strict();

const fsReadOutput = z
	.object({
		sandbox: z.string(),
		op: z
			.enum(['read', 'list', 'stat'])
			.describe(
				'Fields not set by op are null. read: content..nextOffset (size: whole file); list: items; stat: exists, entry.'
			),
		path: z.string(),
		exists: z.boolean().nullable(),
		entry: entrySchema.nullable(),
		content: z.string().nullable(),
		encoding: z.enum(['text', 'base64']).nullable(),
		offset: z.number().int().nullable(),
		bytes: z.number().int().nullable(),
		size: z.number().nullable(),
		nextOffset: z.number().int().nullable(),
		items: z.array(entrySchema).nullable(),
		returnedCount: z.number().int().nullable(),
		nextCursor: z.string().nullable(),
		completeness: completenessSchema().nullable(),
	})
	.strict();

const fsWriteInput = z
	.object({
		sandbox: sandboxInput,
		path: sandboxPath,
		op: z
			.enum(['write', 'remove', 'mkdir'])
			.default('write')
			.describe('write: create/overwrite a file; remove: delete; mkdir: create a folder.'),
		text: z.string().max(MAX_WRITE_BYTES).optional().describe('write: UTF-8 file content (exclusive with base64).'),
		base64: z
			.string()
			.max(Math.ceil((MAX_WRITE_BYTES * 4) / 3) + 4)
			.optional()
			.describe('write: base64 file content for binary files (exclusive with text).'),
		recursive: z.boolean().default(false).describe('remove: delete a directory and its contents.'),
	})
	.strict();

const fsWriteOutput = z
	.object({
		sandbox: z.string(),
		op: z.enum(['write', 'remove', 'mkdir']),
		path: z.string(),
		// write: bytes written.
		bytes: z.number().int().nullable(),
		done: z.literal(true),
	})
	.strict();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createSandboxTools(deps: SandboxDeps = {}): readonly PtcTool[] {
	/** Check auth and parse the handle; invalid handles become INVALID_ARGUMENT. */
	const open = (subject: string, ctx: PtcContext, sandbox?: string, jobs?: SandboxJobsClient): PtcSandboxClient => {
		requireToken(ctx);
		try {
			return new PtcSandboxClient(ctx, sandbox, jobs ?? deps.jobsClient?.(ctx), deps.rpcClient);
		} catch (error) {
			throw sandboxError(error, subject);
		}
	};

	const tools: PtcTool[] = [
		definePtcTool({
			name: 'hf_sandbox_create',
			family: 'sandbox',
			title: 'Create a Hugging Face sandbox',
			description:
				'Sandbox: Create a Hugging Face sandbox (cloud shell, dev container) on CPU or GPU hardware. Choose a Docker image, idle lifetime and optional volume mounts. Returns a sandbox handle and readiness flag. Consumes paid compute billed to the owning user or organization while running.',
			input: createInput,
			output: createOutput,
			access: 'write',
			annotations: DESTRUCTIVE,
			run: async (input, ctx) => {
				const sandbox = open('hf_sandbox_create', ctx);
				validateLifetime(input.lifetime);
				if (input.resourceGroupId && !input.namespace) {
					throw new PtcError('INVALID_ARGUMENT', 'resourceGroupId requires namespace (the owning organization).');
				}
				let bucket: string | undefined;
				if (input.bucket) {
					const ref = parseRef(input.bucket, 'bucket');
					if (ref.kind !== 'bucket' || ref.path) {
						throw new PtcError('INVALID_ARGUMENT', 'bucket must name a storage bucket (hf://buckets/OWNER/NAME).');
					}
					bucket = ref.id;
				}
				try {
					parseVolumes([...(input.volumes ?? []), ...(bucket ? [`hf://buckets/${bucket}:/data:rw`] : [])]);
				} catch (error) {
					throw new PtcError(
						'INVALID_ARGUMENT',
						(error instanceof Error ? error.message : 'invalid volume').slice(0, 300)
					);
				}
				const args = ['--image', input.image, '--flavor', input.flavor, '--timeout', input.lifetime];
				if (input.name) args.push('--name', input.name);
				if (input.namespace) args.push('--namespace', input.namespace);
				if (input.resourceGroupId) args.push('--resource-group-id', input.resourceGroupId);
				if (input.forwardHfToken) args.push('--forward-hf-token');
				for (const volume of input.volumes ?? []) args.push('--volume', volume);
				if (bucket) args.push('--bucket', bucket);
				const relay = progressRelay(ctx, (text) => sandbox.redact(text));
				const result = (await guarded('hf_sandbox_create', () =>
					sandbox.run({ cmd: 'create', args }, { onProgress: (p) => relay(p.message ?? p.event) })
				)) as SandboxCreateResult;
				return {
					...sandboxFields({ namespace: result.namespace, jobId: result.job_id }),
					name: result.name,
					serverUrl: result.url,
					volumes: result.volumes.map(volumeRecord),
					ready: !result.message,
					hfTokenForwarded: input.forwardHfToken,
				};
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_status',
			family: 'sandbox',
			title: 'Get Hugging Face sandbox status',
			description:
				'Sandbox: Check Hugging Face sandbox status, server health and background processes by handle. Returns job stage, hardware flavor, image, idle lifetime and volume mounts, plus detached process IDs, tags, running states and exit codes when process listing is available.',
			input: statusInput,
			output: statusOutput,
			access: 'write',
			annotations: READ_ONLY,
			run: async (input, ctx) => {
				requireToken(ctx);
				// Record the JobInfo the legacy status call fetches (labels, env, timestamps) instead of fetching twice.
				let job: JobInfo | undefined;
				const jobs = deps.jobsClient?.(ctx) ?? new JobsApiClient(ctx.hfToken, ctx.username, ctx.signal);
				const recording: SandboxJobsClient = {
					getNamespace: (ns) => jobs.getNamespace(ns),
					runJob: (spec, ns) => jobs.runJob(spec, ns),
					cancelJob: (id, ns) => jobs.cancelJob(id, ns),
					getJob: async (id, ns) => {
						job = await jobs.getJob(id, ns);
						sandbox.rememberJob(job);
						return job;
					},
				};
				const sandbox = open('hf_sandbox_status', ctx, input.sandbox, recording);
				const redact = (text: string) => sandbox.redact(text);
				const status = (await guarded('hf_sandbox_status', () =>
					sandbox.run({ cmd: 'status', args: [sandbox.id] })
				)) as SandboxStatusResult;
				const healthy = status.health.ok;
				let healthError: string | null = null;
				if (!healthy) {
					const raw = typeof status.health.error === 'string' ? status.health.error : 'health check failed';
					healthError = redact(sandboxError(new Error(raw), 'sandbox server').message);
				}
				let processes: SandboxProcess[] = [];
				let available = false;
				if (healthy) {
					try {
						processes = await sandbox.processes();
						available = true;
					} catch {
						available = false;
					}
				}
				const items = processes.slice(0, MAX_PROCESSES).map((p) => processRecord(p, redact));
				const idle = Number(job?.environment?.SBX_IDLE_TIMEOUT);
				return {
					...sandboxFields(sandbox.handle),
					name: job?.labels?.pet ?? null,
					serverUrl: status.url,
					stage: status.status.stage,
					stageMessage: status.status.message ? redact(status.status.message) : null,
					healthy,
					healthError,
					flavor: job?.flavor ?? null,
					image: job?.dockerImage ?? null,
					createdAt: job?.createdAt ?? null,
					idleLifetimeSeconds: Number.isFinite(idle) ? idle : null,
					volumes: status.volumes.map(volumeRecord),
					processes: {
						items,
						returnedCount: items.length,
						nextCursor: null,
						completeness:
							processes.length > items.length
								? { hasMore: true, truncated: true, reason: 'items_cap' as const, available }
								: { hasMore: false, available },
					},
				};
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_terminate',
			family: 'sandbox',
			title: 'Terminate a Hugging Face sandbox',
			description:
				'Sandbox: Stop and terminate a Hugging Face sandbox by its handle. Ends the sandbox and returns termination confirmation, the sandbox ID, the underlying job ID and a link to its job page.',
			input: terminateInput,
			output: terminateOutput,
			access: 'write',
			annotations: DESTRUCTIVE,
			run: async (input, ctx) => {
				const sandbox = open('hf_sandbox_terminate', ctx, input.sandbox);
				await guarded('hf_sandbox_terminate', () => sandbox.run({ cmd: 'terminate', args: [sandbox.id] }));
				return { ...sandboxFields(sandbox.handle), terminated: true as const };
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_exec',
			family: 'sandbox',
			title: 'Run a command in a Hugging Face sandbox',
			description:
				'Sandbox: Run a shell command in an existing Hugging Face sandbox using /bin/sh, with pipes and redirects. Returns exit code, stdout and stderr, or starts a background process and returns its ID. Choose a working directory and command environment. Commands can modify or delete sandbox data.',
			input: execInput,
			output: execOutput,
			access: 'write',
			annotations: DESTRUCTIVE,
			run: async (input, ctx) => {
				if (!input.detach && input.timeout !== undefined && input.timeout > MAX_FOREGROUND_TIMEOUT) {
					throw new PtcError(
						'INVALID_ARGUMENT',
						`foreground timeout must be <= ${String(MAX_FOREGROUND_TIMEOUT)} seconds; use detach=True for longer commands.`
					);
				}
				if (!input.detach && input.tag !== undefined) {
					throw new PtcError('INVALID_ARGUMENT', 'tag applies to detached commands only (detach=True).');
				}
				const sandbox = open('hf_sandbox_exec', ctx, input.sandbox);
				for (const value of Object.values(input.env ?? {})) sandbox.addSecret(value, MIN_REDACT_LENGTH);
				const redact = (text: string) => sandbox.redact(text);
				const opts: ExecOptions = {
					workdir: input.workdir,
					stdin: input.stdin,
					env: input.env,
					timeout: input.timeout,
					detach: input.detach,
					tag: input.tag,
				};
				const result = await guarded('hf_sandbox_exec', () =>
					sandbox.exec(input.command, opts, progressRelay(ctx, redact))
				);
				if (input.detach) {
					const proc = result as SandboxProcess;
					return {
						sandbox: sandbox.id,
						detached: true,
						exitCode: null,
						signal: null,
						timedOut: false,
						durationMs: null,
						stdout: '',
						stderr: '',
						stdoutTruncated: false,
						stderrTruncated: false,
						process: processRecord(
							{ ...proc, tag: proc.tag ?? input.tag ?? null, cmd: proc.cmd ?? input.command },
							redact
						),
					};
				}
				const done = result as SandboxExecResult;
				// Redact before trimming so a secret is never cut into an unrecognizable fragment.
				const stdout = tail(redact(done.stdout));
				const stderr = tail(redact(done.stderr));
				return {
					sandbox: sandbox.id,
					detached: false,
					exitCode: done.returncode,
					signal: done.signal,
					timedOut: done.timed_out,
					durationMs: done.duration_ms,
					stdout: stdout.text,
					stderr: stderr.text,
					stdoutTruncated: stdout.truncated || done.stdout_dropped === true,
					stderrTruncated: stderr.truncated || done.stderr_dropped === true,
					process: null,
				};
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_kill',
			family: 'sandbox',
			title: 'Kill a sandbox background process',
			description:
				'Sandbox: Kill a background process in a Hugging Face sandbox by process ID or tag. A tag stops every matching process. Returns the killed process records and match method; the sandbox itself keeps running.',
			input: killInput,
			output: killOutput,
			access: 'write',
			annotations: DESTRUCTIVE,
			run: async (input, ctx) => {
				const sandbox = open('hf_sandbox_kill', ctx, input.sandbox);
				const processes = await guarded('hf_sandbox_kill', () => sandbox.processes());
				const byId = processes.filter((p) => String(p.id) === input.process);
				const matchedBy = byId.length ? ('id' as const) : ('tag' as const);
				const targets = byId.length ? byId : processes.filter((p) => p.tag === input.process && p.running !== false);
				if (!targets.length) {
					throw new PtcError('NOT_FOUND', 'no running process with that id or tag; see hf_sandbox_status.');
				}
				for (const proc of targets) {
					await guarded('hf_sandbox_kill', () => sandbox.killProcess(String(proc.id)));
				}
				const killed = targets.map((p) => processRecord({ ...p, running: false }, (text) => sandbox.redact(text)));
				return { sandbox: sandbox.id, matchedBy, killed, returnedCount: killed.length };
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_fs_read',
			family: 'sandbox',
			title: 'Read files in a Hugging Face sandbox',
			description:
				'Sandbox: Read a Hugging Face sandbox file, list a directory or inspect a path by absolute sandbox path. Returns file bytes as UTF-8 text or base64, directory entries, or existence, type, size and mode. File reads return a continuation offset for chunked access.',
			input: fsReadInput,
			output: fsReadOutput,
			access: 'write',
			annotations: READ_ONLY,
			run: async (input, ctx) => {
				const sandbox = open('hf_sandbox_fs_read', ctx, input.sandbox);
				const empty = {
					sandbox: sandbox.id,
					op: input.op,
					path: input.path,
					exists: null,
					entry: null,
					content: null,
					encoding: null,
					offset: null,
					bytes: null,
					size: null,
					nextOffset: null,
					items: null,
					returnedCount: null,
					nextCursor: null,
					completeness: null,
				};
				const subject = 'sandbox path';
				if (input.op === 'stat') {
					const entry = await guarded(subject, () => sandbox.stat(input.path));
					return { ...empty, exists: entry !== null, entry: entry ? entryRecord(entry) : null };
				}
				if (input.op === 'list') {
					const binding = { tool: 'hf_sandbox_fs_read', sandbox: sandbox.id, path: input.path };
					const start = Number(openCursor(input.cursor, binding, ctx) ?? 0);
					const entries = await guarded(subject, () => sandbox.list(input.path));
					const items = entries.slice(start, start + LIST_PAGE_SIZE).map(entryRecord);
					const end = start + items.length;
					const more = end < entries.length;
					return {
						...empty,
						items,
						returnedCount: items.length,
						nextCursor: more ? sealCursor(binding, ctx, String(end)) : null,
						completeness: { hasMore: more },
					};
				}
				const stat = await guarded(subject, () => sandbox.stat(input.path));
				if (!stat) throw new PtcError('NOT_FOUND', 'sandbox path not found; check it with op=list.');
				if (stat.type === 'dir') throw new PtcError('INVALID_ARGUMENT', 'path is a directory; use op=list.');
				let offset = input.offset;
				let data: Buffer;
				if (input.encoding === 'base64') {
					data = await guarded(subject, () => sandbox.read(input.path, offset, input.maxBytes));
				} else {
					// Read a few extra bytes so a window can be aligned to whole UTF-8 characters.
					const window = await guarded(subject, () =>
						sandbox.read(input.path, offset, input.maxBytes + UTF8_LOOKAHEAD)
					);
					const text = utf8Window(window, input.maxBytes, offset > 0, offset + window.length >= stat.size);
					offset += text.skip;
					data = text.data;
				}
				const end = offset + data.length;
				return {
					...empty,
					content: input.encoding === 'text' ? data.toString('utf-8') : data.toString('base64'),
					encoding: input.encoding,
					offset,
					bytes: data.length,
					size: stat.size,
					nextOffset: end < stat.size && data.length > 0 ? end : null,
				};
			},
		}),
		definePtcTool({
			name: 'hf_sandbox_fs_write',
			family: 'sandbox',
			title: 'Write files in a Hugging Face sandbox',
			description:
				'Sandbox: Write a Hugging Face sandbox file from text or base64 content at an absolute sandbox path. Create or overwrite files, create directories, or delete files and recursively remove directory contents. Overwrites replace existing file content. Returns completion and, for writes, bytes written.',
			input: fsWriteInput,
			output: fsWriteOutput,
			access: 'write',
			annotations: DESTRUCTIVE,
			run: async (input, ctx) => {
				const sandbox = open('hf_sandbox_fs_write', ctx, input.sandbox);
				const result = { sandbox: sandbox.id, op: input.op, path: input.path, bytes: null, done: true as const };
				const subject = 'sandbox path';
				if (input.op === 'write') {
					if ((input.text === undefined) === (input.base64 === undefined)) {
						throw new PtcError('INVALID_ARGUMENT', 'op=write needs exactly one of text or base64.');
					}
					let data: Buffer;
					if (input.text !== undefined) {
						data = Buffer.from(input.text, 'utf-8');
					} else {
						const encoded = (input.base64 ?? '').replace(/\s+/g, '');
						if (!BASE64.test(encoded) || encoded.length % 4 === 1) {
							throw new PtcError('INVALID_ARGUMENT', 'base64 is not valid base64.');
						}
						data = Buffer.from(encoded, 'base64');
					}
					if (data.length > MAX_WRITE_BYTES) {
						throw new PtcError('INVALID_ARGUMENT', 'content exceeds the 10 MiB write limit.');
					}
					await guarded(subject, () => sandbox.write(input.path, data));
					return { ...result, bytes: data.length };
				}
				if (input.text !== undefined || input.base64 !== undefined) {
					throw new PtcError('INVALID_ARGUMENT', `text/base64 apply to op=write only, not op=${input.op}.`);
				}
				if (input.op === 'remove') {
					await guarded(subject, () => sandbox.remove(input.path, input.recursive));
				} else {
					await guarded(subject, () => sandbox.mkdir(input.path));
				}
				return result;
			},
		}),
	];
	return tools.map(withCancellation);
}

/** Sandboxes: lifecycle, exec, filesystem. */
export const SANDBOX_TOOLS: readonly PtcTool[] = createSandboxTools();
