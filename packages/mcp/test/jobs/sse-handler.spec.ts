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
});
