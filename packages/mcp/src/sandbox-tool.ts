import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { parseCommandArgs, type CommandOptionMap } from './command-args.js';
import { JobsApiClient } from './jobs/api-client.js';
import type { JobInfo, JobSpec, JobStatus, JobVolume } from './jobs/types.js';
import { parseTimeout, parseVolumes } from './jobs/commands/utils.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from './network/fetch-profile.js';
import { escapeMarkdown, formatBytes } from './utilities.js';

const SANDBOX_HANDLE_VERSION = 'hfsb2';
const SANDBOX_PORT = 49983;
const DEFAULT_BUCKET_MOUNT_PATH = '/data';
const DEFAULT_IMAGE = 'python:3.12';
const DEFAULT_FLAVOR = 'cpu-basic';
const DEFAULT_TIMEOUT = '1h';
const DEFAULT_EXEC_TIMEOUT = 30;
const MAX_FOREGROUND_EXEC_TIMEOUT = 55;
const CREATE_HEALTH_TIMEOUT_MS = 10_000;
const CREATE_HEALTH_POLL_MS = 500;
const FOREGROUND_EXEC_HTTP_GRACE_SECONDS = 5;
const EXEC_PROGRESS_MIN_INTERVAL_MS = 2_000;
const VOLUME_FORMAT = 'hf://[models|datasets|spaces|buckets]/OWNER/NAME[/PATH]:/MOUNT_PATH[:ro|:rw]';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const HOST_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SANDBOX_SERVER_BUCKET = 'huggingface/sbx-server';
const SANDBOX_SERVER_MOUNT_PATH = '/.hf-sbx-server';
const SANDBOX_MAX_LIFETIME = '24h';
const SANDBOX_LABEL = 'hf-sandbox';
const MODE_LABEL = 'hf-sandbox-mode';
const MODE_DEDICATED = 'dedicated';
const NONCE_LABEL = 'hf-sandbox-nonce';
const DEFAULT_CAT_MAX_BYTES = 20_000;
const MAX_CAT_BYTES = 100_000;
const HANDLE_CACHE_MAX = 500;
const AUTH_REQUIRED_MESSAGE =
	'Hugging Face sandboxes require authentication because they create and control HF Jobs. Set HF_TOKEN or authenticate your MCP client, then retry with ?mix=sandbox or ?bouquet=sandbox.';
const BOOTSTRAP_DOWNLOAD = `set -e
d=/tmp/.sbx-server
if command -v wget >/dev/null 2>&1; then wget -q --header "Authorization: Bearer $SBX_DL_TOKEN" -O "$d" "$SBX_SERVER_URL"
elif command -v curl >/dev/null 2>&1; then curl -fsSL -H "Authorization: Bearer $SBX_DL_TOKEN" -o "$d" "$SBX_SERVER_URL"
else cp "$SBX_SERVER_MOUNT/sbx-server" "$d"; fi
chmod +x "$d"
unset SBX_DL_TOKEN SBX_SERVER_URL SBX_SERVER_MOUNT
exec "$d"`;

function handleDescription(username?: string): string {
	const namespaceHint = username ? ` Bare job ids default to namespace ${username}.` : '';
	return (
		`Sandbox handle returned by hf_sandbox create. Use this value for future sandbox operations. Accepted forms: ` +
		`${SANDBOX_HANDLE_VERSION}:NAMESPACE:JOB_ID, NAMESPACE/JOB_ID, or a bare job id.${namespaceHint}`
	);
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

export interface SandboxHandle {
	namespace: string;
	jobId: string;
}

function validateName(name: string): void {
	if (!NAME_PATTERN.test(name)) {
		throw new Error('Sandbox name must be 1-63 URL-safe alphanumeric or hyphen characters.');
	}
}

function validateNamespace(namespace: string): void {
	if (!NAMESPACE_PATTERN.test(namespace)) {
		throw new Error('namespace contains unsupported characters.');
	}
}

function validateJobId(jobId: string): void {
	if (!HOST_SAFE_PATTERN.test(jobId)) {
		throw new Error('job id in handle contains unsupported characters.');
	}
}

export function parseSandboxHandle(handle: string, defaultNamespace?: string): SandboxHandle {
	if (handle.includes(':')) {
		const parts = handle.split(':');
		if (parts.length !== 3 || parts[0] !== SANDBOX_HANDLE_VERSION) {
			throw new Error(
				`Invalid sandbox handle. Expected ${SANDBOX_HANDLE_VERSION}:<namespace>:<job_id>, <namespace>/<job_id>, or a bare job id.`
			);
		}
		const [, namespace, jobId] = parts;
		if (!namespace || !jobId) {
			throw new Error('Invalid sandbox handle. All handle fields are required.');
		}
		validateNamespace(namespace);
		validateJobId(jobId);
		return { namespace, jobId };
	}

	if (handle.includes('/')) {
		const parts = handle.split('/');
		const [namespace, jobId] = parts;
		if (parts.length !== 2 || !namespace || !jobId) {
			throw new Error('Invalid sandbox handle. Expected <namespace>/<job_id>.');
		}
		validateNamespace(namespace);
		validateJobId(jobId);
		return { namespace, jobId };
	}

	if (!defaultNamespace) {
		throw new Error(
			`Bare job id needs a namespace. Use ${SANDBOX_HANDLE_VERSION}:<namespace>:<job_id> or <namespace>/<job_id>.`
		);
	}
	validateNamespace(defaultNamespace);
	validateJobId(handle);
	return { namespace: defaultNamespace, jobId: handle };
}

export function formatSandboxHandle(handle: SandboxHandle): string {
	validateNamespace(handle.namespace);
	validateJobId(handle.jobId);
	return `${SANDBOX_HANDLE_VERSION}:${handle.namespace}:${handle.jobId}`;
}

// ---------------------------------------------------------------------------
// Stateless auth: SBX_TOKEN = HMAC(hf_token, nonce), nonce lives in job labels.
// Matches huggingface_hub's scheme so handles are portable across clients.
// ---------------------------------------------------------------------------

export interface SandboxConnection {
	url: string;
	hfToken: string;
	sandboxToken: string;
}

function createNonce(): string {
	return randomBytes(16).toString('hex');
}

function deriveSandboxToken(hfToken: string, nonce: string): string {
	if (!NONCE_PATTERN.test(nonce)) {
		throw new Error(`Sandbox job is missing a valid '${NONCE_LABEL}' label.`);
	}
	return createHmac('sha256', hfToken).update(`hf-sandbox:${nonce}`).digest('hex');
}

function getJobUrl(namespace: string, jobId: string): string {
	return `https://huggingface.co/jobs/${namespace}/${jobId}`;
}

function getExposeUrl(job: JobInfo | undefined, jobId: string, port: number): string {
	const exposed = job?.status.expose_urls?.find((url) => typeof url === 'string' && url.startsWith('https://'));
	return exposed ?? `https://${jobId}--${String(port)}.hf.jobs`;
}

// The nonce and expose URL are immutable for a job's lifetime, so cache them to
// avoid a Jobs API round-trip on every sandbox operation.
const handleCache = new Map<string, { nonce: string; url: string }>();

export function clearSandboxHandleCache(): void {
	handleCache.clear();
}

function cacheKey(handle: SandboxHandle): string {
	return `${handle.namespace}:${handle.jobId}`;
}

function cacheConnection(handle: SandboxHandle, nonce: string, url: string): void {
	if (handleCache.size >= HANDLE_CACHE_MAX) {
		const oldest = handleCache.keys().next().value;
		if (oldest !== undefined) {
			handleCache.delete(oldest);
		}
	}
	handleCache.set(cacheKey(handle), { nonce, url });
}

// ---------------------------------------------------------------------------
// Sandbox RPC client (sbx-server HTTP API through the HF Jobs proxy)
// ---------------------------------------------------------------------------

export interface SandboxExecRequest {
	command: string[];
	workdir?: string;
	stdin?: string;
	timeout?: number;
	env?: Record<string, string>;
}

export interface SandboxExecResult {
	returncode: number | null;
	stdout: string;
	stderr: string;
	signal: number | string | null;
	timed_out: boolean;
	duration_ms: number;
}

interface SandboxExecAccumulator extends SandboxExecResult {
	sawExit: boolean;
}

export type SandboxExecEvent =
	| { event: 'start'; pid?: number }
	| { event: 'stdout' | 'stderr'; data?: string }
	| { event: 'ping' }
	| {
			event: 'exit';
			exit_code?: number | null;
			signal?: number | string | null;
			timed_out?: boolean;
			duration_ms?: number;
	  };

export interface SandboxProgress {
	progress?: number;
	total?: number;
	message?: string;
	event: string;
}

export interface SandboxExecProgress extends SandboxProgress {
	event: SandboxExecEvent['event'];
}

export interface SandboxOptions {
	onProgress?: (progress: SandboxProgress) => void | Promise<void>;
}

export interface SandboxExecOptions {
	onProgress?: (progress: SandboxExecProgress) => void | Promise<void>;
}

export interface SandboxHealthOptions {
	timeoutSeconds?: number;
}

export interface SandboxProcess {
	id: string;
	pid: number;
	cmd?: unknown;
	tag?: string | null;
	started_at_ms?: number;
	running?: boolean;
	exit_code?: number | null;
}

export interface SandboxFsEntry {
	name: string;
	path: string;
	type: 'file' | 'dir' | 'symlink';
	size: number;
	mtime_ms: number | null;
	mode: string;
}

export interface SandboxRpcClient {
	health(conn: SandboxConnection, options?: SandboxHealthOptions): Promise<unknown>;
	exec(conn: SandboxConnection, args: SandboxExecRequest, options?: SandboxExecOptions): Promise<SandboxExecResult>;
	execDetached(conn: SandboxConnection, args: SandboxExecRequest & { tag?: string }): Promise<SandboxProcess>;
	listProcesses(conn: SandboxConnection): Promise<SandboxProcess[]>;
	killProcess(conn: SandboxConnection, processId: string): Promise<void>;
	readFile(conn: SandboxConnection, args: { path: string; offset?: number; length?: number }): Promise<Buffer>;
	writeFile(conn: SandboxConnection, args: { path: string; data: Buffer }): Promise<void>;
	listDir(conn: SandboxConnection, path: string): Promise<SandboxFsEntry[]>;
	statPath(conn: SandboxConnection, path: string): Promise<SandboxFsEntry | null>;
	deletePath(conn: SandboxConnection, args: { path: string; recursive: boolean }): Promise<void>;
	mkdir(conn: SandboxConnection, path: string): Promise<void>;
}

export function normalizeSandboxHealth(payload: unknown): Record<string, unknown> & { ok: boolean } {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		return { ok: false, value: payload };
	}
	const record = payload as Record<string, unknown>;
	const ok = typeof record.ok === 'boolean' ? record.ok : record.status === 'ok';
	return { ...record, ok };
}

