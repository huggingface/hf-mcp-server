import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HF_SANDBOX_TOOL_CONFIG,
	HF_SANDBOX_EXEC_TOOL_CONFIG,
	HF_SANDBOX_FS_TOOL_CONFIG,
	HfSandboxExecTool,
	HfSandboxFsTool,
	HfSandboxTool,
	clearSandboxHandleCache,
	formatSandboxExecMarkdown,
	formatSandboxFsMarkdown,
	formatSandboxHandle,
	formatSandboxMarkdown,
	normalizeSandboxHealth,
	parseSandboxExecEvents,
	parseSandboxHandle,
	type SandboxCreateResult,
	type SandboxJobsClient,
	type SandboxRpcClient,
} from '../src/sandbox-tool.js';
import type { JobInfo, JobSpec } from '../src/jobs/types.js';

const HANDLE = 'hfsb2:evalstate:6a2bfe87871c005b5352b2d1';
const NONCE = '0123456789abcdef0123456789abcdef';
const STORED_VOLUMES = [
	{ type: 'dataset', source: 'org/ds', mountPath: '/data', readOnly: true },
	{ type: 'bucket', source: 'org/b', mountPath: '/output' },
];

function createJobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		id: '6a2bfe87871c005b5352b2d1',
		createdAt: '2026-01-01T00:00:00Z',
		dockerImage: 'python:3.12',
		command: ['/bin/sh', '-c', 'server'],
		environment: {},
		flavor: 'cpu-basic',
		status: { stage: 'RUNNING', expose_urls: ['https://custom--49983.hf.jobs'] },
		owner: { id: 'user-id', name: 'evalstate', type: 'user' },
		labels: { 'hf-sandbox': '1', 'hf-sandbox-mode': 'dedicated', 'hf-sandbox-nonce': NONCE },
		...overrides,
	};
}

function createJobsClient(): SandboxJobsClient {
	return {
		getNamespace: vi.fn(async (namespace?: string) => namespace ?? 'evalstate'),
		runJob: vi.fn(async () => createJobInfo()),
		getJob: vi.fn(async () => createJobInfo()),
		cancelJob: vi.fn(async () => undefined),
	};
}

function createRpcClient(): SandboxRpcClient {
	return {
		health: vi.fn(async () => ({ ok: true })),
		exec: vi.fn(async () => ({
			returncode: 0,
			stdout: '42\n',
			stderr: '',
			signal: null,
			timed_out: false,
			duration_ms: 20,
		})),
		execDetached: vi.fn(async () => ({ id: 'p-1', pid: 4242, cmd: 'sleep 60', tag: 'svc' })),
		listProcesses: vi.fn(async () => [
			{ id: 'p-1', pid: 4242, cmd: 'sleep 60', tag: 'svc', started_at_ms: 1, running: true, exit_code: null },
		]),
		killProcess: vi.fn(async () => undefined),
		readFile: vi.fn(async () => Buffer.from('tada! sandbox tool', 'utf-8')),
		writeFile: vi.fn(async () => undefined),
		listDir: vi.fn(async () => [
			{ name: 'out.txt', path: '/work/out.txt', type: 'file' as const, size: 5, mtime_ms: 1, mode: '644' },
		]),
		statPath: vi.fn(async () => ({
			name: 'out.txt',
			path: '/work/out.txt',
			type: 'file' as const,
			size: 18,
			mtime_ms: 1,
			mode: '644',
		})),
		deletePath: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
	};
}

beforeEach(() => {
	clearSandboxHandleCache();
});

