import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HubModule from '@huggingface/hub';
import { callPtcTool, type PtcTool } from '../core/tool.js';
import { parseRef } from '../core/refs.js';
import { ACCOUNT_TOOLS } from './account.js';

const hub = vi.hoisted(() => ({ commit: vi.fn(), downloadFile: vi.fn() }));
const createMock = vi.hoisted(() => vi.fn());
const createCtor = vi.hoisted(() => vi.fn());

vi.mock('@huggingface/hub', async (importOriginal) => ({
	...(await importOriginal<typeof HubModule>()),
	commit: hub.commit,
	downloadFile: hub.downloadFile,
}));
vi.mock('../../create-repo.js', () => ({
	CreateRepoTool: class {
		constructor(...args: unknown[]) {
			createCtor(...args);
		}
		create = createMock;
	},
}));

function tool(name: string): PtcTool {
	const found = ACCOUNT_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}
function fetchJson(body: unknown, status = 200) {
	return vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(Response.json(body, { status })));
}
const TOKEN = 'hf_secretvalue';

afterEach(() => {
	vi.clearAllMocks();
});

describe('hf_whoami', () => {
	it('returns an allowlisted account summary without token values', async () => {
		const fetch = fetchJson({
			type: 'user',
			name: 'alice',
			fullname: 'Alice',
			email: 'alice@example.com',
			isPro: true,
			orgs: [{ name: 'acme', fullname: 'Acme', roleInOrg: 'admin', isEnterprise: true, email: 'x@y' }],
			auth: {
				type: 'access_token',
				accessToken: {
					displayName: 'laptop',
					role: 'fineGrained',
					fineGrained: {
						global: ['inference.serverless.write'],
						scoped: [{ entity: { type: 'org', name: 'acme', _id: '1' }, permissions: ['repo.write'] }],
					},
				},
			},
		});
		const { structured } = await callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: TOKEN });
		expect(new URL(fetch.mock.calls[0]?.[0] as string).pathname).toBe('/api/whoami-v2');
		expect(structured).toEqual({
			kind: 'user',
			id: 'alice',
			uri: 'https://huggingface.co/alice',
			url: 'https://huggingface.co/alice',
			fullname: 'Alice',
			isPro: true,
			orgs: [
				{
					kind: 'org',
					id: 'acme',
					uri: 'https://huggingface.co/acme',
					url: 'https://huggingface.co/acme',
					fullname: 'Acme',
					role: 'admin',
					plan: 'enterprise',
				},
			],
			token: {
				role: 'fineGrained',
				fineGrained: {
					global: ['inference.serverless.write'],
					scoped: [{ entityType: 'org', entityName: 'acme', permissions: ['repo.write'] }],
					scopedTruncated: false,
				},
			},
		});
		expect(JSON.stringify(structured)).not.toContain('example.com');
	});

	it('requires a token', async () => {
		await expect(callPtcTool(tool('hf_whoami'), {}, {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
	});
});

describe('hf_repo_create', () => {
	it('creates a Space with sdk and flavor through CreateRepoTool', async () => {
		createMock.mockResolvedValue({
			action: 'created',
			uri: 'hf://spaces/alice/app',
			url: 'https://huggingface.co/spaces/alice/app',
			repo: 'alice/app',
			repo_type: 'space',
			sdk: 'gradio',
			hardware: { requested: 'zero-a10g', confirmed: true, stage: 'BUILDING' },
		});
		const controller = new AbortController();
		const { structured } = await callPtcTool(
			tool('hf_repo_create'),
			{ repo: 'hf://spaces/alice/app', sdk: 'gradio', flavor: 'zero-a10g', private: true },
			{ hfToken: TOKEN, signal: controller.signal }
		);
		// The request signal reaches the create client (create and duplicate follow cancellation).
		expect(createCtor).toHaveBeenCalledWith(TOKEN, undefined, controller.signal);
		expect(createMock).toHaveBeenCalledWith({
			uri: 'hf://spaces/alice/app',
			private: true,
			sdk: 'gradio',
			hardware: 'zero-a10g',
		});
		expect(structured).toMatchObject({
			action: 'created',
			repo: { kind: 'space', id: 'alice/app', uri: 'hf://spaces/alice/app' },
			runtime: { stage: 'BUILDING', hardware: { requested: 'zero-a10g' }, confirmed: true },
		});
	});

	it('duplicates with source and polls copy status once', async () => {
		createMock.mockResolvedValue({
			action: 'duplicated',
			uri: 'hf://spaces/alice/copy',
			url: 'https://huggingface.co/spaces/alice/copy',
			repo: 'alice/copy',
			repo_type: 'space',
		});
		const fetch = fetchJson({ pending: true, filesTotal: 10, filesCopied: 3 });
		const { structured } = await callPtcTool(
			tool('hf_repo_create'),
			{ repo: 'alice/copy', source: 'hf://spaces/acme/app' },
			{ hfToken: TOKEN, fetch }
		);
		expect(createMock).toHaveBeenCalledWith({ uri: 'hf://spaces/alice/copy', source_uri: 'hf://spaces/acme/app' });
		expect(new URL(fetch.mock.calls[0]?.[0] as string).pathname).toBe('/api/spaces/alice/copy/duplicate/status');
		expect(structured).toMatchObject({
			action: 'duplicated',
			source: { id: 'acme/app', kind: 'space' },
			copyStatus: { pending: true, numFiles: 10, filesCopied: 3 },
		});
	});

	it('accepts the pre-rename argument names uri and hardware', async () => {
		createMock.mockResolvedValue({ action: 'created', uri: 'hf://spaces/alice/app', repo: 'alice/app' });
		await callPtcTool(
			tool('hf_repo_create'),
			{ uri: 'hf://spaces/alice/app', hardware: 't4-small' },
			{ hfToken: TOKEN }
		);
		expect(createMock).toHaveBeenCalledWith({ uri: 'hf://spaces/alice/app', hardware: 't4-small' });
	});

	it('rejects flavor for non-Spaces and mismatched duplicate kinds', async () => {
		await expect(
			callPtcTool(tool('hf_repo_create'), { repo: 'hf://models/alice/m', flavor: 't4-small' }, { hfToken: TOKEN })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(
			callPtcTool(
				tool('hf_repo_create'),
				{ repo: 'hf://datasets/alice/d', source: 'hf://models/acme/m' },
				{ hfToken: TOKEN }
			)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		expect(createMock).not.toHaveBeenCalled();
	});
});

describe('hf_repo_write_files', () => {
	it('commits put, delete and move in one commit', async () => {
		const source = new Blob(['old']);
		hub.downloadFile.mockResolvedValue(source);
		hub.commit.mockResolvedValue({
			commit: { oid: 'abc', url: 'https://huggingface.co/alice/m/commit/abc' },
			pullRequestUrl: 'https://huggingface.co/alice/m/discussions/1',
			hookOutput: '',
		});
		const { structured } = await callPtcTool(
			tool('hf_repo_write_files'),
			{
				repo: 'hf://models/alice/m',
				message: 'Update',
				createPr: true,
				changes: [
					{ op: 'put', path: 'README.md', text: 'hi' },
					{ op: 'put', path: 'bin.dat', base64: 'AAEC' },
					{ op: 'delete', path: 'old.txt' },
					{ op: 'move', from: 'a.txt', to: 'b/a.txt' },
				],
			},
			{ hfToken: TOKEN }
		);
		expect(hub.commit).toHaveBeenCalledTimes(1);
		const params = hub.commit.mock.calls[0]?.[0] as {
			repo: unknown;
			isPullRequest?: boolean;
			operations: Array<{ operation: string; path: string; content?: Blob }>;
		};
		expect(params.repo).toEqual({ type: 'model', name: 'alice/m' });
		expect(params.isPullRequest).toBe(true);
		expect(params.operations.map((op) => `${op.operation}:${op.path}`)).toEqual([
			'addOrUpdate:README.md',
			'addOrUpdate:bin.dat',
			'delete:old.txt',
			'addOrUpdate:b/a.txt',
			'delete:a.txt',
		]);
		expect(params.operations[3]?.content).toBe(source);
		expect(structured).toMatchObject({
			repo: { uri: 'hf://models/alice/m' },
			commit: { oid: 'abc' },
			pullRequestUrl: 'https://huggingface.co/alice/m/discussions/1',
			changes: [
				{
					op: 'put',
					path: 'README.md',
					bytes: 2,
					file: {
						uri: 'hf://models/alice/m@refs%2Fpr%2F1/README.md',
						url: 'https://huggingface.co/alice/m/blob/refs%2Fpr%2F1/README.md',
					},
				},
				{ op: 'put', path: 'bin.dat', bytes: 3 },
				{ op: 'delete', path: 'old.txt' },
				{
					op: 'move',
					path: 'b/a.txt',
					from: 'a.txt',
					bytes: 3,
					file: { uri: 'hf://models/alice/m@refs%2Fpr%2F1/b/a.txt' },
				},
			],
		});
	});

	it('PR file references round-trip to the PR ref (A6 regression)', async () => {
		hub.commit.mockResolvedValue({
			commit: { oid: 'abc', url: 'https://huggingface.co/alice/m/commit/abc' },
			pullRequestUrl: 'https://huggingface.co/alice/m/discussions/7',
			hookOutput: '',
		});
		const { structured } = await callPtcTool(
			tool('hf_repo_write_files'),
			{ repo: 'alice/m', message: 'm', createPr: true, changes: [{ op: 'put', path: 'x.txt', text: 'x' }] },
			{ hfToken: TOKEN }
		);
		const uri = (structured as { changes: Array<{ file: { uri: string } }> }).changes[0]?.file.uri ?? '';
		expect(parseRef(uri)).toMatchObject({ kind: 'model', id: 'alice/m', revision: 'refs/pr/7', path: 'x.txt' });
	});

	it('PR file references fall back to the commit oid without a PR url', async () => {
		const oid = 'a'.repeat(40);
		hub.commit.mockResolvedValue({
			commit: { oid, url: `https://huggingface.co/alice/m/commit/${oid}` },
			hookOutput: '',
		});
		const { structured } = await callPtcTool(
			tool('hf_repo_write_files'),
			{ repo: 'alice/m', message: 'm', createPr: true, changes: [{ op: 'put', path: 'x.txt', text: 'x' }] },
			{ hfToken: TOKEN }
		);
		expect(structured).toMatchObject({ changes: [{ file: { uri: `hf://models/alice/m@${oid}/x.txt` } }] });
	});

	it('branch writes reference the branch, and pass the caller signal to commit and downloads', async () => {
		hub.downloadFile.mockResolvedValue(new Blob(['old']));
		hub.commit.mockResolvedValue({ commit: { oid: 'abc', url: 'u' }, hookOutput: '' });
		const controller = new AbortController();
		const { structured } = await callPtcTool(
			tool('hf_repo_write_files'),
			{
				repo: 'hf://datasets/alice/d@dev',
				message: 'm',
				changes: [
					{ op: 'put', path: 'x.txt', text: 'x' },
					{ op: 'move', from: 'a', to: 'b' },
				],
			},
			{ hfToken: TOKEN, signal: controller.signal }
		);
		expect(structured).toMatchObject({
			revision: 'dev',
			changes: [{ file: { uri: 'hf://datasets/alice/d@dev/x.txt' } }, { file: { uri: 'hf://datasets/alice/d@dev/b' } }],
		});
		expect((hub.commit.mock.calls[0]?.[0] as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);
		const download = hub.downloadFile.mock.calls[0]?.[0] as { revision?: string; fetch?: typeof fetch };
		expect(download.revision).toBe('dev');
		const seen: Array<AbortSignal | null | undefined> = [];
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
			seen.push(init?.signal);
			return Promise.resolve(new Response('ok'));
		});
		try {
			await download.fetch?.('https://huggingface.co/x');
			controller.abort();
			expect(seen[0]?.aborted).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it('supports bucket puts without commit output', async () => {
		hub.commit.mockResolvedValue(undefined);
		const { structured } = await callPtcTool(
			tool('hf_repo_write_files'),
			{ repo: 'hf://buckets/alice/b', message: 'Add', changes: [{ op: 'put', path: 'x.txt', text: 'x' }] },
			{ hfToken: TOKEN }
		);
		expect((hub.commit.mock.calls[0]?.[0] as { repo: unknown }).repo).toEqual({ type: 'bucket', name: 'alice/b' });
		expect(structured).toMatchObject({ repo: { kind: 'bucket' }, changes: [{ op: 'put', path: 'x.txt' }] });
		expect(structured.commit).toBeUndefined();
	});

	it('bucket moves upload first and never delete a source whose copy failed', async () => {
		hub.downloadFile.mockResolvedValue(new Blob(['abc']));
		hub.commit.mockRejectedValueOnce(new Error('Failed to upload 1 file(s): b.txt'));
		const error = await callPtcTool(
			tool('hf_repo_write_files'),
			{
				repo: 'hf://buckets/alice/b',
				message: 'mv',
				changes: [
					{ op: 'move', from: 'a.txt', to: 'b.txt' },
					{ op: 'delete', path: 'old.txt' },
				],
			},
			{ hfToken: TOKEN }
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'UPSTREAM_RESPONSE' });
		expect(String((error as Error).message)).toContain('nothing was deleted');
		expect(hub.commit).toHaveBeenCalledTimes(1);
		const ops = (hub.commit.mock.calls[0]?.[0] as { operations: Array<{ operation: string; path: string }> })
			.operations;
		expect(ops.map((op) => `${op.operation} ${op.path}`)).toEqual(['addOrUpdate b.txt']);
	});

	it('bucket moves delete the source only after the upload succeeded', async () => {
		hub.downloadFile.mockResolvedValue(new Blob(['abc']));
		hub.commit.mockResolvedValue(undefined);
		await callPtcTool(
			tool('hf_repo_write_files'),
			{ repo: 'hf://buckets/alice/b', message: 'mv', changes: [{ op: 'move', from: 'a.txt', to: 'b.txt' }] },
			{ hfToken: TOKEN }
		);
		const phases = hub.commit.mock.calls.map((call) =>
			(call[0] as { operations: Array<{ operation: string; path: string }> }).operations.map(
				(op) => `${op.operation} ${op.path}`
			)
		);
		expect(phases).toEqual([['addOrUpdate b.txt'], ['delete a.txt']]);
	});

	it('rejects invalid changes before committing', async () => {
		const call = (input: Record<string, unknown>) =>
			callPtcTool(tool('hf_repo_write_files'), { repo: 'alice/m', message: 'm', ...input }, { hfToken: TOKEN });
		await expect(call({ changes: [{ op: 'put', path: '../x', text: 'a' }] })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(call({ changes: [{ op: 'put', path: 'x', text: 'a', base64: 'YQ==' }] })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(
			call({
				changes: [
					{ op: 'put', path: 'x', text: 'a' },
					{ op: 'delete', path: 'x' },
				],
			})
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		await expect(
			callPtcTool(
				tool('hf_repo_write_files'),
				{ ref: 'hf://buckets/a/b', message: 'm', create_pr: true, changes: [{ op: 'delete', path: 'x' }] },
				{ hfToken: TOKEN }
			)
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		expect(hub.commit).not.toHaveBeenCalled();
	});

	it('maps Hub errors to sanitized codes', async () => {
		hub.commit.mockRejectedValue(Object.assign(new Error('Forbidden: token hf_secretvalue'), { statusCode: 403 }));
		const error = await callPtcTool(
			tool('hf_repo_write_files'),
			{ repo: 'alice/m', message: 'm', changes: [{ op: 'delete', path: 'x' }] },
			{ hfToken: TOKEN }
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'FORBIDDEN' });
		expect(String((error as Error).message)).not.toContain(TOKEN);
	});

	it('declares write access and destructive annotations', () => {
		expect(tool('hf_repo_write_files').access).toBe('write');
		expect(tool('hf_repo_write_files').annotations.destructiveHint).toBe(true);
		expect(tool('hf_repo_create').annotations.destructiveHint).toBe(false);
		expect(tool('hf_whoami').access).toBe('authenticated');
		for (const t of ACCOUNT_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});
});
