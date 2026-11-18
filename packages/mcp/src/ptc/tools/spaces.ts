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
import { PtcError, ptcHttpError, toPtcError } from '../core/errors.js';
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
	// Runtime stage, e.g. RUNNING, SLEEPING, BUILDING, RUNTIME_ERROR, PAUSED.
	stage: z.string().optional(),
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
					inputSchema: z.record(z.string(), z.unknown()),
					fileInputs: z
						.array(z.string())
						.describe('Parameters that take a file: pass a public http(s) URL as the value.'),
					locallyValidated: z.boolean().describe('False: arguments are passed through unchecked.'),
					schemaOmitted: z.boolean().optional().describe('Too large to return; see the Space docs.'),
				})
				.strict()
		),
		returnedCount: z.number().int(),
		truncated: z.boolean().describe('More tools exist than were returned.'),
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
			returnedCount: 0,
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
			inputSchema: oversized ? { type: 'object' } : schema,
			...(oversized ? { schemaOmitted: true } : {}),
			fileInputs: analysis.parameters.filter((p) => p.isFileData).map((p) => p.name),
			locallyValidated: analysis.isSimple,
		};
		used += JSON.stringify(entry).length;
		if (used > MAX_TOOLS_CHARS && shown.length > 0) break;
		shown.push(entry);
	}
	const notes = [
		...(record.running ? [] : ['The Space is not running; calling it may wake it and take a while.']),
		...(omitted
			? [`${omitted} input schema(s) exceeded ${MAX_SCHEMA_CHARS} characters and were omitted (schemaOmitted).`]
			: []),
		...(shown.length < Math.min(tools.length, MAX_TOOLS)
			? ['Tool list cut to stay within the response size budget.']
			: []),
	];
	return {
		space: record,
		tools: shown,
		returnedCount: shown.length,
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
			.describe("Arguments matching the tool's inputSchema; files as public http(s) URLs."),
	})
	.strict();

const mediaSchema = z
	.object({
		type: z.enum(['image', 'audio', 'resource_link', 'resource']),
		mimeType: z.string().optional(),
		// Link to the generated file (resource links and embedded resources).
		uri: z.string().optional(),
	})
	.strict();

