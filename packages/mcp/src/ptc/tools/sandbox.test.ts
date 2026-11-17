import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo, JobSpec } from '../../jobs/types.js';
import {
	clearSandboxHandleCache,
	type SandboxConnection,
	type SandboxExecOptions,
	type SandboxExecRequest,
	type SandboxExecResult,
	type SandboxFsEntry,
	type SandboxJobsClient,
	type SandboxProcess,
	type SandboxRpcClient,
} from '../../sandbox-tool.js';
import type { PtcError } from '../core/errors.js';
import { callPtcTool, type PtcContext, type PtcTool } from '../core/tool.js';
import { createSandboxTools, SANDBOX_TOOLS } from './sandbox.js';

const JOB_ID = '6a2bfe87871c005b5352b2d1';
const HANDLE = `hfsb2:evalstate:${JOB_ID}`;
const NONCE = '0123456789abcdef0123456789abcdef';
const TOKEN = 'hf_secret_token_value';

function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		id: JOB_ID,
		createdAt: '2026-01-01T00:00:00Z',
		dockerImage: 'python:3.12',
		environment: {
			SBX_IDLE_TIMEOUT: '3600',
			MCP_SANDBOX_VOLUMES: JSON.stringify([{ type: 'dataset', source: 'org/ds', mountPath: '/data', readOnly: true }]),
		},
		flavor: 'cpu-basic',
		// OpenAPI: status.exposeUrls.
		status: { stage: 'RUNNING', exposeUrls: ['https://custom--49983.hf.jobs'] },
		owner: { id: 'u', name: 'evalstate', type: 'user' },
		labels: { 'hf-sandbox': '1', 'hf-sandbox-nonce': NONCE, pet: 'calm-harbor' },
		...overrides,
	};
}

const FILE: SandboxFsEntry = {
	name: 'out.txt',
	path: '/work/out.txt',
	type: 'file',
	size: 6,
	mtime_ms: 0,
	mode: '644',
};

function jobsMock() {
	return {
		getNamespace: vi.fn((ns?: string) => Promise.resolve(ns ?? 'evalstate')),
		runJob: vi.fn((spec: JobSpec) => Promise.resolve(jobInfo({ labels: spec.labels }))),
		getJob: vi.fn(() => Promise.resolve(jobInfo())),
		cancelJob: vi.fn(() => Promise.resolve()),
	} satisfies SandboxJobsClient;
}

function rpcMock() {
	return {
		health: vi.fn((): Promise<unknown> => Promise.resolve({ ok: true })),
		exec: vi.fn(
			async (
				_conn: SandboxConnection,
				_args: SandboxExecRequest,
				options?: SandboxExecOptions
			): Promise<SandboxExecResult> => {
				await options?.onProgress?.({ event: 'start', message: 'Started process 7.' });
				return { returncode: 0, stdout: '42\n', stderr: '', signal: null, timed_out: false, duration_ms: 20 };
			}
		),
		execDetached: vi.fn(() => Promise.resolve<SandboxProcess>({ id: 'p-1', pid: 4242, tag: 'svc' })),
		listProcesses: vi.fn(() =>
			Promise.resolve<SandboxProcess[]>([
				{
					id: 'p-1',
					pid: 4242,
					cmd: ['/bin/sh', '-lc', 'python serve.py'],
					tag: 'svc',
					running: true,
					exit_code: null,
				},
				{ id: 'p-2', pid: 4243, cmd: ['/bin/sh', '-lc', 'sleep 1'], tag: 'svc', running: false, exit_code: 0 },
			])
		),
		killProcess: vi.fn((_conn: SandboxConnection, _id: string) => Promise.resolve()),
		readFile: vi.fn(
			(_conn: SandboxConnection, _args: { path: string; offset?: number; length?: number }): Promise<Buffer> =>
				Promise.resolve(Buffer.from('héllo', 'utf-8'))
		),
		writeFile: vi.fn(() => Promise.resolve()),
		listDir: vi.fn(() => Promise.resolve([FILE])),
		statPath: vi.fn((): Promise<SandboxFsEntry | null> => Promise.resolve(FILE)),
		deletePath: vi.fn(() => Promise.resolve()),
		mkdir: vi.fn(() => Promise.resolve()),
	} satisfies SandboxRpcClient;
}

