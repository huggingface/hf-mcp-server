import { describe, expect, it, vi } from 'vitest';
import { parseRef, repoUri } from './refs.js';
import { hubFetch, isAllowedRedirectTarget } from './hub-http.js';
import { PtcError } from './errors.js';

describe('ref parsing safety', () => {
	it.each([
		'hf://models/o/r/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fapi/whoami-v2',
		'hf://models/o/r/a/%2e%2e/b',
		'hf://models/o/r/..%2fx',
		'hf://datasets/o/r/a%5c..%5cb',
		'hf://models/o/r/a%00b',
		'https://huggingface.co/o/r/blob/main/%2e%2e%2fapi%2fwhoami-v2',
		'hf://models/../api',
	])('rejects traversal or separators smuggled in a segment: %s', (ref) => {
		expect(() => parseRef(ref)).toThrow(PtcError);
	});

	it('accepts legacy unnamespaced model URIs that repoUri emits', () => {
		expect(parseRef(repoUri('model', 'gpt2'))).toEqual({ kind: 'model', id: 'gpt2', path: '' });
	});

	it('keeps legitimate encoded names and revisions round-trippable', () => {
		const parsed = parseRef('hf://models/o/r@refs%2Fpr%2F3/dir/a%20b.json');
		expect(parsed).toEqual({ kind: 'model', id: 'o/r', revision: 'refs/pr/3', path: 'dir/a b.json' });
		expect(repoUri('model', 'o/r', 'refs/pr/3', 'dir/a b.json')).toBe('hf://models/o/r@refs%2Fpr%2F3/dir/a%20b.json');
	});
});

describe('hubFetch path guard', () => {
	it('refuses dot-segments before any request is made', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		for (const path of ['/api/models/o/r/../../whoami-v2', '/api/models/%2e%2e/x', '/./api']) {
			await expect(hubFetch({ path }, { fetch, hfToken: 'secret' })).rejects.toMatchObject({
				code: 'INVALID_ARGUMENT',
			});
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('hubFetch redirect policy', () => {
	const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

	it('follows Hugging Face CDN redirects and drops authorization when the host changes', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(redirect('https://cas-bridge.xethub.hf.co/blob?sig=1'))
			.mockResolvedValueOnce(new Response('hello'));
		const result = await hubFetch(
			{ path: '/o/r/resolve/main/a.txt', as: 'text', followRedirects: true },
			{ fetch, hfToken: 'secret' }
		);
		expect(result.data).toBe('hello');
		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret');
		expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBeNull();
		expect(fetch.mock.calls.every((call) => call[1]?.redirect === 'manual')).toBe(true);
	});

	it.each([
		'http://cdn-lfs.hf.co/x',
		'https://169.254.169.254/latest/meta-data',
		'https://localhost/x',
		'https://evil.example/x',
		'https://huggingface.co.evil.example/x',
		'https://user:pass@cdn-lfs.hf.co/x',
	])('refuses redirects to %s', async (location) => {
		expect(isAllowedRedirectTarget(new URL(location))).toBe(false);
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(redirect(location));
		await expect(
			hubFetch({ path: '/o/r/resolve/main/a.txt', as: 'text', followRedirects: true }, { fetch, hfToken: 'secret' })
		).rejects.toBeInstanceOf(PtcError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('stops after a bounded number of hops', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(() => Promise.resolve(redirect('https://huggingface.co/loop')));
		await expect(hubFetch({ path: '/loop', followRedirects: true }, { fetch })).rejects.toThrow('too many');
		expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
	});
});