function createExecAccumulator(): SandboxExecAccumulator {
	return {
		returncode: null,
		stdout: '',
		stderr: '',
		signal: null,
		timed_out: false,
		duration_ms: 0,
		sawExit: false,
	};
}

function parseSandboxExecEventLine(line: string): SandboxExecEvent | null {
	if (!line) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// A partially transmitted trailing line means the connection dropped;
		// the missing exit event below reports it.
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return null;
	}
	const event = parsed as SandboxExecEvent;
	if (
		event.event === 'start' ||
		event.event === 'stdout' ||
		event.event === 'stderr' ||
		event.event === 'ping' ||
		event.event === 'exit'
	) {
		return event;
	}
	return null;
}

function applySandboxExecEvent(accumulator: SandboxExecAccumulator, event: SandboxExecEvent): void {
	if (event.event === 'stdout') {
		accumulator.stdout += event.data ?? '';
	} else if (event.event === 'stderr') {
		accumulator.stderr += event.data ?? '';
	} else if (event.event === 'exit') {
		accumulator.sawExit = true;
		accumulator.returncode = event.exit_code ?? null;
		accumulator.signal = event.signal ?? null;
		accumulator.timed_out = event.timed_out ?? false;
		accumulator.duration_ms = event.duration_ms ?? 0;
	}
}

function finishSandboxExecResult(accumulator: SandboxExecAccumulator): SandboxExecResult {
	if (!accumulator.sawExit) {
		throw new Error('connection lost while running command');
	}
	const { sawExit: _sawExit, ...result } = accumulator;
	return result;
}

export function parseSandboxExecEvents(text: string): SandboxExecResult {
	const accumulator = createExecAccumulator();

	for (const line of text.split(/\r?\n/)) {
		const event = parseSandboxExecEventLine(line);
		if (event) {
			applySandboxExecEvent(accumulator, event);
		}
	}

	return finishSandboxExecResult(accumulator);
}

function sandboxExecProgressFromEvent(event: SandboxExecEvent): SandboxExecProgress | null {
	switch (event.event) {
		case 'start':
			return { event: 'start', progress: 0, message: `Started process${event.pid ? ` ${String(event.pid)}` : ''}.` };
		case 'stdout':
		case 'stderr': {
			const stream = event.event;
			const text = (event.data ?? '').replace(/\s+$/u, '');
			const lines = text.split(/\r?\n/).filter(Boolean);
			const lastLine = lines[lines.length - 1];
			return {
				event: stream,
				message: lastLine ? `${stream}: ${lastLine.slice(0, 160)}` : `Received ${stream} output.`,
			};
		}
		case 'ping':
			return { event: 'ping', message: 'Command is still running.' };
		case 'exit':
			return {
				event: 'exit',
				message: event.timed_out
					? `Command timed out after ${String(event.duration_ms ?? 0)}ms.`
					: `Command exited with ${event.exit_code === null || event.exit_code === undefined ? `signal ${String(event.signal)}` : `code ${String(event.exit_code)}`}.`,
			};
	}
}

async function notifySandboxExecProgress(
	options: SandboxExecOptions | undefined,
	event: SandboxExecEvent
): Promise<void> {
	const progress = sandboxExecProgressFromEvent(event);
	if (!progress || !options?.onProgress) {
		return;
	}
	try {
		await options.onProgress(progress);
	} catch {
		// Progress notifications are advisory; a failed notification must not
		// fail the command whose output is still streaming.
	}
}

async function notifySandboxProgress(options: SandboxOptions | undefined, progress: SandboxProgress): Promise<void> {
	if (!options?.onProgress) {
		return;
	}
	try {
		await options.onProgress(progress);
	} catch {
		// Progress notifications are advisory; a failed notification must not fail the operation.
	}
}

