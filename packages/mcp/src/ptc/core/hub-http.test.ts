import { describe, expect, it, vi } from 'vitest';
import { caseOnlyRedirect, hubFetch } from './hub-http.js';

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