describe('sandbox handles', () => {
	it('exposes the expected tool names', () => {
		expect(HF_SANDBOX_TOOL_CONFIG.name).toBe('hf_sandbox');
		expect(HF_SANDBOX_EXEC_TOOL_CONFIG.name).toBe('hf_sandbox_exec');
		expect(HF_SANDBOX_FS_TOOL_CONFIG.name).toBe('hf_sandbox_fs');
	});

	it('exposes the cmd/args schema and command grammars', () => {
		expect(Object.keys(HF_SANDBOX_TOOL_CONFIG.schema.shape)).toEqual(['cmd', 'args']);
		expect(Object.keys(HF_SANDBOX_EXEC_TOOL_CONFIG.schema.shape)).toEqual(['cmd', 'args']);
		expect(Object.keys(HF_SANDBOX_FS_TOOL_CONFIG.schema.shape)).toEqual(['cmd', 'args']);
		expect(HF_SANDBOX_TOOL_CONFIG.description).toContain('create [--name NAME]');
		expect(HF_SANDBOX_EXEC_TOOL_CONFIG.description).toContain('exec HANDLE SHELL_COMMAND');
		expect(HF_SANDBOX_FS_TOOL_CONFIG.description).toContain('cat HANDLE PATH');
	});

	it('parses and formats portable handles', () => {
		const parsed = parseSandboxHandle(HANDLE);
		expect(parsed).toEqual({ namespace: 'evalstate', jobId: '6a2bfe87871c005b5352b2d1' });
		expect(formatSandboxHandle(parsed)).toBe(HANDLE);
	});

	it('accepts CLI-style namespace/job_id and bare job ids with a default namespace', () => {
		expect(parseSandboxHandle('evalstate/6a2bfe87871c005b5352b2d1')).toEqual({
			namespace: 'evalstate',
			jobId: '6a2bfe87871c005b5352b2d1',
		});
		expect(parseSandboxHandle('6a2bfe87871c005b5352b2d1', 'evalstate')).toEqual({
			namespace: 'evalstate',
			jobId: '6a2bfe87871c005b5352b2d1',
		});
	});

	it('rejects bare job ids without a namespace', () => {
		expect(() => parseSandboxHandle('6a2bfe87871c005b5352b2d1')).toThrow(/namespace/);
	});

	it('rejects old token-bearing handles', () => {
		expect(() => parseSandboxHandle('hfsb1:evalstate:job123:secret')).toThrow(/hfsb2/);
	});
});