async function parseSandboxExecResponse(response: Response, options?: SandboxExecOptions): Promise<SandboxExecResult> {
	if (!response.body) {
		return parseSandboxExecEvents(await response.text());
	}

	const accumulator = createExecAccumulator();
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	let lastOutputProgressAt = 0;

	const handleLine = async (line: string): Promise<void> => {
		const event = parseSandboxExecEventLine(line);
		if (!event) {
			return;
		}
		applySandboxExecEvent(accumulator, event);

		if (event.event === 'stdout' || event.event === 'stderr') {
			const now = Date.now();
			if (now - lastOutputProgressAt < EXEC_PROGRESS_MIN_INTERVAL_MS) {
				return;
			}
			lastOutputProgressAt = now;
		}
		await notifySandboxExecProgress(options, event);
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffered += decoder.decode(value, { stream: true });
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? '';
		for (const line of lines) {
			await handleLine(line);
		}
	}

	buffered += decoder.decode();
	if (buffered) {
		await handleLine(buffered);
	}

	return finishSandboxExecResult(accumulator);
}

class HttpSandboxRpcClient implements SandboxRpcClient {
	private async request(
		conn: SandboxConnection,
		path: string,
		options: {
			method?: string;
			body?: BodyInit;
			headers?: Record<string, string>;
			timeoutSeconds?: number;
			allowStatuses?: number[];
		} = {}
	): Promise<Response> {
		const requestInit: RequestInit = {
			method: options.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${conn.hfToken}`,
				'X-Sandbox-Token': conn.sandboxToken,
				...options.headers,
			},
			...(options.body ? { body: options.body } : {}),
		};
		const { response } = await fetchWithProfile(`${conn.url}${path}`, NETWORK_FETCH_PROFILES.externalHttps(), {
			timeoutMs: (options.timeoutSeconds ?? 30) * 1000,
			requestInit,
		});

		if (!response.ok && !options.allowStatuses?.includes(response.status)) {
			const responseText = await response.text();
			let payload: unknown = responseText;
			try {
				payload = responseText ? (JSON.parse(responseText) as unknown) : {};
			} catch {
				// Keep raw text.
			}
			throw new Error(`Sandbox RPC ${path} failed with ${String(response.status)}: ${JSON.stringify(payload)}`);
		}

		return response;
	}

	private async requestJson(
		conn: SandboxConnection,
		path: string,
		options: Parameters<HttpSandboxRpcClient['request']>[2] = {}
	): Promise<unknown> {
		const response = await this.request(conn, path, {
			...options,
			headers: { Accept: 'application/json', ...options.headers },
		});
		const text = await response.text();
		return text ? (JSON.parse(text) as unknown) : {};
	}

	private execBody(args: SandboxExecRequest & { tag?: string }): string {
		return JSON.stringify({
			cmd: args.command,
			shell: false,
			cwd: args.workdir,
			stdin: args.stdin,
			timeout: args.timeout,
			env: args.env,
			tag: args.tag,
		});
	}

	async health(conn: SandboxConnection, options?: SandboxHealthOptions): Promise<unknown> {
		return normalizeSandboxHealth(await this.requestJson(conn, '/health', { timeoutSeconds: options?.timeoutSeconds }));
	}

	async exec(
		conn: SandboxConnection,
		args: SandboxExecRequest,
		options?: SandboxExecOptions
	): Promise<SandboxExecResult> {
		const timeout = args.timeout ?? DEFAULT_EXEC_TIMEOUT;
		const response = await this.request(conn, '/v1/exec', {
			method: 'POST',
			headers: {
				Accept: 'application/x-ndjson',
				'Content-Type': 'application/json',
			},
			body: this.execBody({ ...args, timeout }),
			timeoutSeconds: timeout + FOREGROUND_EXEC_HTTP_GRACE_SECONDS,
		});
		return parseSandboxExecResponse(response, options);
	}

	async execDetached(conn: SandboxConnection, args: SandboxExecRequest & { tag?: string }): Promise<SandboxProcess> {
		return (await this.requestJson(conn, '/v1/processes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: this.execBody(args),
		})) as SandboxProcess;
	}

	async listProcesses(conn: SandboxConnection): Promise<SandboxProcess[]> {
		const payload = await this.requestJson(conn, '/v1/processes');
		return Array.isArray(payload) ? (payload as SandboxProcess[]) : [];
	}

	async killProcess(conn: SandboxConnection, processId: string): Promise<void> {
		await this.requestJson(conn, `/v1/processes/${encodeURIComponent(processId)}`, { method: 'DELETE' });
	}

	async readFile(conn: SandboxConnection, args: { path: string; offset?: number; length?: number }): Promise<Buffer> {
		const params = new URLSearchParams({ path: args.path });
		if (args.offset !== undefined) {
			params.set('offset', String(args.offset));
		}
		if (args.length !== undefined) {
			params.set('length', String(args.length));
		}
		const response = await this.request(conn, `/v1/files/read?${params.toString()}`, { timeoutSeconds: 60 });
		return Buffer.from(await response.arrayBuffer());
	}

	async writeFile(conn: SandboxConnection, args: { path: string; data: Buffer }): Promise<void> {
		const params = new URLSearchParams({ path: args.path });
		const body = new Uint8Array(args.data.byteLength);
		body.set(args.data);
		await this.request(conn, `/v1/files/write?${params.toString()}`, {
			method: 'PUT',
			body,
			timeoutSeconds: 60,
		});
	}

	async listDir(conn: SandboxConnection, path: string): Promise<SandboxFsEntry[]> {
		const params = new URLSearchParams({ path });
		const payload = (await this.requestJson(conn, `/v1/files/list?${params.toString()}`)) as {
			entries?: SandboxFsEntry[];
		};
		return payload.entries ?? [];
	}

	async statPath(conn: SandboxConnection, path: string): Promise<SandboxFsEntry | null> {
		const params = new URLSearchParams({ path });
		const response = await this.request(conn, `/v1/files/stat?${params.toString()}`, {
			headers: { Accept: 'application/json' },
			allowStatuses: [404],
		});
		if (response.status === 404) {
			return null;
		}
		return (await response.json()) as SandboxFsEntry;
	}

	async deletePath(conn: SandboxConnection, args: { path: string; recursive: boolean }): Promise<void> {
		const params = new URLSearchParams({ path: args.path, recursive: args.recursive ? 'true' : 'false' });
		await this.requestJson(conn, `/v1/files/delete?${params.toString()}`, { method: 'DELETE' });
	}

	async mkdir(conn: SandboxConnection, path: string): Promise<void> {
		const params = new URLSearchParams({ path });
		await this.requestJson(conn, `/v1/files/mkdir?${params.toString()}`, { method: 'POST' });
	}
}

// ---------------------------------------------------------------------------
// Shared tool base
// ---------------------------------------------------------------------------

abstract class SandboxToolBase {
	protected readonly jobsClient: SandboxJobsClient;
	protected readonly rpcClient: SandboxRpcClient;
	protected readonly hfToken?: string;
	protected readonly isAuthenticated: boolean;
	protected readonly defaultNamespace?: string;

	constructor(
		hfToken?: string,
		isAuthenticated?: boolean,
		namespace?: string,
		jobsClient?: SandboxJobsClient,
		rpcClient?: SandboxRpcClient
	) {
		this.hfToken = hfToken;
		this.isAuthenticated = isAuthenticated ?? !!hfToken;
		this.defaultNamespace = namespace;
		this.jobsClient = jobsClient ?? new JobsApiClient(hfToken, namespace);
		this.rpcClient = rpcClient ?? new HttpSandboxRpcClient();
	}

	protected requireToken(): string {
		if (!this.isAuthenticated || !this.hfToken) {
			throw new Error(AUTH_REQUIRED_MESSAGE);
		}
		return this.hfToken;
	}

	protected parseHandle(handle: string): SandboxHandle {
		return parseSandboxHandle(handle, this.defaultNamespace);
	}

	protected connectionFromJob(handle: SandboxHandle, job: JobInfo): SandboxConnection {
		const nonce = job.labels?.[NONCE_LABEL];
		if (!nonce) {
			throw new Error(`Job ${handle.jobId} is not a current sandbox (missing '${NONCE_LABEL}' label).`);
		}
		const hfToken = this.requireToken();
		const url = getExposeUrl(job, handle.jobId, SANDBOX_PORT);
		const sandboxToken = deriveSandboxToken(hfToken, nonce);
		cacheConnection(handle, nonce, url);
		return { url, hfToken, sandboxToken };
	}

	protected async connect(handle: SandboxHandle): Promise<SandboxConnection> {
		const hfToken = this.requireToken();
		const cached = handleCache.get(cacheKey(handle));
		if (cached) {
			return { url: cached.url, hfToken, sandboxToken: deriveSandboxToken(hfToken, cached.nonce) };
		}
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		return this.connectionFromJob(handle, job);
	}
}

export interface SandboxJobsClient {
	getNamespace(namespace?: string): Promise<string>;
	runJob(jobSpec: JobSpec, namespace?: string): Promise<JobInfo>;
	getJob(jobId: string, namespace?: string): Promise<JobInfo>;
	cancelJob(jobId: string, namespace?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// hf_sandbox: create / status / terminate / ps / kill
// ---------------------------------------------------------------------------

const SANDBOX_OPERATIONS = ['create', 'status', 'terminate', 'ps', 'kill'] as const;
export type SandboxOperation = (typeof SANDBOX_OPERATIONS)[number];

const SANDBOX_CREATE_FLAGS: CommandOptionMap = {
	'--image': { key: 'image', kind: 'string' },
	'--flavor': { key: 'flavor', kind: 'string' },
	'--timeout': { key: 'timeout', kind: 'string' },
	'--name': { key: 'name', kind: 'string' },
	'--namespace': { key: 'namespace', kind: 'string' },
	'--forward-hf-token': { key: 'forward_hf_token', kind: 'boolean' },
	'--volume': { key: 'volumes', kind: 'string', repeatable: true },
	'--bucket': { key: 'bucket', kind: 'string' },
	'--bucket-mode': { key: 'bucket_mode', kind: 'string' },
	'--bucket-mount-path': { key: 'bucket_mount_path', kind: 'string' },
};

const SANDBOX_FLAGS: Readonly<Record<SandboxOperation, CommandOptionMap>> = {
	create: SANDBOX_CREATE_FLAGS,
	status: {},
	terminate: {},
	ps: {},
	kill: {},
};

const SANDBOX_DESCRIPTION = `Create and manage Hugging Face Sandboxes.

Grammar; each token below is one args array element:
  create [--name NAME] [--image IMAGE] [--flavor FLAVOR] [--timeout DURATION]
         [--namespace NAMESPACE] [--forward-hf-token] [--volume SPEC]...
         [--bucket OWNER/NAME] [--bucket-mode ro|rw] [--bucket-mount-path PATH]
  status HANDLE
  terminate HANDLE
  ps HANDLE
  kill HANDLE PROCESS_ID

HANDLE is returned by create. Volume SPEC is ${VOLUME_FORMAT}.
No pipes, redirects, shell expansion, or multiple commands.`;

function createSandboxSchema(username?: string) {
	return z.strictObject({
		cmd: z.enum(SANDBOX_OPERATIONS).describe('Command to execute.'),
		args: z
			.array(z.string())
			.describe(`Command arguments; each array item is one grammar token. ${handleDescription(username)}`),
	});
}

function createSandboxOutputSchema() {
	return z.object({
		op: z.enum(SANDBOX_OPERATIONS),
		handle: z.string().optional(),
		name: z.string().optional(),
		namespace: z.string().optional(),
		job_id: z.string().optional(),
		url: z.string().optional(),
		job_url: z.string().optional(),
		volumes: z.array(z.record(z.string(), z.unknown())).optional(),
		message: z.string().optional(),
		status: z.record(z.string(), z.unknown()).optional(),
		health: z.record(z.string(), z.unknown()).optional(),
		terminated: z.boolean().optional(),
		processes: z.array(z.record(z.string(), z.unknown())).optional(),
		process_id: z.string().optional(),
		killed: z.boolean().optional(),
	});
}

export const HF_SANDBOX_TOOL_CONFIG = {
	name: 'hf_sandbox',
	title: 'Hugging Face Sandbox',
	description: SANDBOX_DESCRIPTION,
	schema: createSandboxSchema(),
	outputSchema: createSandboxOutputSchema(),
	annotations: {
		title: 'Hugging Face Sandbox',
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

type SandboxToolConfig = Omit<typeof HF_SANDBOX_TOOL_CONFIG, 'schema'> & {
	schema: ReturnType<typeof createSandboxSchema>;
};

export type HfSandboxParams = z.input<ReturnType<typeof createSandboxSchema>>;

interface SandboxParams {
	op: SandboxOperation;
	handle?: string;
	image?: string;
	flavor?: string;
	timeout?: string;
	name?: string;
	namespace?: string;
	forward_hf_token?: boolean;
	volumes?: string[];
	bucket?: string;
	bucket_mode?: 'ro' | 'rw';
	bucket_mount_path?: string;
	process_id?: string;
}

function parseSandboxRequest(request: HfSandboxParams): SandboxParams {
	const { positionals, options } = parseCommandArgs(request, SANDBOX_FLAGS[request.cmd]);
	const expected = request.cmd === 'create' ? 0 : request.cmd === 'kill' ? 2 : 1;
	if (positionals.length < expected) {
		const required = request.cmd === 'kill' && positionals.length === 1 ? 'PROCESS_ID' : 'HANDLE';
		throw new Error(`EINVAL: ${request.cmd} requires ${required}`);
	}
	if (positionals.length > expected) {
		throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${positionals[expected] ?? ''}`);
	}
	const bucketMode = options.bucket_mode as string | undefined;
	if (bucketMode !== undefined && bucketMode !== 'ro' && bucketMode !== 'rw') {
		throw new Error('EINVAL: --bucket-mode must be ro or rw');
	}
	return {
		op: request.cmd,
		...(positionals[0] !== undefined ? { handle: positionals[0] } : {}),
		...(positionals[1] !== undefined ? { process_id: positionals[1] } : {}),
		...(typeof options.image === 'string' ? { image: options.image } : {}),
		...(typeof options.flavor === 'string' ? { flavor: options.flavor } : {}),
		...(typeof options.timeout === 'string' ? { timeout: options.timeout } : {}),
		...(typeof options.name === 'string' ? { name: options.name } : {}),
		...(typeof options.namespace === 'string' ? { namespace: options.namespace } : {}),
		...(options.forward_hf_token === true ? { forward_hf_token: true } : {}),
		...(Array.isArray(options.volumes) ? { volumes: options.volumes } : {}),
		...(typeof options.bucket === 'string' ? { bucket: options.bucket } : {}),
		...(bucketMode !== undefined ? { bucket_mode: bucketMode } : {}),
		...(typeof options.bucket_mount_path === 'string' ? { bucket_mount_path: options.bucket_mount_path } : {}),
	};
}

