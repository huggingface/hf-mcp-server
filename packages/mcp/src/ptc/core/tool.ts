import type { z } from 'zod';
import { normalizePtcArguments, ptcInputIssueMessages } from './arguments.js';
import { PtcError, toPtcError } from './errors.js';
import { currentPage } from './hub-http.js';

/** Families group tools in documentation, metrics and the management UI. */
export const PTC_FAMILIES = [
	'discovery',
	'repo',
	'dataset',
	'papers',
	'collections',
	'docs',
	'spaces',
	'people',
	'account',
	'jobs',
	'sandbox',
] as const;
export type PtcFamily = (typeof PTC_FAMILIES)[number];

/**
 * Listing policy for the PTC bouquet: every tool the token can use is listed and
 * clients search them. `anonymous` < `authenticated` (any token) < `write`
 * (any token not reported as read-only). The Hub still enforces permissions per call.
 */
export type PtcAccess = 'anonymous' | 'authenticated' | 'write';

export interface PtcProgress {
	progress: number;
	total?: number;
	message?: string;
}

/** Request-scoped execution context. Never persisted; never echoed. */
export interface PtcContext {
	hfToken?: string;
	/** Authenticated username, when the server verified the token. */
	username?: string;
	signal?: AbortSignal;
	/** Test seam for HTTP. Production uses global fetch. */
	fetch?: typeof globalThis.fetch;
	onProgress?: (progress: PtcProgress) => void | Promise<void>;
}

export type PtcContent =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: 'audio'; data: string; mimeType: string }
	| { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

/**
 * Return this from `run` to attach MCP content blocks (images, audio) next to structured output,
 * or to report that a remote tool (e.g. a Space) ran but failed (`isError`), without throwing.
 */
export class PtcResult<T> {
	constructor(
		public readonly structured: T,
		public readonly content: PtcContent[],
		public readonly options: { isError?: boolean } = {}
	) {}
}

export interface PtcAnnotations {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface PtcToolSpec<I extends z.ZodObject, O extends z.ZodObject> {
	name: string;
	family: PtcFamily;
	title: string;
	description: string;
	input: I;
	output: O;
	access: PtcAccess;
	annotations: PtcAnnotations;
	run(input: z.output<I>, ctx: PtcContext): Promise<z.input<O> | PtcResult<z.input<O>>>;
}

/** Type-erased tool, as stored in the registry. */
export interface PtcTool {
	readonly name: string;
	readonly family: PtcFamily;
	readonly title: string;
	readonly description: string;
	readonly input: z.ZodObject;
	readonly output: z.ZodObject;
	readonly access: PtcAccess;
	readonly annotations: PtcAnnotations;
	run(input: unknown, ctx: PtcContext): Promise<unknown>;
}

export function definePtcTool<I extends z.ZodObject, O extends z.ZodObject>(spec: PtcToolSpec<I, O>): PtcTool {
	return { ...spec, run: (input, ctx) => spec.run(input as z.output<I>, ctx) };
}

export const READ_ONLY: PtcAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
export const MUTATING: PtcAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};
export const DESTRUCTIVE: PtcAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

export interface PtcCallResult {
	structured: Record<string, unknown>;
	content: PtcContent[];
	/** The call completed but the remote tool reported failure (MCP isError). */
	isError: boolean;
}

function inputError(tool: PtcTool, error: z.ZodError, args: unknown): PtcError {
	return new PtcError(
		'INVALID_ARGUMENT',
		`invalid input. ${ptcInputIssueMessages(tool.input, error, args).join('; ')}`
	);
}

/** From this page on, a listing result says it is deep into one query (soft cap: paging still works). */
export const PAGING_NOTE_FROM_PAGE = 10;

/**
 * Exhaustive paging is the main way a code-mode client overspends (one Codex run paged a listing
 * 215 times). Deep pages say so in `completeness`, which every listing has; the advertised
 * completeness schema is open, so the extra keys stay valid for clients.
 */
function withPagingNote(data: Record<string, unknown>, page: number): Record<string, unknown> {
	const completeness = data.completeness;
	if (page < PAGING_NOTE_FROM_PAGE || typeof completeness !== 'object' || completeness === null) return data;
	return {
		...data,
		completeness: {
			...completeness,
			page,
			paging_note: `Page ${String(page)} of this query. Lists are pages, not totals: narrow the filters (query, owner, sort) instead of paging further unless every item is needed.`,
		},
	};
}

/** Validate input, run, validate output. Every failure is a sanitized PtcError. */
export async function callPtcTool(tool: PtcTool, rawInput: unknown, ctx: PtcContext = {}): Promise<PtcCallResult> {
	const args = normalizePtcArguments(tool.input, rawInput === undefined ? {} : rawInput);
	const parsed = tool.input.safeParse(args);
	if (!parsed.success) throw inputError(tool, parsed.error, args);
	if (ctx.signal?.aborted) throw new PtcError('CANCELLED', 'request cancelled.');
	let raw: unknown;
	try {
		raw = await tool.run(parsed.data, ctx);
	} catch (error) {
		throw toPtcError(error, tool.name);
	}
	const structured: unknown = raw instanceof PtcResult ? (raw.structured as unknown) : raw;
	const checked = tool.output.safeParse(structured);
	if (!checked.success) {
		throw new PtcError('UPSTREAM_RESPONSE', `${tool.name}: malformed upstream data or output contract violation.`);
	}
	const data: Record<string, unknown> = withPagingNote(checked.data, currentPage(ctx));
	const content: PtcContent[] = raw instanceof PtcResult ? raw.content : [];
	return {
		structured: data,
		content: content.length ? content : [{ type: 'text', text: JSON.stringify(data) }],
		isError: raw instanceof PtcResult && raw.options.isError === true,
	};
}
