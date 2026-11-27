import { describe, expect, it, vi } from 'vitest';
import { fileItem, parsePaperRef, parseRef, repoItem, repoUri, repoUrl, type RepoKind } from './refs.js';
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

describe('uri round-trips (legacy single-segment and owner/name IDs)', () => {
	const cases: [RepoKind, string][] = [
		['model', 'gpt2'],
		['model', 'openai-community/gpt2'],
		['dataset', 'squad'],
		['dataset', 'rajpurkar/squad'],
		['space', 'o/s'],
		['bucket', 'o/b'],
	];
	it.each(cases)('%s %s: root and file, with and without revision', (kind, id) => {
		const legacy = !id.includes('/');
		for (const revision of [undefined, 'v1.0', 'refs/pr/3']) {
			if (kind === 'bucket' && revision) continue;
			for (const path of ['', 'config.json', 'dir/a b.json']) {
				const uri = repoUri(kind, id, revision, path);
				const expected = revision ?? (legacy && path ? 'main' : undefined);
				expect(parseRef(uri), uri).toEqual({ kind, id, ...(expected ? { revision: expected } : {}), path });
				// Re-emitting the parsed ref is a fixed point.
				const parsed = parseRef(uri);
				expect(repoUri(kind, parsed.id, parsed.revision, parsed.path)).toBe(uri);
			}
		}
		expect(parseRef(repoItem(kind, id).uri)).toMatchObject({ kind, id, path: '' });
		expect(parseRef(fileItem(kind, id, 'a/b.txt', 'file').uri)).toMatchObject({ kind, id, path: 'a/b.txt' });
	});

	it('writes legacy file uris with an explicit revision and keeps owner/name unambiguous', () => {
		expect(repoUri('model', 'gpt2', undefined, 'config.json')).toBe('hf://models/gpt2@main/config.json');
		expect(repoUri('model', 'gpt2')).toBe('hf://models/gpt2');
		expect(parseRef('hf://models/gpt2/config.json')).toEqual({ kind: 'model', id: 'gpt2/config.json', path: '' });
		expect(parseRef('hf://datasets/squad@main/plain_text/train.parquet')).toEqual({
			kind: 'dataset',
			id: 'squad',
			revision: 'main',
			path: 'plain_text/train.parquet',
		});
		expect(() => parseRef('hf://spaces/s@main/app.py')).toThrow(PtcError);
	});

	it('parses the web urls emitted for legacy ids with a path, and datasets roots', () => {
		for (const [kind, id] of [
			['model', 'gpt2'],
			['dataset', 'squad'],
		] as const) {
			expect(parseRef(repoUrl(kind, id, undefined, 'config.json'))).toEqual({ kind, id, path: 'config.json' });
			expect(parseRef(repoUrl(kind, id, 'v1', 'dir', true))).toEqual({ kind, id, revision: 'v1', path: 'dir' });
		}
		expect(parseRef('https://huggingface.co/datasets/squad')).toEqual({ kind: 'dataset', id: 'squad', path: '' });
		// A bare one-segment page is usually a user or organization profile.
		expect(() => parseRef('https://huggingface.co/gpt2')).toThrow(PtcError);
	});
});

describe('/raw/ URLs and singular hf:// roots', () => {
	it('parses /raw/ Hub URLs alongside blob/resolve/tree', () => {
		expect(parseRef('https://huggingface.co/LiquidAI/LFM2.5-24B-A2B/raw/main/README.md')).toEqual({
			kind: 'model',
			id: 'LiquidAI/LFM2.5-24B-A2B',
			path: 'README.md',
		});
		expect(parseRef('https://huggingface.co/datasets/org/ds/raw/v1/dir/file.csv')).toEqual({
			kind: 'dataset',
			id: 'org/ds',
			revision: 'v1',
			path: 'dir/file.csv',
		});
		expect(parseRef('https://huggingface.co/gpt2/raw/main/config.json')).toEqual({
			kind: 'model',
			id: 'gpt2',
			path: 'config.json',
		});
	});

	it('accepts singular hf:// roots without affecting web URL usernames', () => {
		expect(parseRef('hf://model/org/m/README.md')).toEqual({ kind: 'model', id: 'org/m', path: 'README.md' });
		expect(parseRef('hf://dataset/org/ds/data.parquet')).toEqual({
			kind: 'dataset',
			id: 'org/ds',
			path: 'data.parquet',
		});
		expect(parseRef('hf://space/org/sp/app.py')).toEqual({ kind: 'space', id: 'org/sp', path: 'app.py' });
		expect(parseRef('hf://bucket/org/bk/out.json')).toEqual({ kind: 'bucket', id: 'org/bk', path: 'out.json' });
		// On web URLs, /dataset/... stays a model owned by user "dataset" (Hub web routes are plural).
		expect(parseRef('https://huggingface.co/dataset/my-model')).toEqual({
			kind: 'model',
			id: 'dataset/my-model',
			path: '',
		});
	});
});

describe('paper refs', () => {
	it.each([
		'2106.09685',
		'2106.09685v2',
		'hf://papers/2106.09685',
		'arxiv:2106.09685',
		'arXiv:2106.09685v3',
		'https://huggingface.co/papers/2106.09685',
		'https://huggingface.co/papers/2106.09685#community',
		'https://arxiv.org/abs/2106.09685',
		'https://arxiv.org/abs/2106.09685v2',
		'https://arxiv.org/pdf/2106.09685v2.pdf',
		'https://arxiv.org/pdf/2106.09685',
		'  2106.09685  ',
	])('accepts %s', (ref) => {
		expect(parsePaperRef(ref)).toBe('2106.09685');
	});

	it.each([
		'https://evil.example/2106.09685oops',
		'https://evil.example/papers/2106.09685',
		'https://huggingface.co.evil.example/papers/2106.09685',
		'http://arxiv.org/abs/2106.09685',
		'https://arxiv.org/abs/2106.09685oops',
		'https://huggingface.co/2106.09685',
		'2106.09685oops',
		'x2106.09685',
		'hf://papers/2106.09685/extra',
		'paper 2106.09685',
		'',
	])('rejects %s', (ref) => {
		expect(() => parsePaperRef(ref)).toThrow(PtcError);
	});
});
