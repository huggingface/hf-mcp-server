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

const SECRET_PARAM =
	/^(?:.*token.*|.*secret.*|.*passw(?:or)?d.*|.*api[-_]?key.*|key|auth.*|sig|signature|x-amz-[\w-]+|credential.*)$/i;

/**
 * Remove credentials a caller may have pasted into a uri/ref: URL userinfo, token-like query
 * parameters (token, access_token, api_key, sig, X-Amz-Signature...) and Hugging Face tokens.
 */
export function redactLoggedValue(value: string): string {
	return value
		.replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/?#@]*@/gi, '$1<redacted>@')
		.replace(/([?&;])([^=&#\s;]+)=([^&#\s;]*)/g, (match, sep: string, name: string) =>
			SECRET_PARAM.test(decodeName(name)) ? `${sep}${name}=<redacted>` : match
		)
		.replace(/\bhf_[A-Za-z0-9]{8,}\b/g, 'hf_<redacted>');
}

function decodeName(name: string): string {
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/** Argument names whose value is a short, useful query term (checked in order, on the raw arguments). */
const LOGGED_KEYS = [
	'query',
	'uri',
	'repo',
	'repos',
	'dataset',
	'space',
	'discussion',
	'paper',
	'papers',
	'job',
	// Pre-rename names, still accepted as aliases (logged before normalization).
	'ref',
	'refs',
	'paper_ids',
	'job_id',
];

/** Arguments that are safe and useful to log: short scalar search terms only, with credentials removed. */
function loggedQuery(params: Record<string, unknown>): string {
	for (const key of LOGGED_KEYS) {
		const value = params[key];
		if (typeof value === 'string') return redactLoggedValue(value).slice(0, 500);
		if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
			return redactLoggedValue(value.join(',')).slice(0, 500);
		}
	}
	return '';
}

/** Metrics and query logs are best-effort: a failure here must never change the tool result. */
function observe(record: () => void): void {
	try {
		record();
	} catch {
		// Swallowed on purpose: the call has already completed (a write may have been applied).
	}
}

/**
 * The SDK would validate arguments before the handler runs and answer failures itself, without
 * the ptc-error code and without metrics. Advertise the same schema but defer validation to
 * callPtcTool, which normalizes and validates identically and reports a coded INVALID_ARGUMENT.
 */
function deferValidation(schema: ReturnType<typeof advertisedInputSchema>): ReturnType<typeof advertisedInputSchema> {
	return {
		'~standard': {
			...schema['~standard'],
			validate: (value: unknown) => ({ value: (value ?? {}) as Record<string, unknown> }),
		},
	};
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
		let query = '';
		observe(() => {
			query = loggedQuery(params);
		});
		let result: Awaited<ReturnType<typeof callPtcTool>>;
		try {
			result = await callPtcTool(tool, params, ptcCtx);
		} catch (error) {
			const safe = toPtcError(error, tool.name);
			const durationMs = Math.round(performance.now() - start);
			observe(() => recordPtcToolCall(options.clientInfo ?? {}, tool.name, durationMs, safe.code));
			observe(() =>
				logToolQuery(logName, query, {}, { ...options.logOptions, durationMs, success: false, error: safe.message })
			);
			return {
				isError: true,
				content: [{ type: 'text', text: safe.message }],
				_meta: { 'huggingface.co/ptc-error': { code: safe.code, retryable: safe.retryable } },
			} as CallToolResult;
		}
		// The call completed: from here on nothing may turn it into an error (no duplicate writes).
		const durationMs = Math.round(performance.now() - start);
		// A remote tool (e.g. a Space) can run and still report failure: keep MCP isError and count it.
		observe(() =>
			recordPtcToolCall(options.clientInfo ?? {}, tool.name, durationMs, result.isError ? 'TOOL_ERROR' : undefined)
		);
		observe(() => {
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
		});
		return {
			structuredContent: result.structured,
			content: result.content,
			...(result.isError ? { isError: true } : {}),
		} as CallToolResult;
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
				inputSchema: deferValidation(advertisedInputSchema(tool.input)),
				// Smaller open schema for tools/list; results are still validated against tool.output.
				outputSchema: advertisedOutputSchema(tool.output),
				annotations: { title: tool.title, ...tool.annotations },
			},
			handler(tool, options)
		);
	}
	return tools.map((tool) => tool.name);
}