describe('HfSandboxTool', () => {
	it('creates a Jobs-backed sandbox with official sbx-server bootstrap', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = (await tool.run({
			cmd: 'create',
			args: [
				'--name',
				'steady-bridge',
				'--forward-hf-token',
				'--volume',
				'hf://datasets/org/ds:/data:ro',
				'--volume',
				'hf://buckets/org/b:/output',
			],
		})) as SandboxCreateResult;

		expect(result.handle).toBe(HANDLE);
		expect(result.url).toBe('https://custom--49983.hf.jobs');
		expect(result.job_url).toBe('https://huggingface.co/jobs/evalstate/6a2bfe87871c005b5352b2d1');
		expect(result.volumes).toEqual(STORED_VOLUMES);
		expect(result.message).toBeUndefined();

		expect(jobsClient.runJob).toHaveBeenCalledOnce();
		const [jobSpec, namespace] = vi.mocked(jobsClient.runJob).mock.calls[0] as [JobSpec, string];
		expect(namespace).toBe('evalstate');
		expect(jobSpec.expose).toEqual({ ports: [49983] });
		expect(jobSpec.labels).toMatchObject({
			'hf-sandbox': '1',
			'hf-sandbox-mode': 'dedicated',
			pet: 'steady-bridge',
		});
		expect(jobSpec.labels?.['hf-sandbox-nonce']).toMatch(/^[0-9a-f]{32}$/);
		expect(jobSpec.environment).toMatchObject({
			SBX_PORT: '49983',
			SBX_IDLE_TIMEOUT: '3600',
			SBX_SERVER_URL: 'https://huggingface.co/buckets/huggingface/sbx-server/resolve/sbx-server',
			SBX_SERVER_MOUNT: '/.hf-sbx-server',
			MCP_SANDBOX_VOLUMES: JSON.stringify(STORED_VOLUMES),
		});
		expect(jobSpec.environment?.MCP_SANDBOX_NAME).toBeUndefined();
		expect(jobSpec.secrets).toMatchObject({
			SBX_DL_TOKEN: 'hf-token',
			HF_TOKEN: 'hf-token',
		});
		expect(jobSpec.secrets?.SBX_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(jobSpec.volumes).toEqual([
			...STORED_VOLUMES,
			{ type: 'bucket', source: 'huggingface/sbx-server', mountPath: '/.hf-sbx-server', readOnly: true },
		]);
		expect(jobSpec.command[0]).toBe('/bin/sh');
		expect(jobSpec.command[2]).toContain('sbx-server');
	});

	it('waits for sandbox health during create', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		await tool.run({ cmd: 'create', args: ['--name', 'steady-bridge'] });

		expect(rpcClient.health).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://custom--49983.hf.jobs',
				hfToken: 'hf-token',
				sandboxToken: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
			expect.objectContaining({ timeoutSeconds: expect.any(Number) })
		);
	});

	it('emits startup progress while creating a sandbox', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);
		const onProgress = vi.fn();

		await tool.run({ cmd: 'create', args: ['--name', 'steady-bridge'] }, { onProgress });

		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'create',
				message: expect.stringMatching(/resolving namespace/),
			})
		);
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'create',
				message: expect.stringMatching(/\(step 1\)/),
			})
		);
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'create',
				message: expect.stringMatching(/server is ready/),
			})
		);
	});

	it('returns a startup message if create health is not ready within 10 seconds', async () => {
		vi.useFakeTimers();
		try {
			const rpcClient = createRpcClient();
			vi.mocked(rpcClient.health).mockRejectedValue(new Error('Sandbox RPC /health failed with 503'));
			const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

			const pending = tool.run({ cmd: 'create', args: ['--name', 'steady-bridge'] });
			await vi.advanceTimersByTimeAsync(10_000);
			const result = (await pending) as SandboxCreateResult;

			expect(result.handle).toBe(HANDLE);
			expect(result.message).toMatch(/may still be starting/);
			expect(rpcClient.health).toHaveBeenCalledTimes(20);
		} finally {
			vi.useRealTimers();
		}
	});

	it('supports bucket convenience args for read-write mounts', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = (await tool.run({
			cmd: 'create',
			args: [
				'--name',
				'steady-bridge',
				'--bucket',
				'evalstate/sandbox-testing',
				'--bucket-mode',
				'rw',
				'--bucket-mount-path',
				'/data',
			],
		})) as SandboxCreateResult;

		expect(result.volumes).toEqual([
			{ type: 'bucket', source: 'evalstate/sandbox-testing', mountPath: '/data', readOnly: false },
		]);

		const [jobSpec] = vi.mocked(jobsClient.runJob).mock.calls[0] as [JobSpec, string];
		expect(jobSpec.volumes).toEqual([
			{ type: 'bucket', source: 'evalstate/sandbox-testing', mountPath: '/data', readOnly: false },
			{ type: 'bucket', source: 'huggingface/sbx-server', mountPath: '/.hf-sbx-server', readOnly: true },
		]);
	});

	it('rejects unknown create arguments instead of silently ignoring them', async () => {
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), createRpcClient());

		await expect(
			tool.run({ cmd: 'create', args: ['--name', 'steady-bridge', '--unused-bucket-arg', 'x'] })
		).rejects.toThrow(/unexpected argument/);
	});

	it('returns job status plus best-effort sandbox health with a single job fetch', async () => {
		const jobsClient = createJobsClient();
		vi.mocked(jobsClient.getJob).mockResolvedValueOnce(
			createJobInfo({ environment: { MCP_SANDBOX_VOLUMES: JSON.stringify(STORED_VOLUMES) } })
		);
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = await tool.run({ cmd: 'status', args: [HANDLE] });

		expect(result).toMatchObject({
			op: 'status',
			namespace: 'evalstate',
			job_id: '6a2bfe87871c005b5352b2d1',
			status: { stage: 'RUNNING' },
			health: { ok: true },
			volumes: STORED_VOLUMES,
		});
		expect(jobsClient.getJob).toHaveBeenCalledOnce();
		expect(jobsClient.getJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('normalizes official sbx-server health payloads in status', async () => {
		const rpcClient = createRpcClient();
		vi.mocked(rpcClient.health).mockResolvedValueOnce({ status: 'ok', version: '1.2.3' });
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const result = await tool.run({ cmd: 'status', args: [HANDLE] });

		expect(result).toMatchObject({ health: { ok: true, status: 'ok', version: '1.2.3' } });
	});

	it('terminates the backing job', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = await tool.run({ cmd: 'terminate', args: [HANDLE] });

		expect(result).toMatchObject({ op: 'terminate', terminated: true });
		expect(jobsClient.cancelJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('lists and kills background processes', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const psResult = await tool.run({ cmd: 'ps', args: [HANDLE] });
		expect(psResult).toMatchObject({ op: 'ps', processes: [{ id: 'p-1', running: true }] });

		const killResult = await tool.run({ cmd: 'kill', args: [HANDLE, 'p-1'] });
		expect(killResult).toMatchObject({ op: 'kill', process_id: 'p-1', killed: true });
		expect(rpcClient.killProcess).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://custom--49983.hf.jobs' }),
			'p-1'
		);
	});

	it('requires process_id for kill', async () => {
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), createRpcClient());

		await expect(tool.run({ cmd: 'kill', args: [HANDLE] })).rejects.toThrow(/PROCESS_ID/);
	});

	it('does not expose proxy fetch in the first-release sandbox surface', async () => {
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', createJobsClient(), createRpcClient());

		await expect(tool.run({ cmd: 'fetch', args: [HANDLE] } as never)).rejects.toThrow(/Invalid option/);
	});

	it('caches the nonce and expose URL so repeat operations skip the Jobs API', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		await tool.run({ cmd: 'ps', args: [HANDLE] });
		await tool.run({ cmd: 'ps', args: [HANDLE] });

		expect(jobsClient.getJob).toHaveBeenCalledOnce();
	});

	it('rejects jobs without a sandbox nonce label', async () => {
		const jobsClient = createJobsClient();
		vi.mocked(jobsClient.getJob).mockResolvedValueOnce(createJobInfo({ labels: { 'hf-sandbox': '1' } }));
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		await expect(tool.run({ cmd: 'ps', args: [HANDLE] })).rejects.toThrow(/hf-sandbox-nonce/);
	});

	it('requires authentication', async () => {
		const tool = new HfSandboxTool(undefined, false, 'evalstate', createJobsClient(), createRpcClient());

		await expect(tool.run({ cmd: 'create', args: ['--name', 'steady-bridge'] })).rejects.toThrow(
			/require authentication/
		);
	});
});

