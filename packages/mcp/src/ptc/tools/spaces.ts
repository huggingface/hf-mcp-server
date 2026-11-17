import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/client';
import {
	definePtcTool,
	MUTATING,
	PtcResult,
	READ_ONLY,
	type PtcContent,
	type PtcContext,
	type PtcTool,
} from '../core/tool.js';
import { PtcError, ptcHttpError } from '../core/errors.js';
import { hubFetch } from '../core/hub-http.js';
import { itemSchema, parseRef, refSchema, repoItem, type PtcItem } from '../core/refs.js';
import { fetchGradioSchema, SpaceHttpError } from '../../space/utils/space-http.js';
import { ResponseTooLargeError } from '../../network/read-capped.js';
import { analyzeSchemaComplexity, applyDefaults, validateParameters } from '../../space/utils/schema-validator.js';
import { callGradioToolWithHeaders } from '../../space/utils/gradio-caller.js';
import { isFileDataProperty, type JsonSchemaProperty } from '../../space/types.js';
import { isIpInternalOrReserved } from '../../network/ip-policy.js';

const MAX_TOOLS = 50;
const MAX_DESCRIPTION = 4000;
/** Aggregate text budget across all text content blocks (and the structured text mirror). */
const MAX_TEXT = 20_000;
/** Aggregate image/audio budget: each block is returned complete or dropped (8 MiB decoded in total). */
const MAX_MEDIA_BASE64 = Math.ceil((8 * 1024 * 1024 * 4) / 3);
/** Upstream content blocks considered; the rest are dropped with a warning. */
const MAX_BLOCKS = 32;
const MAX_URI = 2048;
const MAX_LINK_TEXT = 500;
const MAX_WARNINGS = 20;
/** Per-tool and total JSON size of the schemas returned by hf_space_tools. */
const MAX_SCHEMA_CHARS = 32_000;
const MAX_TOOLS_CHARS = 200_000;
/** Total deadline for one hf_space_invoke call (connect + call), even while the Space reports progress. */
const INVOKE_DEADLINE_MS = 10 * 60_000;
/** Schema body budget, enforced while streaming (before parsing). */
const MAX_SCHEMA_BYTES = 2 * 1024 * 1024;
const RUNNING_STAGES = new Set(['RUNNING', 'RUNNING_BUILDING', 'RUNNING_APP_STARTING']);

interface SpaceInfo {
	item: PtcItem;
	subdomain?: string;
	private: boolean;
	sdk?: string;
	stage?: string;
	hardware?: string;
}

const spaceSchema = itemSchema.extend({
	sdk: z.string().optional(),
	stage: z.string().optional().describe('Runtime stage, e.g. RUNNING, SLEEPING, BUILDING, RUNTIME_ERROR, PAUSED.'),
	running: z.boolean(),
	hardware: z.string().optional(),
});

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function parseSpaceRef(ref: string): string {
	const parsed = parseRef(ref, 'space');
	if (parsed.kind !== 'space' || parsed.path || parsed.revision) {
		throw new PtcError('INVALID_ARGUMENT', 'space must reference a Space repository, e.g. hf://spaces/owner/name.');
	}
	return parsed.id;
}

/** One Hub call: subdomain, runtime, visibility and SDK (no separate /runtime request). */
async function resolveSpace(ref: string, ctx: PtcContext): Promise<SpaceInfo> {
	const id = parseSpaceRef(ref);
	const params = new URLSearchParams();
	for (const field of ['subdomain', 'runtime', 'private', 'sdk']) params.append('expand', field);
	const { data } = await hubFetch(
		{ path: `/api/spaces/${id.split('/').map(encodeURIComponent).join('/')}`, params, subject: 'Space' },
		ctx
	);
	const info = (data ?? {}) as {
		id?: unknown;
		subdomain?: unknown;
		private?: unknown;
		sdk?: unknown;
		runtime?: { stage?: unknown; hardware?: { current?: unknown; requested?: unknown } };
	};
	const canonical = str(info.id) ?? id;
	return {
		item: repoItem('space', /^[\w.-]+\/[\w.-]+$/.test(canonical) ? canonical : id),
		subdomain: str(info.subdomain),
		private: info.private === true,
		sdk: str(info.sdk),
		stage: str(info.runtime?.stage),
		hardware: str(info.runtime?.hardware?.current) ?? str(info.runtime?.hardware?.requested),
	};
}

