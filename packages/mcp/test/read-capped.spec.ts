import { describe, expect, it } from 'vitest';
import { readCappedJson, readCappedText, ResponseTooLargeError } from '../src/network/read-capped.js';

function streamed(
	chunks: number,
	chunkSize: number,
	onPull?: () => void
): { response: Response; pulled: () => number } {
	let count = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			onPull?.();
			if (count >= chunks) {
				controller.close();
				return;
			}
			count += 1;
			controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
		},
	});
	return { response: new Response(stream), pulled: () => count };
}

describe('readCappedText', () => {
	it('returns bodies within the budget', async () => {
		expect(await readCappedText(new Response('héllo'), 100)).toBe('héllo');
		expect(await readCappedJson(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
	});

	it('stops reading as soon as the budget is exceeded instead of buffering the whole body', async () => {
		const { response, pulled } = streamed(10_000, 1024);
		await expect(readCappedText(response, 8 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
		expect(pulled()).toBeLessThan(20);
	});

	it('rejects a declared Content-Length over budget before reading', async () => {
		const response = new Response('x'.repeat(10), { headers: { 'content-length': '999999' } });
		await expect(readCappedText(response, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it('never returns a partial body as success when aborted', async () => {
		const controller = new AbortController();
		const { response } = streamed(100, 10, () => {
			controller.abort();
		});
		await expect(readCappedText(response, 1_000_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});
});
