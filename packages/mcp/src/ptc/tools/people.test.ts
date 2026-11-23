import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { changedFilesFromDiff, PEOPLE_TOOLS } from './people.js';
import { resetPersonCaseCache } from '../core/person.js';

function tool(name: string) {
	const found = PEOPLE_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(name);
	return found;
}

interface Route {
	status?: number;
	body?: unknown;
	text?: string;
	headers?: Record<string, string>;
}
function mockCtx(routes: Record<string, Route | ((url: URL) => Route)>, extra: Partial<PtcContext> = {}) {
	const urls: URL[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>((input) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		urls.push(url);
		const entry = routes[url.pathname];
		if (!entry) return Promise.resolve(new Response('missing', { status: 404 }));
		const route = typeof entry === 'function' ? entry(url) : entry;
		const body = route.text ?? JSON.stringify(route.body);
		return Promise.resolve(new Response(body, { status: route.status ?? 200, headers: route.headers }));
	});
	const ctx: PtcContext = { fetch, ...extra };
	return { ctx, urls };
}

// Redacted wire fixtures (shapes captured from live anonymous calls, 2026-11-16).
const userOverview = {
	_id: 'x',
	avatarUrl: '/avatars/abc.svg',
	isPro: true,
	fullname: 'Julien Chaumond',
	numModels: 53,
	numDatasets: 26,
	numSpaces: 49,
	numBuckets: 10,
	numDiscussions: 1888,
	numPapers: 8,
	numUpvotes: 1082,
	numLikes: 2086,
	numFollowers: 5325,
	numFollowing: 600,
	numFollowingOrgs: 338,
	orgs: [
		{ id: 'y', name: 'huggingface', fullname: 'Hugging Face', avatarUrl: 'https://cdn-avatars.huggingface.co/a.png' },
	],
	user: 'julien-c',
	type: 'user',
	details: '<3 ML/AI for everyone',
	createdAt: '2019-11-23T17:38:57.000Z',
	email: 'secret@example.com',
};
const orgOverview = {
	_id: 'z',
	avatarUrl: 'https://cdn-avatars.huggingface.co/hf.png',
	fullname: 'Hugging Face',
	name: 'huggingface',
	details: 'The AI community building the future.',
	isVerified: true,
	plan: 'team',
	numUsers: 187,
	numModels: 18,
	numSpaces: 49,
	numDatasets: 50,
	numFollowers: 110483,
};
const member = (user: string) => ({
	avatarUrl: '/avatars/x.svg',
	fullname: user.toUpperCase(),
	isPro: false,
	user,
	type: 'user',
	_id: 'id',
	email: `${user}@example.com`,
});
const orgRow = (name: string) => ({ name, fullname: name, orgType: 'company', emailDomains: ['x.com'], type: 'org' });
const likeRow = (name: string, type: string, createdAt = '2026-11-16T16:49:41.000Z') => ({
	createdAt,
	repo: { name, type },
});
const discussionRow = (num: number, extra: Record<string, unknown> = {}) => ({
	num,
	author: { _id: 'a', name: 'victim3432', fullname: 'x', type: 'user' },
	repo: { name: 'openai-community/gpt2', type: 'model' },
	title: `pr${String(num)}`,
	status: 'closed',
	createdAt: `2026-11-0${String(num % 9)}T00:58:59.000Z`,
	isPullRequest: true,
	numComments: 1,
	pinned: false,
	...extra,
});