const invokeOutput = z
	.object({
		space: itemSchema,
		tool: z.string(),
		isError: z.boolean().describe('The error message is in text.'),
		text: z.string().describe('About 20,000 characters at most.'),
		textTruncated: z.boolean(),
		media: z
			.array(mediaSchema)
			.max(MAX_BLOCKS)
			.describe('8 MiB of media in total; includes links to Gradio file outputs found in text.'),
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

/** Content types for file extensions Spaces commonly return; anything else is linked without a mimeType. */
const FILE_MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	glb: 'model/gltf-binary',
	gltf: 'model/gltf+json',
	obj: 'model/obj',
	ply: 'application/octet-stream',
	pdf: 'application/pdf',
	json: 'application/json',
	csv: 'text/csv',
	txt: 'text/plain',
	zip: 'application/zip',
};
/** Text blocks longer than this are not parsed for FileData (Gradio prints small reprs). */
const MAX_FILE_SCAN = 200_000;
const MAX_LITERAL_DEPTH = 32;
const MAX_LITERAL_NODES = 20_000;
const STRING_ESCAPES: Record<string, string> = {
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	'\\': '\\',
	"'": "'",
	'"': '"',
	'/': '/',
};
const LITERAL_NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?j?/y;
const LITERAL_NAME = /[A-Za-z_]\w*/y;
const LITERAL_CONSTANTS = new Set(['None', 'True', 'False', 'null', 'true', 'false', 'inf', 'nan']);

/**
 * Parse the JSON / Python-literal (repr) subset Gradio prints for outputs: dicts, lists, tuples, strings,
 * numbers and constants. Bounded and non-evaluating; dicts become Maps (string keys only matter), scalars
 * other than strings become null. Anything else (class reprs, bytes, prose) throws.
 */
function parseLiteral(text: string): unknown {
	let i = 0;
	let nodes = 0;
	const fail = (): never => {
		throw new Error('not a literal');
	};
	const ws = () => {
		while (i < text.length && /\s/.test(text[i] ?? '')) i++;
	};
	const hex = (length: number): string => {
		const digits = text.slice(i, i + length);
		if (!new RegExp(`^[0-9a-fA-F]{${String(length)}}$`).test(digits)) fail();
		i += length;
		const code = Number.parseInt(digits, 16);
		return code <= 0x10ffff ? String.fromCodePoint(code) : fail();
	};
	const string = (): string => {
		const quote = text[i++];
		let out = '';
		while (i < text.length) {
			const char = text[i++];
			if (char === quote) return out;
			if (char === '\n') fail();
			if (char !== '\\') {
				out += char;
				continue;
			}
			const escape = text[i++] ?? fail();
			if (escape === 'x') out += hex(2);
			else if (escape === 'u') out += hex(4);
			else if (escape === 'U') out += hex(8);
			else out += STRING_ESCAPES[escape] ?? `\\${escape}`;
		}
		return fail();
	};
	const items = (close: string, item: () => void) => {
		i++;
		for (;;) {
			ws();
			if (text[i] === close) {
				i++;
				return;
			}
			item();
			ws();
			if (text[i] === ',') i++;
			else if (text[i] !== close) fail();
		}
	};
	const value = (depth: number): unknown => {
		if (depth > MAX_LITERAL_DEPTH || ++nodes > MAX_LITERAL_NODES) fail();
		ws();
		const char = text[i];
		if (char === '{') {
			const map = new Map<string, unknown>();
			items('}', () => {
				const key = value(depth + 1);
				ws();
				if (text[i++] !== ':') fail();
				const entry = value(depth + 1);
				if (typeof key === 'string') map.set(key, entry);
			});
			return map;
		}
		if (char === '[' || char === '(') {
			const list: unknown[] = [];
			items(char === '[' ? ']' : ')', () => list.push(value(depth + 1)));
			return list;
		}
		if (char === '"' || char === "'") return string();
		for (const pattern of [LITERAL_NUMBER, LITERAL_NAME]) {
			pattern.lastIndex = i;
			const match = pattern.exec(text);
			if (match && (pattern === LITERAL_NUMBER || LITERAL_CONSTANTS.has(match[0]))) {
				i += match[0].length;
				return null;
			}
		}
		return fail();
	};
	const result = value(0);
	ws();
	return i === text.length ? result : fail();
}

/** The url of every gradio.FileData object (url and meta._type on the same dict) in a parsed literal. */
function fileDataUrls(node: unknown, out: string[] = []): string[] {
	if (Array.isArray(node)) for (const entry of node) fileDataUrls(entry, out);
	else if (node instanceof Map) {
		const dict = node as Map<unknown, unknown>;
		const meta: unknown = dict.get('meta');
		const url: unknown = dict.get('url');
		if (
			meta instanceof Map &&
			(meta as Map<unknown, unknown>).get('_type') === 'gradio.FileData' &&
			typeof url === 'string'
		)
			out.push(url);
		for (const entry of dict.values()) fileDataUrls(entry, out);
	}
	return out;
}

/**
 * File URLs of gradio.FileData objects that a Gradio Space printed as a text block (its MCP output for
 * image/audio/file components, as JSON or a Python repr). Only https links on the Space's own host are trusted.
 */
function fileDataLinks(text: string, spaceHost: string | undefined): { uri: string; mimeType?: string }[] {
	if (!spaceHost || text.length > MAX_FILE_SCAN || !text.includes('gradio.FileData')) return [];
	let parsed: unknown;
	try {
		parsed = parseLiteral(text);
	} catch {
		return [];
	}
	const links: { uri: string; mimeType?: string }[] = [];
	for (const href of fileDataUrls(parsed)) {
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			continue;
		}
		if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
		if (url.hostname.toLowerCase() !== spaceHost) continue;
		const extension = /\.([a-z0-9]{1,8})$/i.exec(url.pathname)?.[1]?.toLowerCase();
		const mimeType = extension ? FILE_MIME_TYPES[extension] : undefined;
		links.push({ uri: url.href, ...(mimeType ? { mimeType } : {}) });
	}
	return links;
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
function mapContent(blocks: unknown[], warnings: string[], spaceHost?: string) {
	const content: PtcContent[] = [];
	const media: z.input<typeof mediaSchema>[] = [];
	const texts: string[] = [];
	let textLeft = MAX_TEXT;
	let mediaLeft = MAX_MEDIA_BASE64;
	let textTruncated = false;
	// FileData links found in text, placed after their text block once the original content is mapped.
	const found: { at: number; mediaAt: number; links: { uri: string; mimeType?: string }[] }[] = [];

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
			// Gradio returns image/audio/file outputs as FileData printed in text: surface them as links too.
			const links = fileDataLinks(block.text, spaceHost);
			if (links.length) found.push({ at: content.length, mediaAt: media.length, links });
		} else if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
			if (block.data.length > mediaLeft) {
				warn(warnings, `Dropped ${block.type} output beyond the 8 MiB total media budget.`);
				continue;
			}
			mediaLeft -= block.data.length;
			const type = block.type;
			const mime = mimeType ?? (type === 'image' ? 'image/png' : 'audio/wav');
			content.push({ type, data: block.data, mimeType: mime });
			media.push({ type, mimeType: mime });
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
			media.push({ type: 'resource_link', ...(mimeType ? { mimeType } : {}), uri });
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
			media.push({ type: 'resource', ...(mime ? { mimeType: mime } : {}), ...(uri ? { uri } : {}) });
		} else {
			warn(warnings, 'Skipped an unsupported content block.');
		}
	}
	addFileLinks(content, media, found, warnings, linkUri);
	return { content, media, text: texts.join('\n'), textTruncated };
}

