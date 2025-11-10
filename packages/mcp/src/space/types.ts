import { z } from 'zod';

/**
 * Operations supported by the space tool
 */
export const OPERATION_NAMES = ['view_parameters', 'invoke'] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

/**
 * Zod schema for operation arguments
 */
export const spaceArgsSchema = z.object({
	operation: z
		.enum(OPERATION_NAMES)
		.optional()
		.describe('Operation to execute. Valid values: "view_parameters", "invoke"'),
	space_name: z.string().optional().describe('The Hugging Face space ID (format: "username/space-name")'),
	parameters: z.string().optional().describe('For invoke operation: JSON object string of parameters'),
});

export type SpaceArgs = z.infer<typeof spaceArgsSchema>;

/**
 * Parameter information extracted from schema
 */
export interface ParameterInfo {
	name: string;
	type: string;
	description?: string;
	required: boolean;
	default?: unknown;
	enum?: unknown[];
	isFileData?: boolean;
	complexType?: string; // Reason why the type is complex
}

/**
 * Result of schema complexity analysis
 */
export interface SchemaComplexityResult {
	isSimple: boolean;
	reason?: string; // Reason if not simple
	parameters: ParameterInfo[];
	toolName: string;
	toolDescription?: string;
}

/**
 * Result of parameter processing
 */
export interface ProcessParametersResult {
	valid: boolean;
	parameters?: Record<string, unknown>;
	error?: string;
	warnings?: string[];
}

/**
 * JSON Schema property definition
 */
export interface JsonSchemaProperty {
	type?: string;
	title?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	format?: string;
	properties?: Record<string, JsonSchemaProperty>;
	items?: JsonSchemaProperty;
	required?: string[];
	[key: string]: unknown;
}

/**
 * JSON Schema definition
 */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	description?: string;
	[key: string]: unknown;
}

/**
 * File input help message constant
 */
export const FILE_INPUT_HELP_MESSAGE =
	'Provide a publicly accessible URL (http:// or https://) pointing to the file. ' +
	'To upload local files, use the dedicated gr_* prefixed tool for this space, which supports file upload.';

/**
 * Check if a property is a FileData type
 */
export function isFileDataProperty(prop: JsonSchemaProperty): boolean {
	return (
		prop.title === 'ImageData' ||
		prop.title === 'FileData' ||
		(prop.format?.includes('http') && prop.format?.includes('file')) ||
		false
	);
}

/**
 * Check if a schema contains file data
 */
export function hasFileData(schema: JsonSchema): boolean {
	if (!schema.properties) return false;

	return Object.values(schema.properties).some((prop) => isFileDataProperty(prop));
}