let jobs: ReturnType<typeof jobsMock>;
let rpc: ReturnType<typeof rpcMock>;
let tools: readonly PtcTool[];

function tool(name: string): PtcTool {
	const found = tools.find((t) => t.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

async function call(name: string, input: unknown, ctx: PtcContext = {}) {
	return (await callPtcTool(tool(name), input, { hfToken: TOKEN, username: 'evalstate', ...ctx })).structured;
}

beforeEach(() => {
	clearSandboxHandleCache();
	jobs = jobsMock();
	rpc = rpcMock();
	tools = createSandboxTools({ jobsClient: () => jobs, rpcClient: rpc });
});

describe('sandbox tool definitions', () => {
	it('registers the v2 names with write access and correct annotations', () => {
		expect(SANDBOX_TOOLS.map((t) => t.name)).toEqual([
			'hf_sandbox_create',
			'hf_sandbox_status',
			'hf_sandbox_terminate',
			'hf_sandbox_exec',
			'hf_sandbox_kill',
			'hf_sandbox_fs_read',
			'hf_sandbox_fs_write',
		]);
		for (const t of SANDBOX_TOOLS) {
			expect(t.access).toBe('write');
			expect(t.family).toBe('sandbox');
			expect(t.description.length).toBeGreaterThanOrEqual(150);
			expect(t.description.length).toBeLessThanOrEqual(700);
			const readOnly = t.name === 'hf_sandbox_status' || t.name === 'hf_sandbox_fs_read';
			expect(t.annotations.readOnlyHint).toBe(readOnly);
			expect(t.annotations.destructiveHint).toBe(!readOnly);
		}
	});

	it('requires a token', async () => {
		await expect(callPtcTool(tool('hf_sandbox_status'), { sandbox: HANDLE }, {})).rejects.toMatchObject({
			code: 'AUTH_REQUIRED',
		});
	});

	it('rejects malformed handles as INVALID_ARGUMENT', async () => {
		await expect(call('hf_sandbox_status', { sandbox: 'bad:handle' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});
});

describe('hf_sandbox_create', () => {
	it('builds the job spec from structured params and returns the handle with hf:// volumes', async () => {
		const progress = vi.fn();
		const out = await call(
			'hf_sandbox_create',
			{
				name: 'my-box',
				flavor: 't4-small',
				lifetime: '2h',
				volumes: ['hf://datasets/org/ds:/data:ro'],
				bucket: 'hf://buckets/me/scratch',
				forward_hf_token: true,
			},
			{ onProgress: progress }
		);
		const spec = jobs.runJob.mock.calls[0]?.[0] as JobSpec;
		expect(spec.flavor).toBe('t4-small');
		expect(spec.environment?.SBX_IDLE_TIMEOUT).toBe('7200');
		expect(spec.secrets?.HF_TOKEN).toBe(TOKEN);
		expect(spec.volumes?.map((v) => v.source)).toEqual(['org/ds', 'me/scratch', 'huggingface/sbx-server']);
		expect(out).toMatchObject({
			kind: 'sandbox',
			id: HANDLE,
			name: 'my-box',
			url: `https://huggingface.co/jobs/evalstate/${JOB_ID}`,
			ready: true,
			hf_token_forwarded: true,
		});
		expect(out.volumes).toEqual([
			expect.objectContaining({ kind: 'dataset', id: 'org/ds', uri: 'hf://datasets/org/ds', read_only: true }),
			expect.objectContaining({
				kind: 'bucket',
				id: 'me/scratch',
				uri: 'hf://buckets/me/scratch',
				mount_path: '/data',
			}),
		]);
		expect(JSON.stringify(out)).not.toContain(TOKEN);
		expect(progress).toHaveBeenCalled();
	});

	it('validates lifetime and volumes before creating a job', async () => {
		await expect(call('hf_sandbox_create', { lifetime: '48h' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(call('hf_sandbox_create', { volumes: ['org/ds:/data'] })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		expect(jobs.runJob).not.toHaveBeenCalled();
	});
});

describe('hf_sandbox_status / terminate', () => {
	it('combines job state, lifetime, mounts and processes', async () => {
		const out = await call('hf_sandbox_status', { sandbox: `evalstate/${JOB_ID}` });
		expect(jobs.getJob).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({
			id: HANDLE,
			name: 'calm-harbor',
			stage: 'RUNNING',
			healthy: true,
			health_error: null,
			idle_lifetime_seconds: 3600,
			server_url: 'https://custom--49983.hf.jobs',
		});
		expect(out.volumes).toEqual([expect.objectContaining({ uri: 'hf://datasets/org/ds' })]);
		expect(out.processes).toMatchObject({
			returnedCount: 2,
			nextCursor: null,
			completeness: { hasMore: false, available: true },
		});
		expect((out.processes as { items: unknown[] }).items[0]).toEqual({
			kind: 'process',
			id: 'p-1',
			pid: 4242,
			tag: 'svc',
			command: 'python serve.py',
			running: true,
			exit_code: null,
			started_at: null,
		});
	});

	it('redacts the token and sbx-server token from stage messages and process commands (A5 regression)', async () => {
		const sbxToken = createHmac('sha256', TOKEN).update(`hf-sandbox:${NONCE}`).digest('hex');
		jobs.getJob.mockResolvedValue(
			jobInfo({
				status: { stage: 'RUNNING', message: `boot ${TOKEN}`, exposeUrls: ['https://custom--49983.hf.jobs'] },
			})
		);
		rpc.listProcesses.mockResolvedValue([
			{ id: 'p-1', pid: 1, cmd: ['/bin/sh', '-lc', `echo ${TOKEN} ${sbxToken}`], running: true },
		]);
		const out = await call('hf_sandbox_status', { sandbox: HANDLE });
		const text = JSON.stringify(out);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(sbxToken);
		expect(out.stage_message).toBe('boot <redacted>');
		expect((out.processes as { items: Array<{ command: string }> }).items[0]?.command).toBe(
			'echo <redacted> <redacted>'
		);
		const killed = await call('hf_sandbox_kill', { sandbox: HANDLE, process: 'p-1' });
		expect(JSON.stringify(killed)).not.toContain(TOKEN);
		expect(JSON.stringify(killed)).not.toContain(sbxToken);
	});

	it('reports an unhealthy server without leaking the upstream body', async () => {
		rpc.health.mockRejectedValue(new Error('Sandbox RPC /health failed with 503: {"secret":"body"}'));
		const out = await call('hf_sandbox_status', { sandbox: HANDLE });
		expect(out.healthy).toBe(false);
		expect(String(out.health_error)).toContain('503');
		expect(String(out.health_error)).not.toContain('secret');
		expect(out.processes).toMatchObject({ returnedCount: 0, completeness: { available: false } });
	});

	it('terminates by cancelling the job', async () => {
		const out = await call('hf_sandbox_terminate', { sandbox: HANDLE });
		expect(jobs.cancelJob).toHaveBeenCalledWith(JOB_ID, 'evalstate');
		expect(out).toMatchObject({ id: HANDLE, terminated: true });
	});
});

describe('hf_sandbox_exec', () => {
	it('runs a foreground command, relays progress and never echoes env or stdin', async () => {
		const progress = vi.fn();
		const out = await call(
			'hf_sandbox_exec',
			{ sandbox: HANDLE, command: 'python -c "print(42)"', env: { API_KEY: 'shh' }, stdin: 'private-input' },
			{ onProgress: progress }
		);
		expect(rpc.exec).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://custom--49983.hf.jobs' }),
			expect.objectContaining({
				command: ['/bin/sh', '-lc', 'python -c "print(42)"'],
				timeout: 30,
				env: { API_KEY: 'shh' },
				stdin: 'private-input',
			}),
			expect.anything()
		);
		expect(out).toMatchObject({ detached: false, exit_code: 0, stdout: '42\n', process: null });
		expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, message: 'Started process 7.' }));
		const text = JSON.stringify(out);
		expect(text).not.toContain('shh');
		expect(text).not.toContain('private-input');
	});

	it('redacts the caller token and env secrets from output, commands and progress (A5 regression)', async () => {
		const secret = 'sk-live-abcdef';
		rpc.exec.mockImplementation(
			async (_conn: SandboxConnection, _args: SandboxExecRequest, options?: SandboxExecOptions) => {
				await options?.onProgress?.({ event: 'stdout', message: `token ${TOKEN} key ${secret}` });
				return {
					returncode: 0,
					stdout: `HF_TOKEN=${TOKEN}\nKEY=${secret}\nDEBUG=1\n`,
					stderr: `warning: ${TOKEN}`,
					signal: null,
					timed_out: false,
					duration_ms: 5,
				};
			}
		);
		const progress = vi.fn();
		const out = await call(
			'hf_sandbox_exec',
			{ sandbox: HANDLE, command: 'env', env: { KEY: secret, DEBUG: '1' } },
			{ onProgress: progress }
		);
		const text = JSON.stringify(out) + JSON.stringify(progress.mock.calls);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(secret);
		expect(out.stdout).toBe('HF_TOKEN=<redacted>\nKEY=<redacted>\nDEBUG=1\n');
		expect(out.stderr).toBe('warning: <redacted>');

		rpc.execDetached.mockResolvedValue({ id: 'p-9', pid: 1, cmd: ['/bin/sh', '-lc', `curl -H "${TOKEN}"`] });
		const detached = await call('hf_sandbox_exec', { sandbox: HANDLE, command: 'x', detach: true });
		expect(detached.process).toMatchObject({ command: 'curl -H "<redacted>"' });
	});

	it('bounds output and enforces the foreground timeout', async () => {
		rpc.exec.mockResolvedValue({
			returncode: 1,
			stdout: 'x'.repeat(50_000),
			stderr: '',
			signal: null,
			timed_out: false,
			duration_ms: 1,
		});
		const out = await call('hf_sandbox_exec', { sandbox: HANDLE, command: 'yes' });
		expect((out.stdout as string).length).toBe(40_000);
		expect(out.stdout_truncated).toBe(true);
		await expect(call('hf_sandbox_exec', { sandbox: HANDLE, command: 'x', timeout: 120 })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('streams with a bounded, redacting reader and follows the request signal', async () => {
		rpc.exec.mockResolvedValue({
			returncode: 0,
			stdout: 'tail',
			stderr: '',
			signal: null,
			timed_out: false,
			duration_ms: 1,
			stdout_dropped: true,
		});
		const controller = new AbortController();
		const out = await call('hf_sandbox_exec', { sandbox: HANDLE, command: 'yes' }, { signal: controller.signal });
		const [conn, , options] = rpc.exec.mock.calls[0] as [SandboxConnection, unknown, SandboxExecOptions];
		expect(conn.signal).toBe(controller.signal);
		expect(conn.url).toBe('https://custom--49983.hf.jobs');
		expect(options.maxOutputChars).toBe(40_000);
		expect(options.redact?.(`a ${TOKEN} b`)).toBe('a <redacted> b');
		expect(out).toMatchObject({ stdout: 'tail', stdout_truncated: true, stderr_truncated: false });
	});

	it('reports an abort mid-call as CANCELLED', async () => {
		const controller = new AbortController();
		rpc.exec.mockImplementation(() => {
			controller.abort();
			return Promise.reject(new Error('Request was aborted'));
		});
		await expect(
			call('hf_sandbox_exec', { sandbox: HANDLE, command: 'sleep 9' }, { signal: controller.signal })
		).rejects.toMatchObject({ code: 'CANCELLED' });
	});

	it('redacts a process command before truncating it', async () => {
		const command = `${'x'.repeat(495)} ${TOKEN}`;
		rpc.execDetached.mockResolvedValue({ id: 'p-9', pid: 1, cmd: ['/bin/sh', '-lc', command] });
		const detached = await call('hf_sandbox_exec', { sandbox: HANDLE, command: 'x', detach: true });
		const shown = (detached.process as { command: string }).command;
		expect(shown.length).toBeLessThanOrEqual(500);
		expect(shown).not.toContain(TOKEN.slice(0, 4));
	});

	it('starts detached processes with a tag', async () => {
		const out = await call('hf_sandbox_exec', {
			sandbox: HANDLE,
			command: 'python serve.py',
			detach: true,
			tag: 'svc',
		});
		expect(rpc.execDetached).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'svc' }));
		expect(out).toMatchObject({
			detached: true,
			exit_code: null,
			process: { kind: 'process', id: 'p-1', pid: 4242, tag: 'svc', command: 'python serve.py' },
		});
	});
});

describe('hf_sandbox_kill', () => {
	it('kills by id', async () => {
		const out = await call('hf_sandbox_kill', { sandbox: HANDLE, process: 'p-2' });
		expect(rpc.killProcess).toHaveBeenCalledWith(expect.anything(), 'p-2');
		expect(out).toMatchObject({ matched_by: 'id', returnedCount: 1 });
	});

	it('kills running processes by tag and reports unknown targets', async () => {
		const out = await call('hf_sandbox_kill', { sandbox: HANDLE, process: 'svc' });
		expect(rpc.killProcess).toHaveBeenCalledTimes(1);
		expect(rpc.killProcess).toHaveBeenCalledWith(expect.anything(), 'p-1');
		expect(out).toMatchObject({ matched_by: 'tag', killed: [{ id: 'p-1', running: false }] });
		await expect(call('hf_sandbox_kill', { sandbox: HANDLE, process: 'nope' })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});

describe('hf_sandbox_fs_read', () => {
	/** Serve `content` as the sandbox file, honoring offset/length like sbx-server. */
	function serveFile(content: Buffer) {
		rpc.statPath.mockResolvedValue({ ...FILE, size: content.length });
		rpc.readFile.mockImplementation((_conn, args) => {
			const start = args.offset ?? 0;
			return Promise.resolve(content.subarray(start, args.length === undefined ? undefined : start + args.length));
		});
	}

	async function readText(offset: number, maxBytes: number) {
		return call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/work/out.txt', offset, max_bytes: maxBytes });
	}

	it('reads text with offsets and keeps UTF-8 boundaries', async () => {
		serveFile(Buffer.from('héllo', 'utf-8'));
		const out = await readText(0, 2);
		expect(rpc.readFile).toHaveBeenCalledWith(expect.anything(), { path: '/work/out.txt', offset: 0, length: 5 });
		expect(out).toMatchObject({ op: 'read', content: 'h', bytes: 1, size: 6, nextOffset: 1, encoding: 'text' });
	});

	it('always makes progress on 1-3 byte windows and reassembles the file (A9 regression)', async () => {
		const text = 'é€😀a😀';
		const file = Buffer.from(text, 'utf-8');
		serveFile(file);
		for (const maxBytes of [1, 2, 3]) {
			let offset: number | null = 0;
			let joined = '';
			let calls = 0;
			while (offset !== null) {
				const out = await readText(offset, maxBytes);
				expect(out.bytes as number).toBeGreaterThan(0);
				expect(out.content as string).not.toContain('\uFFFD');
				joined += out.content as string;
				offset = out.nextOffset as number | null;
				calls += 1;
				expect(calls).toBeLessThan(20);
			}
			expect(joined).toBe(text);
		}
		// A file starting with é and max_bytes=1 returns the whole character, not an empty end of file.
		expect(await readText(0, 1)).toMatchObject({ content: 'é', bytes: 2, nextOffset: 2 });
	});

	it('aligns a mid-codepoint offset to the next character', async () => {
		serveFile(Buffer.from('a€b', 'utf-8')); // a=0, €=1..3, b=4
		const out = await readText(2, 10);
		expect(out).toMatchObject({ offset: 4, content: 'b', bytes: 1, nextOffset: null });
		const exact = await readText(1, 3);
		expect(exact).toMatchObject({ offset: 1, content: '€', bytes: 3, nextOffset: 4 });
	});

	it('reads base64 to the end of file', async () => {
		const out = await call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/work/out.txt', encoding: 'base64' });
		expect(out).toMatchObject({ content: Buffer.from('héllo').toString('base64'), bytes: 6, nextOffset: null });
	});

	it('lists and stats paths', async () => {
		const list = await call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/work', op: 'list' });
		expect(list).toMatchObject({
			items: [{ kind: 'file', id: '/work/out.txt', name: 'out.txt', size: 6, mode: '644' }],
			returnedCount: 1,
			nextCursor: null,
			completeness: { hasMore: false },
		});
		rpc.statPath.mockResolvedValueOnce(null);
		const stat = await call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/missing', op: 'stat' });
		expect(stat).toMatchObject({ exists: false, entry: null });
	});

	it('maps sbx-server errors and rejects directories and relative paths', async () => {
		rpc.statPath.mockResolvedValueOnce({
			name: 'work',
			path: '/work',
			type: 'dir',
			size: 0,
			mtime_ms: null,
			mode: '755',
		});
		await expect(call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/work' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(call('hf_sandbox_fs_read', { sandbox: HANDLE, path: 'rel' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		rpc.listDir.mockRejectedValueOnce(
			new Error('Sandbox RPC /v1/files/list?path=%2F500 failed with 404: {"detail":"x"}')
		);
		const error = (await call('hf_sandbox_fs_read', { sandbox: HANDLE, path: '/500', op: 'list' }).catch(
			(e: unknown) => e
		)) as PtcError;
		expect(error.code).toBe('NOT_FOUND');
		expect(error.message).not.toContain('detail');
	});
});

describe('hf_sandbox_fs_write', () => {
	it('writes text and base64 without echoing the body', async () => {
		const out = await call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/work/a.txt', text: 'top secret' });
		expect(rpc.writeFile).toHaveBeenCalledWith(expect.anything(), {
			path: '/work/a.txt',
			data: Buffer.from('top secret'),
		});
		expect(out).toEqual({ sandbox: HANDLE, op: 'write', path: '/work/a.txt', bytes: 10, done: true });
		const bin = await call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/b.bin', base64: 'AAEC' });
		expect(bin.bytes).toBe(3);
	});

	it('validates write payloads', async () => {
		await expect(call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/a' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(
			call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/a', text: 'x', base64: 'AA==' })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/a', base64: '%%%' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('removes recursively and creates directories', async () => {
		await call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/work', op: 'remove', recursive: true });
		expect(rpc.deletePath).toHaveBeenCalledWith(expect.anything(), { path: '/work', recursive: true });
		const out = await call('hf_sandbox_fs_write', { sandbox: HANDLE, path: '/new', op: 'mkdir' });
		expect(rpc.mkdir).toHaveBeenCalledWith(expect.anything(), '/new');
		expect(out).toMatchObject({ op: 'mkdir', bytes: null, done: true });
	});
});
