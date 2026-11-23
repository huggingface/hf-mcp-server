import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HubModule from '@huggingface/hub';
import { callPtcTool, type PtcTool } from '../core/tool.js';
import { parseRef } from '../core/refs.js';
import { ACCOUNT_TOOLS } from './account.js';
import { z } from 'zod';
import { PtcError } from '../core/errors.js';
import { CONFIG_GUIDANCE } from '../../utilities.js';
import { createHfWhoamiOutput, hfWhoamiAuthenticatedOutputSchema, hfWhoamiResponseSchema } from '../../whoami/index.js';

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

function oauthToken(scopes: string[]): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({ scope: scopes, sub: 'user-id' })).toString('base64url');
	return `hf_oauth_${header}.${payload}.c2lnbmF0dXJlLXZhbHVlLXNlY3JldA`;
}
const OAUTH_TOKEN = oauthToken(['openid', 'profile', 'read-repos']);

const FULL_ORG = {
	id: 'org-id',
	type: 'org',
	name: 'acme',
	fullname: 'Acme',
	email: 'x@y',
	plan: 'enterprise',
	roleInOrg: 'admin',
	securityRestrictions: ['sso'],
	resourceGroups: [{ id: 'rg-id', name: 'Research', role: 'write' }],
};

function whoamiUser(auth: Record<string, unknown>) {
	return {
		id: 'user-id',
		type: 'user',
		name: 'alice',
		fullname: 'Alice',
		email: 'alice@example.com',
		isPro: true,
		orgs: [FULL_ORG],
		auth,
	};
}

/** One fully populated upstream response per credential branch (together they cover every output field). */
const FIXTURES = {
	fineGrained: {
		token: TOKEN,
		body: whoamiUser({
			type: 'access_token',
			accessToken: {
				displayName: 'laptop',
				role: 'fineGrained',
				createdAt: '2026-01-02T03:04:05.000Z',
				fineGrained: {
					global: ['inference.serverless.write'],
					canReadGatedRepos: true,
					scoped: [
						{
							entity: { type: 'org', name: 'acme', _id: 'org-id' },
							permissions: ['repo.write'],
							patterns: [{ resourceType: 'inference-endpoint', wildcardPatterns: ['prod-*'] }],
						},
					],
				},
			},
		}),
	},
	readToken: {
		token: TOKEN,
		body: whoamiUser({
			type: 'access_token',
			accessToken: { displayName: 'ci', role: 'read', createdAt: '2026-01-02T03:04:05.000Z' },
		}),
	},
	oauth: { token: OAUTH_TOKEN, body: whoamiUser({ type: 'oauth', expiresAt: '2026-12-01T00:00:00.000Z' }) },
	app: {
		token: TOKEN,
		body: {
			id: 'app-id',
			type: 'app',
			name: 'my-app',
			scope: { role: 'read', entities: [{ type: 'model', name: 'acme/m' }, 'acme'] },
			auth: { type: 'access_token' },
		},
	},
	other: { token: TOKEN, body: whoamiUser({ type: 'session', expiresAt: '2026-12-01T00:00:00.000Z' }) },
} satisfies Record<string, { body: unknown; token: string }>;

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Leaf paths of a value (array indices dropped), with an optional key rename. */
function leaves(
	value: unknown,
	rename: (key: string, path: string) => string,
	path = '',
	out = new Map<string, unknown[]>()
) {
	if (Array.isArray(value)) value.forEach((item) => leaves(item, rename, `${path}[]`, out));
	else if (typeof value === 'object' && value !== null) {
		for (const [key, child] of Object.entries(value))
			leaves(child, rename, `${path}${path ? '.' : ''}${rename(key, path)}`, out);
	} else out.set(path, [...(out.get(path) ?? []), value]);
	return out;
}

/** Every property path the standard authenticated schema allows (through oneOf branches and items). */
function schemaPaths(schema: unknown, path = '', out = new Set<string>()): Set<string> {
	if (typeof schema !== 'object' || schema === null) return out;
	const node = schema as Record<string, unknown>;
	for (const key of ['oneOf', 'anyOf', 'allOf']) {
		if (Array.isArray(node[key])) for (const branch of node[key] as unknown[]) schemaPaths(branch, path, out);
	}
	if (node.items) {
		const before = out.size;
		schemaPaths(node.items, `${path}[]`, out);
		// An array of scalars: its leaves are the items themselves.
		if (out.size === before) out.add(`${path}[]`);
	}
	const properties = node.properties as Record<string, unknown> | undefined;
	if (properties) {
		for (const [key, child] of Object.entries(properties)) {
			const childPath = `${path}${path ? '.' : ''}${key}`;
			const before = out.size;
			schemaPaths(child, childPath, out);
			if (out.size === before) out.add(childPath);
		}
	}
	return out;
}

const standardToPtcKey = (key: string, path: string) =>
	path === 'credential' && key === 'permissions' ? 'fineGrained' : camel(key);