export interface SandboxCreateResult {
	op: 'create';
	handle: string;
	name: string;
	namespace: string;
	job_id: string;
	url: string;
	job_url: string;
	volumes: JobVolume[];
	message?: string;
}

export interface SandboxStatusResult {
	op: 'status';
	handle: string;
	namespace: string;
	job_id: string;
	url: string;
	job_url: string;
	status: JobStatus;
	health: Record<string, unknown> & { ok: boolean };
	volumes: JobVolume[];
}

export interface SandboxTerminateResult {
	op: 'terminate';
	handle: string;
	job_url: string;
	terminated: true;
}

export interface SandboxPsResult {
	op: 'ps';
	handle: string;
	processes: SandboxProcess[];
}

export interface SandboxKillResult {
	op: 'kill';
	handle: string;
	process_id: string;
	killed: true;
}

export type SandboxResult =
	SandboxCreateResult | SandboxStatusResult | SandboxTerminateResult | SandboxPsResult | SandboxKillResult;

function generateName(): string {
	const adjectives = ['calm', 'bright', 'clear', 'quick', 'steady', 'fresh', 'kind', 'prime'];
	const nouns = ['harbor', 'summit', 'orbit', 'signal', 'meadow', 'bridge', 'canvas', 'spark'];
	const adjective = adjectives[(randomBytes(1)[0] ?? 0) % adjectives.length] ?? adjectives[0];
	const noun = nouns[(randomBytes(1)[0] ?? 0) % nouns.length] ?? nouns[0];
	return `${adjective}-${noun}`;
}