/**
 * Insert FileData links after their text blocks, in the slots the original content leaves under MAX_BLOCKS
 * (original output is never displaced). Each URI is linked once, and not again if the Space also linked it.
 */
function addFileLinks(
	content: PtcContent[],
	media: z.input<typeof mediaSchema>[],
	found: { at: number; mediaAt: number; links: { uri: string; mimeType?: string }[] }[],
	warnings: string[],
	linkUri: (uri: string | undefined) => string | undefined
): void {
	const linked = new Set(content.flatMap((block) => (block.type === 'resource_link' ? [block.uri] : [])));
	let slots = MAX_BLOCKS - content.length;
	const accepted: { at: number; mediaAt: number; uri: string; mimeType?: string }[] = [];
	for (const { at, mediaAt, links } of found) {
		for (const link of links) {
			const uri = linkUri(link.uri);
			if (!uri || linked.has(uri)) continue;
			if (slots <= 0) {
				warn(warnings, `File links beyond the ${String(MAX_BLOCKS)}-block content cap dropped.`);
				break;
			}
			slots--;
			linked.add(uri);
			accepted.push({ at, mediaAt, uri, ...(link.mimeType ? { mimeType: link.mimeType } : {}) });
		}
	}
	// Splice from the end so earlier insertion points stay valid; equal points keep their order.
	for (const { at, mediaAt, uri, mimeType } of accepted.reverse()) {
		const name = truncate(uri.split('/').pop() || 'file', 200);
		content.splice(at, 0, { type: 'resource_link', uri, name, ...(mimeType ? { mimeType } : {}) });
		media.splice(mediaAt, 0, { type: 'resource_link', ...(mimeType ? { mimeType } : {}), uri });
	}
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
		// Name the Space and tool: the generic fallback would name hf_space_invoke itself.
		throw toPtcError(spaceHttpError(error), `Space ${info.item.id} tool ${truncate(tool.name, 120)}`);
	}

	const mapped = mapContent(
		Array.isArray(result.content) ? result.content : [],
		warnings,
		`${info.subdomain}.hf.space`.toLowerCase()
	);
	const isError = result.isError === true;
	const structured = {
		space: info.item,
		tool: tool.name,
		isError,
		text: mapped.text,
		textTruncated: mapped.textTruncated,
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
