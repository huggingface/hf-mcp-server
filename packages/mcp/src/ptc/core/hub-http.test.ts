import { describe, expect, it, vi } from 'vitest';
import { caseOnlyRedirect, hubFetch, openCursor, repoMove, requestPage, sealCursor } from './hub-http.js';

describe('canonical-case redirects', () => {
	const from = new URL('https://huggingface.co/api/users/EVALSTATE/overview?x=1');

	it('accepts only same-origin 307/308 redirects that change letter case alone', () => {
		expect(caseOnlyRedirect(from, 307, '/api/users/evalstate/overview?x=1')?.pathname).toBe(
			'/api/users/evalstate/overview'
		);
		expect(caseOnlyRedirect(from, 308, 'https://huggingface.co/api/users/evalstate/overview?x=1')).toBeDefined();
		expect(caseOnlyRedirect(from, 302, '/api/users/evalstate/overview?x=1')).toBeUndefined();
		expect(caseOnlyRedirect(from, 307, '/api/users/other/overview?x=1')).toBeUndefined();
		expect(caseOnlyRedirect(from, 307, '/api/users/evalstate/overview?x=2')).toBeUndefined();
		expect(caseOnlyRedirect(from, 307, 'https://hf.co/api/users/evalstate/overview?x=1')).toBeUndefined();
		expect(caseOnlyRedirect(from, 307, 'https://evil.example/api/users/evalstate/overview?x=1')).toBeUndefined();
		expect(caseOnlyRedirect(from, 307, null)).toBeUndefined();
	});

	it('hubFetch follows it with method, body and token, and stops after two hops', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>((input) => {
			const url = new URL(input as string);
			if (url.pathname === '/api/jobs/EvalState')
				return Promise.resolve(new Response(null, { status: 307, headers: { location: '/api/jobs/evalstate' } }));
			if (url.pathname === '/api/jobs/evalstate') return Promise.resolve(Response.json({ ok: true }));
			// A loop of case flips is cut off.
			const flipped = url.pathname === '/api/loop/A' ? '/api/loop/a' : '/api/loop/A';
			return Promise.resolve(new Response(null, { status: 307, headers: { location: flipped } }));
		});
		const r = await hubFetch(
			{ path: '/api/jobs/EvalState', method: 'POST', body: { a: 1 } },
			{ fetch, hfToken: 'hf_x' }
		);
		expect(r.data).toEqual({ ok: true });
		const [, init] = fetch.mock.calls[1] ?? [];
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe('{"a":1}');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hf_x');
		await expect(hubFetch({ path: '/api/loop/A' }, { fetch })).rejects.toMatchObject({ code: 'UPSTREAM_HTTP' });
	});
});

describe('repository move redirects', () => {
	const from = new URL('https://huggingface.co/api/datasets/CohereForAI/aya_dataset/tree/main?limit=1');

	it('recognizes a same-route redirect to a new owner/name', () => {
		expect(repoMove(from, 307, '/api/datasets/CohereLabs/aya_dataset/tree/main?limit=1')).toEqual({
			kind: 'dataset',
			from: 'CohereForAI/aya_dataset',
			to: 'CohereLabs/aya_dataset',
		});
		expect(
			repoMove(new URL('https://huggingface.co/api/models/gpt2'), 308, '/api/models/openai-community/gpt2')
		).toEqual({
			kind: 'model',
			from: 'gpt2',
			to: 'openai-community/gpt2',
		});
	});

	it('ignores other redirects', () => {
		expect(repoMove(from, 302, '/api/datasets/CohereLabs/aya_dataset/tree/main?limit=1')).toBeUndefined();
		expect(repoMove(from, 307, '/api/datasets/CohereLabs/aya_dataset/tree/dev?limit=1')).toBeUndefined();
		expect(repoMove(from, 307, '/api/models/CohereLabs/aya_dataset/tree/main?limit=1')).toBeUndefined();
		expect(repoMove(from, 307, '/api/datasets/CohereLabs/aya_dataset/tree/main?limit=2')).toBeUndefined();
		expect(repoMove(from, 307, 'https://evil.example/api/datasets/a/b/tree/main?limit=1')).toBeUndefined();
		expect(repoMove(new URL('https://huggingface.co/api/buckets/a/b'), 307, '/api/buckets/c/d')).toBeUndefined();
	});
});

describe('hubFetch body deadline', () => {
	/** A 200 response that sends one chunk and then stalls until cancelled. */
	function stalling(): Response {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"partial": tr'));
			},
		});
		return new Response(body, { status: 200 });
	}

	it.each(['text', 'json', 'bytes'] as const)('never returns a partial %s body when the timeout fires', async (as) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(stalling());
		await expect(hubFetch({ path: '/api/x', as, timeoutMs: 20 }, { fetch })).rejects.toMatchObject({
			code: 'UPSTREAM_UNAVAILABLE',
			retryable: true,
		});
	});

	it('reports CANCELLED when the caller aborts during the body read', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(stalling());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await expect(hubFetch({ path: '/api/x', as: 'text' }, { fetch, signal: controller.signal })).rejects.toMatchObject({
			code: 'CANCELLED',
		});
	});
});

