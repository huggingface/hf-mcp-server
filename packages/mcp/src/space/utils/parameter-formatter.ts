import type { SchemaComplexityResult, ParameterInfo } from '../types.js';
import { FILE_INPUT_HELP_MESSAGE, VIEW_PARAMETERS } from '../types.js';

/**
 * Formats parameter schema for display to users
 * Shows parameters in a clear, organized manner with:
 * - Required parameters first
 * - Alphabetical sorting within groups
 * - Clear type information
 * - Default values
 * - Enum options
 */
export function formatParameters(schemaResult: SchemaComplexityResult, spaceName: string): string {
	const { toolName, toolDescription, parameters } = schemaResult;

	let output = `# Parameters for: ${toolName}\n\n`;

	if (toolDescription) {
		output += `**Description:** ${toolDescription}\n\n`;
	}

	// Sort parameters: required first, then alphabetical
	const sortedParams = [...parameters].sort((a, b) => {
		if (a.required !== b.required) {
			return a.required ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	output += `## Parameters:\n\n`;

	for (const param of sortedParams) {
		output += formatParameter(param);
	}

	// Add usage example
	output +=
		'\n## Usage Example:\n\nIllustrative values; adjust arrays and object fields to the Space schema. Only basic types and required fields are checked locally, not full JSON Schema constraints.\n\n';
	output += formatUsageExample(spaceName, toolName, parameters);

	return output;
}

/**
 * Formats a single parameter for display
 */
function formatParameter(param: ParameterInfo): string {
	const badge = param.required ? '[REQUIRED]' : '[OPTIONAL]';
	let output = `### ${param.name} ${badge}\n`;

	// Type
	output += `- **Type:** ${param.type}\n`;

	// Description
	if (param.description) {
		output += `- **Description:** ${param.description}\n`;
	}

	// Default value
	if (param.default !== undefined) {
		const defaultStr = formatValue(param.default);
		output += `- **Default:** ${defaultStr}\n`;
	}

	// Enum values
	if (param.enum && param.enum.length > 0) {
		const enumStr = param.enum.map((v) => formatValue(v)).join(', ');
		output += `- **Allowed values:** ${enumStr}\n`;
	}

	// File input help
	if (param.isFileData) {
		output += `- **Note:** ${FILE_INPUT_HELP_MESSAGE}\n`;
	}

	output += '\n';
	return output;
}

/**
 * Formats a value for display
 */
function formatValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `"${value}"`;
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		} catch {
			return '[object]';
		}
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return JSON.stringify(value);
}

/**
 * Formats a usage example
 */
function formatUsageExample(spaceName: string, toolName: string, parameters: ParameterInfo[]): string {
	// Illustrative values only: nested fields and constraints may require adjustment.
	const exampleParams: Record<string, unknown> = {};

	// Add required parameters
	for (const param of parameters.filter((p) => p.required)) {
		exampleParams[param.name] = getExampleValue(param);
	}

	// Add one or two optional parameters if they exist
	const optionalParams = parameters.filter((p) => !p.required);
	for (let i = 0; i < Math.min(2, optionalParams.length); i++) {
		const param = optionalParams[i];
		if (param) {
			exampleParams[param.name] = getExampleValue(param);
		}
	}

	return `\`\`\`json
${JSON.stringify(
	{
		operation: 'invoke',
		space_name: spaceName,
		tool_name: toolName,
		parameters: JSON.stringify(exampleParams),
	},
	null,
	2
)}
\`\`\``;
}

/**
 * Gets an example value for a parameter
 */
function getExampleValue(param: ParameterInfo): unknown {
	// Use default if available
	if (param.default !== undefined) {
		return param.default;
	}

	// Use first enum value if available
	if (param.enum && param.enum.length > 0) {
		return param.enum[0];
	}

	// File data
	if (param.isFileData) {
		return 'https://example.com/file.jpg';
	}

	// Generate example based on type
	const baseType = param.type.split(' ')[0]?.split('<')[0];

	switch (baseType) {
		case 'string':
			return 'example value';
		case 'number':
		case 'integer':
			return 42;
		case 'boolean':
			return true;
		case 'array':
			return [];
		case 'object':
			return {};
		default:
			return 'value';
	}
}

/**
 * Formats a complex schema error message
 */
export function formatComplexSchemaError(spaceName: string, reason: string): string {
	return `Error: Schema too complex for space '${spaceName}'.

${reason}

Supported types: strings, numbers, booleans, arrays of primitives, enums, shallow objects, and file URLs.

Add this Space at https://huggingface.co/settings/mcp, then use its dedicated gr_* tool.\nDynamic invocation performs only basic parameter checks, not full JSON Schema validation.`;
}

/**
 * Formats validation errors
 */
export function formatValidationError(errors: string[], spaceName: string): string {
	let output = `Error: Invalid parameters for space '${spaceName}'.\n\n`;

	for (const error of errors) {
		output += `- ${error}\n`;
	}

	output += `\nUse the ${VIEW_PARAMETERS} operation to see all required parameters and their types.`;

	return output;
}
