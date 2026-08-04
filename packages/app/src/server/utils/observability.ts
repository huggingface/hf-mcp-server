export interface ErrorLogFields {
	err: unknown;
	errorMessage: string;
	errorName?: string;
	errorCode?: string | number;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === 'string') return value;

	try {
		const serialized = JSON.stringify(value);
		if (serialized && serialized !== '{}') return serialized;
	} catch {
		// Fall through for circular or otherwise non-serializable values.
	}

	return String(value);
}

/**
 * Put Error objects under Pino's conventional `err` key so its standard
 * serializer retains message, name, and stack. Duplicate useful scalar fields
 * because the dataset transport stores bindings in a generic `data` field.
 */
export function getErrorLogFields(error: unknown): ErrorLogFields {
	const errorObject = typeof error === 'object' && error !== null ? error : undefined;
	const errorCode =
		errorObject && 'code' in errorObject && ['string', 'number'].includes(typeof errorObject.code)
			? (errorObject.code as string | number)
			: undefined;

	if (error instanceof Error) {
		return {
			err: error,
			errorMessage: error.message,
			errorName: error.name,
			...(errorCode !== undefined ? { errorCode } : {}),
		};
	}

	return {
		err: error,
		errorMessage: stringifyUnknown(error),
		...(errorCode !== undefined ? { errorCode } : {}),
	};
}

/**
 * MCP tools may report an expected failure as a handler result with
 * `isError: true`. Convert that result into useful telemetry.
 */
export function getToolResultErrorMessage(result: unknown): string | undefined {
	if (typeof result !== 'object' || result === null || !('isError' in result) || !result.isError) {
		return undefined;
	}

	if ('formatted' in result && typeof result.formatted === 'string' && result.formatted.length > 0) {
		return result.formatted;
	}

	return 'Tool returned an error result';
}