describe('HfSandboxExecTool', () => {
	it('runs foreground commands via /bin/sh -lc', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxExecTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.run({
			cmd: 'exec',
			args: [HANDLE, 'python -c "print(6 * 7)"', '--env', 'DEBUG=1'],
		});

		expect(result).toMatchObject({ returncode: 0, stdout: '42\n' });
		expect(rpcClient.exec).toHaveBeenCalledWith(
			expect.objectContaining({ hfToken: 'hf-token', sandboxToken: expect.stringMatching(/^[0-9a-f]{64}$/) }),
			expect.objectContaining({
				command: ['/bin/sh', '-lc', 'python -c "print(6 * 7)"'],
				env: { DEBUG: '1' },
				timeout: 30,
			})
		);
		expect(jobsClient.runJob).not.toHaveBeenCalled();
	});

	it('caps foreground command timeouts', async () => {
		const tool = new HfSandboxExecTool('hf-token', true, 'evalstate', createJobsClient(), createRpcClient());

		await expect(tool.run({ cmd: 'exec', args: [HANDLE, 'sleep 120', '--timeout', '56'] })).rejects.toThrow(
			/foreground exec timeout must be <= 55 seconds/
		);
	});

	it('passes foreground progress callbacks to the RPC client', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxExecTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);
		const onProgress = vi.fn();

		await tool.run({ cmd: 'exec', args: [HANDLE, 'echo hi'] }, { onProgress });

		expect(rpcClient.exec).toHaveBeenCalledWith(expect.anything(), expect.anything(), { onProgress });
	});

	it('starts detached processes without a default timeout', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxExecTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const result = await tool.run({
			cmd: 'exec',
			args: [HANDLE, 'python -m http.server 8000', '--detach', '--tag', 'svc'],
		});

		expect(result).toEqual({ detached: true, process_id: 'p-1', pid: 4242, tag: 'svc' });
		const [, args] = vi.mocked(rpcClient.execDetached).mock.calls[0] as [unknown, Record<string, unknown>];
		expect(args.tag).toBe('svc');
		expect(args.timeout).toBeUndefined();
		expect(rpcClient.exec).not.toHaveBeenCalled();
	});
});