function normalizeSandboxVolumes(params: SandboxParams): JobVolume[] | undefined {
	const volumeSpecs = [...(params.volumes ?? [])];
	if (params.bucket) {
		volumeSpecs.push(
			`hf://buckets/${params.bucket}:${params.bucket_mount_path ?? DEFAULT_BUCKET_MOUNT_PATH}:${params.bucket_mode ?? 'rw'}`
		);
	}
	return parseVolumes(volumeSpecs);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStoredSandboxVolumes(job: JobInfo): JobVolume[] {
	const storedVolumes = job.environment?.MCP_SANDBOX_VOLUMES;
	if (!storedVolumes) {
		return [];
	}
	try {
		const parsed = JSON.parse(storedVolumes) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((volume): volume is JobVolume => {
			if (!volume || typeof volume !== 'object') {
				return false;
			}
			const candidate = volume as Partial<JobVolume>;
			return (
				typeof candidate.type === 'string' &&
				typeof candidate.source === 'string' &&
				typeof candidate.mountPath === 'string'
			);
		});
	} catch {
		return [];
	}
}

export class HfSandboxTool extends SandboxToolBase {
	static createToolConfig(username?: string): SandboxToolConfig {
		return { ...HF_SANDBOX_TOOL_CONFIG, schema: createSandboxSchema(username) };
	}

	async run(params: HfSandboxParams, options?: SandboxOptions): Promise<SandboxResult> {
		this.requireToken();
		const parsed = parseSandboxRequest(createSandboxSchema(this.defaultNamespace).parse(params));
		switch (parsed.op) {
			case 'create':
				return this.create(parsed, options);
			case 'status':
				return this.status(this.requireHandle(parsed));
			case 'terminate':
				return this.terminate(this.requireHandle(parsed));
			case 'ps':
				return this.ps(this.requireHandle(parsed));
			case 'kill':
				return this.kill(this.requireHandle(parsed), parsed);
		}
	}

	private requireHandle(params: SandboxParams): SandboxHandle {
		if (!params.handle) {
			throw new Error(`handle is required for op=${params.op}.`);
		}
		return this.parseHandle(params.handle);
	}

	private async create(params: SandboxParams, options?: SandboxOptions): Promise<SandboxCreateResult> {
		const name = params.name ?? generateName();
		validateName(name);
		await notifySandboxProgress(options, {
			event: 'create',
			message: `Creating sandbox ${name}: resolving namespace.`,
		});
		const namespace = await this.jobsClient.getNamespace(params.namespace);
		validateNamespace(namespace);
		const nonce = createNonce();
		const hfToken = this.requireToken();
		const sandboxToken = deriveSandboxToken(hfToken, nonce);
		await notifySandboxProgress(options, {
			event: 'create',
			message: `Creating sandbox ${name}: preparing job specification.`,
		});

		const secrets: Record<string, string> = {
			SBX_TOKEN: sandboxToken,
			SBX_DL_TOKEN: hfToken,
		};
		if (params.forward_hf_token) {
			secrets.HF_TOKEN = hfToken;
		}
		const userVolumes = normalizeSandboxVolumes(params);
		const volumes: JobVolume[] = [
			...(userVolumes ?? []),
			{
				type: 'bucket',
				source: SANDBOX_SERVER_BUCKET,
				mountPath: SANDBOX_SERVER_MOUNT_PATH,
				readOnly: true,
			},
		];

		const jobSpec: JobSpec = {
			dockerImage: params.image ?? DEFAULT_IMAGE,
			command: ['/bin/sh', '-c', BOOTSTRAP_DOWNLOAD],
			flavor: params.flavor ?? DEFAULT_FLAVOR,
			timeoutSeconds: parseTimeout(SANDBOX_MAX_LIFETIME),
			environment: {
				SBX_PORT: String(SANDBOX_PORT),
				SBX_IDLE_TIMEOUT: String(parseTimeout(params.timeout ?? DEFAULT_TIMEOUT)),
				SBX_SERVER_URL: `https://huggingface.co/buckets/${SANDBOX_SERVER_BUCKET}/resolve/sbx-server`,
				SBX_SERVER_MOUNT: SANDBOX_SERVER_MOUNT_PATH,
				...(userVolumes ? { MCP_SANDBOX_VOLUMES: JSON.stringify(userVolumes) } : {}),
			},
			secrets,
			labels: {
				[SANDBOX_LABEL]: '1',
				[MODE_LABEL]: MODE_DEDICATED,
				[NONCE_LABEL]: nonce,
				pet: name,
			},
			expose: { ports: [SANDBOX_PORT] },
			volumes,
		};

		await notifySandboxProgress(options, {
			event: 'create',
			message: `Creating sandbox ${name}: submitting Hugging Face Job.`,
		});
		const job = await this.jobsClient.runJob(jobSpec, namespace);
		const handle: SandboxHandle = { namespace, jobId: job.id };
		const url = getExposeUrl(job, job.id, SANDBOX_PORT);
		cacheConnection(handle, nonce, url);
		await notifySandboxProgress(options, {
			event: 'create',
			message: `Creating sandbox ${name}: job ${job.id} is starting.`,
		});
		const ready = await this.waitForCreateHealth({ url, hfToken, sandboxToken }, name, options);

		return {
			op: 'create',
			handle: formatSandboxHandle(handle),
			name,
			namespace,
			job_id: job.id,
			url,
			job_url: getJobUrl(namespace, job.id),
			volumes: userVolumes ?? [],
			...(ready
				? {}
				: {
						message:
							'Sandbox was created, but health did not become ready within 10 seconds; it may still be starting.',
					}),
		};
	}

	private async waitForCreateHealth(conn: SandboxConnection, name: string, options?: SandboxOptions): Promise<boolean> {
		const deadline = Date.now() + CREATE_HEALTH_TIMEOUT_MS;
		let attempt = 0;
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				await notifySandboxProgress(options, {
					event: 'create',
					message: `Creating sandbox ${name}: startup health check timed out; sandbox may still be starting.`,
				});
				return false;
			}
			attempt += 1;
			await notifySandboxProgress(options, {
				event: 'create',
				message: `Creating sandbox ${name}: (step ${String(attempt)}).`,
			});
			try {
				const health = normalizeSandboxHealth(
					await this.rpcClient.health(conn, { timeoutSeconds: Math.max(0.1, remaining / 1000) })
				);
				if (health.ok) {
					await notifySandboxProgress(options, {
						event: 'create',
						message: `Creating sandbox ${name}: server is ready.`,
					});
					return true;
				}
			} catch {
				// The Jobs proxy can return 503 while the container/server is still starting.
			}
			await sleep(Math.min(CREATE_HEALTH_POLL_MS, Math.max(0, deadline - Date.now())));
		}
	}

	private async status(handle: SandboxHandle): Promise<SandboxStatusResult> {
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		let health: Record<string, unknown> & { ok: boolean };
		try {
			const conn = this.connectionFromJob(handle, job);
			health = normalizeSandboxHealth(await this.rpcClient.health(conn));
		} catch (error) {
			health = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		return {
			op: 'status',
			handle: formatSandboxHandle(handle),
			namespace: handle.namespace,
			job_id: handle.jobId,
			url: getExposeUrl(job, handle.jobId, SANDBOX_PORT),
			job_url: getJobUrl(handle.namespace, handle.jobId),
			status: job.status,
			health,
			volumes: parseStoredSandboxVolumes(job),
		};
	}

	private async terminate(handle: SandboxHandle): Promise<SandboxTerminateResult> {
		await this.jobsClient.cancelJob(handle.jobId, handle.namespace);
		handleCache.delete(cacheKey(handle));
		return {
			op: 'terminate',
			handle: formatSandboxHandle(handle),
			job_url: getJobUrl(handle.namespace, handle.jobId),
			terminated: true,
		};
	}

	private async ps(handle: SandboxHandle): Promise<SandboxPsResult> {
		const conn = await this.connect(handle);
		return {
			op: 'ps',
			handle: formatSandboxHandle(handle),
			processes: await this.rpcClient.listProcesses(conn),
		};
	}

	private async kill(handle: SandboxHandle, params: SandboxParams): Promise<SandboxKillResult> {
		if (!params.process_id) {
			throw new Error('process_id is required for op=kill.');
		}
		const conn = await this.connect(handle);
		await this.rpcClient.killProcess(conn, params.process_id);
		return {
			op: 'kill',
			handle: formatSandboxHandle(handle),
			process_id: params.process_id,
			killed: true,
		};
	}
}

