/**
 * Stable dynamic_space failure categories. No raw exception text or user inputs.
 * Present on failures only; consumers should use isError for the outcome.
 */
export interface DynamicSpaceErrorMetadata {
	stage: 'request' | 'metadata' | 'schema' | 'selection' | 'validation' | 'invocation' | 'operation';
	code:
		| 'unknown_operation'
		| 'missing_space_name'
		| 'missing_parameters'
		| 'invalid_parameters_json'
		| 'authentication_required'
		| 'access_denied'
		| 'not_found_or_inaccessible'
		| 'service_unavailable'
		| 'metadata_fetch_failed'
		| 'schema_fetch_failed'
		| 'no_tools'
		| 'tool_not_found'
		| 'unsupported_schema'
		| 'invalid_parameters'
		| 'invocation_failed'
		| 'upstream_tool_error'
		| 'operation_failed';
}

/**
 * Standard response format for all tools to enable consistent query logging
 */
export interface ToolResult {
	errorMetadata?: DynamicSpaceErrorMetadata;
	/**
	 * The formatted output string to be returned to the MCP client
	 */
	formatted: string;

	/**
	 * Total number of results found (before any limits applied)
	 * For detail tools: 1 if found, 0 if not found
	 */
	totalResults: number;

	/**
	 * Number of results actually included in the formatted response
	 * Usually limited by the 'limit' parameter for search tools
	 * For detail tools: same as totalResults
	 */
	resultsShared: number;

	/**
	 * Indicates whether this result represents an error condition
	 * When true, formatted contains an error message
	 */
	isError?: boolean;
}