describe('HfSandboxFsTool', () => {
	it('lists directories', async () => {
		const tool = new HfSandboxFsTool('hf-token', true, 'evalstate', createJobsClient(), createRpcClient());

		const result = await tool.run({ cmd: 'ls', args: [HANDLE, '/work'] });

		expect(result).toMatchObject({ op: 'ls', path: '/work', entries: [{ name: 'out.txt', type: 'file' }] });
	});

	it('reads files with truncation metadata', async () => {
		const rpcClient = createRpcClient();
		vi.mocked(rpcClient.statPath).mockResolvedValueOnce({
			name: 'big.log',
			path: '/work/big.log',
			type: 'file',
			size: 1000,
			mtime_ms: 1,
			mode: '644',
		});
		vi.mocked(rpcClient.readFile).mockResolvedValueOnce(Buffer.from('x'.repeat(100)));
		const tool = new HfSandboxFsTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const result = await tool.run({ cmd: 'cat', args: [HANDLE, '/work/big.log', '--max-bytes', '100'] });

		expect(result).toMatchObject({ op: 'cat', bytes: 100, size: 1000, truncated: true, next_offset: 100 });
		expect(rpcClient.readFile).toHaveBeenCalledWith(expect.anything(), {
			path: '/work/big.log',
			offset: 0,
			length: 100,
		});
	});

	it('reports missing paths from stat instead of erroring', async () => {
		const rpcClient = createRpcClient();
		vi.mocked(rpcClient.statPath).mockResolvedValueOnce(null);
		const tool = new HfSandboxFsTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const result = await tool.run({ cmd: 'stat', args: [HANDLE, '/nope'] });

		expect(result).toEqual({ op: 'stat', path: '/nope', exists: false });
	});

	it('writes text and base64 content, requiring exactly one', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxFsTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		const result = await tool.run({ cmd: 'write', args: [HANDLE, '/work/msg.txt', '--text', 'tada!'] });
		expect(result).toEqual({ op: 'write', path: '/work/msg.txt', bytes: 5 });

		await expect(tool.run({ cmd: 'write', args: [HANDLE, '/work/msg.txt'] })).rejects.toThrow(
			/exactly one of text or base64/
		);
		await expect(
			tool.run({ cmd: 'write', args: [HANDLE, '/work/msg.txt', '--text', 'a', '--base64', 'YQ=='] })
		).rejects.toThrow(/exactly one of text or base64/);
	});

	it('deletes and creates directories', async () => {
		const rpcClient = createRpcClient();
		const tool = new HfSandboxFsTool('hf-token', true, 'evalstate', createJobsClient(), rpcClient);

		await expect(tool.run({ cmd: 'rm', args: [HANDLE, '/work/tmp', '--recursive'] })).resolves.toEqual({
			op: 'rm',
			path: '/work/tmp',
			deleted: true,
		});
		expect(rpcClient.deletePath).toHaveBeenCalledWith(expect.anything(), { path: '/work/tmp', recursive: true });

		await expect(tool.run({ cmd: 'mkdir', args: [HANDLE, '/work/new'] })).resolves.toEqual({
			op: 'mkdir',
			path: '/work/new',
			created: true,
		});
	});
});