// ---------------------------------------------------------------------------
// hf_sandbox_exec: run a shell command, foreground or detached
// ---------------------------------------------------------------------------

const SANDBOX_EXEC_OPERATIONS = ['exec'] as const;

const SANDBOX_EXEC_FLAGS: CommandOptionMap = {
	'--workdir': { key: 'workdir', kind: 'string' },
	'--stdin': { key: 'stdin', kind: 'string' },
	'--timeout': { key: 'timeout', kind: 'integer' },
	'--env': { key: 'env', kind: 'string', repeatable: true },
	'--detach': { key: 'detach', kind: 'boolean' },
	'--tag': { key: 'tag', kind: 'string' },
};

const SANDBOX_EXEC_DESCRIPTION = `Run a shell command inside a Hugging Face Sandbox.

Grammar; each token below is one args array element:
  exec HANDLE SHELL_COMMAND [--workdir PATH] [--stdin TEXT] [--timeout SECONDS]
       [--env NAME=VALUE]... [--detach] [--tag TAG]

SHELL_COMMAND is one string token and runs via /bin/sh -lc.
Foreground timeout defaults to ${String(DEFAULT_EXEC_TIMEOUT)} seconds and may not exceed ${String(MAX_FOREGROUND_EXEC_TIMEOUT)}.
Detached commands have no timeout unless set. Redirect detached output to a file.`;

function createSandboxExecSchema(username?: string) {
	return z.strictObject({
		cmd: z.enum(SANDBOX_EXEC_OPERATIONS).describe('Command to execute.'),
		args: z
			.array(z.string())
			.describe(`Command arguments; each array item is one grammar token. ${handleDescription(username)}`),
	});
}

function createSandboxExecOutputSchema() {
	return z.object({
		returncode: z.number().nullable().optional(),
		stdout: z.string().optional(),
		stderr: z.string().optional(),
		signal: z.union([z.number(), z.string()]).nullable().optional(),
		timed_out: z.boolean().optional(),
		duration_ms: z.number().optional(),
		detached: z.boolean().optional(),
		process_id: z.string().optional(),
		pid: z.number().optional(),
		tag: z.string().optional(),
	});
}

export const HF_SANDBOX_EXEC_TOOL_CONFIG = {
	name: 'hf_sandbox_exec',
	title: 'Hugging Face Sandbox Exec',
	description: SANDBOX_EXEC_DESCRIPTION,
	schema: createSandboxExecSchema(),
	outputSchema: createSandboxExecOutputSchema(),
	annotations: {
		title: 'Hugging Face Sandbox Exec',
		readOnlyHint: false,
		openWorldHint: true,
		destructiveHint: true,
	},
} as const;

type SandboxExecToolConfig = Omit<typeof HF_SANDBOX_EXEC_TOOL_CONFIG, 'schema'> & {
	schema: ReturnType<typeof createSandboxExecSchema>;
};

export type HfSandboxExecParams = z.input<ReturnType<typeof createSandboxExecSchema>>;

interface SandboxExecParams {
	handle: string;
	command: string;
	workdir?: string;
	stdin?: string;
	timeout?: number;
	env?: Record<string, string>;
	detach?: boolean;
	tag?: string;
}

function parseSandboxExecRequest(request: HfSandboxExecParams): SandboxExecParams {
	const { positionals, options } = parseCommandArgs(request, SANDBOX_EXEC_FLAGS);
	if (positionals.length < 2) {
		throw new Error(`EINVAL: exec requires ${positionals.length === 0 ? 'HANDLE' : 'SHELL_COMMAND'}`);
	}
	if (positionals.length > 2) {
		throw new Error(`EINVAL: unexpected argument for exec: ${positionals[2] ?? ''}`);
	}
	const timeout = options.timeout as number | undefined;
	if (timeout !== undefined && timeout <= 0) {
		throw new Error('EINVAL: --timeout must be a positive integer');
	}
	const env = Array.isArray(options.env) ? parseSandboxEnv(options.env) : undefined;
	return {
		handle: positionals[0] ?? '',
		command: positionals[1] ?? '',
		...(typeof options.workdir === 'string' ? { workdir: options.workdir } : {}),
		...(typeof options.stdin === 'string' ? { stdin: options.stdin } : {}),
		...(timeout !== undefined ? { timeout } : {}),
		...(env !== undefined ? { env } : {}),
		...(options.detach === true ? { detach: true } : {}),
		...(typeof options.tag === 'string' ? { tag: options.tag } : {}),
	};
}

function parseSandboxEnv(values: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const value of values) {
		const separator = value.indexOf('=');
		if (separator <= 0) {
			throw new Error('EINVAL: --env requires NAME=VALUE');
		}
		const name = value.slice(0, separator);
		if (env[name] !== undefined) {
			throw new Error(`EINVAL: duplicate environment variable: ${name}`);
		}
		env[name] = value.slice(separator + 1);
	}
	return env;
}

export interface SandboxDetachResult {
	detached: true;
	process_id: string;
	pid: number;
	tag?: string;
}

export type HfSandboxExecResult = SandboxExecResult | SandboxDetachResult;

export class HfSandboxExecTool extends SandboxToolBase {
	static createToolConfig(username?: string): SandboxExecToolConfig {
		return { ...HF_SANDBOX_EXEC_TOOL_CONFIG, schema: createSandboxExecSchema(username) };
	}