async function callWhoami(fixture: { body: unknown; token: string }) {
	const fetch = fetchJson(fixture.body);
	const { structured } = await callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: fixture.token });
	const standard = createHfWhoamiOutput(hfWhoamiResponseSchema.parse(fixture.body), fixture.token, 'unused');
	return { fetch, structured, standard };
}

/** Everything a caller (or the model) could see from a thrown error. */
function errorSurface(error: unknown): string {
	const own =
		error instanceof Error
			? Object.getOwnPropertyNames(error).map((key) => (error as unknown as Record<string, unknown>)[key])
			: [];
	return [String(error), JSON.stringify(error), JSON.stringify(own), error instanceof Error ? error.stack : ''].join(
		'\n'
	);
}

function tokenFragments(token: string): string[] {
	// The whole token, and every JWT segment of an OAuth token (scopes are output; the encoded payload is not).
	return [
		token,
		...token
			.replace(/^hf_oauth_/, '')
			.split('.')
			.filter((part) => part.length > 8),
	];
}

describe('hf_whoami', () => {
	it('returns the standard hf_whoami result in camelCase for a fine-grained token', async () => {
		const { fetch, structured } = await callWhoami(FIXTURES.fineGrained);
		expect(new URL(fetch.mock.calls[0]?.[0] as string).pathname).toBe('/api/whoami-v2');
		expect(structured).toEqual({
			signedIn: true,
			account: { id: 'user-id', type: 'user', name: 'alice', url: 'https://huggingface.co/alice', isPro: true },
			organizations: [
				{
					id: 'org-id',
					name: 'acme',
					displayName: 'Acme',
					url: 'https://huggingface.co/acme',
					role: 'admin',
					plan: 'enterprise',
					securityRestrictions: ['sso'],
					resourceGroups: [{ id: 'rg-id', name: 'Research', role: 'write' }],
				},
			],
			credential: {
				type: 'personal_access_token',
				role: 'fine_grained',
				createdAt: '2026-01-02T03:04:05.000Z',
				fineGrained: {
					scoped: [
						{
							entity: { id: 'org-id', type: 'org', name: 'acme' },
							permissions: ['repo.write'],
							restrictions: [{ resourceType: 'inference_endpoint', patterns: ['prod-*'] }],
						},
					],
					global: ['inference.serverless.write'],
					canReadGatedRepos: true,
				},
			},
		});
		const text = JSON.stringify(structured);
		expect(text).not.toContain('example.com');
		expect(text).not.toContain('laptop');
	});

	it('reports OAuth scopes and expiry from the session token (never an empty credential)', async () => {
		const { structured } = await callWhoami(FIXTURES.oauth);
		expect(structured.credential).toEqual({
			type: 'oauth',
			expiresAt: '2026-12-01T00:00:00.000Z',
			scopes: ['openid', 'profile', 'read-repos'],
		});
	});

	it('reports app tokens with their scoped entities', async () => {
		const { structured } = await callWhoami(FIXTURES.app);
		expect(structured).toEqual({
			signedIn: true,
			account: { id: 'app-id', type: 'app', name: 'my-app' },
			organizations: [],
			credential: { type: 'app_token', role: 'read', entities: [{ type: 'model', name: 'acme/m' }, { name: 'acme' }] },
		});
	});

	it.each(Object.entries(FIXTURES))(
		'maps every standard field of the %s fixture, dropping nothing',
		async (_name, fixture) => {
			const { structured, standard } = await callWhoami(fixture);
			expect(structured.signedIn).toBe(true);
			expect(standard.status).toBe('authenticated');
			// status (always 'authenticated') becomes signedIn; every other field maps one to one.
			const ptcLeaves = leaves(structured, (key) => key);
			const standardLeaves = leaves(standard, standardToPtcKey);
			ptcLeaves.delete('signedIn');
			standardLeaves.delete('status');
			expect(Object.fromEntries(ptcLeaves)).toEqual(Object.fromEntries(standardLeaves));
		}
	);

	it('fixtures together populate every field of the standard authenticated schema', async () => {
		const seen = new Set<string>();
		for (const fixture of Object.values(FIXTURES)) {
			const { standard } = await callWhoami(fixture);
			for (const path of leaves(standard, (key) => key).keys()) seen.add(path);
		}
		const all = schemaPaths(z.toJSONSchema(hfWhoamiAuthenticatedOutputSchema, { io: 'output' }));
		expect([...all].filter((path) => !seen.has(path))).toEqual([]);
	});

	it('rejects a malformed upstream response', async () => {
		const fetch = fetchJson({ name: 'alice' });
		await expect(callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: TOKEN })).rejects.toMatchObject({
			code: 'UPSTREAM_RESPONSE',
		});
	});

	it('reports signed out, without calling the Hub, when there is no token', async () => {
		const fetch = fetchJson({});
		const { structured } = await callPtcTool(tool('hf_whoami'), {}, { fetch });
		expect(fetch).not.toHaveBeenCalled();
		expect(structured).toEqual({
			signedIn: false,
			account: null,
			organizations: [],
			credential: null,
			guidance: CONFIG_GUIDANCE,
		});
	});

	it('reports signed out with fixed guidance when the Hub rejects the token (401)', async () => {
		const fetch = fetchJson({ error: 'Invalid credentials in Authorization header' }, 401);
		const { structured } = await callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: TOKEN });
		expect(structured).toEqual({
			signedIn: false,
			account: null,
			organizations: [],
			credential: null,
			guidance: expect.stringMatching(/^The supplied Hugging Face token was rejected/) as unknown,
		});
	});

	it.each([
		['403', 403, 'FORBIDDEN'],
		['500', 500, 'UPSTREAM_HTTP'],
		['503', 503, 'UPSTREAM_HTTP'],
	])('keeps a typed error, not signed out, for %s', async (_name, status, code) => {
		await expect(
			callPtcTool(tool('hf_whoami'), {}, { fetch: fetchJson({}, status), hfToken: TOKEN })
		).rejects.toMatchObject({ code });
	});

	it('keeps a retryable typed error, not signed out, when the Hub is unreachable', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));
		await expect(callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: TOKEN })).rejects.toMatchObject({
			code: 'UPSTREAM_UNAVAILABLE',
			retryable: true,
		});
	});

	it('rejects signed-in and signed-out fields mixed in one record', () => {
		const output = tool('hf_whoami').output;
		expect(output.safeParse({ signedIn: true, account: null, organizations: [], credential: null }).success).toBe(
			false
		);
		expect(output.safeParse({ signedIn: false, account: null, organizations: [], credential: null }).success).toBe(
			false
		);
	});

	describe('never exposes the token', () => {
		const tokens = { pat: 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', oauth: OAUTH_TOKEN };
		/** Upstream that echoes the token everywhere it can: body, headers, error text. */
		const echoing = (token: string, status: number) =>
			vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify({ error: `bad token ${token}`, token }), {
						status,
						headers: { 'content-type': 'application/json', 'x-error-message': `Invalid token ${token}` },
					})
				)
			);
		const failures: Record<string, (token: string) => typeof globalThis.fetch> = {
			'malformed upstream': (token) => fetchJson({ name: token, auth: { accessToken: token } }),
			'non-JSON upstream': (token) =>
				vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`<html>${token}</html>`, { status: 200 })),
			'403': (token) => echoing(token, 403),
			'500': (token) => echoing(token, 500),
			'503': (token) => echoing(token, 503),
			'network failure': (token) =>
				vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError(`fetch failed for Bearer ${token}`)),
		};

		for (const [kind, token] of Object.entries(tokens)) {
			it(`keeps the ${kind} token out of a successful result`, async () => {
				const body = kind === 'oauth' ? FIXTURES.oauth.body : FIXTURES.fineGrained.body;
				const fetch = fetchJson(body);
				const result = await callPtcTool(tool('hf_whoami'), {}, { fetch, hfToken: token });
				const text = JSON.stringify(result);
				for (const fragment of tokenFragments(token)) expect(text).not.toContain(fragment);
				// The token is only sent upstream as the bearer credential.
				const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
				expect(headers.get('authorization')).toBe(`Bearer ${token}`);
			});

			it(`keeps the ${kind} token out of the signed-out result for a 401`, async () => {
				const result = await callPtcTool(tool('hf_whoami'), {}, { fetch: echoing(token, 401), hfToken: token });
				expect(result.structured.signedIn).toBe(false);
				const text = JSON.stringify(result);
				for (const fragment of tokenFragments(token)) expect(text).not.toContain(fragment);
			});

			for (const [failure, makeFetch] of Object.entries(failures)) {
				it(`keeps the ${kind} token out of the error for ${failure}`, async () => {
					let caught: unknown;
					try {
						await callPtcTool(tool('hf_whoami'), {}, { fetch: makeFetch(token), hfToken: token });
					} catch (error) {
						caught = error;
					}
					expect(caught).toBeInstanceOf(PtcError);
					const surface = errorSurface(caught);
					for (const fragment of tokenFragments(token)) expect(surface).not.toContain(fragment);
				});
			}
		}
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
	it.each([
		['dataset_id', 'dataset'],
		['datasetId', 'dataset'],
		['DATASET-ID', 'dataset'],
		['spaceId', 'space'],
		['SPACE_ID', 'space'],
	])('commits to the %s repository, not the same-named model', async (alias, kind) => {
		hub.commit.mockResolvedValue({ commit: { oid: 'abc', url: 'u' }, hookOutput: '' });
		await callPtcTool(
			tool('hf_repo_write_files'),
			{ [alias]: 'alice/shared', message: 'Remove', changes: [{ op: 'delete', path: 'old.txt' }] },
			{ hfToken: TOKEN }
		);
		expect(hub.commit).toHaveBeenCalledTimes(1);
		expect(hub.commit).toHaveBeenCalledWith(expect.objectContaining({ repo: { type: kind, name: 'alice/shared' } }));
	});

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
		expect(tool('hf_whoami').access).toBe('anonymous');
		for (const t of ACCOUNT_TOOLS) {
			expect(t.description.length).toBeGreaterThanOrEqual(250);
			expect(t.description.length).toBeLessThanOrEqual(700);
		}
	});
});
