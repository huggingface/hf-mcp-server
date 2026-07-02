import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { JobsApiClient } from './jobs/api-client.js';
import type { JobInfo, JobSpec, JobVolume } from './jobs/types.js';
import { parseTimeout, parseVolumes } from './jobs/commands/utils.js';
import type { ToolResult } from './types/tool-result.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from './network/fetch-profile.js';

const SANDBOX_HANDLE_VERSION = 'hfsb2';
const SANDBOX_PORT = 49983;
const DEFAULT_BUCKET_MOUNT_PATH = '/data';
const DEFAULT_IMAGE = 'python:3.12';
const DEFAULT_FLAVOR = 'cpu-basic';
const DEFAULT_TIMEOUT = '1h';
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
const BOOTSTRAP_DOWNLOAD = `set -e
d=/tmp/.sbx-server
if command -v wget >/dev/null 2>&1; then wget -q --header "Authorization: Bearer $SBX_DL_TOKEN" -O "$d" "$SBX_SERVER_URL"
elif command -v curl >/dev/null 2>&1; then curl -fsSL -H "Authorization: Bearer $SBX_DL_TOKEN" -o "$d" "$SBX_SERVER_URL"
else cp "$SBX_SERVER_MOUNT/sbx-server" "$d"; fi
chmod +x "$d"
unset SBX_DL_TOKEN SBX_SERVER_URL SBX_SERVER_MOUNT
exec "$d"`;

const createArgsSchema = z
	.object({
		image: z.string().optional().default(DEFAULT_IMAGE),
		flavor: z.string().optional().default(DEFAULT_FLAVOR),
		timeout: z.string().optional().default(DEFAULT_TIMEOUT),
		namespace: z.string().optional(),
		name: z.string().optional(),
		forward_hf_token: z.boolean().optional().default(false),
		bucket: z
			.string()
			.optional()
			.describe(
				`Convenience bucket mount in OWNER/NAME format. Mounts at bucket_mount_path, default ${DEFAULT_BUCKET_MOUNT_PATH}.`
			),
		bucket_mode: z.enum(['ro', 'rw']).optional().default('rw').describe('Access mode for bucket convenience mount.'),
		bucket_mount_path: z
			.string()
			.optional()
			.default(DEFAULT_BUCKET_MOUNT_PATH)
			.describe('Absolute mount path for bucket convenience mount.'),
		volumes: z
			.array(z.string())
			.optional()
			.describe(`Volume mounts using hf:// URLs. Format: ${VOLUME_FORMAT}. Type prefixes are plural.`),
	})
	.strict();

const execArgsSchema = z
	.object({
		handle: z.string(),
		command: z.array(z.string()).min(1),
		workdir: z.string().optional(),
		stdin: z.string().optional(),
		timeout: z.number().int().positive().optional().default(600),
	})
	.strict();

const shellExecArgsSchema = z
	.object({
		handle: z.string().describe('Portable sandbox handle returned by hf_sandbox create.'),
		cmd: z.string().min(1).describe('Shell command to execute inside the sandbox. Runs via /bin/sh -lc.'),
		workdir: z.string().optional().describe('Working directory inside the sandbox.'),
		stdin: z.string().optional().describe('Optional stdin to pass to the command.'),
		timeout: z.number().int().positive().optional().default(600).describe('Command timeout in seconds.'),
	})
	.strict();

const fileEncodingSchema = z.enum(['utf-8', 'base64']).optional().default('utf-8');

const writeArgsSchema = z
	.object({
		handle: z.string(),
		path: z.string().min(1),
		content: z.string(),
		encoding: fileEncodingSchema,
	})
	.strict();

const readArgsSchema = z
	.object({
		handle: z.string(),
		path: z.string().min(1),
		encoding: fileEncodingSchema,
	})
	.strict();

const handleArgsSchema = z
	.object({
		handle: z.string(),
	})
	.strict();

