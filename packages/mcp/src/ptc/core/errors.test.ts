import { describe, expect, it } from 'vitest';
import { PtcError, toPtcError } from './errors.js';

const map = (error: unknown) => toPtcError(error, 'subject');

describe('toPtcError', () => {
	it('maps structured statuses', () => {
		expect(map(Object.assign(new Error('x'), { status: 404 })).code).toBe('NOT_FOUND');
		expect(map(Object.assign(new Error('x'), { statusCode: 401 })).code).toBe('AUTH_REQUIRED');
		expect(map(Object.assign(new Error('x'), { status: 200 })).code).toBe('UPSTREAM_UNAVAILABLE');
	});

	it.each([
		['HTTP 404: Not Found', 'NOT_FOUND'],
		['Documentation fetch failed with status 404 Not Found', 'NOT_FOUND'],
		['Documentation manifest fetch failed with status 503', 'UPSTREAM_HTTP'],
		['Failed to fetch logs: 403 Forbidden', 'FORBIDDEN'],
		['API request failed: 401 Unauthorized', 'AUTH_REQUIRED'],
		['Sandbox RPC /exec failed with 409: {"x":1}', 'CONFLICT'],
	])('maps the HTTP-shaped legacy message %s', (message, code) => {
		const result = map(new Error(message));
		expect(result.code).toBe(code);
		expect(result.message).not.toContain('{"x"');
	});

	it.each([
		'model org/model-404 has no card',
		'checkpoint step 500 missing',
		'read 4040 bytes, expected 500',
		'job 5000 exited',
	])('does not read a status out of an arbitrary number: %s', (message) => {
		const result = map(new Error(message));
		expect(result.code).toBe('UPSTREAM_UNAVAILABLE');
		expect(result.message).toBe('subject: upstream request failed. Check the arguments or retry later.');
	});

	it.each([
		['ENOENT: no such file or directory', 'NOT_FOUND', 'subject: no such file or directory'],
		['EINVAL: URI must start with hf://docs', 'INVALID_ARGUMENT', 'subject: URI must start with hf://docs'],
		['EISDIR: hf://docs/hub is a directory', 'INVALID_ARGUMENT', 'subject: hf://docs/hub is a directory'],
		['ENOTDIR: not a directory', 'INVALID_ARGUMENT', 'subject: not a directory'],
		[
			"ENOENT: documentation section '#x' was not found. Try: cat hf://docs/hub/a.md",
			'NOT_FOUND',
			"subject: documentation section '#x' was not found.",
		],
	])('maps and strips the errno of %s', (message, code, text) => {
		const result = map(new Error(message));
		expect(result).toBeInstanceOf(PtcError);
		expect(result.code).toBe(code);
		expect(result.message).toBe(text);
	});

	it('bounds and sanitizes errno details', () => {
		const result = map(
			new Error(`ENOENT: token hf_abcdefghijklmnop at https://x.example/a?sig=secret\n${'y'.repeat(1000)}`)
		);
		expect(result.code).toBe('NOT_FOUND');
		expect(result.message).not.toMatch(/hf_abcdef|sig=secret|ENOENT|\n/);
		expect(result.message.length).toBeLessThanOrEqual('subject: '.length + 200);
		expect(map(new Error('ENOENT: ')).message).toBe('subject: not found.');
	});

	it('maps 412 to retryable CONFLICT and 501 to non-retryable UNSUPPORTED', () => {
		const precondition = map({ statusCode: 412 });
		expect(precondition.code).toBe('CONFLICT');
		expect(precondition.retryable).toBe(true);
		expect(precondition.message).toMatch(/precondition failed.*batch/i);

		const unsupported = map({ statusCode: 501 });
		expect(unsupported.code).toBe('UNSUPPORTED');
		expect(unsupported.retryable).toBe(false);
	});
});
