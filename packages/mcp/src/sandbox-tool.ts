import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { JobsApiClient } from './jobs/api-client.js';
import type { JobInfo, JobSpec, JobVolume } from './jobs/types.js';
import { parseTimeout, parseVolumes } from './jobs/commands/utils.js';
import type { ToolResult } from './types/tool-result.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from './network/fetch-profile.js';

const SANDBOX_HANDLE_VERSION = 'hfsb1';
const SANDBOX_PORT = 8000;
const SANDBOX_ROOT = '/sandbox';
const DEFAULT_BUCKET_MOUNT_PATH = '/data';
const DEFAULT_IMAGE = 'python:3.12';
const DEFAULT_FLAVOR = 'cpu-basic';
const DEFAULT_TIMEOUT = '1h';
const VOLUME_FORMAT = 'hf://[models|datasets|spaces|buckets]/OWNER/NAME[/PATH]:/MOUNT_PATH[:ro|:rw]';
const TOKEN_MIN_LENGTH = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const HOST_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const SANDBOX_SERVER_SCRIPT = String.raw`
import base64
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("HF_SANDBOX_TOKEN", "")
ROOT = os.environ.get("HF_SANDBOX_ROOT", "/sandbox")
PORT = int(os.environ.get("HF_SANDBOX_PORT", "8000"))
os.makedirs(ROOT, exist_ok=True)
os.chdir(ROOT)

def send_json(handler, status, payload):
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

def resolve_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError("path must be a non-empty string")
    if "\x00" in path:
        raise ValueError("path cannot contain null bytes")
    candidate = path if os.path.isabs(path) else os.path.join(ROOT, path)
    return os.path.abspath(candidate)

class Handler(BaseHTTPRequestHandler):
    server_version = "hf-sandbox-rpc/1"

    def log_message(self, fmt, *args):
        return

    def authorized(self):
        return bool(TOKEN) and self.headers.get("X-Sandbox-Token") == TOKEN

    def read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if self.path != "/health":
            send_json(self, 404, {"error": "not found"})
            return
        if not self.authorized():
            send_json(self, 401, {"error": "unauthorized"})
            return
        send_json(self, 200, {"ok": True, "name": os.environ.get("HF_SANDBOX_NAME"), "root": ROOT})

    def do_POST(self):
        if not self.authorized():
            send_json(self, 401, {"error": "unauthorized"})
            return
        try:
            payload = self.read_payload()
            if self.path == "/exec":
                command = payload.get("command")
                if not isinstance(command, list) or not command or not all(isinstance(item, str) for item in command):
                    raise ValueError("command must be a non-empty string array")
                workdir = payload.get("workdir") or ROOT
                workdir = resolve_path(workdir)
                timeout = int(payload.get("timeout", 600))
                stdin = payload.get("stdin")
                result = subprocess.run(
                    command,
                    cwd=workdir,
                    input=stdin,
                    text=True,
                    capture_output=True,
                    timeout=timeout,
                    check=False,
                )
                send_json(self, 200, {
                    "returncode": result.returncode,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                })
                return
            if self.path == "/write":
                target = resolve_path(payload.get("path"))
                content = payload.get("content")
                encoding = payload.get("encoding", "utf-8")
                if not isinstance(content, str):
                    raise ValueError("content must be a string")
                data = base64.b64decode(content) if encoding == "base64" else content.encode("utf-8")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(data)
                send_json(self, 200, {"path": target, "bytes": len(data)})
                return
            if self.path == "/read":
                target = resolve_path(payload.get("path"))
                encoding = payload.get("encoding", "utf-8")
                with open(target, "rb") as f:
                    data = f.read()
                content = base64.b64encode(data).decode("ascii") if encoding == "base64" else data.decode("utf-8")
                send_json(self, 200, {"path": target, "content": content, "encoding": encoding, "bytes": len(data)})
                return
            send_json(self, 404, {"error": "not found"})
        except subprocess.TimeoutExpired as exc:
            send_json(self, 408, {"error": "command timed out", "stdout": exc.stdout or "", "stderr": exc.stderr or ""})
        except Exception as exc:
            send_json(self, 400, {"error": str(exc)})

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;

const createArgsSchema = z
	.object({
		image: z.string().optional().default(DEFAULT_IMAGE),
		flavor: z.string().optional().default(DEFAULT_FLAVOR),
		timeout: z.string().optional().default(DEFAULT_TIMEOUT),
		namespace: z.string().optional(),
		name: z.string().optional(),
		sandbox_token: z.string().optional(),
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
		workdir: z.string().optional().describe(`Working directory inside the sandbox. Defaults to ${SANDBOX_ROOT}.`),
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
	sandboxToken: string;
}

export interface SandboxRpcClient {
	health(handle: SandboxHandle, hfToken: string): Promise<unknown>;
	exec(handle: SandboxHandle, hfToken: string, args: z.infer<typeof execArgsSchema>): Promise<unknown>;
	write(handle: SandboxHandle, hfToken: string, args: z.infer<typeof writeArgsSchema>): Promise<unknown>;
	read(handle: SandboxHandle, hfToken: string, args: z.infer<typeof readArgsSchema>): Promise<unknown>;
}

export interface SandboxJobsClient {
	getNamespace(namespace?: string): Promise<string>;
	runJob(jobSpec: JobSpec, namespace?: string): Promise<JobInfo>;
	getJob(jobId: string, namespace?: string): Promise<JobInfo>;
	cancelJob(jobId: string, namespace?: string): Promise<void>;
}

export const HF_SANDBOX_TOOL_CONFIG = {
	name: 'hf_sandbox',
	description:
		'Create and manage interactive Hugging Face Jobs sandboxes. Supports create, read, write, status, and terminate with portable stateless handles. Use hf_sandbox_exec to run shell commands in a sandbox. ' +
		`Mount Hub repos with volumes using ${VOLUME_FORMAT}; type prefixes must be plural. Examples: ` +
		'["hf://buckets/user/bucket:/data:rw"], ["hf://datasets/org/dataset:/data:ro"], ["hf://models/org/model:/model"]. ' +
		'For buckets, create also accepts bucket, bucket_mode, and bucket_mount_path as a convenience. ' +
		`The default working directory is ${SANDBOX_ROOT}, which is fast ephemeral container storage; mounted buckets use FUSE and are better for persisted artifacts than build-heavy work.`,
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
	const storedVolumes = job.environment?.HF_SANDBOX_VOLUMES;
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

function randomSuffix(): string {
	return randomBytes(18).toString('base64url');
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

function validateToken(token: string): void {
	if (token.length < TOKEN_MIN_LENGTH || !TOKEN_PATTERN.test(token)) {
		throw new Error('sandbox_token must be at least 32 URL-safe characters.');
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

function createSandboxToken(name: string, suppliedToken?: string): string {
	if (suppliedToken) {
		validateToken(suppliedToken);
		return suppliedToken;
	}
	return `${name}-${randomSuffix()}`;
}

export function parseSandboxHandle(handle: string): SandboxHandle {
	const parts = handle.split(':');
	if (parts.length !== 4 || parts[0] !== SANDBOX_HANDLE_VERSION) {
		throw new Error(`Invalid sandbox handle. Expected ${SANDBOX_HANDLE_VERSION}:<namespace>:<job_id>:<token>.`);
	}

	const [, namespace, jobId, sandboxToken] = parts;
	if (!namespace || !jobId || !sandboxToken) {
		throw new Error('Invalid sandbox handle. All handle fields are required.');
	}

	validateNamespace(namespace);
	validateJobId(jobId);
	validateToken(sandboxToken);

	return { namespace, jobId, sandboxToken };
}

export function formatSandboxHandle(handle: SandboxHandle): string {
	validateNamespace(handle.namespace);
	validateJobId(handle.jobId);
	validateToken(handle.sandboxToken);
	return `${SANDBOX_HANDLE_VERSION}:${handle.namespace}:${handle.jobId}:${handle.sandboxToken}`;
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
		hfToken: string,
		path: string,
		body?: unknown,
		timeoutSeconds = 30
	): Promise<unknown> {
		const requestInit: RequestInit = {
			method: body ? 'POST' : 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${hfToken}`,
				'X-Sandbox-Token': handle.sandboxToken,
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		};
		const { response } = await fetchWithProfile(
			`${getSandboxUrl(handle.jobId)}${path}`,
			NETWORK_FETCH_PROFILES.externalHttps(),
			{
				timeoutMs: timeoutSeconds * 1000,
				requestInit,
			}
		);
		const responseText = await response.text();
		const payload = responseText ? (JSON.parse(responseText) as unknown) : {};

		if (!response.ok) {
			throw new Error(`Sandbox RPC ${path} failed with ${String(response.status)}: ${JSON.stringify(payload)}`);
		}

		return payload;
	}

	health(handle: SandboxHandle, hfToken: string): Promise<unknown> {
		return this.request(handle, hfToken, '/health');
	}

	exec(handle: SandboxHandle, hfToken: string, args: z.infer<typeof execArgsSchema>): Promise<unknown> {
		return this.request(
			handle,
			hfToken,
			'/exec',
			{
				command: args.command,
				workdir: args.workdir,
				stdin: args.stdin,
				timeout: args.timeout,
			},
			args.timeout + 5
		);
	}

	write(handle: SandboxHandle, hfToken: string, args: z.infer<typeof writeArgsSchema>): Promise<unknown> {
		return this.request(handle, hfToken, '/write', {
			path: args.path,
			content: args.content,
			encoding: args.encoding,
		});
	}

	read(handle: SandboxHandle, hfToken: string, args: z.infer<typeof readArgsSchema>): Promise<unknown> {
		return this.request(handle, hfToken, '/read', {
			path: args.path,
			encoding: args.encoding,
		});
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
					`Sandbox commands run from ${SANDBOX_ROOT} by default. This is fast ephemeral container storage and is deleted with the sandbox Job. ` +
					'Use mounted Hub volumes for persisted inputs or outputs; for build-heavy work, prefer building in /sandbox and copying final artifacts to the mounted bucket.\n\n' +
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
				return this.rpcClient.write(parseSandboxHandle(parsed.handle), this.requireToken(), parsed);
			}
			case 'read': {
				const parsed = readArgsSchema.parse(args);
				return this.rpcClient.read(parseSandboxHandle(parsed.handle), this.requireToken(), parsed);
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

	private async create(args: z.infer<typeof createArgsSchema>): Promise<unknown> {
		const name = args.name ?? generateName();
		validateName(name);
		const namespace = await this.jobsClient.getNamespace(args.namespace);
		validateNamespace(namespace);
		const sandboxToken = createSandboxToken(name, args.sandbox_token);

		const secrets: Record<string, string> = {
			HF_SANDBOX_TOKEN: sandboxToken,
		};
		if (args.forward_hf_token) {
			secrets.HF_TOKEN = this.requireToken();
		}
		const volumes = normalizeSandboxVolumes(args);

		const jobSpec: JobSpec = {
			dockerImage: args.image,
			command: ['python', '-u', '-c', SANDBOX_SERVER_SCRIPT],
			flavor: args.flavor,
			timeoutSeconds: parseTimeout(args.timeout),
			environment: {
				HF_SANDBOX_NAME: name,
				HF_SANDBOX_HANDLE_VERSION: '1',
				HF_SANDBOX_PORT: String(SANDBOX_PORT),
				HF_SANDBOX_ROOT: SANDBOX_ROOT,
				...(volumes ? { HF_SANDBOX_VOLUMES: JSON.stringify(volumes) } : {}),
			},
			secrets,
			labels: {
				'hf-sandbox': '',
				pet: name,
			},
			expose: { ports: [SANDBOX_PORT] },
		};
		if (volumes) {
			jobSpec.volumes = volumes;
		}

		const job = await this.jobsClient.runJob(jobSpec, namespace);
		const handle = formatSandboxHandle({
			namespace,
			jobId: job.id,
			sandboxToken,
		});

		return {
			name,
			namespace,
			job_id: job.id,
			port: SANDBOX_PORT,
			url: getExposeUrl(job, job.id, SANDBOX_PORT),
			handle,
			job_url: getJobUrl(namespace, job.id),
			volumes: volumes ?? [],
		};
	}

	private async status(args: z.infer<typeof handleArgsSchema>): Promise<unknown> {
		const handle = parseSandboxHandle(args.handle);
		const job = await this.jobsClient.getJob(handle.jobId, handle.namespace);
		let health: unknown;
		try {
			health = await this.rpcClient.health(handle, this.requireToken());
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
	private rpcClient: SandboxRpcClient;
	private hfToken?: string;
	private isAuthenticated: boolean;

	constructor(hfToken?: string, isAuthenticated?: boolean, rpcClient?: SandboxRpcClient) {
		this.hfToken = hfToken;
		this.isAuthenticated = isAuthenticated ?? !!hfToken;
		this.rpcClient = rpcClient ?? new HttpSandboxRpcClient();
	}

	async execute(params: z.infer<typeof shellExecArgsSchema>): Promise<ToolResult> {
		if (!this.isAuthenticated || !this.hfToken) {
			return authRequiredResult();
		}

		try {
			const parsed = shellExecArgsSchema.parse(params);
			const result = await this.rpcClient.exec(parseSandboxHandle(parsed.handle), this.hfToken, {
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
}
