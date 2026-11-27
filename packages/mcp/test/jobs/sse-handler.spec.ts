import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJobLogs } from '../../src/jobs/sse-handler.js';
import { safeFetch } from '../../src/network/safe-fetch.js';

vi.mock('../../src/network/safe-fetch.js', () => ({
	safeFetch: vi.fn(),
}));

function createSseResponse(read: () => Promise<ReadableStreamReadResult<Uint8Array>>): Response {
	return {
		ok: true,
		body: {
			getReader: () => ({
				read,
				cancel: vi.fn().mockResolvedValue(undefined),
			}),
		},
	} as unknown as Response;
}

describe('fetchJobLogs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([-1, 0, 1.5, 2001, NaN, Infinity])(
		'rejects invalid maxLines %s before opening a stream',
		async (maxLines) => {
			await expect(fetchJobLogs('https://example.com/logs', { maxLines })).rejects.toThrow(/maxLines/);
			expect(safeFetch).not.toHaveBeenCalled();
		}
	);

	it('treats timeout-aborted SSE reads as expected truncation', async () => {
		const abortedRead = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw new DOMException('The operation was aborted.', 'AbortError');
		};

		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(abortedRead),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});

		const result = await fetchJobLogs('https://example.com/logs', { maxDuration: 1, maxLines: 5 });

		expect(result).toEqual({
			logs: [],
			finished: false,
			truncated: true,
			linesDropped: false,
		});
	});

	it('throws non-timeout stream errors', async () => {
		const failingRead = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
			throw new Error('stream read failed');
		};

		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(failingRead),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});

		await expect(fetchJobLogs('https://example.com/logs', { maxDuration: 100 })).rejects.toThrow('stream read failed');
	});

	it('reports streamed job lifecycle and log events as progress', async () => {
		const encoded = new TextEncoder().encode(
			[
				'data: {"timestamp":"1","data":"===== Job started ====="}',
				'data: {"timestamp":"2","data":"installing dependencies"}',
				'data: {"timestamp":"3","data":"===== Job finished: status=COMPLETED ====="}',
				'',
			].join('\n')
		);
		const read = vi
			.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
			.mockResolvedValueOnce({ done: false, value: encoded })
			.mockResolvedValue({ done: true, value: undefined });
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});
		const onProgress = vi.fn().mockResolvedValue(undefined);

		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 100,
			maxLines: 5,
			onProgress,
		});

		expect(result).toEqual({
			logs: ['installing dependencies', '===== Job finished: status=COMPLETED ====='],
			finished: true,
			truncated: false,
			linesDropped: false,
		});
		expect(onProgress.mock.calls.map(([progress]) => progress.message)).toEqual([
			'Job started.',
			'job: installing dependencies',
			'===== Job finished: status=COMPLETED =====',
		]);
	});

	it('continues consuming logs when a progress callback fails', async () => {
		const encoded = new TextEncoder().encode('data: {"timestamp":"1","data":"still running"}\n');
		const read = vi
			.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
			.mockResolvedValueOnce({ done: false, value: encoded })
			.mockResolvedValue({ done: true, value: undefined });
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});

		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 100,
			onProgress: vi.fn().mockRejectedValue(new Error('Disconnected')),
		});

		expect(result.logs).toEqual(['still running']);
	});
	it('redacts before storing or shortening, and drops old lines to the budget while streaming', async () => {
		const secret = 'hf_sse_secret_value';
		const long = `${'p'.repeat(150)}${secret} tail`;
		const lines = [long, ...Array.from({ length: 50 }, (_, i) => `line ${String(i)} ${'x'.repeat(100)}`)];
		const encoded = new TextEncoder().encode(
			lines.map((data, i) => `data: ${JSON.stringify({ timestamp: String(i), data })}`).join('\n') + '\n'
		);
		const read = vi
			.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
			.mockResolvedValueOnce({ done: false, value: encoded })
			.mockResolvedValue({ done: true, value: undefined });
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});
		const onProgress = vi.fn().mockResolvedValue(undefined);

		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 100,
			maxLines: 1000,
			maxChars: 1_200,
			maxLineChars: 120,
			redact: (text) => text.split(secret).join('<redacted>'),
			onProgress,
		});

		expect(result.linesDropped).toBe(true);
		expect(result.logs.join('\n').length).toBeLessThanOrEqual(1_200 + 200);
		expect(result.logs.at(-1)).toContain('line 49');
		expect(result.logs.every((line) => line.length <= 121)).toBe(true);
		const progress = onProgress.mock.calls.map(([p]) => String(p.message)).join('\n');
		expect(progress).not.toContain(secret.slice(0, 4));
		expect(progress).toContain('<redacted>'.slice(0, 5));
	});

	it('flags lines dropped by maxLines', async () => {
		const encoded = new TextEncoder().encode(
			['a', 'b', 'c'].map((data) => `data: ${JSON.stringify({ timestamp: '1', data })}`).join('\n') + '\n'
		);
		const read = vi
			.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
			.mockResolvedValueOnce({ done: false, value: encoded })
			.mockResolvedValue({ done: true, value: undefined });
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});
		const result = await fetchJobLogs('https://example.com/logs', { maxDuration: 100, maxLines: 2 });
		expect(result).toMatchObject({ logs: ['b', 'c'], linesDropped: true });
	});

	it('flags linesDropped when a single line is truncated by maxLineChars', async () => {
		const encoded = new TextEncoder().encode(`data: ${JSON.stringify({ timestamp: '1', data: 'x'.repeat(250) })}\n`);
		const read = vi
			.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
			.mockResolvedValueOnce({ done: false, value: encoded })
			.mockResolvedValue({ done: true, value: undefined });
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});
		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 100,
			maxLines: 200,
			maxChars: 80_000,
			maxLineChars: 100,
		});
		expect(result.logs).toEqual([`${'x'.repeat(100)}…`]);
		expect(result.linesDropped).toBe(true);
	});

	it('rejects with an AbortError when the caller aborts', async () => {
		const controller = new AbortController();
		const read = vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>().mockImplementation(async () => {
			controller.abort();
			return { done: true, value: undefined };
		});
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});
		await expect(
			fetchJobLogs('https://example.com/logs', { maxDuration: 1000, signal: controller.signal })
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('settles cleanly via idleTimeoutMs after draining replayed chunks without setting truncated', async () => {
		const encoded = new TextEncoder().encode(
			['line 1', 'line 2'].map((data) => `data: ${JSON.stringify({ timestamp: '1', data })}`).join('\n') + '\n'
		);
		let readCount = 0;
		const read = vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>().mockImplementation(() => {
			readCount++;
			if (readCount === 1) {
				return Promise.resolve({ done: false, value: encoded });
			}
			const signal = vi.mocked(safeFetch).mock.calls[0]?.[1]?.requestInit?.signal as AbortSignal | undefined;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
					once: true,
				});
			});
		});
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});

		const started = Date.now();
		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 5_000,
			maxLines: 20,
			idleTimeoutMs: 30,
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(result).toEqual({
			logs: ['line 1', 'line 2'],
			finished: false,
			truncated: false,
			linesDropped: false,
		});
	});

	it('settles cleanly via initialIdleTimeoutMs when a terminal job stream emits zero events', async () => {
		const read = vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>().mockImplementation(() => {
			const signal = vi.mocked(safeFetch).mock.calls[0]?.[1]?.requestInit?.signal as AbortSignal | undefined;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
					once: true,
				});
			});
		});
		vi.mocked(safeFetch).mockResolvedValue({
			response: createSseResponse(read),
			finalUrl: new URL('https://example.com/logs'),
			redirectsFollowed: 0,
		});

		const result = await fetchJobLogs('https://example.com/logs', {
			maxDuration: 5_000,
			maxLines: 20,
			idleTimeoutMs: 30,
			initialIdleTimeoutMs: 40,
		});
		expect(result).toEqual({
			logs: [],
			finished: false,
			truncated: false,
			linesDropped: false,
		});
	});
});