describe('sealed cursors', () => {
	const binding = ['hf_tool', { query: 'x' }];
	const decode = (cursor: string) =>
		JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: number; s: string; m: string };
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const rejects = (fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			expect(error).toMatchObject({ code: 'INVALID_CURSOR' });
			expect((error as Error).message).toContain('repeat the call without cursor');
			return;
		}
		throw new Error('expected INVALID_CURSOR');
	};

	it('round-trips opaque base64url state without exposing the token', () => {
		const cursor = sealCursor(binding, { hfToken: 'hf_secret_token' }, '40');
		expect(cursor).toMatch(/^[\w-]+$/);
		expect(Buffer.from(cursor, 'base64url').toString()).not.toContain('hf_secret_token');
		expect(openCursor(cursor, binding, { hfToken: 'hf_secret_token' })).toBe('40');
		expect(openCursor(undefined, binding, {})).toBeUndefined();
	});

	it('rejects edited state, a wrong token and a wrong binding', () => {
		const cursor = sealCursor(binding, { hfToken: 'a' }, '40');
		const tampered = encode({ ...decode(cursor), s: '4000' });
		rejects(() => openCursor(tampered, binding, { hfToken: 'a' }));
		rejects(() => openCursor(cursor, binding, { hfToken: 'b' }));
		rejects(() => openCursor(cursor, binding, {}));
		rejects(() => openCursor(cursor, ['hf_tool', { query: 'y' }], { hfToken: 'a' }));
		rejects(() => openCursor(encode({ v: 1, query: 'x'.repeat(64), cursor: '40' }), binding, {}));
		rejects(() => openCursor('not base64!', binding, {}));
	});

	it('keeps cursors valid across processes, and keyed by PTC_CURSOR_SECRET when set', async () => {
		const cursor = sealCursor(binding, {}, '40');
		vi.resetModules();
		const other = await import('./hub-http.js');
		expect(other.openCursor(cursor, binding, {})).toBe('40');

		vi.stubEnv('PTC_CURSOR_SECRET', 'shared-secret-for-tests');
		try {
			vi.resetModules();
			const first = await import('./hub-http.js');
			const shared = first.sealCursor(binding, {}, '40');
			vi.resetModules();
			const second = await import('./hub-http.js');
			expect(second.openCursor(shared, binding, {})).toBe('40');
			// A cursor signed with the built-in key is not valid under a configured secret.
			expect(() => second.openCursor(cursor, binding, {})).toThrow(/expired, is from another server/);
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});

	it('binds Link-paginated page cursors to the query and token', async () => {
		const page = (link?: string) => Promise.resolve(Response.json([], link ? { headers: { link } } : undefined));
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(() => page('<https://huggingface.co/api/models?limit=2&cursor=abc>; rel="next"'))
			.mockImplementation(() => page());
		const params = new URLSearchParams({ limit: '2' });
		const first = await requestPage('/api/models', params, undefined, { fetch, hfToken: 't' });
		expect(first.nextCursor).toMatch(/^[\w-]+$/);
		await requestPage('/api/models', params, first.nextCursor ?? undefined, { fetch, hfToken: 't' });
		expect(new URL(fetch.mock.calls[1]?.[0] as string).searchParams.get('cursor')).toBe('abc');
		const tampered = Buffer.from(JSON.stringify({ ...decode(first.nextCursor ?? ''), s: 'other' })).toString(
			'base64url'
		);
		for (const [cursor, token, query] of [
			[tampered, 't', params],
			[first.nextCursor, 'u', params],
			[first.nextCursor, 't', new URLSearchParams({ limit: '3' })],
		] as const) {
			await expect(
				requestPage('/api/models', query, cursor ?? undefined, { fetch, hfToken: token })
			).rejects.toMatchObject({
				code: 'INVALID_CURSOR',
			});
		}
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('accepts %2F-encoded nested tree paths in Link headers while rejecting path changes', async () => {
		const params = new URLSearchParams({ expand: 'false', recursive: 'false', limit: '5' });
		const treePath = '/api/datasets/evalstate/hf-mcp-logs/tree/main/sessions/2026-11-25';
		const encodedNext =
			'<https://huggingface.co/api/datasets/evalstate/hf-mcp-logs/tree/main/sessions%2F2026-11-25?expand=false&recursive=false&limit=5&cursor=page2>; rel="next"';
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(() => Promise.resolve(Response.json([], { headers: { link: encodedNext } })))
			.mockImplementationOnce(() => Promise.resolve(Response.json([])));
		const first = await requestPage(treePath, params, undefined, { fetch, hfToken: 't' });
		expect(first.nextCursor).toMatch(/^[\w-]+$/);
		const second = await requestPage(treePath, params, first.nextCursor ?? undefined, { fetch, hfToken: 't' });
		expect(second.nextCursor).toBeNull();
		expect(new URL(fetch.mock.calls[1]?.[0] as string).pathname).toBe(treePath);

		const wrongPathFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json([], {
				headers: {
					link: '<https://huggingface.co/api/datasets/evalstate/hf-mcp-logs/tree/main/sessions%2F2026-11-26?expand=false&recursive=false&limit=5&cursor=page2>; rel="next"',
				},
			})
		);
		await expect(requestPage(treePath, params, undefined, { fetch: wrongPathFetch, hfToken: 't' })).rejects.toThrow(
			/unsafe or changed upstream pagination/
		);
	});
});
