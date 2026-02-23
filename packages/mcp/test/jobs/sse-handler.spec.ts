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
});
