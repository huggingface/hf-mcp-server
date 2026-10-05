import type { Tool } from '@modelcontextprotocol/client';
import type { ToolResult } from '../../types/tool-result.js';

/** Exact named selection; omission preserves the historical first-tool default. */
export function selectTool(tools: Tool[], spaceName: string, toolName?: string): Tool | ToolResult {
	const tool = toolName === undefined ? tools[0] : tools.find((candidate) => candidate.name === toolName);
	if (tool) return tool;
	return {
		formatted:
			tools.length === 0
				? `Error: No tools found for space '${spaceName}'. Check that the Space is running and MCP-enabled, then retry view_parameters.`
				: `Error: Tool ${JSON.stringify(toolName)} not found in space '${spaceName}'. Available tools: ${tools.map((candidate) => JSON.stringify(candidate.name)).join(', ')}. Retry view_parameters with an exact tool_name from this list.`,
		totalResults: 0,
		resultsShared: 0,
		isError: true,
		errorMetadata: { stage: 'selection', code: tools.length === 0 ? 'no_tools' : 'tool_not_found' },
	};
}
