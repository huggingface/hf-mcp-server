/** A response body exceeded its byte budget; the stream was cancelled before it was buffered in full. */
export class ResponseTooLargeError extends Error {
	constructor(public readonly maxBytes: number) {
		super(`response body exceeds ${String(maxBytes)} bytes`);
		this.name = 'ResponseTooLargeError';
	}
}

/**
 * Read a response body as UTF-8 text, streaming, and stop as soon as it exceeds `maxBytes`
 * (a declared Content-Length over budget fails before reading). Never buffers more than
 * `maxBytes` plus one chunk. A cancelled reader can report `done`, so the signal is re-checked
 * after every read: an abort never yields a truncated body as success.
 */
export async function readCappedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
	const declared = Number(response.headers?.get?.('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new ResponseTooLargeError(maxBytes);
	}
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ResponseTooLargeError(maxBytes);
		return text;
	}
	const reader = response.body.getReader();
	const cancel = () => void reader.cancel().catch(() => undefined);
	signal?.addEventListener('abort', cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		signal?.throwIfAborted();
		while (true) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				cancel();
				throw new ResponseTooLargeError(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener('abort', cancel);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** readCappedText, then JSON.parse. */
export async function readCappedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
	return JSON.parse(await readCappedText(response, maxBytes, signal)) as unknown;
}