const operations = ['create', 'write', 'read', 'status', 'terminate'] as const;
type SandboxOperation = (typeof operations)[number];

export interface SandboxHandle {
	namespace: string;
	jobId: string;
}

export interface SandboxRpcClient {
	health(handle: SandboxHandle, auth: SandboxAuth): Promise<unknown>;
	exec(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof execArgsSchema>): Promise<unknown>;
	write(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof writeArgsSchema>): Promise<unknown>;
	read(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof readArgsSchema>): Promise<unknown>;
}

export interface SandboxJobsClient {
	getNamespace(namespace?: string): Promise<string>;
	runJob(jobSpec: JobSpec, namespace?: string): Promise<JobInfo>;
	getJob(jobId: string, namespace?: string): Promise<JobInfo>;
	cancelJob(jobId: string, namespace?: string): Promise<void>;
}

export interface SandboxAuth {
	hfToken: string;
	sandboxToken: string;
}

export const HF_SANDBOX_TOOL_CONFIG = {
	name: 'hf_sandbox',
	description:
		'Create and manage interactive Hugging Face Jobs sandboxes. Supports create, read, write, status, and terminate with portable stateless handles. Use hf_sandbox_exec to run shell commands in a sandbox. ' +
		`Mount Hub repos with volumes using ${VOLUME_FORMAT}; type prefixes must be plural. Examples: ` +
		'["hf://buckets/user/bucket:/data:rw"], ["hf://datasets/org/dataset:/data:ro"], ["hf://models/org/model:/model"]. ' +
		'For buckets, create also accepts bucket, bucket_mode, and bucket_mount_path as a convenience. ' +
		'Mounted buckets use FUSE and are better for persisted artifacts than build-heavy work.',
	schema: z.object({
		operation: z
			.enum(operations)
			.optional()
			.describe(`Operation to execute: ${operations.join(', ')}`),
		args: z.record(z.any()).optional().describe('Operation-specific arguments as a JSON object'),
	}),
	annotations: {
		title: 'Hugging Face Sandbox',
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

export const HF_SANDBOX_EXEC_TOOL_CONFIG = {
	name: 'hf_sandbox_exec',
	description:
		'Execute shell commands inside a Hugging Face Jobs sandbox. Provide a portable sandbox handle and a shell command string; returns stdout, stderr, and returncode.',
	schema: shellExecArgsSchema,
	annotations: {
		title: 'Hugging Face Sandbox Exec',
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

function formatJson(value: unknown): string {
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function normalizeSandboxVolumes(args: z.infer<typeof createArgsSchema>): JobVolume[] | undefined {
	const volumeSpecs = [...(args.volumes ?? [])];
	if (args.bucket) {
		volumeSpecs.push(`hf://buckets/${args.bucket}:${args.bucket_mount_path}:${args.bucket_mode}`);
	}

	return parseVolumes(volumeSpecs);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSandboxHealth(payload: unknown): Record<string, unknown> & { ok: boolean } {
	if (!isRecord(payload)) {
		return { ok: false, value: payload };
	}

	const explicitOk = payload.ok;
	const ok = typeof explicitOk === 'boolean' ? explicitOk : payload.status === 'ok';
	return { ...payload, ok };
}

export interface SandboxExecResult {
	returncode: number | null;
	stdout: string;
	stderr: string;
	signal: number | string | null;
	timed_out: boolean;
	duration_ms: number;
}

export function parseSandboxExecEvents(text: string): SandboxExecResult {
	let stdout = '';
	let stderr = '';
	let returncode: number | null = null;
	let signal: number | string | null = null;
	let timedOut = false;
	let durationMs = 0;
	let sawExit = false;

	for (const line of text.split(/\r?\n/)) {
		if (!line) {
			continue;
		}
		const event = JSON.parse(line) as {
			event?: string;
			data?: string;
			exit_code?: number | null;
			signal?: number | string | null;
			timed_out?: boolean;
			duration_ms?: number;
		};
		if (event.event === 'stdout') {
			stdout += event.data ?? '';
		} else if (event.event === 'stderr') {
			stderr += event.data ?? '';
		} else if (event.event === 'exit') {
			sawExit = true;
			returncode = event.exit_code ?? null;
			signal = event.signal ?? null;
			timedOut = event.timed_out ?? false;
			durationMs = event.duration_ms ?? 0;
		}
	}

	if (!sawExit) {
		throw new Error('connection lost while running command');
	}
	return { returncode, stdout, stderr, signal, timed_out: timedOut, duration_ms: durationMs };
}

function generateName(): string {
	const adjectives = ['calm', 'bright', 'clear', 'quick', 'steady', 'fresh', 'kind', 'prime'];
	const nouns = ['harbor', 'summit', 'orbit', 'signal', 'meadow', 'bridge', 'canvas', 'spark'];
	const adjectiveIndex = (randomBytes(1)[0] ?? 0) % adjectives.length;
	const nounIndex = (randomBytes(1)[0] ?? 0) % nouns.length;
	const adjective = adjectives[adjectiveIndex] ?? adjectives[0];
	const noun = nouns[nounIndex] ?? nouns[0];
	return `${adjective}-${noun}`;
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

export function parseSandboxHandle(handle: string): SandboxHandle {
	const parts = handle.split(':');
	if (parts.length !== 3 || parts[0] !== SANDBOX_HANDLE_VERSION) {
		throw new Error(`Invalid sandbox handle. Expected ${SANDBOX_HANDLE_VERSION}:<namespace>:<job_id>.`);
	}

	const [, namespace, jobId] = parts;
	if (!namespace || !jobId) {
		throw new Error('Invalid sandbox handle. All handle fields are required.');
	}

	validateNamespace(namespace);
	validateJobId(jobId);

	return { namespace, jobId };
}

export function formatSandboxHandle(handle: SandboxHandle): string {
	validateNamespace(handle.namespace);
	validateJobId(handle.jobId);
	return `${SANDBOX_HANDLE_VERSION}:${handle.namespace}:${handle.jobId}`;
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

function getSandboxUrl(jobId: string): string {
	return `https://${jobId}--${String(SANDBOX_PORT)}.hf.jobs`;
}

function getJobUrl(namespace: string, jobId: string): string {
	return `https://huggingface.co/jobs/${namespace}/${jobId}`;
}

function getExposeUrl(job: JobInfo, jobId: string, port: number): string {
	const exposed = job.status.expose_urls?.find((url) => typeof url === 'string' && url.startsWith('https://'));
	return exposed ?? `https://${jobId}--${String(port)}.hf.jobs`;
}

class HttpSandboxRpcClient implements SandboxRpcClient {
	private async request(
		handle: SandboxHandle,
		auth: SandboxAuth,
		path: string,
		options: {
			method?: string;
			body?: BodyInit;
			headers?: Record<string, string>;
			timeoutSeconds?: number;
		} = {}
	): Promise<Response> {
		const requestInit: RequestInit = {
			method: options.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${auth.hfToken}`,
				'X-Sandbox-Token': auth.sandboxToken,
				...options.headers,
			},
			...(options.body ? { body: options.body } : {}),
		};
		const { response } = await fetchWithProfile(
			`${getSandboxUrl(handle.jobId)}${path}`,
			NETWORK_FETCH_PROFILES.externalHttps(),
			{
				timeoutMs: (options.timeoutSeconds ?? 30) * 1000,
				requestInit,
			}
		);

		if (!response.ok) {
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

	async health(handle: SandboxHandle, auth: SandboxAuth): Promise<unknown> {
		const response = await this.request(handle, auth, '/health', {
			headers: { Accept: 'application/json' },
		});
		const responseText = await response.text();
		return normalizeSandboxHealth(responseText ? (JSON.parse(responseText) as unknown) : {});
	}

	async exec(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof execArgsSchema>): Promise<unknown> {
		const response = await this.request(handle, auth, '/v1/exec', {
			method: 'POST',
			headers: {
				Accept: 'application/x-ndjson',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				cmd: args.command,
				shell: false,
				cwd: args.workdir,
				stdin: args.stdin,
				timeout: args.timeout,
			}),
			timeoutSeconds: args.timeout + 5,
		});
		const text = await response.text();
		return parseSandboxExecEvents(text);
	}

	async write(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof writeArgsSchema>): Promise<unknown> {
		const data = args.encoding === 'base64' ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf-8');
		const params = new URLSearchParams({ path: args.path });
		await this.request(handle, auth, `/v1/files/write?${params.toString()}`, {
			method: 'PUT',
			body: data,
			timeoutSeconds: 60,
		});
		return { path: args.path, bytes: data.length };
	}

	async read(handle: SandboxHandle, auth: SandboxAuth, args: z.infer<typeof readArgsSchema>): Promise<unknown> {
		const params = new URLSearchParams({ path: args.path });
		const response = await this.request(handle, auth, `/v1/files/read?${params.toString()}`, {
			timeoutSeconds: 60,
		});
		const data = Buffer.from(await response.arrayBuffer());
		return {
			path: args.path,
			content: args.encoding === 'base64' ? data.toString('base64') : data.toString('utf-8'),
			encoding: args.encoding,
			bytes: data.length,
		};
	}
}

function authRequiredResult(): ToolResult {
	return {
		formatted:
			'Hugging Face sandboxes require authentication because they create and control HF Jobs. Set HF_TOKEN or authenticate your MCP client, then retry with ?mix=sandbox or ?bouquet=sandbox.',
		totalResults: 0,
		resultsShared: 0,
		isError: true,
	};
}

function validationErrorResult(error: z.ZodError | Error, operation: string): ToolResult {
	const message =
		error instanceof z.ZodError
			? error.errors.map((entry) => `${entry.path.join('.') || 'args'}: ${entry.message}`).join('\n')
			: error.message;
	return {
		formatted: `Error: Invalid parameters for '${operation}'\n\n${message}`,
		totalResults: 0,
		resultsShared: 0,
		isError: true,
	};
}

function isOperation(value: string): value is SandboxOperation {
	return (operations as readonly string[]).includes(value);
}

export class HfSandboxTool {
	private jobsClient: SandboxJobsClient;
	private rpcClient: SandboxRpcClient;
	private hfToken?: string;
	private isAuthenticated: boolean;

	constructor(
		hfToken?: string,
		isAuthenticated?: boolean,
		namespace?: string,
		jobsClient?: SandboxJobsClient,
		rpcClient?: SandboxRpcClient
	) {
		this.hfToken = hfToken;
		this.isAuthenticated = isAuthenticated ?? !!hfToken;
		this.jobsClient = jobsClient ?? new JobsApiClient(hfToken, namespace);
		this.rpcClient = rpcClient ?? new HttpSandboxRpcClient();
	}

	async execute(params: { operation?: string; args?: Record<string, unknown> }): Promise<ToolResult> {
		if (!this.isAuthenticated || !this.hfToken) {
			return authRequiredResult();
		}

		if (!params.operation) {
			return {
				formatted:
					'# Hugging Face Sandbox\n\n' +
					'Available operations: create, write, read, status, terminate. Use hf_sandbox_exec for shell commands.\n\n' +
					'Sandboxes run the official Hugging Face sbx-server and are deleted with the backing Job. ' +
					'Use mounted Hub volumes for persisted inputs or outputs.\n\n' +
					`Mount Hub repos with create args volumes: ["${VOLUME_FORMAT}"]. Type prefixes are plural: models, datasets, spaces, buckets. ` +
					'Examples: ["hf://buckets/user/bucket:/data:rw"], ["hf://datasets/org/dataset:/data:ro"], ["hf://models/org/model:/model"]. ' +
					`For buckets only, you can use {"bucket": "user/bucket", "bucket_mode": "rw", "bucket_mount_path": "${DEFAULT_BUCKET_MOUNT_PATH}"}.\n\n` +
					'Handles are portable bearer capabilities. Do not share them in logs or URLs.',
				totalResults: 1,
				resultsShared: 1,
			};
		}

		const operation = params.operation.toLowerCase();
		if (!isOperation(operation)) {
			return {
				formatted: `Unknown sandbox operation: "${params.operation}". Available operations: ${operations.join(', ')}.`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		try {
			const result = await this.executeOperation(operation, params.args ?? {});
			return {
				formatted: formatJson(result),
				totalResults: 1,
				resultsShared: 1,
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				return validationErrorResult(error, operation);
			}
			if (error instanceof Error) {
				return {
					formatted: `Error executing sandbox ${operation}: ${error.message}`,
					totalResults: 0,
					resultsShared: 0,
					isError: true,
				};
			}
			return {
				formatted: `Error executing sandbox ${operation}: ${String(error)}`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}
	}

	private async executeOperation(operation: SandboxOperation, args: Record<string, unknown>): Promise<unknown> {
		switch (operation) {
			case 'create':
				return this.create(createArgsSchema.parse(args));
			case 'write': {
				const parsed = writeArgsSchema.parse(args);
				const handle = parseSandboxHandle(parsed.handle);
				return this.rpcClient.write(handle, await this.authForHandle(handle), parsed);
			}
			case 'read': {
				const parsed = readArgsSchema.parse(args);
				const handle = parseSandboxHandle(parsed.handle);
				return this.rpcClient.read(handle, await this.authForHandle(handle), parsed);
			}
			case 'status':
				return this.status(handleArgsSchema.parse(args));
			case 'terminate':
				return this.terminate(handleArgsSchema.parse(args));
		}
	}

	private requireToken(): string {
		if (!this.hfToken) {
			throw new Error('HF token is required.');
		}
		return this.hfToken;
	}

	private async authForHandle(handle: SandboxHandle): Promise<SandboxAuth> {
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		const nonce = job.labels?.[NONCE_LABEL];
		if (!nonce) {
			throw new Error(`Job ${handle.jobId} is not a current sandbox (missing '${NONCE_LABEL}' label).`);
		}
		const hfToken = this.requireToken();
		return { hfToken, sandboxToken: deriveSandboxToken(hfToken, nonce) };
	}

	private async create(args: z.infer<typeof createArgsSchema>): Promise<unknown> {
		const name = args.name ?? generateName();
		validateName(name);
		const namespace = await this.jobsClient.getNamespace(args.namespace);
		validateNamespace(namespace);
		const nonce = createNonce();
		const hfToken = this.requireToken();
		const sandboxToken = deriveSandboxToken(hfToken, nonce);

		const secrets: Record<string, string> = {
			SBX_TOKEN: sandboxToken,
			SBX_DL_TOKEN: hfToken,
		};
		if (args.forward_hf_token) {
			secrets.HF_TOKEN = hfToken;
		}
		const userVolumes = normalizeSandboxVolumes(args);
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
			dockerImage: args.image,
			command: ['/bin/sh', '-c', BOOTSTRAP_DOWNLOAD],
			flavor: args.flavor,
			timeoutSeconds: parseTimeout(SANDBOX_MAX_LIFETIME),
			environment: {
				SBX_PORT: String(SANDBOX_PORT),
				SBX_IDLE_TIMEOUT: String(parseTimeout(args.timeout)),
				SBX_SERVER_URL: `https://huggingface.co/buckets/${SANDBOX_SERVER_BUCKET}/resolve/sbx-server`,
				SBX_SERVER_MOUNT: SANDBOX_SERVER_MOUNT_PATH,
				MCP_SANDBOX_NAME: name,
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

		const job = await this.jobsClient.runJob(jobSpec, namespace);
		const handle = formatSandboxHandle({
			namespace,
			jobId: job.id,
		});

		return {
			name,
			namespace,
			job_id: job.id,
			port: SANDBOX_PORT,
			url: getExposeUrl(job, job.id, SANDBOX_PORT),
			handle,
			job_url: getJobUrl(namespace, job.id),
			volumes: userVolumes ?? [],
		};
	}

	private async status(args: z.infer<typeof handleArgsSchema>): Promise<unknown> {
		const handle = parseSandboxHandle(args.handle);
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		let health: unknown;
		try {
			health = normalizeSandboxHealth(await this.rpcClient.health(handle, await this.authForHandle(handle)));
		} catch (error) {
			health = {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		return {
			namespace: handle.namespace,
			job_id: handle.jobId,
			port: SANDBOX_PORT,
			url: getExposeUrl(job, handle.jobId, SANDBOX_PORT),
			job_url: getJobUrl(handle.namespace, handle.jobId),
			status: job.status,
			health,
			volumes: parseStoredSandboxVolumes(job),
		};
	}

	private async terminate(args: z.infer<typeof handleArgsSchema>): Promise<unknown> {
		const handle = parseSandboxHandle(args.handle);
		await this.jobsClient.cancelJob(handle.jobId, handle.namespace);
		return {
			namespace: handle.namespace,
			job_id: handle.jobId,
			terminated: true,
			job_url: getJobUrl(handle.namespace, handle.jobId),
		};
	}
}

export class HfSandboxExecTool {
	private jobsClient: SandboxJobsClient;
	private rpcClient: SandboxRpcClient;
	private hfToken?: string;
	private isAuthenticated: boolean;

	constructor(
		hfToken?: string,
		isAuthenticated?: boolean,
		rpcClient?: SandboxRpcClient,
		jobsClient?: SandboxJobsClient
	) {
		this.hfToken = hfToken;
		this.isAuthenticated = isAuthenticated ?? !!hfToken;
		this.rpcClient = rpcClient ?? new HttpSandboxRpcClient();
		this.jobsClient = jobsClient ?? new JobsApiClient(hfToken);
	}

	async execute(params: z.infer<typeof shellExecArgsSchema>): Promise<ToolResult> {
		if (!this.isAuthenticated || !this.hfToken) {
			return authRequiredResult();
		}

		try {
			const parsed = shellExecArgsSchema.parse(params);
			const handle = parseSandboxHandle(parsed.handle);
			const result = await this.rpcClient.exec(handle, await this.authForHandle(handle), {
				handle: parsed.handle,
				command: ['/bin/sh', '-lc', parsed.cmd],
				workdir: parsed.workdir,
				stdin: parsed.stdin,
				timeout: parsed.timeout,
			});

			return {
				formatted: formatJson(result),
				totalResults: 1,
				resultsShared: 1,
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				return validationErrorResult(error, HF_SANDBOX_EXEC_TOOL_CONFIG.name);
			}
			return {
				formatted: `Error executing sandbox command: ${error instanceof Error ? error.message : String(error)}`,
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}
	}

	private requireToken(): string {
		if (!this.hfToken) {
			throw new Error('HF token is required.');
		}
		return this.hfToken;
	}

	private async authForHandle(handle: SandboxHandle): Promise<SandboxAuth> {
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		const nonce = job.labels?.[NONCE_LABEL];
		if (!nonce) {
			throw new Error(`Job ${handle.jobId} is not a current sandbox (missing '${NONCE_LABEL}' label).`);
		}
		const hfToken = this.requireToken();
		return { hfToken, sandboxToken: deriveSandboxToken(hfToken, nonce) };
	}
}