describe('sandbox RPC parsing', () => {
	it('normalizes health responses from embedded and official sandbox servers', () => {
		expect(normalizeSandboxHealth({ ok: true })).toEqual({ ok: true });
		expect(normalizeSandboxHealth({ status: 'ok', uptime: 12 })).toEqual({ ok: true, status: 'ok', uptime: 12 });
		expect(normalizeSandboxHealth({ status: 'starting' })).toEqual({ ok: false, status: 'starting' });
	});

	it('treats signaled exits as completed command results', () => {
		const result = parseSandboxExecEvents(
			[
				JSON.stringify({ event: 'stdout', data: 'before\n' }),
				JSON.stringify({ event: 'exit', exit_code: null, signal: 'SIGTERM', timed_out: false, duration_ms: 15 }),
				'',
			].join('\n')
		);

		expect(result).toEqual({
			returncode: null,
			stdout: 'before\n',
			stderr: '',
			signal: 'SIGTERM',
			timed_out: false,
			duration_ms: 15,
		});
	});

	it('ignores keepalive pings and partially transmitted lines', () => {
		const result = parseSandboxExecEvents(
			[
				JSON.stringify({ event: 'ping' }),
				JSON.stringify({ event: 'stdout', data: 'ok' }),
				JSON.stringify({ event: 'exit', exit_code: 0, signal: null, timed_out: false, duration_ms: 5 }),
				'{"event":"stdo',
			].join('\n')
		);

		expect(result).toMatchObject({ returncode: 0, stdout: 'ok' });
	});

	it('reports connection loss only when no exit event is received', () => {
		expect(() => parseSandboxExecEvents(JSON.stringify({ event: 'stdout', data: 'partial' }))).toThrow(
			'connection lost while running command'
		);
	});
});

describe('sandbox markdown formatting', () => {
	it('renders sandbox lifecycle results as terse markdown instead of JSON fences', () => {
		const createMarkdown = formatSandboxMarkdown({
			op: 'create',
			handle: HANDLE,
			name: 'steady-bridge',
			namespace: 'evalstate',
			job_id: '6a2bfe87871c005b5352b2d1',
			url: 'https://custom--49983.hf.jobs',
			job_url: 'https://huggingface.co/jobs/evalstate/6a2bfe87871c005b5352b2d1',
			volumes: STORED_VOLUMES,
		});
		expect(createMarkdown).toContain('Created sandbox `steady-bridge`.');
		expect(createMarkdown).toContain(`Handle: \`${HANDLE}\``);
		expect(createMarkdown).not.toContain('```json');

		const statusMarkdown = formatSandboxMarkdown({
			op: 'status',
			handle: HANDLE,
			namespace: 'evalstate',
			job_id: '6a2bfe87871c005b5352b2d1',
			url: 'https://custom--49983.hf.jobs',
			job_url: 'https://huggingface.co/jobs/evalstate/6a2bfe87871c005b5352b2d1',
			status: { stage: 'RUNNING' },
			health: { ok: true },
			volumes: [],
		});
		expect(statusMarkdown).toContain('Status: `RUNNING`');
		expect(statusMarkdown).toContain('Health: ok');
		expect(statusMarkdown).not.toContain('```json');

		expect(
			formatSandboxMarkdown({ op: 'terminate', handle: HANDLE, job_url: 'https://hf.co/jobs/x', terminated: true })
		).toBe(`Terminated sandbox \`${HANDLE}\`.\nJob: https://hf.co/jobs/x`);
		expect(formatSandboxMarkdown({ op: 'kill', handle: HANDLE, process_id: 'p-1', killed: true })).toBe(
			`Killed process \`p-1\` in sandbox \`${HANDLE}\`.`
		);
	});

	it('renders exec and filesystem results as terse markdown instead of JSON fences', () => {
		expect(
			formatSandboxExecMarkdown({
				returncode: 0,
				stdout: '42\n',
				stderr: '',
				signal: null,
				timed_out: false,
				duration_ms: 20,
			})
		).toContain('exit 0 in 20ms');

		const statMarkdown = formatSandboxFsMarkdown({
			op: 'stat',
			path: '/work/out.txt',
			exists: true,
			type: 'file',
			size: 5,
			mtime_ms: 1,
			mode: '644',
		});
		expect(statMarkdown).toContain('`/work/out.txt`: file');
		expect(statMarkdown).not.toContain('```json');

		expect(formatSandboxFsMarkdown({ op: 'stat', path: '/missing', exists: false })).toBe('`/missing` does not exist.');
		expect(formatSandboxFsMarkdown({ op: 'write', path: '/work/out.txt', bytes: 5 })).toBe(
			'Wrote 5 bytes to `/work/out.txt`.'
		);
		expect(formatSandboxFsMarkdown({ op: 'rm', path: '/work/out.txt', deleted: true })).toBe(
			'Deleted `/work/out.txt`.'
		);
		expect(formatSandboxFsMarkdown({ op: 'mkdir', path: '/work/new', created: true })).toBe(
			'Created directory `/work/new`.'
		);
	});
});
