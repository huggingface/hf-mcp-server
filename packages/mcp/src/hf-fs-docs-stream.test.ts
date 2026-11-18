import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HfFsDocsProvider } from './hf-fs-docs.js';
import type { HfFsCatResult } from './hf-fs.js';
import { sliceUtf8 } from './hf-fs-guidance.js';

const HARD_CAP = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const HUGE_HEAD = '# Huge\n\n## Intro[[intro]]\n\nShort intro.\n\n## Rest\n\n';
const UTF8_PAGE = `# Ünïcödé\n\n${'é€😀a'.repeat(5_000)}\n`;

// Bytes produced by the endless page (the stream may pull one chunk ahead of the reader).
let pulled = 0;
let requests: string[] = [];
let pendingSignals: AbortSignal[] = [];

/** An endless markdown page: the provider must stop reading at its byte cap. */
function hugeBody(): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let first = true;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = first ? `${HUGE_HEAD}${'x'.repeat(CHUNK - HUGE_HEAD.length - 1)}\n` : `${'y'.repeat(CHUNK - 1)}\n`;
			first = false;
			const bytes = encoder.encode(chunk);
			pulled += bytes.byteLength;
			if (pulled > 64 * 1024 * 1024) controller.error(new Error('read far past the cap'));
			else controller.enqueue(bytes);
		},
	});
}

/** Stream a body in tiny chunks so multi-byte characters straddle chunk boundaries. */
function chunkedBody(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let position = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (position >= bytes.byteLength) return controller.close();
			controller.enqueue(bytes.slice(position, position + size));
			position += size;
		},
	});
}

const markdown = { 'content-type': 'text/markdown; charset=utf-8' };

function route(url: URL, init: RequestInit | undefined): Response | Promise<Response> {
	switch (url.pathname) {
		case '/api/docs':
			return Response.json([{ id: 'big', url: '/docs/big', category: 'Test' }]);
		case '/docs/big/llms.txt':
			return new Response(
				`# Big
- [Huge](https://huggingface.co/docs/big/v2.0.0/huge.md)
- [Unicode](https://huggingface.co/docs/big/v2.0.0/utf8.md)
- [Quicktour](https://huggingface.co/docs/big/v2.0.0/quicktour.md)
- [Hang](https://huggingface.co/docs/big/v2.0.0/hang.md)
- [Stall](https://huggingface.co/docs/big/v2.0.0/stall.md)`,
				{ headers: { 'content-type': 'text/plain' } }
			);
		case '/docs/big/v2.0.0/huge.md':
			return new Response(hugeBody(), { headers: markdown });
		case '/docs/big/v2.0.0/utf8.md':
			return new Response(chunkedBody(UTF8_PAGE, 7), { headers: markdown });
		case '/docs/big/v2.0.0/quicktour.md':
			return new Response('# Quicktour\n\nCurrent.\n', { headers: markdown });
		case '/docs/big/v1.0.0/en/quicktour.md':
			return new Response('# Quicktour\n\nOld v1.\n', { headers: markdown });
		case '/docs/big/v2.0.0/hang.md':
			// Never answers: only an abort can end this request.
			if (init?.signal) pendingSignals.push(init.signal);
			return new Promise<Response>(() => undefined);
		case '/docs/big/v2.0.0/stall.md': {
			if (init?.signal) pendingSignals.push(init.signal);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('# Stall\n'));
				},
			});
			return new Response(body, { headers: markdown });
		}
		default:
			return new Response('<html>missing</html>', { status: 404, headers: { 'content-type': 'text/html' } });
	}
}