function spaceRecord(info: SpaceInfo): z.input<typeof spaceSchema> {
	return {
		...info.item,
		...(info.sdk ? { sdk: info.sdk } : {}),
		...(info.stage ? { stage: info.stage } : {}),
		running: info.stage ? RUNNING_STAGES.has(info.stage) : false,
		...(info.hardware ? { hardware: info.hardware } : {}),
	};
}

function isDeadline(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	// AbortSignal.timeout rejects with TimeoutError; the MCP SDK reports maxTotalTimeout as McpError RequestTimeout.
	return error.name === 'TimeoutError' || /maximum total timeout|request timed out/i.test(error.message);
}

function spaceHttpError(error: unknown): unknown {
	return error instanceof SpaceHttpError ? ptcHttpError(error.status, 'Space MCP endpoint') : error;
}

async function loadSpaceTools(info: SpaceInfo, ctx: PtcContext): Promise<Tool[]> {
	if (!info.subdomain) {
		throw new PtcError('UNSUPPORTED', 'this Space has no app endpoint (no subdomain); it cannot be called as a tool.');
	}
	try {
		return await fetchGradioSchema(info.subdomain, info.private, ctx.hfToken, {
			maxBytes: MAX_SCHEMA_BYTES,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
	} catch (error) {
		if (ctx.signal?.aborted) throw new PtcError('CANCELLED', 'Space MCP schema: cancelled.', true);
		if (error instanceof ResponseTooLargeError) {
			throw new PtcError('UPSTREAM_RESPONSE', `the Space MCP schema exceeds ${String(MAX_SCHEMA_BYTES)} bytes.`);
		}
		throw spaceHttpError(error);
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ------------------------------------------------------------------ hf_space_tools

const toolsInput = z
	.object({
		space: refSchema.describe('Space: hf://spaces/owner/name (preferred), owner/name or URL.'),
	})
	.strict();

const toolsOutput = z
	.object({
		space: spaceSchema,
		tools: z.array(
			z
				.object({
					name: z.string().describe('Pass as tool to hf_space_invoke.'),
					description: z.string(),
					input_schema: z.record(z.string(), z.unknown()).describe('JSON Schema for the arguments object.'),
					file_inputs: z
						.array(z.string())
						.describe('Parameters that take a file: pass a public http(s) URL as the value.'),
					locally_validated: z
						.boolean()
						.describe('False when the schema is too complex for local checks; arguments are passed through as-is.'),
					schema_omitted: z
						.boolean()
						.optional()
						.describe('True when input_schema was too large to return; consult the Space docs instead.'),
				})
				.strict()
		),
		returned_count: z.number().int(),
		truncated: z
			.boolean()
			.describe('True when the Space exposes more tools than were returned (count or size budget).'),
		note: z.string().optional(),
	})
	.strict();

async function spaceTools(input: z.output<typeof toolsInput>, ctx: PtcContext): Promise<z.input<typeof toolsOutput>> {
	const info = await resolveSpace(input.space, ctx);
	const record = spaceRecord(info);
	let tools: Tool[];
	try {
		tools = await loadSpaceTools(info, ctx);
	} catch (error) {
		// A Space that is asleep, not Gradio, or not MCP-enabled is an answer, not a failure.
		const code = error instanceof PtcError ? error.code : undefined;
		if (code === 'AUTH_REQUIRED' || code === 'FORBIDDEN' || code === 'CANCELLED') throw error;
		// Only the schema size budget yields UPSTREAM_RESPONSE here (HTTP statuses map to other codes).
		if (code === 'UPSTREAM_RESPONSE') throw error;
		// Rate limits and server errors from a running Space are transient: report a retryable error,
		// not "no tools". A Space that is not running answers 5xx while asleep; the note explains that.
		if (error instanceof PtcError && error.retryable && (record.running || /HTTP 429\b/.test(error.message))) {
			throw error;
		}
		const reason = !record.running
			? `the Space is not running (stage ${info.stage ?? 'unknown'}); it may need waking or a rebuild`
			: info.sdk && info.sdk !== 'gradio'
				? `the Space uses the ${info.sdk} SDK, not Gradio`
				: 'the Space does not expose a Gradio MCP schema (mcp_server not enabled?)';
		return {
			space: record,
			tools: [],
			returned_count: 0,
			truncated: false,
			note: `No MCP tools available: ${reason}.`,
		};
	}
	const shown: z.input<typeof toolsOutput>['tools'] = [];
	let used = 0;
	let omitted = 0;
	for (const tool of tools.slice(0, MAX_TOOLS)) {
		const analysis = analyzeSchemaComplexity(tool);
		const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
		const oversized = JSON.stringify(schema).length > MAX_SCHEMA_CHARS;
		if (oversized) omitted++;
		const entry = {
			name: truncate(tool.name, 256),
			description: truncate(tool.description ?? '', MAX_DESCRIPTION),
			input_schema: oversized ? { type: 'object' } : schema,
			...(oversized ? { schema_omitted: true } : {}),
			file_inputs: analysis.parameters.filter((p) => p.isFileData).map((p) => p.name),
			locally_validated: analysis.isSimple,
		};
		used += JSON.stringify(entry).length;
		if (used > MAX_TOOLS_CHARS && shown.length > 0) break;
		shown.push(entry);
	}
	const notes = [
		...(record.running ? [] : ['The Space is not running; calling it may wake it and take a while.']),
		...(omitted
			? [`${omitted} input schema(s) exceeded ${MAX_SCHEMA_CHARS} characters and were omitted (schema_omitted).`]
			: []),
		...(shown.length < Math.min(tools.length, MAX_TOOLS)
			? ['Tool list cut to stay within the response size budget.']
			: []),
	];
	return {
		space: record,
		tools: shown,
		returned_count: shown.length,
		truncated: tools.length > shown.length,
		...(notes.length ? { note: notes.join(' ') } : {}),
	};
}

// ------------------------------------------------------------------ hf_space_invoke

const invokeInput = z
	.object({
		space: refSchema.describe('Space to run: hf://spaces/owner/name (preferred), "owner/name", or a Space URL.'),
		tool: z.string().trim().min(1).max(256).describe('Exact tool name from hf_space_tools.'),
		arguments: z
			.record(z.string(), z.unknown())
			.default({})
			.describe("Arguments matching the tool's input_schema; files as public http(s) URLs."),
	})
	.strict();

const mediaSchema = z
	.object({
		type: z.enum(['image', 'audio', 'resource_link', 'resource']),
		mime_type: z.string().optional(),
		uri: z.string().optional().describe('Link to the generated file (resource links and embedded resources).'),
	})
	.strict();

const invokeOutput = z
	.object({
		space: itemSchema,
		tool: z.string(),
		is_error: z.boolean().describe('True when the Space tool reported an error (its message is in text).'),
		text: z.string().describe('Concatenated text output, about 20,000 characters at most in total.'),
		text_truncated: z.boolean(),
		media: z
			.array(mediaSchema)
			.max(MAX_BLOCKS)
			.describe('Images, audio and files returned as content blocks (8 MiB of media in total).'),
		warnings: z.array(z.string()).max(MAX_WARNINGS),
	})
	.strict();

interface UpstreamBlock {
	type?: unknown;
	text?: unknown;
	data?: unknown;
	mimeType?: unknown;
	uri?: unknown;
	name?: unknown;
	description?: unknown;
	resource?: { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
}

/** Warnings are deduplicated and bounded. */
function warn(warnings: string[], message: string): void {
	if (!warnings.includes(message) && warnings.length < MAX_WARNINGS) warnings.push(message);
}

/**
 * Map upstream MCP content to PTC content under one shared budget: at most MAX_BLOCKS blocks, MAX_TEXT
 * characters of text in total (text blocks and embedded text resources), MAX_MEDIA_BASE64 of image/audio
 * in total (each block complete or dropped), and bounded link metadata. The structured mirror (text,
 * media) is derived from exactly what is kept, so content and structured output agree.
 */
function mapContent(blocks: unknown[], warnings: string[]) {
	const content: PtcContent[] = [];
	const media: z.input<typeof mediaSchema>[] = [];
	const texts: string[] = [];
	let textLeft = MAX_TEXT;
	let mediaLeft = MAX_MEDIA_BASE64;
	let textTruncated = false;

	const addText = (text: string) => {
		const kept = text.slice(0, textLeft);
		if (kept.length < text.length) {
			textTruncated = true;
			warn(warnings, `Text output truncated to ${MAX_TEXT} characters in total.`);
		}
		if (!kept) return;
		textLeft -= kept.length;
		texts.push(kept);
		content.push({ type: 'text', text: kept });
	};
	const linkUri = (uri: string | undefined) => {
		if (uri && uri.length > MAX_URI) {
			warn(warnings, `Dropped a file link longer than ${MAX_URI} characters.`);
			return undefined;
		}
		return uri;
	};

	if (blocks.length > MAX_BLOCKS)
		warn(warnings, `Only the first ${MAX_BLOCKS} of ${blocks.length} content blocks kept.`);
	for (const raw of blocks.slice(0, MAX_BLOCKS)) {
		const block = (typeof raw === 'string' ? { type: 'text', text: raw } : (raw ?? {})) as UpstreamBlock;
		const mimeType = str(block.mimeType) ? truncate(str(block.mimeType) ?? '', 100) : undefined;
		if (block.type === 'text' && typeof block.text === 'string') {
			addText(block.text);
		} else if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
			if (block.data.length > mediaLeft) {
				warn(warnings, `Dropped ${block.type} output beyond the 8 MiB total media budget.`);
				continue;
			}
			mediaLeft -= block.data.length;
			const type = block.type;
			const mime = mimeType ?? (type === 'image' ? 'image/png' : 'audio/wav');
			content.push({ type, data: block.data, mimeType: mime });
			media.push({ type, mime_type: mime });
		} else if (block.type === 'resource_link' && typeof block.uri === 'string') {
			const uri = linkUri(block.uri);
			if (!uri) continue;
			const description = str(block.description);
			content.push({
				type: 'resource_link',
				uri,
				name: truncate(str(block.name) ?? (uri.split('/').pop() || 'file'), 200),
				...(mimeType ? { mimeType } : {}),
				...(description ? { description: truncate(description, MAX_LINK_TEXT) } : {}),
			});
			media.push({ type: 'resource_link', ...(mimeType ? { mime_type: mimeType } : {}), uri });
		} else if (block.type === 'resource' && block.resource) {
			const uri = linkUri(str(block.resource.uri));
			const mime = str(block.resource.mimeType) ? truncate(str(block.resource.mimeType) ?? '', 100) : undefined;
			if (typeof block.resource.text === 'string') {
				addText(block.resource.text);
			} else if (uri) {
				content.push({
					type: 'resource_link',
					uri,
					name: truncate(uri.split('/').pop() || 'file', 200),
					...(mime ? { mimeType: mime } : {}),
				});
			} else {
				warn(warnings, 'Skipped an embedded resource without text or a usable URI.');
				continue;
			}
			media.push({ type: 'resource', ...(mime ? { mime_type: mime } : {}), ...(uri ? { uri } : {}) });
		} else {
			warn(warnings, 'Skipped an unsupported content block.');
		}
	}
	return { content, media, text: texts.join('\n'), textTruncated };
}

// ------------------------------------------------------------------ file inputs

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/**
 * A file input must be a public http(s) URL: no file:/data: or other schemes, no credentials, no
 * localhost or internal names, no private, loopback or link-local IP literals. Hostnames are not
 * resolved here (the Space fetches the file, not this server).
 */
function checkFileUrl(name: string, value: string): void {
	const reject = (why: string) => {
		throw new PtcError(
			'INVALID_ARGUMENT',
			`file input ${JSON.stringify(truncate(name, 80))} must be a public http(s) URL (${why}).`
		);
	};
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return reject('not a URL');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') reject(`${url.protocol} is not allowed`);
	if (url.username || url.password) reject('credentials are not allowed');
	const host = url.hostname.toLowerCase().replace(/\.+$/, '');
	if (!host || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		reject('local hostnames are not allowed');
	}
	let internal = false;
	try {
		internal = isIpInternalOrReserved(host);
	} catch {
		// Not an IP literal: a public DNS name.
	}
	if (internal) reject('private, loopback and link-local addresses are not allowed');
}

/** Gradio FileData object ({path, url, meta: {_type: 'gradio.FileData'}}) or a list of them. */
function checkFileValue(name: string, value: unknown): void {
	if (typeof value === 'string') return checkFileUrl(name, value);
	if (Array.isArray(value)) {
		for (const entry of value) checkFileValue(name, entry);
		return;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of ['url', 'path']) {
			if (typeof record[key] === 'string') checkFileUrl(name, record[key]);
		}
	}
}

/** Find FileData objects nested anywhere in an argument value (bounded depth). */
function checkNestedFileData(name: string, value: unknown, depth = 0): void {
	if (depth > 8 || !value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const entry of value) checkNestedFileData(name, entry, depth + 1);
		return;
	}
	const record = value as Record<string, unknown>;
	const meta = record.meta as { _type?: unknown } | undefined;
	if (meta && typeof meta === 'object' && meta._type === 'gradio.FileData') checkFileValue(name, record);
	for (const entry of Object.values(record)) checkNestedFileData(name, entry, depth + 1);
}

/**
 * Validate every recognised file input: top-level properties the schema marks as FileData/ImageData
 * (also in schemas too complex for full local validation) and any nested gradio.FileData object.
 * Other values in opaque complex schemas are passed through unvalidated; the Space is responsible.
 */
function checkFileInputs(tool: Tool, args: Record<string, unknown>): void {
	const properties = ((tool.inputSchema ?? {}) as { properties?: Record<string, JsonSchemaProperty> }).properties ?? {};
	for (const [name, value] of Object.entries(args)) {
		const prop = properties[name];
		if (prop && typeof prop === 'object' && isFileDataProperty(prop) && value != null) checkFileValue(name, value);
		checkNestedFileData(name, value);
	}
}

async function spaceInvoke(input: z.output<typeof invokeInput>, ctx: PtcContext) {
	const info = await resolveSpace(input.space, ctx);
	const tools = await loadSpaceTools(info, ctx);
	const tool = tools.find((candidate) => candidate.name === input.tool);
	if (!tool) {
		const names = tools
			.slice(0, 20)
			.map((candidate) => JSON.stringify(truncate(candidate.name, 80)))
			.join(', ');
		throw new PtcError('NOT_FOUND', `tool not found in this Space. Available tools: ${names || 'none'}.`);
	}

	const warnings: string[] = [];
	let args = input.arguments;
	checkFileInputs(tool, args);
	const analysis = analyzeSchemaComplexity(tool);
	if (analysis.isSimple) {
		const validation = validateParameters(args, analysis);
		if (!validation.valid) {
			throw new PtcError('INVALID_ARGUMENT', truncate(validation.errors.join('; '), 1000));
		}
		const known = new Set(analysis.parameters.map((p) => p.name));
		for (const key of Object.keys(args)) {
			if (!known.has(key)) warn(warnings, `Unknown parameter ${JSON.stringify(truncate(key, 80))} passed through.`);
		}
		args = applyDefaults(args, analysis);
	} else {
		warn(
			warnings,
			'Schema too complex for local validation; arguments passed through unchanged (file inputs still checked).'
		);
	}

	if (!info.subdomain) throw new PtcError('UNSUPPORTED', 'this Space has no app endpoint.');
	let result;
	try {
		({ result } = await callGradioToolWithHeaders(
			`https://${info.subdomain}.hf.space/gradio_api/mcp/`,
			tool.name,
			args,
			ctx.hfToken,
			{
				maxTotalMs: INVOKE_DEADLINE_MS,
				...(ctx.signal ? { signal: ctx.signal } : {}),
				onProgress: ctx.onProgress
					? (progress) =>
							ctx.onProgress?.({
								progress: progress.progress,
								...(progress.total !== undefined ? { total: progress.total } : {}),
								...(progress.message ? { message: progress.message } : {}),
							})
					: undefined,
			}
		));
	} catch (error) {
		if (ctx.signal?.aborted) throw new PtcError('CANCELLED', 'Space call: cancelled.', true);
		if (isDeadline(error)) {
			throw new PtcError(
				'UPSTREAM_UNAVAILABLE',
				`the Space call timed out (no response, or over the ${String(INVOKE_DEADLINE_MS / 60_000)}-minute limit); it may still have run.`,
				true
			);
		}
		throw spaceHttpError(error);
	}

	const mapped = mapContent(Array.isArray(result.content) ? result.content : [], warnings);
	const isError = result.isError === true;
	const structured = {
		space: info.item,
		tool: tool.name,
		is_error: isError,
		text: mapped.text,
		text_truncated: mapped.textTruncated,
		media: mapped.media,
		warnings,
	};
	// A Space that ran but reported failure is an MCP tool error (isError), with its diagnostics kept.
	return new PtcResult(structured, mapped.content, isError ? { isError: true } : {});
}

/** Callable Spaces: describe tools and invoke. */
export const SPACES_TOOLS: readonly PtcTool[] = [
	definePtcTool({
		name: 'hf_space_tools',
		family: 'spaces',
		title: 'List the tools of a Hugging Face Space',
		description:
			'Inspect Hugging Face Space MCP tools (Gradio apps, AI demos) before calling a Space. Select a Space by ID, URI or URL to get tool names, descriptions, argument schemas and file inputs that accept public URLs. Reports whether the Space is running, plus SDK, hardware and runtime stage when available. Results flag when the tool list is truncated. Then hf_space_invoke.',
		input: toolsInput,
		output: toolsOutput,
		access: 'anonymous',
		annotations: READ_ONLY,
		run: (input, ctx) => spaceTools(input, ctx),
	}),
	definePtcTool({
		name: 'hf_space_invoke',
		family: 'spaces',
		title: 'Run a Hugging Face Space tool',
		description:
			"Run Hugging Face Space tools (Gradio apps, AI demos) by exact tool name and JSON arguments. Select a Space by ID, URI or URL and supply arguments matching its input schema, with file inputs as public HTTP(S) URLs. Results include text, any image, audio or file content returned, warnings and a tool error indicator. The call runs the remote app, which may have side effects; ZeroGPU calls use the caller's quota. See hf_space_tools.",
		input: invokeInput,
		output: invokeOutput,
		access: 'anonymous',
		// Not DESTRUCTIVE: it starts no paid compute and deletes nothing on the caller's account (unlike
		// hf_job_run); the remote tool's own effects are unknown, so it is not read-only either.
		annotations: MUTATING,
		run: (input, ctx) => spaceInvoke(input, ctx),
	}),
];
