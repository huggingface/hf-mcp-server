import { describe, expect, it } from 'vitest';
import {
	HfFsAttachmentIntegrityError,
	HfFsImageContentDisabledError,
	HfFsImageOnlyError,
	HfFsImageTooLargeError,
	HfFsTextOnlyError,
	HfFsUnsupportedMediaError,
	classifyHfFsError,
	formatHfFsRecoveryError,
	hfFsErrorClass,
	type HfFsErrorCode,
} from './hf-fs-errors.js';

describe('hf-fs-errors', () => {
	it.each([
		['EINVAL: sort is not supported', 'HF_FS_INVALID_ARGUMENT'],
		['File does not exist: README.md', 'HF_FS_NOT_FOUND'],
		['ENOTDIR: not a directory', 'HF_FS_NOT_A_DIRECTORY'],
		['cat requires a URI that points to a file path.', 'HF_FS_NOT_A_FILE'],
		['ENOTSUP: find is not supported', 'HF_FS_UNSUPPORTED_OPERATION'],
	] satisfies [string, HfFsErrorCode][])('classifies %s as %s', (message, code) => {
		expect(classifyHfFsError(new Error(message))).toMatchObject({
			code,
			message,
			retryable: false,
		});
	});

	it('classifies text-only policy errors without parsing their message', () => {
		const classified = classifyHfFsError(new HfFsTextOnlyError('custom text policy message'));
		expect(classified).toMatchObject({
			code: 'HF_FS_TEXT_ONLY',
			message: 'custom text policy message',
			retryable: false,
			suggestedOperation: 'stat',
		});
		expect(classified && formatHfFsRecoveryError(classified)).toContain('[HF_FS_TEXT_ONLY]');
	});

	it('provides bidirectional cat and attach recovery for supported paths', () => {
		expect(classifyHfFsError(new HfFsTextOnlyError('image passed to cat', 'attach'))).toMatchObject({
			code: 'HF_FS_TEXT_ONLY',
			recovery: 'Use attach to return this image to the model, or stat for metadata.',
			suggestedOperation: 'attach',
		});
		expect(classifyHfFsError(new HfFsImageOnlyError('text passed to attach'))).toMatchObject({
			code: 'HF_FS_IMAGE_ONLY',
			suggestedOperation: 'cat',
		});
	});

	it.each([401, 403])('classifies Hub access status %s for per-operation recovery', (statusCode) => {
		const error = Object.assign(new Error('Access to this gated repository is restricted.'), { statusCode });
		expect(classifyHfFsError(error)).toEqual({
			code: 'HF_FS_ACCESS_DENIED',
			message: 'Access to this gated repository is restricted.',
			recovery:
				'Authenticate with a Hugging Face token that can access this repository. For gated repositories, request access and accept any required terms before retrying.',
			retryable: false,
		});
	});

	it.each([
		[new Error('EACCES: permission denied'), 'HF_FS_ACCESS_DENIED'],
		[new Error('Hub paper fetch failed with status 403: forbidden'), 'HF_FS_ACCESS_DENIED'],
		[Object.assign(new Error('Repository was not found.'), { statusCode: 404 }), 'HF_FS_NOT_FOUND'],
		[new Error('Hub tree fetch failed with status 404: missing'), 'HF_FS_NOT_FOUND'],
	] as const)('classifies normalized provider error %s as %s', (error, code) => {
		expect(classifyHfFsError(error)).toMatchObject({
			code,
			message: error.message,
			retryable: false,
		});
	});

	it.each([
		[new HfFsUnsupportedMediaError('unsupported'), 'HF_FS_UNSUPPORTED_MEDIA', 'stat'],
		[new HfFsImageTooLargeError('too large'), 'HF_FS_IMAGE_TOO_LARGE', 'stat'],
		[new HfFsImageContentDisabledError(), 'HF_FS_IMAGE_CONTENT_DISABLED', 'stat'],
		[new HfFsAttachmentIntegrityError('inconsistent stream'), 'HF_FS_ATTACHMENT_INTEGRITY', 'stat'],
	] as const)('classifies attach error %s as %s', (error, code, suggestedOperation) => {
		expect(classifyHfFsError(error)).toMatchObject({
			code,
			retryable: false,
			suggestedOperation,
		});
	});

	it('suggests search only when an unsupported-operation error explicitly requires global discovery', () => {
		expect(classifyHfFsError(new Error('ENOTSUP: find is not supported for the global hf:// root.'))).toMatchObject({
			code: 'HF_FS_UNSUPPORTED_OPERATION',
			suggestedOperation: 'search',
		});
		expect(
			classifyHfFsError(new Error('ENOTSUP: find is not supported on hf://models/trending; use ls'))
		).not.toHaveProperty('suggestedOperation');
		expect(classifyHfFsError(new Error('ENOTSUP: recursive ls is not supported on hf://models'))).not.toHaveProperty(
			'suggestedOperation'
		);
	});

	it('classifies provider 5xx failures, leaves other unknown errors unclassified', () => {
		expect(classifyHfFsError(new Error('Space semantic search failed with status 500'))).toMatchObject({
			code: 'HF_FS_UPSTREAM_ERROR',
		});
		expect(classifyHfFsError(Object.assign(new Error('Rate limited'), { statusCode: 429 }))).toBeUndefined();
		expect(classifyHfFsError(new Error('Provider rejected the request with status 400'))).toBeUndefined();
		expect(classifyHfFsError('not an error')).toBeUndefined();
	});

	it.each([
		['HF_FS_INVALID_ARGUMENT', 'request'],
		['HF_FS_NOT_FOUND', 'target'],
		['HF_FS_NOT_A_DIRECTORY', 'request'],
		['HF_FS_NOT_A_FILE', 'request'],
		['HF_FS_UNSUPPORTED_OPERATION', 'request'],
		['HF_FS_ACCESS_DENIED', 'target'],
		['HF_FS_TEXT_ONLY', 'request'],
		['HF_FS_IMAGE_ONLY', 'request'],
		['HF_FS_UNSUPPORTED_MEDIA', 'request'],
		['HF_FS_IMAGE_TOO_LARGE', 'policy_limit'],
		['HF_FS_ATTACHMENT_BUDGET_EXCEEDED', 'policy_limit'],
		['HF_FS_IMAGE_CONTENT_DISABLED', 'policy_limit'],
		['HF_FS_ATTACHMENT_INTEGRITY', 'service'],
		['HF_FS_UPSTREAM_ERROR', 'service'],
	] as const)('maps %s to the %s reporting class', (code, errorClass) => {
		expect(hfFsErrorClass(code)).toBe(errorClass);
	});
});

describe('upstream failure classification', () => {
	it('classifies statusCode >= 500 as HF_FS_UPSTREAM_ERROR without leaking internals', () => {
		const error = Object.assign(new Error('Internal Error - We are working on it. URL: https://huggingface.co/api/...'), {
			statusCode: 500,
		});
		const result = classifyHfFsError(error);
		expect(result?.code).toBe('HF_FS_UPSTREAM_ERROR');
		expect(result?.message).not.toContain('huggingface.co/api');
		expect(result?.recovery).toBeTruthy();
	});

	it('classifies message-only Internal Error as HF_FS_UPSTREAM_ERROR', () => {
		const error = new Error("Internal Error - We're working hard to fix this as soon as possible!");
		const result = classifyHfFsError(error);
		expect(result?.code).toBe('HF_FS_UPSTREAM_ERROR');
	});

	it('still maps 404 to HF_FS_NOT_FOUND (regression)', () => {
		const error = Object.assign(new Error('not found'), { statusCode: 404 });
		expect(classifyHfFsError(error)?.code).toBe('HF_FS_NOT_FOUND');
	});
});