beforeEach(() => {
	pulled = 0;
	requests = [];
	pendingSignals = [];
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>((input, init) => {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			requests.push(url.pathname);
			return Promise.resolve(route(url, init));
		})
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

async function cat(provider: HfFsDocsProvider, uri: string, extra: { offset?: number; max_bytes?: number } = {}) {
	return (await provider.run({ op: 'cat', uri, ...extra })) as HfFsCatResult;
}

describe('HfFsDocsProvider page streaming', () => {
	it('reads only offset + max_bytes (plus a small margin) of a page larger than the cap', async () => {
		const provider = new HfFsDocsProvider();
		const first = await cat(provider, 'hf://docs/big/v2.0.0/huge.md', { max_bytes: 100 });
		expect(first).toMatchObject({ bytes: 100, truncated: true, truncation_reason: 'max_bytes', next_offset: 100 });
		expect(first.content.startsWith('# Huge')).toBe(true);
		expect(pulled).toBeLessThanOrEqual(2 * CHUNK);

		pulled = 0;
		const later = await cat(provider, 'hf://docs/big/v2.0.0/huge.md', { offset: 3 * CHUNK + 5, max_bytes: 50 });
		expect(later).toMatchObject({ bytes: 50, truncated: true, next_offset: 3 * CHUNK + 55 });
		expect(later.content).toBe('y'.repeat(50));
		expect(pulled).toBeLessThanOrEqual(5 * CHUNK);
	});

	it('fails safely when the requested range or section lies beyond the hard cap', async () => {
		const provider = new HfFsDocsProvider();
		await expect(
			cat(provider, 'hf://docs/big/v2.0.0/huge.md', { offset: HARD_CAP - 10, max_bytes: 100 })
		).rejects.toThrow(/^EFBIG: .*read limit/);
		expect(pulled).toBeLessThanOrEqual(HARD_CAP + 2 * CHUNK);

		// A section that ends inside the capped prefix is still served.
		pulled = 0;
		const intro = await cat(provider, 'hf://docs/big/v2.0.0/huge.md#intro');
		expect(intro).toMatchObject({ section: 'Intro', content: '## Intro[[intro]]\n\nShort intro.', truncated: false });
		expect(pulled).toBeLessThanOrEqual(HARD_CAP + 2 * CHUNK);

		// A section running past the cap (or not found within it) is refused, not silently cut.
		await expect(cat(provider, 'hf://docs/big/v2.0.0/huge.md#rest')).rejects.toThrow(
			/^EFBIG: .*section '#rest' does not end within it/
		);
		await expect(cat(provider, 'hf://docs/big/v2.0.0/huge.md#missing')).rejects.toThrow(/^EFBIG: /);
	});

	it('keeps byte offsets exact across UTF-8 characters split between chunks', async () => {
		const provider = new HfFsDocsProvider();
		for (const [offset, maxBytes] of [
			[0, 13],
			[14, 1],
			[15, 6],
			[1000, 333],
			[45_000, 40_000],
			[200_000, 10],
		] as const) {
			const result = await cat(provider, 'hf://docs/big/v2.0.0/utf8.md', { offset, max_bytes: maxBytes });
			const expected = sliceUtf8(UTF8_PAGE, offset, maxBytes);
			expect(result.content).toBe(expected.content);
			expect(result.bytes).toBe(expected.bytes);
			expect(result.truncated).toBe(expected.truncated);
			expect(result.next_offset).toBe(expected.nextOffset);
		}
	});
});

describe('HfFsDocsProvider cancellation', () => {
	it('rejects promptly and aborts the in-flight page fetch', async () => {
		const controller = new AbortController();
		const provider = new HfFsDocsProvider(undefined, { signal: controller.signal });
		const pending = cat(provider, 'hf://docs/big/v2.0.0/hang.md');
		await vi.waitFor(() => expect(pendingSignals).toHaveLength(1));
		const started = Date.now();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(pendingSignals[0]?.aborted).toBe(true);
	});

	it('aborts while streaming the page body', async () => {
		const controller = new AbortController();
		const provider = new HfFsDocsProvider(undefined, { signal: controller.signal });
		const pending = cat(provider, 'hf://docs/big/v2.0.0/stall.md');
		await vi.waitFor(() => expect(pendingSignals).toHaveLength(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(pendingSignals[0]?.aborted).toBe(true);
	});

	it('does not fetch at all with an already aborted signal', async () => {
		const provider = new HfFsDocsProvider(undefined, { signal: AbortSignal.abort() });
		await expect(provider.run({ op: 'search', uri: 'hf://docs/big', query: 'x' })).rejects.toMatchObject({
			name: 'AbortError',
		});
		await expect(cat(provider, 'hf://docs/big/v2.0.0/quicktour.md')).rejects.toMatchObject({ name: 'AbortError' });
		expect(requests).toEqual([]);
	});

	it('passes the signal to search requests and stops waiting on shared manifest loads', async () => {
		const controller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>((input, init) => {
				const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				if (url.pathname.startsWith('/api/docs/search')) {
					signals.push(init?.signal ?? undefined);
					return new Promise<Response>(() => undefined);
				}
				return Promise.resolve(route(url, init));
			})
		);
		const provider = new HfFsDocsProvider(undefined, { signal: controller.signal });
		const pending = provider.run({ op: 'search', uri: 'hf://docs/big', query: 'quicktour' });
		await vi.waitFor(() => expect(signals).toHaveLength(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(signals[0]?.aborted).toBe(true);
	});
});

describe('HfFsDocsProvider pinned versions', () => {
	it('legacy hf_fs (no resolveUnversioned) never maps or fetches a pinned version', async () => {
		const provider = new HfFsDocsProvider();
		await expect(cat(provider, 'hf://docs/big/v1.0.0/en/quicktour.md')).rejects.toThrow(/^ENOENT: /);
		expect(requests).not.toContain('/docs/big/v1.0.0/en/quicktour.md');
	});

	it('resolveUnversioned reads a pinned version directly and keeps its uri', async () => {
		const provider = new HfFsDocsProvider(undefined, { resolveUnversioned: true });
		await expect(cat(provider, 'hf://docs/big/v1.0.0/en/quicktour.md')).resolves.toMatchObject({
			uri: 'hf://docs/big/v1.0.0/en/quicktour.md',
			path: 'v1.0.0/en/quicktour.md',
			content: '# Quicktour\n\nOld v1.\n',
		});
		await expect(cat(provider, 'hf://docs/big/v0.1.0/en/quicktour.md')).rejects.toThrow(
			'only the current docs version v2.0.0 (English) is indexed. Use: hf://docs/big/v2.0.0/quicktour.md'
		);
		await expect(cat(provider, 'hf://docs/big/v2.0.0/en/quicktour.md')).resolves.toMatchObject({
			uri: 'hf://docs/big/v2.0.0/quicktour.md',
			content: '# Quicktour\n\nCurrent.\n',
		});
	});
});