	async run(params: HfSandboxExecParams, options?: SandboxExecOptions): Promise<HfSandboxExecResult> {
		this.requireToken();
		const parsed = parseSandboxExecRequest(createSandboxExecSchema(this.defaultNamespace).parse(params));
		const handle = this.parseHandle(parsed.handle);
		const conn = await this.connect(handle);
		const request: SandboxExecRequest = {
			command: ['/bin/sh', '-lc', parsed.command],
			workdir: parsed.workdir,
			stdin: parsed.stdin,
			env: parsed.env,
			...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
		};

		if (parsed.detach) {
			const proc = await this.rpcClient.execDetached(conn, { ...request, tag: parsed.tag });
			return {
				detached: true,
				process_id: proc.id,
				pid: proc.pid,
				...(proc.tag ? { tag: proc.tag } : {}),
			};
		}

		const timeout = parsed.timeout ?? DEFAULT_EXEC_TIMEOUT;
		if (timeout > MAX_FOREGROUND_EXEC_TIMEOUT) {
			throw new Error(`foreground exec timeout must be <= ${String(MAX_FOREGROUND_EXEC_TIMEOUT)} seconds.`);
		}

		const execRequest = { ...request, timeout };
		return options ? this.rpcClient.exec(conn, execRequest, options) : this.rpcClient.exec(conn, execRequest);
	}
}

// ---------------------------------------------------------------------------
// hf_sandbox_fs: files inside the sandbox
// ---------------------------------------------------------------------------

const SANDBOX_FS_OPERATIONS = ['ls', 'cat', 'stat', 'write', 'rm', 'mkdir'] as const;
export type SandboxFsOperation = (typeof SANDBOX_FS_OPERATIONS)[number];

const SANDBOX_FS_FLAGS: Readonly<Record<SandboxFsOperation, CommandOptionMap>> = {
	ls: {},
	cat: {
		'--offset': { key: 'offset', kind: 'integer' },
		'--max-bytes': { key: 'max_bytes', kind: 'integer' },
	},
	stat: {},
	write: {
		'--text': { key: 'text', kind: 'string' },
		'--base64': { key: 'base64', kind: 'string' },
	},
	rm: {
		'-r': { key: 'recursive', kind: 'boolean' },
		'-R': { key: 'recursive', kind: 'boolean' },
		'--recursive': { key: 'recursive', kind: 'boolean' },
	},
	mkdir: {},
};

const SANDBOX_FS_DESCRIPTION = `Read, write and manage files inside a Hugging Face Sandbox.

Grammar; each token below is one args array element:
  ls HANDLE PATH
  cat HANDLE PATH [--offset N] [--max-bytes N]
  stat HANDLE PATH
  write HANDLE PATH (--text TEXT|--base64 BASE64)
  rm HANDLE PATH [(-r|-R|--recursive)]
  mkdir HANDLE PATH

PATH is an absolute path inside the sandbox. cat defaults to ${String(DEFAULT_CAT_MAX_BYTES)} bytes and allows at most ${String(MAX_CAT_BYTES)}.`;

function createSandboxFsSchema(username?: string) {
	return z.strictObject({
		cmd: z.enum(SANDBOX_FS_OPERATIONS).describe('Command to execute.'),
		args: z
			.array(z.string())
			.describe(`Command arguments; each array item is one grammar token. ${handleDescription(username)}`),
	});
}

function createSandboxFsOutputSchema() {
	return z.object({
		op: z.enum(SANDBOX_FS_OPERATIONS),
		path: z.string(),
		entries: z.array(z.record(z.string(), z.unknown())).optional(),
		content: z.string().optional(),
		bytes: z.number().optional(),
		size: z.number().optional(),
		truncated: z.boolean().optional(),
		next_offset: z.number().optional(),
		exists: z.boolean().optional(),
		type: z.enum(['file', 'dir', 'symlink']).optional(),
		mtime_ms: z.number().nullable().optional(),
		mode: z.string().optional(),
		deleted: z.boolean().optional(),
		created: z.boolean().optional(),
	});
}

export const HF_SANDBOX_FS_TOOL_CONFIG = {
	name: 'hf_sandbox_fs',
	title: 'Hugging Face Sandbox Files',
	description: SANDBOX_FS_DESCRIPTION,
	schema: createSandboxFsSchema(),
	outputSchema: createSandboxFsOutputSchema(),
	annotations: {
		title: 'Hugging Face Sandbox Files',
		destructiveHint: true,
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

type SandboxFsToolConfig = Omit<typeof HF_SANDBOX_FS_TOOL_CONFIG, 'schema'> & {
	schema: ReturnType<typeof createSandboxFsSchema>;
};

export type HfSandboxFsParams = z.input<ReturnType<typeof createSandboxFsSchema>>;

interface SandboxFsParams {
	op: SandboxFsOperation;
	handle: string;
	path: string;
	text?: string;
	base64?: string;
	offset?: number;
	max_bytes?: number;
	recursive?: boolean;
}

function parseSandboxFsRequest(request: HfSandboxFsParams): SandboxFsParams {
	const { positionals, options } = parseCommandArgs(request, SANDBOX_FS_FLAGS[request.cmd]);
	if (positionals.length < 2) {
		throw new Error(`EINVAL: ${request.cmd} requires ${positionals.length === 0 ? 'HANDLE' : 'PATH'}`);
	}
	if (positionals.length > 2) {
		throw new Error(`EINVAL: unexpected argument for ${request.cmd}: ${positionals[2] ?? ''}`);
	}
	const path = positionals[1] ?? '';
	if (!path.startsWith('/')) {
		throw new Error('EINVAL: PATH must be absolute');
	}
	const offset = options.offset as number | undefined;
	if (offset !== undefined && offset < 0) {
		throw new Error('EINVAL: --offset must be non-negative');
	}
	const maxBytes = options.max_bytes as number | undefined;
	if (maxBytes !== undefined && (maxBytes <= 0 || maxBytes > MAX_CAT_BYTES)) {
		throw new Error(`EINVAL: --max-bytes must be between 1 and ${String(MAX_CAT_BYTES)}`);
	}
	return {
		op: request.cmd,
		handle: positionals[0] ?? '',
		path,
		...(typeof options.text === 'string' ? { text: options.text } : {}),
		...(typeof options.base64 === 'string' ? { base64: options.base64 } : {}),
		...(offset !== undefined ? { offset } : {}),
		...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}),
		...(options.recursive === true ? { recursive: true } : {}),
	};
}

export type SandboxFsResult =
	| { op: 'ls'; path: string; entries: SandboxFsEntry[] }
	| { op: 'cat'; path: string; content: string; bytes: number; size: number; truncated: boolean; next_offset?: number }
	| ({ op: 'stat'; path: string; exists: boolean } & Partial<Omit<SandboxFsEntry, 'name' | 'path'>>)
	| { op: 'write'; path: string; bytes: number }
	| { op: 'rm'; path: string; deleted: true }
	| { op: 'mkdir'; path: string; created: true };

export class HfSandboxFsTool extends SandboxToolBase {
	static createToolConfig(username?: string): SandboxFsToolConfig {
		return { ...HF_SANDBOX_FS_TOOL_CONFIG, schema: createSandboxFsSchema(username) };
	}

