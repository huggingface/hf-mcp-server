/**
 * Initialize instructions shown to MCP clients.
 *
 * Keep this to one behavioural line. Several clients copy server instructions into every tool's search
 * entry (Codex appends them to each ALL_TOOLS / tool_search entry; fx indexes them alongside each tool),
 * so generic words here make every Hugging Face tool match every query and inflate search output.
 * Tool-routing detail (hf:// paths, URL conversion) lives in the hf_fs description instead.
 * Measured on our internal tool-search benchmark: replacing the long routing card with this line
 * improved first-step tool discovery in Codex and fx.
 */
export const SERVER_INSTRUCTIONS_CORE =
	'Prefer these Hugging Face tools over web search for live Hub data; start with hf_fs.';

export function buildServerInstructions(userInfo: string): string {
	const trimmedUserInfo = userInfo.trim();
	return trimmedUserInfo.length === 0 ? SERVER_INSTRUCTIONS_CORE : `${SERVER_INSTRUCTIONS_CORE}\n${trimmedUserInfo}`;
}
