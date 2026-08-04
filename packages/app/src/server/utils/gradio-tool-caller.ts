import type { CallToolResult, Progress } from '@modelcontextprotocol/server';
import { callGradioToolWithHeaders } from '@llmindset/hf-mcp';
import { logger } from './logger.js';
import { stripImageContentFromResult } from './gradio-result-processor.js';

/**
 * Options for calling a Gradio tool
 */
export interface GradioToolCallOptions {
	/** Whether to strip image content from the result */
	stripImageContent?: boolean;
	/** Original tool name (for logging) */
	toolName: string;
	/** Outward-facing tool name (for logging) */
	outwardFacingName: string;
}

/**
 * Unified Gradio tool caller that handles:
 * - Streamable HTTP connection management
 * - MCP tool invocation
 *
 * Returns the raw MCP result without post-processing. Callers should apply
 * image filtering as needed using applyResultPostProcessing.
 *
 * This ensures both proxied gr_* tools and the space tool's invoke operation
 * behave identically.
 */
export async function callGradioTool(
	mcpUrl: string,
	toolName: string,
	parameters: Record<string, unknown>,
	hfToken: string | undefined,
	onProgress?: (progress: Progress) => void | Promise<void>
): Promise<CallToolResult> {
	logger.info({ tool: toolName, params: parameters }, 'Calling Gradio tool via unified caller');

	const { result, capturedHeaders } = await callGradioToolWithHeaders(mcpUrl, toolName, parameters, hfToken, {
		logProxiedReplica: true,
		onProgress,
	});

	// Attach captured headers (e.g., X-Proxied-Replica) to the result meta so callers can inspect them
	const proxiedReplica = capturedHeaders['x-proxied-replica'];
	if (proxiedReplica) {
		logger.debug({ tool: toolName, proxiedReplica }, 'Captured Gradio response header');
		return {
			...result,
			_meta: {
				...(result as { _meta?: Record<string, unknown> })._meta,
				responseHeaders: {
					...(result as { _meta?: { responseHeaders?: Record<string, unknown> } })._meta?.responseHeaders,
					'x-proxied-replica': proxiedReplica,
				},
			},
		} as CallToolResult;
	}

	return result;
}

/**
 * Applies post-processing to a Gradio tool result:
 * - Image content filtering (conditionally)
 *
 * This ensures consistent behavior across all Gradio tools.
 */
export function applyResultPostProcessing(result: CallToolResult, options: GradioToolCallOptions): CallToolResult {
	// Strip image content if requested
	const filteredResult = stripImageContentFromResult(result, {
		enabled: !!options.stripImageContent,
		toolName: options.toolName,
		outwardFacingName: options.outwardFacingName,
	});

	return filteredResult;
}
