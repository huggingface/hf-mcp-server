import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalHttpsPolicy, createHfDocsPolicy } from './url-policy.js';
import { safeFetch } from './safe-fetch.js';

describe('safeFetch', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it('follows redirects manually and validates each hop', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/docs/next' } }))
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await safeFetch('https://huggingface.co/docs/start', {
			urlPolicy: createHfDocsPolicy(),
			externalOnly: true,
		});

		expect(result.redirectsFollowed).toBe(1);
		expect(result.finalUrl.toString()).toBe('https://huggingface.co/docs/next');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://huggingface.co/docs/start');
		expect(fetchMock.mock.calls[1]?.[0]).toBe('https://huggingface.co/docs/next');
	});

	it('rejects redirect to disallowed host', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://example.com/path' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			safeFetch('https://huggingface.co/docs/start', {
				urlPolicy: createHfDocsPolicy(),
				externalOnly: true,
			})
		).rejects.toThrow('URL hostname is not allowed');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('enforces redirect limits', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/docs/a' } }))
			.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/docs/b' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			safeFetch('https://huggingface.co/docs/start', {
				urlPolicy: createHfDocsPolicy(),
				maxRedirects: 1,
			})
		).rejects.toThrow('Redirect limit exceeded');
	});

	it('enforces timeout', async () => {
		const fetchMock = vi.fn().mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_, reject) => {
					const signal = init?.signal;
					signal?.addEventListener(
						'abort',
						() => {
							reject(new DOMException('aborted', 'AbortError'));
						},
						{ once: true }
					);
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			safeFetch('https://example.com/file.wav', {
				urlPolicy: createExternalHttpsPolicy(),
				timeoutMs: 5,
			})
		).rejects.toThrow('Request timed out');
	});

	it('keeps caller abort signal active while streaming response body', async () => {
		const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener(
						'abort',
						() => {
							controller.error(new DOMException('aborted', 'AbortError'));
						},
						{ once: true }
					);
				},
				pull() {
					return new Promise<void>(() => {});
				},
			});

			return Promise.resolve(new Response(stream, { status: 200 }));
		});
		vi.stubGlobal('fetch', fetchMock);

		const controller = new AbortController();
		const { response } = await safeFetch('https://example.com/file.wav', {
			urlPolicy: createExternalHttpsPolicy(),
			timeoutMs: 500,
			requestInit: { signal: controller.signal },
		});

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Expected response body to exist');
		}

		const readPromise = Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error('stream read did not abort'));
				}, 100);
			}),
		]);
		controller.abort();

		await expect(readPromise).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('enforces timeout while streaming response body', async () => {
		const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener(
						'abort',
						() => {
							controller.error(new DOMException('aborted', 'AbortError'));
						},
						{ once: true }
					);
				},
				pull() {
					return new Promise<void>(() => {});
				},
			});

			return Promise.resolve(new Response(stream, { status: 200 }));
		});
		vi.stubGlobal('fetch', fetchMock);

		const { response } = await safeFetch('https://example.com/file.wav', {
			urlPolicy: createExternalHttpsPolicy(),
			timeoutMs: 10,
		});

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Expected response body to exist');
		}

		const readPromise = Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error('stream read did not timeout'));
				}, 200);
			}),
		]);

		await expect(readPromise).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('blocks internal destinations when externalOnly is enabled', async () => {
		await expect(
			safeFetch('https://127.0.0.1/x', {
				urlPolicy: createExternalHttpsPolicy(),
				externalOnly: true,
			})
		).rejects.toThrow('Blocked internal or reserved address');
	});
});
