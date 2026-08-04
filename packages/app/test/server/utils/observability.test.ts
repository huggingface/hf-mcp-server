import { describe, expect, it } from 'vitest';
import { getErrorLogFields, getToolResultErrorMessage } from '../../../src/server/utils/observability.js';

describe('getErrorLogFields', () => {
	it('retains Error details for Pino and dataset logging', () => {
		const error = Object.assign(new Error('modern handler failed'), { code: 'HANDLER_FAILURE' });

		expect(getErrorLogFields(error)).toEqual({
			err: error,
			errorMessage: 'modern handler failed',
			errorName: 'Error',
			errorCode: 'HANDLER_FAILURE',
		});
	});

	it('describes non-Error values', () => {
		const error = { reason: 'invalid modern request', code: 400 };

		expect(getErrorLogFields(error)).toEqual({
			err: error,
			errorMessage: '{"reason":"invalid modern request","code":400}',
			errorCode: 400,
		});
	});
});

describe('getToolResultErrorMessage', () => {
	it('uses a dynamic tool error result formatted message', () => {
		expect(
			getToolResultErrorMessage({
				isError: true,
				formatted: 'Input validation error: text_input is required',
			})
		).toBe('Input validation error: text_input is required');
	});

	it('uses a fallback when an error result has no formatted message', () => {
		expect(getToolResultErrorMessage({ isError: true, formatted: '' })).toBe('Tool returned an error result');
		expect(getToolResultErrorMessage({ isError: false, formatted: 'ok' })).toBeUndefined();
	});
});