	async run(params: HfSandboxFsParams): Promise<SandboxFsResult> {
		this.requireToken();
		const parsed = parseSandboxFsRequest(createSandboxFsSchema(this.defaultNamespace).parse(params));
		const conn = await this.connect(this.parseHandle(parsed.handle));

		switch (parsed.op) {
			case 'ls':
				return { op: 'ls', path: parsed.path, entries: await this.rpcClient.listDir(conn, parsed.path) };
			case 'cat':
				return this.cat(conn, parsed);
			case 'stat': {
				const entry = await this.rpcClient.statPath(conn, parsed.path);
				if (!entry) {
					return { op: 'stat', path: parsed.path, exists: false };
				}
				const { name: _name, path: _path, ...details } = entry;
				return { op: 'stat', path: parsed.path, exists: true, ...details };
			}
			case 'write':
				return this.write(conn, parsed);
			case 'rm':
				await this.rpcClient.deletePath(conn, { path: parsed.path, recursive: parsed.recursive ?? false });
				return { op: 'rm', path: parsed.path, deleted: true };
			case 'mkdir':
				await this.rpcClient.mkdir(conn, parsed.path);
				return { op: 'mkdir', path: parsed.path, created: true };
		}
	}

	private async cat(conn: SandboxConnection, params: SandboxFsParams): Promise<SandboxFsResult> {
		const stat = await this.rpcClient.statPath(conn, params.path);
		if (!stat) {
			throw new Error(`no such file: ${params.path}`);
		}
		if (stat.type === 'dir') {
			throw new Error(`is a directory: ${params.path}`);
		}
		const offset = params.offset ?? 0;
		const length = params.max_bytes ?? DEFAULT_CAT_MAX_BYTES;
		const data = await this.rpcClient.readFile(conn, { path: params.path, offset, length });
		const end = offset + data.length;
		const truncated = end < stat.size;
		return {
			op: 'cat',
			path: params.path,
			content: data.toString('utf-8'),
			bytes: data.length,
			size: stat.size,
			truncated,
			...(truncated ? { next_offset: end } : {}),
		};
	}

	private async write(conn: SandboxConnection, params: SandboxFsParams): Promise<SandboxFsResult> {
		const hasText = params.text !== undefined;
		const hasBase64 = params.base64 !== undefined;
		if (hasText === hasBase64) {
			throw new Error('write requires exactly one of text or base64.');
		}
		const data = hasText ? Buffer.from(params.text ?? '', 'utf-8') : Buffer.from(params.base64 ?? '', 'base64');
		await this.rpcClient.writeFile(conn, { path: params.path, data });
		return { op: 'write', path: params.path, bytes: data.length };
	}
}

// ---------------------------------------------------------------------------
// Markdown rendering for tool text content
// ---------------------------------------------------------------------------

function fence(content: string, label = ''): string {
	const ticks = content.includes('```') ? '````' : '```';
	return `${ticks}${label}\n${content.replace(/\n$/, '')}\n${ticks}`;
}

function inlineCode(value: string | number | boolean | null | undefined): string {
	return `\`${String(value ?? '').replace(/`/g, "'")}\``;
}

function markdownLink(label: string, url: string): string {
	return `[${escapeMarkdown(label)}](${url.replace(/\)/g, '%29')})`;
}

function volumeSummary(volumes: JobVolume[]): string {
	if (volumes.length === 0) {
		return 'none';
	}
	return volumes
		.map((volume) => `${volume.readOnly === true ? 'ro' : 'rw'} ${volume.type}:${volume.source} -> ${volume.mountPath}`)
		.join(', ');
}

function formatStatusMessage(status: JobStatus): string {
	return status.message ? `${status.stage}: ${status.message}` : status.stage;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled sandbox result: ${JSON.stringify(value)}`);
}

export function formatSandboxMarkdown(result: SandboxResult): string {
	switch (result.op) {
		case 'create':
			return [
				`Created sandbox ${inlineCode(result.name)}.`,
				`Handle: ${inlineCode(result.handle)}`,
				`Job: ${markdownLink(result.job_id, result.job_url)}`,
				`URL: ${result.url}`,
				`Volumes: ${escapeMarkdown(volumeSummary(result.volumes))}`,
				...(result.message ? [`Note: ${escapeMarkdown(result.message)}`] : []),
			].join('\n');
		case 'status':
			return [
				`Sandbox ${inlineCode(result.handle)}`,
				`Status: ${inlineCode(formatStatusMessage(result.status))}`,
				`Health: ${result.health.ok ? 'ok' : `not ready${typeof result.health.error === 'string' ? ` (${escapeMarkdown(result.health.error)})` : ''}`}`,
				`Job: ${markdownLink(result.job_id, result.job_url)}`,
				`URL: ${result.url}`,
				`Volumes: ${escapeMarkdown(volumeSummary(result.volumes))}`,
			].join('\n');
		case 'terminate':
			return [`Terminated sandbox ${inlineCode(result.handle)}.`, `Job: ${result.job_url}`].join('\n');
		case 'ps': {
			if (result.processes.length === 0) {
				return 'No background processes.';
			}
			const lines = ['| Id | Pid | Running | Exit | Tag | Cmd |', '|---|---|---|---|---|---|'];
			for (const proc of result.processes) {
				lines.push(
					`| ${escapeMarkdown(proc.id)} | ${String(proc.pid)} | ${proc.running === false ? 'no' : 'yes'} | ${proc.exit_code ?? ''} | ${escapeMarkdown(proc.tag ?? '')} | ${escapeMarkdown(JSON.stringify(proc.cmd ?? ''))} |`
				);
			}
			return lines.join('\n');
		}
		case 'kill':
			return `Killed process ${inlineCode(result.process_id)} in sandbox ${inlineCode(result.handle)}.`;
	}
	return assertNever(result);
}

export function formatSandboxExecMarkdown(result: HfSandboxExecResult): string {
	if ('detached' in result) {
		return `Detached process \`${result.process_id}\` (pid ${String(result.pid)}${result.tag ? `, tag ${result.tag}` : ''}). Manage with hf_sandbox ps/kill.`;
	}
	const lines = [
		`exit ${result.returncode === null ? `signal ${String(result.signal)}` : String(result.returncode)} in ${String(result.duration_ms)}ms${result.timed_out ? ' (timed out)' : ''}`,
	];
	if (result.stdout) {
		lines.push('', 'stdout:', fence(result.stdout));
	}
	if (result.stderr) {
		lines.push('', 'stderr:', fence(result.stderr));
	}
	return lines.join('\n');
}

export function formatSandboxFsMarkdown(result: SandboxFsResult): string {
	switch (result.op) {
		case 'ls': {
			if (result.entries.length === 0) {
				return `\`${result.path}\` is empty.`;
			}
			const lines = ['| Name | Type | Size | Mode |', '|---|---|---:|---|'];
			for (const entry of result.entries) {
				lines.push(
					`| ${escapeMarkdown(entry.name)} | ${entry.type} | ${escapeMarkdown(formatBytes(entry.size))} | ${escapeMarkdown(entry.mode)} |`
				);
			}
			return lines.join('\n');
		}
		case 'cat': {
			const suffix = result.truncated
				? `\n\n_Read ${String(result.bytes)} of ${String(result.size)} bytes. Resume with offset ${String(result.next_offset ?? 0)}._`
				: '';
			return `${fence(result.content)}${suffix}`;
		}
		case 'stat':
			if (!result.exists) {
				return `${inlineCode(result.path)} does not exist.`;
			}
			return [
				`${inlineCode(result.path)}: ${result.type ?? 'unknown'}`,
				...(result.size !== undefined ? [`Size: ${escapeMarkdown(formatBytes(result.size))}`] : []),
				...(result.mode ? [`Mode: ${inlineCode(result.mode)}`] : []),
			].join('\n');
		case 'write':
			return `Wrote ${escapeMarkdown(formatBytes(result.bytes))} to ${inlineCode(result.path)}.`;
		case 'rm':
			return `Deleted ${inlineCode(result.path)}.`;
		case 'mkdir':
			return `Created directory ${inlineCode(result.path)}.`;
	}
	return assertNever(result);
}
