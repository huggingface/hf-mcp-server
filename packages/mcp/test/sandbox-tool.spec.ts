import { describe, expect, it, vi } from 'vitest';
import {
	HF_SANDBOX_TOOL_CONFIG,
	HF_SANDBOX_EXEC_TOOL_CONFIG,
	HfSandboxExecTool,
	HfSandboxTool,
	formatSandboxHandle,
	normalizeSandboxHealth,
	parseSandboxExecEvents,
	parseSandboxHandle,
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

function parseToolJson(text: string): unknown {
	const match = text.match(/^```json\n([\s\S]*)\n```$/);
	if (!match?.[1]) {
		throw new Error(`Expected JSON code block, got: ${text}`);
	}
	return JSON.parse(match[1]) as unknown;
}

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
		exec: vi.fn(async () => ({ returncode: 0, stdout: '42\n', stderr: '' })),
		write: vi.fn(async () => ({ path: '/sandbox/message.txt', bytes: 17 })),
		read: vi.fn(async () => ({
			path: '/sandbox/message.txt',
			content: 'tada! sandbox tool',
			encoding: 'utf-8',
			bytes: 18,
		})),
	};
}

describe('HfSandboxTool', () => {
	it('exposes the expected tool name', () => {
		expect(HF_SANDBOX_TOOL_CONFIG.name).toBe('hf_sandbox');
		expect(HF_SANDBOX_EXEC_TOOL_CONFIG.name).toBe('hf_sandbox_exec');
	});

	it('parses and formats portable handles', () => {
		const parsed = parseSandboxHandle(HANDLE);
		expect(parsed).toEqual({
			namespace: 'evalstate',
			jobId: '6a2bfe87871c005b5352b2d1',
		});
		expect(formatSandboxHandle(parsed)).toBe(HANDLE);
	});

	it('rejects old token-bearing handles', () => {
		expect(() => parseSandboxHandle('hfsb1:evalstate:job123:secret')).toThrow(/hfsb2/);
	});

	it('creates a Jobs-backed sandbox with official sbx-server bootstrap', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.execute({
			operation: 'create',
			args: {
				name: 'steady-bridge',
				forward_hf_token: true,
				volumes: ['hf://datasets/org/ds:/data:ro', 'hf://buckets/org/b:/output'],
			},
		});

		expect(result.isError).toBeUndefined();
		const payload = parseToolJson(result.formatted) as {
			handle: string;
			url: string;
			job_url: string;
			volumes: unknown[];
		};
		expect(payload.handle).toBe(HANDLE);
		expect(payload.url).toBe('https://custom--49983.hf.jobs');
		expect(payload.job_url).toBe('https://huggingface.co/jobs/evalstate/6a2bfe87871c005b5352b2d1');
		expect(payload.volumes).toEqual(STORED_VOLUMES);

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
			MCP_SANDBOX_NAME: 'steady-bridge',
			MCP_SANDBOX_VOLUMES: JSON.stringify(STORED_VOLUMES),
		});
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

	it('supports bucket convenience args for read-write mounts', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = await tool.execute({
			operation: 'create',
			args: {
				name: 'steady-bridge',
				bucket: 'evalstate/sandbox-testing',
				bucket_mode: 'rw',
				bucket_mount_path: '/data',
			},
		});

		expect(result.isError).toBeUndefined();
		const payload = parseToolJson(result.formatted) as { volumes: unknown[] };
		expect(payload.volumes).toEqual([
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

		const result = await tool.execute({
			operation: 'create',
			args: {
				name: 'steady-bridge',
				unused_bucket_arg: 'evalstate/sandbox-testing',
			},
		});

		expect(result.isError).toBe(true);
		expect(result.formatted).toContain('Unrecognized key');
		expect(result.formatted).toContain('unused_bucket_arg');
	});

	it('delegates shell exec to the sandbox RPC client', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxExecTool('hf-token', true, rpcClient, jobsClient);

		const execResult = await tool.execute({ handle: HANDLE, cmd: 'python -c "print(6 * 7)" | cat' });
		expect(parseToolJson(execResult.formatted)).toEqual({ returncode: 0, stdout: '42\n', stderr: '' });

		expect(rpcClient.exec).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: '6a2bfe87871c005b5352b2d1' }),
			expect.objectContaining({ hfToken: 'hf-token', sandboxToken: expect.stringMatching(/^[0-9a-f]{64}$/) }),
			expect.objectContaining({ command: ['/bin/sh', '-lc', 'python -c "print(6 * 7)" | cat'] })
		);
		expect(jobsClient.runJob).not.toHaveBeenCalled();
	});

	it('delegates write and read to the sandbox RPC client', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		await tool.execute({
			operation: 'write',
			args: { handle: HANDLE, path: 'message.txt', content: 'tada! sandbox tool' },
		});
		await tool.execute({
			operation: 'read',
			args: { handle: HANDLE, path: 'message.txt' },
		});

		expect(rpcClient.write).toHaveBeenCalledOnce();
		expect(rpcClient.read).toHaveBeenCalledOnce();
	});

	it('returns job status plus best-effort sandbox health', async () => {
		const jobsClient = createJobsClient();
		vi.mocked(jobsClient.getJob).mockResolvedValueOnce(
			createJobInfo({
				environment: {
					MCP_SANDBOX_VOLUMES: JSON.stringify(STORED_VOLUMES),
				},
			})
		);
		const rpcClient = createRpcClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.execute({ operation: 'status', args: { handle: HANDLE } });

		expect(parseToolJson(result.formatted)).toMatchObject({
			namespace: 'evalstate',
			job_id: '6a2bfe87871c005b5352b2d1',
			status: { stage: 'RUNNING' },
			health: { ok: true },
			volumes: STORED_VOLUMES,
		});
		expect(jobsClient.getJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('normalizes official sbx-server health payloads in status', async () => {
		const jobsClient = createJobsClient();
		const rpcClient = createRpcClient();
		vi.mocked(rpcClient.health).mockResolvedValueOnce({ status: 'ok', version: '1.2.3' });
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, rpcClient);

		const result = await tool.execute({ operation: 'status', args: { handle: HANDLE } });

		expect(parseToolJson(result.formatted)).toMatchObject({
			health: { ok: true, status: 'ok', version: '1.2.3' },
		});
	});

	it('terminates the backing job', async () => {
		const jobsClient = createJobsClient();
		const tool = new HfSandboxTool('hf-token', true, 'evalstate', jobsClient, createRpcClient());

		const result = await tool.execute({ operation: 'terminate', args: { handle: HANDLE } });

		expect(parseToolJson(result.formatted)).toMatchObject({ terminated: true });
		expect(jobsClient.cancelJob).toHaveBeenCalledWith('6a2bfe87871c005b5352b2d1', 'evalstate');
	});

	it('requires authentication', async () => {
		const tool = new HfSandboxTool(undefined, false, 'evalstate', createJobsClient(), createRpcClient());

		const result = await tool.execute({ operation: 'create', args: { name: 'steady-bridge' } });

		expect(result.isError).toBe(true);
		expect(result.formatted).toContain('require authentication');
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

	it('reports connection loss only when no exit event is received', () => {
		expect(() => parseSandboxExecEvents(JSON.stringify({ event: 'stdout', data: 'partial' }))).toThrow(
			'connection lost while running command'
		);
	});
});
