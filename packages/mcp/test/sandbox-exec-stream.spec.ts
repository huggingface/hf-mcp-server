import { describe, expect, it, vi } from 'vitest';
import { parseSandboxExecResponse, type SandboxExecProgress } from '../src/sandbox-tool.js';

const SECRET = 'hf_streamed_secret_value';
const redact = (text: string) => text.split(SECRET).join('<redacted>');

function ndjson(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(stream);
}

function event(stream: 'stdout' | 'stderr', data: string): string {
	return `${JSON.stringify({ event: stream, data })}\n`;
}

const EXIT = `${JSON.stringify({ event: 'exit', exit_code: 0, duration_ms: 3 })}\n`;

describe('parseSandboxExecResponse (bounded, redacting)', () => {
	it('keeps only a bounded tail while streaming and flags the dropped output', async () => {
		const line = `${'y'.repeat(999)}\n`;
		const chunks = Array.from({ length: 2_000 }, () => event('stdout', line));
		const result = await parseSandboxExecResponse(ndjson([...chunks, event('stderr', 'err\n'), EXIT]), {
			maxOutputChars: 40_000,
			redact,
		});
		// 2 MB streamed; at most twice (limit + slack) is retained.
		expect(result.stdout.length).toBeLessThanOrEqual(2 * (40_000 + 70_000));
		expect(result.stdout.endsWith(line)).toBe(true);
		expect(result.stdout_dropped).toBe(true);
		expect(result.stderr).toBe('err\n');
		expect(result.stderr_dropped).toBeUndefined();
	});

	it('redacts a secret before a cut, even when it arrived split across events', async () => {
		const filler = event('stdout', `${'z'.repeat(99_999)}\n`);
		const chunks = [
			event('stdout', `token=${SECRET.slice(0, 7)}`),
			event('stdout', `${SECRET.slice(7)}\n`),
			...Array.from({ length: 3 }, () => filler),
			EXIT,
		];
		const result = await parseSandboxExecResponse(ndjson(chunks), { maxOutputChars: 40_000, redact });
		expect(result.stdout).not.toContain(SECRET.slice(0, 7));
		expect(result.stdout_dropped).toBe(true);
	});

	it('reports progress from the last complete line, redacted before it is shortened', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const progress: SandboxExecProgress[] = [];
			const padding = 'p'.repeat(150);
			await parseSandboxExecResponse(
				ndjson([
					event('stdout', `${padding}${SECRET.slice(0, 12)}`),
					event('stdout', `${SECRET.slice(12)} done\n`),
					EXIT,
				]),
				{
					maxOutputChars: 40_000,
					redact,
					onProgress: (p) => {
						progress.push(p);
						vi.setSystemTime(Date.now() + 10_000);
					},
				}
			);
			const messages = progress.map((p) => p.message ?? '').join('\n');
			expect(messages).not.toContain(SECRET.slice(0, 4));
			expect(messages).toContain('Received stdout output.');
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves the legacy (unbounded, unredacted) behaviour unchanged without options', async () => {
		const result = await parseSandboxExecResponse(ndjson([event('stdout', `a ${SECRET}\n`), EXIT]));
		expect(result).toEqual({
			returncode: 0,
			stdout: `a ${SECRET}\n`,
			stderr: '',
			signal: null,
			timed_out: false,
			duration_ms: 3,
		});
	});
});
