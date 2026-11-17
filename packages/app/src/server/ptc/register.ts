import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
	advertisedInputSchema,
	advertisedOutputSchema,
	callPtcTool,
	ptcToolsForAccess,
	toPtcError,
	type PtcContext,
	type PtcTool,
} from '@llmindset/hf-mcp';
import type { HfWhoamiResponse } from '../utils/hf-whoami-client.js';
import { createProgressRelay } from '../utils/progress-relay.js';
import { logToolQuery, type QueryLoggerOptions } from '../utils/query-logger.js';
import { ptcAccess } from './access.js';
import { recordPtcRequest, recordPtcToolCall } from './metrics.js';

export interface RegisterPtcToolsOptions {
	hfToken?: string;
	user?: HfWhoamiResponse;
	clientInfo?: { name: string; version: string };
	disabledTools: ReadonlySet<string>;
	/** Base query-log options for this request (session, client, protocol). */
	logOptions: QueryLoggerOptions;
}

/** Arguments that are safe and useful to log: short scalar search terms only. */
function loggedQuery(params: Record<string, unknown>): string {
	for (const key of ['query', 'uri', 'ref', 'refs', 'dataset', 'space', 'paper_ids', 'job_id']) {
		const value = params[key];
		if (typeof value === 'string') return value.slice(0, 500);
		if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(',').slice(0, 500);
	}
	return '';
}

function handler(tool: PtcTool, options: RegisterPtcToolsOptions) {
	return async (params: Record<string, unknown>, ctx: Parameters<Parameters<McpServer['registerTool']>[2]>[1]) => {
		const start = performance.now();
		const ptcCtx: PtcContext = {
			hfToken: options.hfToken,
			username: options.user?.name,
			signal: ctx.mcpReq.signal,
			onProgress: createProgressRelay(ctx),
		};
		// Separate PTC usage from legacy tools that share a name (e.g. hf_sandbox_exec) in query logs.
		const logName = `ptc:${tool.name}`;
		// Cursors, file contents, scripts and secrets are never logged: only a short query term.
		const query = loggedQuery(params);
		try {
			const result = await callPtcTool(tool, params, ptcCtx);
			const durationMs = Math.round(performance.now() - start);
			// A remote tool (e.g. a Space) can run and still report failure: keep MCP isError and count it.
			recordPtcToolCall(options.clientInfo ?? {}, tool.name, durationMs, result.isError ? 'TOOL_ERROR' : undefined);
			const items = result.structured.items;
			logToolQuery(
				logName,
				query,
				{},
				{
					...options.logOptions,
					durationMs,
					success: !result.isError,
					...(Array.isArray(items) ? { resultsShared: items.length } : {}),
					responseCharCount: JSON.stringify(result.structured).length,
				}
			);
			return {
				structuredContent: result.structured,
				content: result.content,
				...(result.isError ? { isError: true } : {}),
			} as CallToolResult;
		} catch (error) {
			const safe = toPtcError(error, tool.name);
			const durationMs = Math.round(performance.now() - start);
			recordPtcToolCall(options.clientInfo ?? {}, tool.name, durationMs, safe.code);
			logToolQuery(logName, query, {}, { ...options.logOptions, durationMs, success: false, error: safe.message });
			return {
				isError: true,
				content: [{ type: 'text', text: safe.message }],
				_meta: { 'huggingface.co/ptc-error': { code: safe.code, retryable: safe.retryable } },
			} as CallToolResult;
		}
	};
}

/**
 * Register the PTC bouquet on a request-scoped server: every tool the token can use,
 * minus DISABLE_TOOLS. Returns the registered names.
 */
export function registerPtcTools(server: McpServer, options: RegisterPtcToolsOptions): string[] {
	const access = ptcAccess(options.hfToken, options.user);
	recordPtcRequest(options.clientInfo ?? {}, access);
	const tools = ptcToolsForAccess(access).filter((tool) => !options.disabledTools.has(tool.name));
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				// Accepts habitual argument names and reports actionable validation messages.
				inputSchema: advertisedInputSchema(tool.input),
				// Smaller open schema for tools/list; results are still validated against tool.output.
				outputSchema: advertisedOutputSchema(tool.output),
				annotations: { title: tool.title, ...tool.annotations },
			},
			handler(tool, options)
		);
	}
	return tools.map((tool) => tool.name);
}