describe('people tools', () => {
	it('exports eight read-only anonymous tools with bounded descriptions', () => {
		expect(PEOPLE_TOOLS.map((t) => t.name)).toEqual([
			'hf_profile_get',
			'hf_org_members',
			'hf_follow_graph',
			'hf_user_likes',
			'hf_repo_likers',
			'hf_activity',
			'hf_discussions_list',
			'hf_discussion_get',
		]);
		for (const t of PEOPLE_TOOLS) {
			expect(t.family).toBe('people');
			expect(t.access).toBe('anonymous');
			expect(t.annotations.readOnlyHint).toBe(true);
			expect(t.description.length, t.name).toBeGreaterThanOrEqual(250);
			expect(t.description.length, t.name).toBeLessThanOrEqual(700);
		}
	});

	describe('hf_profile_get', () => {
		it('detects users vs orgs, adds socials, reports per-handle errors and never returns emails', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/julien-c/overview': { body: userOverview },
				'/api/users/julien-c/socials': {
					body: {
						user: 'julien-c',
						socialHandles: { twitter: 'julien_c', github: 'julien-c', linkedin: 'julienchaumond' },
					},
				},
				'/api/organizations/huggingface/overview': { body: orgOverview },
				'/api/organizations/huggingface/socials': { body: { socialHandles: { github: 'huggingface' } } },
			});
			const r = await callPtcTool(
				tool('hf_profile_get'),
				{ handles: ['julien-c', 'https://huggingface.co/huggingface', 'nobody-zz'] },
				ctx
			);
			const [user, org, missing] = r.structured.items as Record<string, unknown>[];
			expect(user).toMatchObject({
				kind: 'user',
				id: 'julien-c',
				uri: 'https://huggingface.co/julien-c',
				url: 'https://huggingface.co/julien-c',
				avatarUrl: 'https://huggingface.co/avatars/abc.svg',
				counts: { followers: 5325, models: 53, following_orgs: 338 },
				organizations: [{ kind: 'org', id: 'huggingface', uri: 'https://huggingface.co/huggingface' }],
				socials: {
					twitter: 'https://x.com/julien_c',
					github: 'https://github.com/julien-c',
					linkedin: 'https://www.linkedin.com/in/julienchaumond',
				},
			});
			expect(org).toMatchObject({ kind: 'org', id: 'huggingface', plan: 'team', counts: { members: 187 } });
			expect(missing).toEqual({
				ref: 'nobody-zz',
				error: { code: 'NOT_FOUND', message: expect.any(String) as unknown },
			});
			expect(JSON.stringify(r.structured)).not.toContain('example.com');
			expect(urls.map((u) => u.pathname)).toContain('/api/users/huggingface/overview');
		});

		it('reports organizations beyond the 100 listed (merve has 103)', async () => {
			const orgs = Array.from({ length: 103 }, (_, i) => ({ name: `org-${String(i)}`, fullname: `Org ${String(i)}` }));
			const { ctx } = mockCtx({ '/api/users/merve/overview': { body: { ...userOverview, user: 'merve', orgs } } });
			const r = await callPtcTool(tool('hf_profile_get'), { handles: ['merve'], includeSocials: false }, ctx);
			const [profile] = r.structured.items as Record<string, unknown>[];
			expect(profile?.organizations).toHaveLength(100);
			expect(profile).toMatchObject({ organizationsTruncated: true, numOrganizations: 103 });

			const { ctx: small } = mockCtx({ '/api/users/julien-c/overview': { body: userOverview } });
			const one = await callPtcTool(tool('hf_profile_get'), { handles: ['julien-c'], includeSocials: false }, small);
			const [complete] = one.structured.items as Record<string, unknown>[];
			expect(complete).not.toHaveProperty('organizationsTruncated');
			expect(complete).not.toHaveProperty('numOrganizations');
		});

		it('honours kind and include_socials, and rejects invalid handles', async () => {
			const { ctx, urls } = mockCtx({ '/api/organizations/huggingface/overview': { body: orgOverview } });
			await callPtcTool(tool('hf_profile_get'), { handles: ['huggingface'], kind: 'org', includeSocials: false }, ctx);
			expect(urls.map((u) => u.pathname)).toEqual(['/api/organizations/huggingface/overview']);
			const bad = await callPtcTool(tool('hf_profile_get'), { handles: ['../etc'] }, ctx);
			expect(bad.structured.items).toEqual([
				{ ref: '../etc', error: expect.objectContaining({ code: 'INVALID_ARGUMENT' }) as unknown },
			]);
		});
	});

	describe('hf_org_members', () => {
		it('pages within an upstream page, then follows the Link cursor, with limit >= 10 upstream', async () => {
			const page1 = Array.from({ length: 10 }, (_, i) => member(`u${String(i)}`));
			const { ctx, urls } = mockCtx({
				'/api/organizations/huggingface/members': (url) =>
					url.searchParams.get('cursor')
						? { body: [member('last')] }
						: {
								body: page1,
								headers: {
									link: '<https://huggingface.co/api/organizations/huggingface/members?cursor=abc&limit=10>; rel="next"',
								},
							},
			});
			const t = tool('hf_org_members');
			const first = await callPtcTool(t, { handle: 'huggingface', limit: 6 }, ctx);
			expect(first.structured.items).toHaveLength(6);
			expect(first.structured.items).toContainEqual(
				expect.objectContaining({ kind: 'user', id: 'u0', uri: 'https://huggingface.co/u0' })
			);
			expect(JSON.stringify(first.structured)).not.toContain('example.com');
			expect(urls[0]?.searchParams.get('limit')).toBe('10');
			const second = await callPtcTool(
				t,
				{ handle: 'huggingface', limit: 6, cursor: first.structured.nextCursor },
				ctx
			);
			expect((second.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['u6', 'u7', 'u8', 'u9', 'last']);
			expect(second.structured.nextCursor).toBeNull();
			expect(urls.at(-1)?.searchParams.get('cursor')).toBe('abc');
			await expect(
				callPtcTool(t, { handle: 'other', limit: 6, cursor: first.structured.nextCursor }, ctx)
			).rejects.toMatchObject({
				code: 'INVALID_CURSOR',
			});
		});

		it('maps 401 on admins and 404 on unknown orgs', async () => {
			const { ctx } = mockCtx({ '/api/organizations/huggingface/members/admins': { status: 401, body: {} } });
			await expect(
				callPtcTool(tool('hf_org_members'), { handle: 'huggingface', adminsOnly: true }, ctx)
			).rejects.toMatchObject({
				code: 'AUTH_REQUIRED',
			});
			await expect(callPtcTool(tool('hf_org_members'), { handle: 'nope' }, ctx)).rejects.toMatchObject({
				code: 'NOT_FOUND',
				message: expect.stringContaining('organization nope') as unknown,
			});
		});

		it('falls back to anonymous listing when an authenticated token gets 403 on a public org', async () => {
			const authHeaders: (string | null)[] = [];
			const fetchMock: typeof globalThis.fetch = (input, init) => {
				const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				const auth = new Headers(init?.headers).get('authorization');
				authHeaders.push(auth);
				if (url.pathname === '/api/organizations/huggingface/members') {
					if (auth)
						return Promise.resolve(
							new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } })
						);
					const cursor = url.searchParams.get('cursor');
					if (cursor === 'p2') {
						return Promise.resolve(
							new Response(JSON.stringify([member('bob')]), {
								status: 200,
								headers: { 'content-type': 'application/json' },
							})
						);
					}
					return Promise.resolve(
						new Response(JSON.stringify([member('alice')]), {
							status: 200,
							headers: {
								'content-type': 'application/json',
								link: '<https://huggingface.co/api/organizations/huggingface/members?cursor=p2&limit=10>; rel="next"',
							},
						})
					);
				}
				return Promise.resolve(new Response('{}', { status: 404 }));
			};
			const ctx = { hfToken: 'hf_fine_grained', fetch: fetchMock };
			const t = tool('hf_org_members');
			const first = await callPtcTool(t, { handle: 'huggingface', limit: 1 }, ctx);
			expect((first.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['alice']);
			expect(first.structured.nextCursor).toBeTruthy();
			const second = await callPtcTool(
				t,
				{ handle: 'huggingface', limit: 1, cursor: first.structured.nextCursor },
				ctx
			);
			expect((second.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['bob']);
			expect(second.structured.nextCursor).toBeNull();
			// First call tried auth (403) then anonymous (200); second page stayed anonymous directly.
			expect(authHeaders).toEqual(['Bearer hf_fine_grained', null, null]);
			// Unclassified 403: generic reason, carried by the sealed cursor onto later pages.
			for (const page of [first, second]) {
				expect(page.structured.access).toMatchObject({
					mode: 'anonymous-fallback',
					reason: 'forbidden',
					rolesOmitted: true,
				});
			}
		});

		it('returns distinct error messages for denied adminsOnly vs private org member lists', async () => {
			const { ctx } = mockCtx({
				'/api/organizations/huggingface/members/admins': { status: 403, body: {} },
				'/api/organizations/secret-org/members': { status: 403, body: {} },
			});
			await expect(
				callPtcTool(tool('hf_org_members'), { handle: 'huggingface', adminsOnly: true }, { ...ctx, hfToken: 'hf_tok' })
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringContaining('adminsOnly=false') as unknown,
			});
			await expect(
				callPtcTool(tool('hf_org_members'), { handle: 'secret-org' }, { ...ctx, hfToken: 'hf_tok' })
			).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringContaining('organization secret-org members') as unknown,
			});
		});
	});

	describe('hf_org_members auth fallbacks', () => {
		interface Reply {
			status?: number;
			body?: unknown;
			headers?: Record<string, string>;
		}
		function authCtx(handler: (url: URL, auth: string | null) => Reply, hfToken: string | null = 'hf_tok') {
			const calls: { url: URL; auth: string | null }[] = [];
			const fetchMock: typeof globalThis.fetch = (input, init) => {
				const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				const auth = new Headers(init?.headers).get('authorization');
				calls.push({ url, auth });
				const reply = handler(url, auth);
				return Promise.resolve(
					new Response(JSON.stringify(reply.body ?? {}), {
						status: reply.status ?? 200,
						headers: { 'content-type': 'application/json', ...reply.headers },
					})
				);
			};
			return { ctx: { hfToken: hfToken ?? undefined, fetch: fetchMock } as PtcContext, calls };
		}
		const SSO_MESSAGE =
			'You need to log in with your SSO account linked to your account in order to access this resource. Please authenticate with SSO here: https://huggingface.co/organizations/acme/sso';
		const PRIVATE_MESSAGE = "This organization's members list is private";
		const adminsPath = '/api/organizations/acme/members/admins';
		const pagedMembers = (url: URL): Reply =>
			url.searchParams.get('cursor')
				? { body: [member('bob')] }
				: {
						body: [member('alice')],
						headers: { link: '<https://huggingface.co/api/organizations/acme/members?cursor=p2&limit=10>; rel="next"' },
					};

		it('classifies an SSO refusal, reads anonymously and seals the reason for later pages', async () => {
			const { ctx, calls } = authCtx((url, auth) =>
				auth ? { status: 403, headers: { 'x-error-message': SSO_MESSAGE } } : pagedMembers(url)
			);
			const t = tool('hf_org_members');
			const first = await callPtcTool(t, { handle: 'acme', limit: 1 }, ctx);
			expect(first.structured.access).toEqual({
				mode: 'anonymous-fallback',
				reason: 'sso',
				rolesOmitted: true,
				note: expect.stringContaining('hf_whoami') as unknown,
			});
			// Never echo upstream text (the SSO URL) into the output.
			expect(JSON.stringify(first.structured)).not.toContain('/sso');
			const second = await callPtcTool(t, { handle: 'acme', limit: 1, cursor: first.structured.nextCursor }, ctx);
			expect((second.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['bob']);
			expect(second.structured.access).toMatchObject({ reason: 'sso' });
			expect(calls.map((c) => c.auth)).toEqual(['Bearer hf_tok', null, null]);
		});

		it.each([
			['Your IP address (1.2.3.4) is not allowed by acme network security settings.', 'ip-allowlist'],
			[
				'Due to the organization token policy, your token needs to be a fine-grained token before you can access this resource.',
				'token-policy',
			],
			['Your token has been revoked by the organization administrator.', 'token-revoked'],
			['You need to enable two-factor authentication to access resources of acme.', 'mfa'],
			['You need to complete the welcome form in order to access this resource.', 'sso-welcome'],
			['This app is bound to an organization and cannot access resources of acme', 'oauth-bound-org'],
		])('maps %s to reason %s', async (message, reason) => {
			const { ctx } = authCtx((_url, auth) =>
				auth ? { status: 403, headers: { 'x-error-message': message } } : { body: [member('alice')] }
			);
			const r = await callPtcTool(tool('hf_org_members'), { handle: 'acme' }, ctx);
			expect(r.structured.access).toMatchObject({ mode: 'anonymous-fallback', reason });
			expect(r.structured.nextCursor).toBeNull();
		});

		it('retries anonymously on 401 with a token and flags token-invalid', async () => {
			const { ctx } = authCtx((_url, auth) => (auth ? { status: 401 } : { body: [member('alice')] }));
			const r = await callPtcTool(tool('hf_org_members'), { handle: 'acme' }, ctx);
			expect((r.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['alice']);
			expect(r.structured.access).toEqual({
				mode: 'anonymous-fallback',
				reason: 'token-invalid',
				rolesOmitted: true,
				note: expect.stringContaining('Re-authenticate') as unknown,
			});
		});

		it('reports an invalid token when the 401 retry also hits a private list', async () => {
			const { ctx } = authCtx((_url, auth) => (auth ? { status: 401 } : { status: 403 }));
			await expect(callPtcTool(tool('hf_org_members'), { handle: 'acme' }, ctx)).rejects.toMatchObject({
				code: 'AUTH_REQUIRED',
				message: expect.stringMatching(/invalid or expired.*private/) as unknown,
			});
		});

		it('fails definitively on a classified private list without an anonymous retry', async () => {
			const { ctx, calls } = authCtx(() => ({ status: 403, headers: { 'x-error-message': PRIVATE_MESSAGE } }));
			await expect(callPtcTool(tool('hf_org_members'), { handle: 'acme' }, ctx)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringContaining('member list is private') as unknown,
			});
			expect(calls).toHaveLength(1);
		});

		it('fails definitively when both the token and anonymous get 403, and anonymously without a token', async () => {
			const both = authCtx(() => ({ status: 403 }));
			await expect(callPtcTool(tool('hf_org_members'), { handle: 'acme' }, both.ctx)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringContaining('member list is private') as unknown,
			});
			expect(both.calls.map((c) => c.auth)).toEqual(['Bearer hf_tok', null]);
			const anon = authCtx(() => ({ status: 403 }), null);
			await expect(callPtcTool(tool('hf_org_members'), { handle: 'acme' }, anon.ctx)).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringContaining('member list is private') as unknown,
			});
		});

		it('adds no access block when the token is accepted', async () => {
			const { ctx } = authCtx(() => ({ body: [{ ...member('alice'), role: 'write' }] }));
			const r = await callPtcTool(tool('hf_org_members'), { handle: 'acme' }, ctx);
			expect(r.structured.access).toBeUndefined();
			expect(r.structured.items).toEqual([expect.objectContaining({ id: 'alice', role: 'write' })]);
		});

		it('adminsOnly: separate messages for 401 with/without a token and for 403', async () => {
			const t = tool('hf_org_members');
			const oauth = authCtx(() => ({ status: 401 }), 'hf_oauth_x');
			await expect(callPtcTool(t, { handle: 'acme', adminsOnly: true }, oauth.ctx)).rejects.toMatchObject({
				code: 'AUTH_REQUIRED',
				message: expect.stringContaining('OAuth tokens are not accepted') as unknown,
			});
			expect(oauth.calls).toHaveLength(1);
			const anon = authCtx(() => ({ status: 401 }), null);
			await expect(callPtcTool(t, { handle: 'acme', adminsOnly: true }, anon.ctx)).rejects.toMatchObject({
				code: 'AUTH_REQUIRED',
				message: expect.stringContaining('needs a classic or fine-grained access token') as unknown,
			});
			const sso = authCtx(() => ({ status: 403, headers: { 'x-error-message': SSO_MESSAGE } }));
			const denied = callPtcTool(t, { handle: 'acme', adminsOnly: true }, sso.ctx);
			await expect(denied).rejects.toMatchObject({
				code: 'FORBIDDEN',
				message: expect.stringMatching(/Hub reason: sso.*membership.*adminsOnly=false/) as unknown,
			});
			await expect(denied).rejects.not.toMatchObject({ message: expect.stringContaining('huggingface.co') as unknown });
		});

		it('adminsOnly: pages the unpaginated whole list locally, marks rows admin and sends no limit', async () => {
			const admins = Array.from({ length: 12 }, (_, i) => ({
				user: `a${String(i)}`,
				fullname: `A${String(i)}`,
				avatarUrl: '/avatars/a.svg',
			}));
			const { ctx, calls } = authCtx((url) => (url.pathname === adminsPath ? { body: admins } : { status: 404 }));
			const t = tool('hf_org_members');
			const first = await callPtcTool(t, { handle: 'acme', adminsOnly: true, limit: 5 }, ctx);
			expect(first.structured.items).toHaveLength(5);
			expect(first.structured.items).toContainEqual(expect.objectContaining({ id: 'a0', kind: 'user', role: 'admin' }));
			expect(first.structured.access).toBeUndefined();
			const second = await callPtcTool(
				t,
				{ handle: 'acme', adminsOnly: true, limit: 5, cursor: first.structured.nextCursor },
				ctx
			);
			expect((second.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['a5', 'a6', 'a7', 'a8', 'a9']);
			const third = await callPtcTool(
				t,
				{ handle: 'acme', adminsOnly: true, limit: 5, cursor: second.structured.nextCursor },
				ctx
			);
			expect((third.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['a10', 'a11']);
			expect(third.structured.nextCursor).toBeNull();
			expect(third.structured.completeness).toMatchObject({ hasMore: false });
			expect(calls.every((c) => c.url.pathname === adminsPath && !c.url.searchParams.has('limit'))).toBe(true);
		});
	});

	describe('hf_follow_graph', () => {
		it('falls back to organization followers when the handle is not a user', async () => {
			const { ctx, urls } = mockCtx({ '/api/organizations/huggingface/followers': { body: [member('fan')] } });
			const r = await callPtcTool(tool('hf_follow_graph'), { handle: 'huggingface', limit: 5 }, ctx);
			expect(r.structured.items).toEqual([expect.objectContaining({ id: 'fan', kind: 'user' })]);
			expect(urls.map((u) => u.pathname)).toEqual([
				'/api/users/huggingface/followers',
				'/api/organizations/huggingface/followers',
			]);
		});

		it('sends no limit for following (fixed upstream pages) and lists following orgs locally', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/julien-c/following': { body: [member('a'), member('b')] },
				'/api/users/julien-c/following/orgs': { body: [orgRow('o1'), orgRow('o2'), orgRow('o3')] },
			});
			await callPtcTool(tool('hf_follow_graph'), { handle: 'julien-c', relation: 'following' }, ctx);
			expect(urls[0]?.search).toBe('');
			const orgs = await callPtcTool(
				tool('hf_follow_graph'),
				{ handle: 'julien-c', relation: 'following_orgs', limit: 2 },
				ctx
			);
			expect(orgs.structured.items).toEqual([
				expect.objectContaining({ kind: 'org', id: 'o1', orgType: 'company' }),
				expect.objectContaining({ kind: 'org', id: 'o2' }),
			]);
			expect(JSON.stringify(orgs.structured)).not.toContain('x.com');
			const rest = await callPtcTool(
				tool('hf_follow_graph'),
				{ handle: 'julien-c', relation: 'following_orgs', limit: 2, cursor: orgs.structured.nextCursor },
				ctx
			);
			expect(rest.structured.items).toEqual([expect.objectContaining({ id: 'o3' })]);
			expect(rest.structured.nextCursor).toBeNull();
			await expect(
				callPtcTool(tool('hf_follow_graph'), { handle: 'huggingface', kind: 'org', relation: 'following' }, ctx)
			).rejects.toMatchObject({ code: 'UNSUPPORTED' });
		});
	});

	describe('hf_user_likes', () => {
		it('returns liked repos as chainable hf:// items, filtered by kind', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/julien-c/likes': {
					body: [
						likeRow('moonshotai/Kimi', 'model'),
						likeRow('HuggingFaceFW/fineweb', 'dataset'),
						likeRow('a/b', 'space'),
					],
				},
			});
			const r = await callPtcTool(tool('hf_user_likes'), { handle: 'julien-c', kindsAny: ['dataset'] }, ctx);
			expect(r.structured.items).toEqual([
				{
					kind: 'dataset',
					id: 'HuggingFaceFW/fineweb',
					uri: 'hf://datasets/HuggingFaceFW/fineweb',
					url: 'https://huggingface.co/datasets/HuggingFaceFW/fineweb',
					likedAt: '2026-11-16T16:49:41.000Z',
				},
			]);
			expect(urls[0]?.searchParams.get('limit')).toBe('100');
			expect(r.structured.completeness).toMatchObject({ rowsScanned: 3 });
		});

		it('reranks a bounded recent window by popularity and does not page', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/julien-c/likes': {
					body: [likeRow('a/low', 'model'), likeRow('a/high', 'model'), likeRow('a/space', 'space')],
				},
				'/api/models/a/low': { body: { likes: 5, downloads: 10 } },
				'/api/models/a/high': { body: { likes: 50, downloads: 1 } },
				'/api/spaces/a/space': { body: { likes: 20 } },
			});
			const r = await callPtcTool(tool('hf_user_likes'), { handle: 'julien-c', sort: 'likes', limit: 2 }, ctx);
			expect((r.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['a/high', 'a/space']);
			expect(r.structured.nextCursor).toBeNull();
			expect(r.structured.completeness).toMatchObject({
				hasMore: false,
				rankingWindow: 3,
			});
			const spaceCall = urls.find((u) => u.pathname === '/api/spaces/a/space');
			expect(spaceCall?.searchParams.getAll('expand[]')).toEqual(['likes']);
		});
	});

	describe('hf_repo_likers', () => {
		it('pages the whole liker list locally and resolves hf:// dataset uris', async () => {
			const { ctx, urls } = mockCtx({
				'/api/datasets/HuggingFaceFW/fineweb/likers': { body: [member('a'), member('b'), member('c')] },
			});
			const t = tool('hf_repo_likers');
			const first = await callPtcTool(t, { repo: 'hf://datasets/HuggingFaceFW/fineweb', limit: 2 }, ctx);
			expect((first.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['a', 'b']);
			const second = await callPtcTool(
				t,
				{ repo: 'hf://datasets/HuggingFaceFW/fineweb', limit: 2, cursor: first.structured.nextCursor },
				ctx
			);
			expect((second.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['c']);
			expect(second.structured.nextCursor).toBeNull();
			expect(urls.every((u) => u.pathname === '/api/datasets/HuggingFaceFW/fineweb/likers')).toBe(true);
			await expect(callPtcTool(t, { repo: 'openai-community/missing' }, ctx)).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
		});
	});

	describe('hf_activity', () => {
		const feed = [
			{
				time: 't1',
				user: 'lysandre',
				type: 'update',
				repoId: 'huggingface/meta',
				repoType: 'dataset',
				org: 'huggingface',
			},
			{
				time: 't2',
				user: 'cfahlgren1',
				type: 'discussion',
				repoId: 'huggingface/hub-stats',
				repoType: 'space',
				discussionData: { num: 2, title: 'Add sections', status: 'merged', isPullRequest: true },
			},
			{ time: 't3', user: 'x', type: 'paper', paper: { id: '2609.39827', title: 'Synthetic' } },
			{
				time: 't4',
				user: 'x',
				type: 'upvote',
				targetType: 'collection',
				target: { slug: 'merve/weekly-123', title: 'Weekly' },
			},
			{ time: 't5', user: 'x', type: 'social-post', socialPost: { rawContent: 'Hello\nworld', url: '/posts/x/1' } },
		];
		it('falls back to the org feed, maps targets to chainable items and pages with the upstream cursor', async () => {
			const { ctx, urls } = mockCtx({
				'/api/recent-activity': (url) => {
					if (url.searchParams.get('feedType') === 'user') return { status: 404, body: {} };
					return url.searchParams.get('cursor')
						? { body: { recentActivity: [], cursor: null } }
						: { body: { recentActivity: feed, cursor: 'eyJjIjoxfQ==' } };
				},
			});
			const t = tool('hf_activity');
			const r = await callPtcTool(t, { handle: 'huggingface', limit: 5 }, ctx);
			const items = r.structured.items as Record<string, unknown>[];
			expect(items[0]).toMatchObject({
				type: 'update',
				org: 'huggingface',
				target: { uri: 'hf://datasets/huggingface/meta' },
			});
			expect(items[1]).toMatchObject({
				target: { kind: 'space', uri: 'hf://spaces/huggingface/hub-stats' },
				discussion: {
					num: 2,
					type: 'pull_request',
					url: 'https://huggingface.co/spaces/huggingface/hub-stats/discussions/2',
				},
			});
			expect(items[2]).toMatchObject({ target: { kind: 'paper', uri: 'hf://papers/2609.39827' } });
			expect(items[3]).toMatchObject({
				targetType: 'collection',
				target: { uri: 'hf://collections/merve/weekly-123' },
			});
			expect(items[4]).toMatchObject({ title: 'Hello world', target: { url: 'https://huggingface.co/posts/x/1' } });
			expect(r.structured.nextCursor).toEqual(expect.any(String));
			const next = await callPtcTool(t, { handle: 'huggingface', limit: 5, cursor: r.structured.nextCursor }, ctx);
			expect(urls.at(-1)?.searchParams.get('cursor')).toBe('eyJjIjoxfQ==');
			expect(next.structured.items).toEqual([]);
			expect(next.structured.nextCursor).toBeNull();
		});

		it('filters by type across a bounded number of pages and reports the scan', async () => {
			let page = 0;
			const { ctx, urls } = mockCtx({
				'/api/recent-activity': () => ({ body: { recentActivity: feed, cursor: `c${String(++page)}` } }),
			});
			const r = await callPtcTool(
				tool('hf_activity'),
				{ handle: 'julien-c', kind: 'user', typesAny: ['paper'], limit: 10 },
				ctx
			);
			expect(r.structured.items).toHaveLength(5);
			expect(urls).toHaveLength(5);
			expect(urls[0]?.searchParams.get('limit')).toBe('100');
			expect(r.structured.completeness).toMatchObject({
				pagesScanned: 5,
				rowsScanned: 25,
				reason: 'page_budget',
			});
			expect(r.structured.nextCursor).toEqual(expect.any(String));
		});

		it('pushes supported single-type filters like upvote to upstream activityType', async () => {
			const paperUpvote = {
				time: '2026-09-09T03:55:26.775Z',
				user: 'akhaliq',
				type: 'upvote',
				targetType: 'paper',
				targetUrl: '/papers/2609.08368',
				target: { id: '2609.08368', title: 'Miles v0.1: Production-Level Post-Training' },
			};
			const { ctx, urls } = mockCtx({
				'/api/recent-activity': () => ({ body: { recentActivity: [paperUpvote], cursor: null } }),
			});
			const r = await callPtcTool(
				tool('hf_activity'),
				{ handle: 'akhaliq', kind: 'user', typesAny: ['upvote'], limit: 20 },
				ctx
			);
			expect(urls).toHaveLength(1);
			expect(urls[0]?.searchParams.get('activityType')).toBe('upvote');
			expect(urls[0]?.searchParams.get('limit')).toBe('20');
			expect(r.structured.items).toEqual([
				{
					type: 'upvote',
					createdAt: '2026-09-09T03:55:26.775Z',
					actor: 'akhaliq',
					targetType: 'paper',
					title: 'Miles v0.1: Production-Level Post-Training',
					target: {
						kind: 'paper',
						id: '2609.08368',
						uri: 'hf://papers/2609.08368',
						url: 'https://huggingface.co/papers/2609.08368',
					},
				},
			]);
		});
	});

	describe('hf_discussions_list', () => {
		it('passes filters upstream, pages by page number and links repo items', async () => {
			const page0 = Array.from({ length: 50 }, (_, i) => discussionRow(100 - i));
			const { ctx, urls } = mockCtx({
				'/api/models/openai-community/gpt2/discussions': (url) => ({
					body: {
						discussions: url.searchParams.get('p') === '0' ? page0 : [discussionRow(3)],
						count: 51,
						start: 0,
					},
				}),
			});
			const t = tool('hf_discussions_list');
			const args = {
				ref: 'hf://models/openai-community/gpt2',
				status: 'closed',
				type: 'pull_request',
				author: 'victim3432',
				limit: 30,
			};
			const r = await callPtcTool(t, args, ctx);
			expect(urls[0]?.searchParams.toString()).toBe('p=0&status=closed&type=pull_request&author=victim3432');
			expect(r.structured.items).toHaveLength(30);
			expect((r.structured.items as Record<string, unknown>[])[0]).toEqual({
				kind: 'discussion',
				id: 'openai-community/gpt2#100',
				uri: 'https://huggingface.co/openai-community/gpt2/discussions/100',
				url: 'https://huggingface.co/openai-community/gpt2/discussions/100',
				repo: {
					kind: 'model',
					id: 'openai-community/gpt2',
					uri: 'hf://models/openai-community/gpt2',
					url: 'https://huggingface.co/openai-community/gpt2',
				},
				num: 100,
				title: 'pr100',
				status: 'closed',
				type: 'pull_request',
				author: 'victim3432',
				createdAt: expect.any(String) as unknown,
				numComments: 1,
				pinned: false,
			});
			expect(r.structured.completeness).toMatchObject({ total: 51 });
			const r2 = await callPtcTool(t, { ...args, cursor: r.structured.nextCursor }, ctx);
			expect(r2.structured.items).toHaveLength(21);
			expect(urls.at(-1)?.searchParams.get('p')).toBe('1');
			expect(r2.structured.nextCursor).toBeNull();
		});

		it('requires exactly one of ref or owner', async () => {
			const { ctx } = mockCtx({});
			await expect(callPtcTool(tool('hf_discussions_list'), {}, ctx)).rejects.toMatchObject({
				code: 'INVALID_ARGUMENT',
			});
			await expect(callPtcTool(tool('hf_discussions_list'), { repo: 'a/b', owner: 'a' }, ctx)).rejects.toMatchObject({
				code: 'INVALID_ARGUMENT',
			});
		});

		it('fans out over an owner repositories with bounded coverage reporting', async () => {
			const repoDiscussions = (repo: string, type: string, count: number) => ({
				body: {
					discussions: [
						discussionRow(1, { repo: { name: repo, type }, createdAt: `2026-0${String(count)}-01T00:00:00Z` }),
					],
					count,
				},
			});
			const { ctx, urls } = mockCtx({
				'/api/models': {
					body: [
						{ id: 'org/m1', likes: 10 },
						{ id: 'org/m2', likes: 1 },
					],
				},
				'/api/datasets': { body: [{ id: 'org/d1', likes: 5 }] },
				'/api/spaces': { body: [{ id: 'org/s1', likes: 3 }] },
				'/api/users/org/overview': { status: 404, body: {} },
				'/api/organizations/org/overview': {
					body: { ...orgOverview, name: 'org', numModels: 2, numDatasets: 1, numSpaces: 3 },
				},
				'/api/models/org/m1/discussions': repoDiscussions('org/m1', 'model', 5),
				'/api/models/org/m2/discussions': { status: 403, body: {} },
				'/api/datasets/org/d1/discussions': repoDiscussions('org/d1', 'dataset', 1),
				'/api/spaces/org/s1/discussions': repoDiscussions('org/s1', 'space', 2),
			});
			const r = await callPtcTool(tool('hf_discussions_list'), { owner: 'org', limit: 2 }, ctx);
			expect((r.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['org/m1#1', 'org/s1#1']);
			expect((r.structured.items as { repo: { uri: string } }[])[1]?.repo.uri).toBe('hf://spaces/org/s1');
			expect(r.structured.completeness).toMatchObject({
				hasMore: true,
				truncated: true,
				reason: 'owner_fanout_cap',
				reposScanned: 3,
				reposFailed: 1,
				numRepos: 6,
			});
			expect(urls.find((u) => u.pathname === '/api/models')?.searchParams.get('author')).toBe('org');
			const next = await callPtcTool(
				tool('hf_discussions_list'),
				{ owner: 'org', limit: 2, cursor: r.structured.nextCursor },
				ctx
			);
			expect((next.structured.items as { id: string }[]).map((i) => i.id)).toEqual(['org/d1#1']);
			expect(next.structured.nextCursor).toBeNull();
		});
	});

	describe('hf_discussion_get', () => {
		const comment = (id: string, raw: string, extra: Record<string, unknown> = {}) => ({
			id,
			author: { name: 'lysandre', email: 'x@example.com' },
			createdAt: '2024-02-16T09:57:18.000Z',
			type: 'comment',
			data: { edited: false, hidden: false, latest: { raw, html: '<p/>' }, ...extra },
		});
		const detail = {
			num: 80,
			title: 'Adds the tokenizer configuration file',
			status: 'merged',
			createdAt: '2024-02-16T09:57:18.000Z',
			isPullRequest: true,
			pinned: false,
			locked: false,
			author: { name: 'lysandre' },
			repo: { name: 'openai-community/gpt2', type: 'model' },
			changes: { base: 'refs/heads/main', mergeCommitId: '607a30d783dfa663caf39e06633721c8d4cfcd7e' },
			filesWithConflicts: [],
			events: [
				comment('c1', 'x'.repeat(5000)),
				{
					id: 'e1',
					author: { name: 'lysandre' },
					type: 'commit',
					data: { subject: 'Adds file', oid: 'db6d57930088fb63' },
				},
				comment('c2', 'second', { hidden: true }),
				comment('c3', 'third'),
				{ id: 'e2', author: { name: 'lysandre' }, type: 'status-change', data: { status: 'merged' } },
			],
		};
		const diff = [
			'diff --git a/tokenizer_config.json b/tokenizer_config.json',
			'new file mode 100644',
			'--- /dev/null',
			'+++ b/tokenizer_config.json',
			'@@ -0,0 +1 @@',
			'+{}',
		].join('\n');

		it('returns bounded comments with continuation, timeline and changed files', async () => {
			const { ctx, urls } = mockCtx({
				'/api/models/openai-community/gpt2/discussions/80': { body: detail },
				'/openai-community/gpt2/discussions/80/files.diff': { text: diff },
			});
			const t = tool('hf_discussion_get');
			const r = await callPtcTool(
				t,
				{ discussion: 'https://huggingface.co/openai-community/gpt2/discussions/80', num: 80, limit: 2 },
				ctx
			);
			const s = r.structured;
			expect(s).toMatchObject({
				kind: 'discussion',
				id: 'openai-community/gpt2#80',
				repo: { uri: 'hf://models/openai-community/gpt2' },
				type: 'pull_request',
				status: 'merged',
				numComments: 3,
				returnedCount: 2,
				files: [{ path: 'tokenizer_config.json', change: 'added' }],
				diffUrl: 'https://huggingface.co/openai-community/gpt2/discussions/80/files.diff',
				mergeCommit: '607a30d783dfa663caf39e06633721c8d4cfcd7e',
				timeline: [
					{ type: 'commit', author: 'lysandre', detail: 'Adds file (db6d57930088)' },
					{ type: 'status-change', author: 'lysandre', detail: 'merged' },
				],
			});
			const comments = s.comments as Record<string, unknown>[];
			expect((comments[0]?.text as string).length).toBe(4000);
			expect(comments[0]?.textTruncated).toBe(true);
			expect(comments[1]).toEqual({
				id: 'c2',
				author: 'lysandre',
				createdAt: expect.any(String) as unknown,
				edited: false,
				hidden: true,
			});
			expect(JSON.stringify(s)).not.toContain('example.com');
			expect(urls.map((u) => u.pathname)).toContain('/openai-community/gpt2/discussions/80/files.diff');

			const more = await callPtcTool(
				t,
				{
					discussion: 'https://huggingface.co/openai-community/gpt2/discussions/80',
					num: 80,
					limit: 2,
					cursor: s.nextCursor,
				},
				ctx
			);
			expect(more.structured.comments).toEqual([expect.objectContaining({ id: 'c3', text: 'third' })]);
			expect(more.structured.nextCursor).toBeNull();
			expect(more.structured.files).toBeUndefined();
			expect(more.structured.timeline).toBeUndefined();
		});

		it('stops at the total text budget and degrades when the diff is unavailable', async () => {
			const big = {
				...detail,
				events: Array.from({ length: 8 }, (_, i) => comment(`c${String(i)}`, 'y'.repeat(3000))),
			};
			const { ctx } = mockCtx({
				'/api/spaces/a/b/discussions/80': { body: { ...big, repo: { name: 'a/b', type: 'space' } } },
			});
			const r = await callPtcTool(tool('hf_discussion_get'), { discussion: 'hf://spaces/a/b', num: 80 }, ctx);
			expect(r.structured.returnedCount).toBe(6);
			expect(r.structured.nextCursor).toEqual(expect.any(String));
			expect(r.structured).toMatchObject({ files: [], filesTruncated: true });
		});

		it('accepts the discussion id or url as ref without num', async () => {
			const { ctx, urls } = mockCtx({
				'/api/models/a/b/discussions/3': { body: { ...detail, events: [], repo: { name: 'a/b', type: 'model' } } },
				'/api/datasets/a/b/discussions/4': {
					body: { ...detail, num: 4, events: [], repo: { name: 'a/b', type: 'dataset' } },
				},
			});
			const viaId = await callPtcTool(tool('hf_discussion_get'), { discussion: 'a/b#3', include: ['comments'] }, ctx);
			expect(viaId.structured).toMatchObject({ repo: { id: 'a/b' } });
			await callPtcTool(
				tool('hf_discussion_get'),
				{ discussion: 'https://huggingface.co/datasets/a/b/discussions/4', include: ['comments'] },
				ctx
			);
			await callPtcTool(
				tool('hf_discussion_get'),
				{ discussion: 'hf://models/a/b#3', num: 3, include: ['comments'] },
				ctx
			);
			expect(urls.map((u) => u.pathname)).toEqual([
				'/api/models/a/b/discussions/3',
				'/api/datasets/a/b/discussions/4',
				'/api/models/a/b/discussions/3',
			]);
			await expect(callPtcTool(tool('hf_discussion_get'), { discussion: 'a/b#3', num: 4 }, ctx)).rejects.toMatchObject({
				code: 'INVALID_ARGUMENT',
			});
			await expect(callPtcTool(tool('hf_discussion_get'), { discussion: 'a/b' }, ctx)).rejects.toThrow(
				/Missing required argument "num"/
			);
		});

		it('maps 404 and rejects buckets', async () => {
			const { ctx } = mockCtx({});
			await expect(callPtcTool(tool('hf_discussion_get'), { discussion: 'a/b', num: 1 }, ctx)).rejects.toMatchObject({
				code: 'NOT_FOUND',
			});
			await expect(
				callPtcTool(tool('hf_discussion_get'), { discussion: 'hf://buckets/a/b', num: 1 }, ctx)
			).rejects.toMatchObject({
				code: 'UNSUPPORTED',
			});
		});

		it('auto-detects dataset and space discussions for bare owner/name#num ids', async () => {
			const { ctx } = mockCtx({
				'/api/datasets/evalstate/all-defects/discussions/1': {
					body: {
						num: 1,
						title: 'Dataset thread',
						status: 'open',
						isPullRequest: false,
						author: { name: 'evalstate' },
						createdAt: '2026-01-01T00:00:00Z',
						events: [],
					},
				},
			});
			const r = await callPtcTool(
				tool('hf_discussion_get'),
				{ discussion: 'evalstate/all-defects#1', include: ['comments'] },
				ctx
			);
			expect(r.structured.id).toBe('evalstate/all-defects#1');
			expect((r.structured.repo as { kind: string }).kind).toBe('dataset');
		});

		describe('bare owner/name#num kind detection', () => {
			const thread = (repo: string, type: string, events: unknown[] = []) => ({
				body: {
					num: 1,
					title: 'Thread',
					status: 'open',
					isPullRequest: false,
					author: { name: 'evalstate' },
					createdAt: '2026-01-01T00:00:00Z',
					repo: { name: repo, type },
					events,
				},
			});
			// What the Hub answers for a repository that does not exist as that kind (moon-landing repoGuard).
			const anonMissing: Route = { status: 401, text: '{"error":"Invalid username or password."}' };
			const authedMissing: Route = {
				status: 404,
				text: '{"error":"Repository not found"}',
				headers: { 'x-error-code': 'RepoNotFound' },
			};
			const get = (ctx: PtcContext, args: Record<string, unknown>) =>
				callPtcTool(tool('hf_discussion_get'), { include: ['comments'], ...args }, ctx);

			it('treats an anonymous 401 as "not this kind" and keeps probing', async () => {
				const { ctx, urls } = mockCtx({
					'/api/models/HuggingFaceFW/fineweb/discussions/1': anonMissing,
					'/api/datasets/HuggingFaceFW/fineweb/discussions/1': thread('HuggingFaceFW/fineweb', 'dataset'),
				});
				const r = await get(ctx, { discussion: 'HuggingFaceFW/fineweb#1' });
				expect(r.structured.repo).toMatchObject({ kind: 'dataset', id: 'HuggingFaceFW/fineweb' });
				expect(urls.map((u) => u.pathname)).toEqual([
					'/api/models/HuggingFaceFW/fineweb/discussions/1',
					'/api/datasets/HuggingFaceFW/fineweb/discussions/1',
				]);
			});

			it('treats an authenticated RepoNotFound 404 as "not this kind"', async () => {
				const { ctx } = mockCtx(
					{
						'/api/models/a/b/discussions/1': authedMissing,
						'/api/datasets/a/b/discussions/1': authedMissing,
						'/api/spaces/a/b/discussions/1': thread('a/b', 'space'),
					},
					{ hfToken: 'hf_x' }
				);
				const r = await get(ctx, { discussion: 'a/b#1' });
				expect(r.structured.repo).toMatchObject({ kind: 'space', id: 'a/b' });
			});

			it('reports not found as any kind instead of a guessed 401', async () => {
				const anon = mockCtx({
					'/api/models/a/b/discussions/1': anonMissing,
					'/api/datasets/a/b/discussions/1': anonMissing,
					'/api/spaces/a/b/discussions/1': anonMissing,
				});
				await expect(get(anon.ctx, { discussion: 'a/b#1' })).rejects.toThrow(
					/a\/b not found as a model, dataset or Space \(or private: authenticate\)/
				);
				expect(anon.urls).toHaveLength(3);
				const authed = mockCtx(
					{
						'/api/models/a/b/discussions/1': authedMissing,
						'/api/datasets/a/b/discussions/1': authedMissing,
						'/api/spaces/a/b/discussions/1': authedMissing,
					},
					{ hfToken: 'hf_x' }
				);
				await expect(get(authed.ctx, { discussion: 'a/b#1' })).rejects.toThrow(
					/not found as a model, dataset or Space \(or not visible to this token\)/
				);
				// An explicit kind gets the same anonymous mapping as hf_repo_info.
				const explicit = mockCtx({ '/api/datasets/a/b/discussions/1': anonMissing });
				await expect(get(explicit.ctx, { discussion: 'hf://datasets/a/b#1' })).rejects.toMatchObject({
					code: 'NOT_FOUND',
					message: 'dataset a/b not found (or private: authenticate).',
				});
			});

			it('surfaces a rejected token instead of probing on', async () => {
				const { ctx, urls } = mockCtx(
					{
						'/api/models/a/b/discussions/1': anonMissing,
						'/api/datasets/a/b/discussions/1': thread('a/b', 'dataset'),
					},
					{ hfToken: 'hf_bad' }
				);
				await expect(get(ctx, { discussion: 'a/b#1' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
				expect(urls).toHaveLength(1);
			});

			it('names a missing discussion on an existing repository, unless another kind has it', async () => {
				const missingThread: Route = { status: 404, text: '{"error":"No discussion found matching num #1"}' };
				const { ctx } = mockCtx({
					'/api/models/a/b/discussions/1': missingThread,
					'/api/datasets/a/b/discussions/1': anonMissing,
					'/api/spaces/a/b/discussions/1': anonMissing,
				});
				await expect(get(ctx, { discussion: 'a/b#1' })).rejects.toMatchObject({
					code: 'NOT_FOUND',
					message: 'discussion #1 not found in model a/b.',
				});
				const both = mockCtx({
					'/api/models/a/b/discussions/1': missingThread,
					'/api/datasets/a/b/discussions/1': thread('a/b', 'dataset'),
				});
				const r = await get(both.ctx, { discussion: 'a/b#1' });
				expect(r.structured.repo).toMatchObject({ kind: 'dataset' });
			});

			it('follows a renamed repository once and resumes with the original id', async () => {
				const events = Array.from({ length: 3 }, (_, i) => comment(`c${String(i)}`, 'text'));
				const { ctx, urls } = mockCtx({
					'/api/models/Old/b/discussions/1': anonMissing,
					'/api/datasets/Old/b/discussions/1': {
						status: 307,
						text: '',
						headers: { location: '/api/datasets/New/b/discussions/1' },
					},
					'/api/datasets/New/b/discussions/1': thread('New/b', 'dataset', events),
				});
				const r = await get(ctx, { discussion: 'Old/b#1', limit: 2 });
				expect(r.structured).toMatchObject({ id: 'New/b#1', repo: { kind: 'dataset', id: 'New/b' }, returnedCount: 2 });
				expect(r.structured.nextCursor).toEqual(expect.any(String));
				urls.length = 0;
				const more = await get(ctx, { discussion: 'Old/b#1', limit: 2, cursor: r.structured.nextCursor });
				expect(more.structured.comments).toEqual([expect.objectContaining({ id: 'c2' })]);
				// The cursor pins the kind: no model probe on the continuation.
				expect(urls.map((u) => u.pathname)).toEqual([
					'/api/datasets/Old/b/discussions/1',
					'/api/datasets/New/b/discussions/1',
				]);
			});

			it('rejects a bad cursor before any request', async () => {
				const { ctx, urls } = mockCtx({});
				await expect(get(ctx, { discussion: 'a/b#1', cursor: 'not-a-cursor' })).rejects.toMatchObject({
					code: 'INVALID_CURSOR',
				});
				expect(urls).toHaveLength(0);
			});
		});
	});

	describe('person names in the wrong letter case', () => {
		/** The Hub's canonical-case 307 (same path in another case, query kept). */
		const recase = (canonicalPath: string) => (url: URL) => ({
			status: 307,
			text: '',
			headers: { location: `${canonicalPath}${url.search}` },
		});

		it('follows canonical-case redirects and emits the canonical name, not the input case', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/EVALSTATE/overview': recase('/api/users/evalstate/overview'),
				'/api/users/evalstate/overview': { body: { ...userOverview, user: 'evalstate' } },
				'/api/users/HuggingFace/overview': { status: 404, body: {} },
				'/api/organizations/HuggingFace/overview': { body: orgOverview },
			});
			const r = await callPtcTool(
				tool('hf_profile_get'),
				{ handles: ['EVALSTATE', 'HuggingFace'], includeSocials: false },
				ctx
			);
			expect(r.structured.items).toEqual([
				expect.objectContaining({ kind: 'user', id: 'evalstate', uri: 'https://huggingface.co/evalstate' }),
				expect.objectContaining({ kind: 'org', id: 'huggingface', uri: 'https://huggingface.co/huggingface' }),
			]);
			expect(urls.map((u) => u.pathname)).toContain('/api/users/evalstate/overview');
		});

		it('keeps the token on a same-host case redirect and pages followers, likes and members', async () => {
			const { ctx, urls } = mockCtx(
				{
					'/api/users/EvalState/followers': recase('/api/users/evalstate/followers'),
					'/api/users/evalstate/followers': { body: [member('fan')] },
					'/api/users/EvalState/likes': recase('/api/users/evalstate/likes'),
					'/api/users/evalstate/likes': { body: [likeRow('a/b', 'model')] },
					'/api/organizations/HuggingFace/members': recase('/api/organizations/huggingface/members'),
					'/api/organizations/huggingface/members': (url) =>
						url.searchParams.get('cursor')
							? { body: [member('last')] }
							: {
									body: Array.from({ length: 10 }, (_, i) => member(`u${String(i)}`)),
									headers: {
										link: '<https://huggingface.co/api/organizations/huggingface/members?cursor=abc&limit=10>; rel="next"',
									},
								},
				},
				{ hfToken: 'hf_secret' }
			);
			const followers = await callPtcTool(tool('hf_follow_graph'), { handle: 'EvalState', kind: 'user' }, ctx);
			expect(followers.structured.items).toEqual([expect.objectContaining({ id: 'fan' })]);
			const likes = await callPtcTool(tool('hf_user_likes'), { handle: 'EvalState' }, ctx);
			expect(likes.structured.items).toEqual([expect.objectContaining({ id: 'a/b' })]);
			const members = await callPtcTool(tool('hf_org_members'), { handle: 'HuggingFace', limit: 10 }, ctx);
			expect(members.structured.items).toHaveLength(10);
			const more = await callPtcTool(
				tool('hf_org_members'),
				{ handle: 'HuggingFace', limit: 10, cursor: members.structured.nextCursor },
				ctx
			);
			expect(more.structured.items).toEqual([expect.objectContaining({ id: 'last' })]);
			const fetch = ctx.fetch as unknown as { mock: { calls: [unknown, RequestInit][] } };
			for (const [, init] of fetch.mock.calls)
				expect(new Headers(init.headers).get('authorization')).toBe('Bearer hf_secret');
			expect(urls.filter((u) => u.pathname === '/api/organizations/huggingface/members')).toHaveLength(2);
		});

		it('accepts a next Link that names the organization in its canonical case', async () => {
			const { ctx } = mockCtx({
				'/api/users/HuggingFace/followers': { status: 404, body: {} },
				'/api/organizations/HuggingFace/followers': (url) =>
					url.searchParams.get('cursor')
						? { body: [member('b')] }
						: {
								body: [member('a')],
								headers: {
									link: `<https://huggingface.co/api/organizations/huggingface/followers?${url.searchParams.toString()}&cursor=c1>; rel="next"`,
								},
							},
			});
			const first = await callPtcTool(tool('hf_follow_graph'), { handle: 'HuggingFace', limit: 1 }, ctx);
			expect(first.structured.nextCursor).toEqual(expect.any(String));
		});

		it('continues an auto-detected organization with its nextCursor', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/huggingface/followers': { status: 404, body: {} },
				'/api/organizations/huggingface/followers': (url) =>
					url.searchParams.get('cursor')
						? { body: [member('b')] }
						: {
								body: [member('a')],
								headers: {
									link: `<https://huggingface.co/api/organizations/huggingface/followers?${url.searchParams.toString()}&cursor=c1>; rel="next"`,
								},
							},
			});
			const args = { handle: 'huggingface', limit: 1 };
			const first = await callPtcTool(tool('hf_follow_graph'), args, ctx);
			const cursor = first.structured.nextCursor as string;
			const second = await callPtcTool(tool('hf_follow_graph'), { ...args, cursor }, ctx);
			expect(second.structured.items).toEqual([expect.objectContaining({ id: 'b' })]);
			expect(urls.slice(2).map((u) => `${u.pathname}?${u.searchParams.get('cursor') ?? ''}`)).toEqual([
				'/api/organizations/huggingface/followers?c1',
			]);
		});

		it('does not follow a redirect that changes more than the letter case', async () => {
			const { ctx } = mockCtx({
				'/api/users/someone/overview': { status: 307, text: '', headers: { location: '/api/users/other/overview' } },
			});
			const r = await callPtcTool(tool('hf_profile_get'), { handles: ['someone'], kind: 'user' }, ctx);
			expect(r.structured.items).toEqual([
				expect.objectContaining({
					ref: 'someone',
					error: expect.objectContaining({ code: 'UPSTREAM_HTTP' }) as unknown,
				}),
			]);
		});

		it('retries the case-sensitive activity feed with the canonical name', async () => {
			resetPersonCaseCache();
			const { ctx } = mockCtx({
				'/api/recent-activity': (url) =>
					url.searchParams.get('entity') === 'evalstate'
						? {
								body: {
									recentActivity: [{ time: 't', user: 'evalstate', type: 'like', repoId: 'a/b', repoType: 'model' }],
								},
							}
						: { status: 404, body: { error: 'User not found' } },
				'/api/users/EVALSTATE/overview': recase('/api/users/evalstate/overview'),
				'/api/users/evalstate/overview': { body: { ...userOverview, user: 'evalstate' } },
			});
			const r = await callPtcTool(tool('hf_activity'), { handle: 'EVALSTATE' }, ctx);
			expect(r.structured.items).toHaveLength(1);
		});

		it('scans an owner with the canonical name (listing author= is case-sensitive)', async () => {
			const { ctx, urls } = mockCtx({
				'/api/users/qwen/overview': { status: 404, body: {} },
				'/api/organizations/qwen/overview': {
					body: { ...orgOverview, name: 'Qwen', numSpaces: 0, numDatasets: 0, numModels: 1 },
				},
				'/api/models': (url) => ({
					body: url.searchParams.get('author') === 'Qwen' ? [{ id: 'Qwen/m', likes: 1 }] : [],
				}),
				'/api/datasets': { body: [] },
				'/api/spaces': { body: [] },
				'/api/models/Qwen/m/discussions': {
					body: { discussions: [discussionRow(1, { repo: { name: 'Qwen/m', type: 'model' } })], count: 1 },
				},
			});
			const r = await callPtcTool(tool('hf_discussions_list'), { owner: 'qwen' }, ctx);
			expect(r.structured.items).toHaveLength(1);
			expect(urls.find((u) => u.pathname === '/api/models')?.searchParams.get('author')).toBe('Qwen');
		});
	});

	it('changedFilesFromDiff detects added, deleted, modified and renamed files', () => {
		const diff = [
			'diff --git a/x.txt b/x.txt',
			'deleted file mode 100644',
			'diff --git a/README.md b/README.md',
			'index 1..2 100644',
			'diff --git a/old.py b/new.py',
			'similarity index 90%',
		].join('\n');
		expect(changedFilesFromDiff(diff)).toEqual([
			{ path: 'x.txt', change: 'deleted' },
			{ path: 'README.md', change: 'modified' },
			{ path: 'new.py', change: 'renamed', from: 'old.py' },
		]);
	});

	it('changedFilesFromDiff parses quoted (octal UTF-8) paths, spaces and renames', () => {
		const diff = [
			String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
			'new file mode 100644',
			'--- /dev/null',
			String.raw`+++ "b/caf\303\251.txt"`,
			'@@ -0,0 +1 @@',
			'+--- a/not-a-header',
			'diff --git a/my file.txt b/my file.txt',
			'index 1..2 100644',
			'--- a/my file.txt\t',
			'+++ b/my file.txt\t',
			'diff --git a/dir b/x.txt b/dir b/x.txt',
			'index 1..2 100644',
			'diff --git a/old name.md b/new name.md',
			'similarity index 100%',
			'rename from old name.md',
			'rename to new name.md',
			String.raw`diff --git a/plain.txt "b/tab\there \"q\".txt"`,
			'similarity index 100%',
			'rename from plain.txt',
			String.raw`rename to "tab\there \"q\".txt"`,
			String.raw`diff --git "a/gone \344\275\240.bin" "b/gone \344\275\240.bin"`,
			'deleted file mode 100644',
			'Binary files differ',
		].join('\n');
		expect(changedFilesFromDiff(diff)).toEqual([
			{ path: 'café.txt', change: 'added' },
			{ path: 'my file.txt', change: 'modified' },
			{ path: 'dir b/x.txt', change: 'modified' },
			{ path: 'new name.md', change: 'renamed', from: 'old name.md' },
			{ path: 'tab\there "q".txt', change: 'renamed', from: 'plain.txt' },
			{ path: 'gone 你.bin', change: 'deleted' },
		]);
	});
});
