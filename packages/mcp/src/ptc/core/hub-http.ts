import { PtcError, ptcHttpError, type PtcErrorCode } from './errors.js';
import type { PtcContext } from './tool.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** @deprecated use PtcContext */
export type PtcCallOptions = Pick<PtcContext, 'hfToken' | 'signal' | 'fetch'>;
export const HUB_ORIGIN = 'https://huggingface.co';
export const DATASETS_SERVER_ORIGIN = 'https://datasets-server.huggingface.co';
const ORIGIN = HUB_ORIGIN;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12_500;
const cursorSchema = z
	.object({
		v: z.literal(2),
		s: z.string().min(1).max(8192),
		m: z.string().length(43),
	})
	.strict();

/**
 * Cursor key. With PTC_CURSOR_SECRET set (same value on every replica), cursors cannot be forged
 * or edited. Unset, a fixed built-in key keeps cursors valid across replicas and restarts (a
 * stateless HTTP deployment would otherwise break paging) and still detects accidental edits or
 * reuse with other arguments or another token.
 */
const CURSOR_SECRET: Buffer = Buffer.from(process.env.PTC_CURSOR_SECRET || 'hf-mcp-server/ptc-cursor/v2', 'utf8');
const CURSOR_ERROR =
	'invalid cursor or changed query: it expired, is from another server, or the arguments or authentication changed; repeat the call without cursor.';

/** HMAC-SHA256 over (binding, token, state): the cursor can be neither edited nor moved to another query or token. */
function cursorMac(binding: unknown, token: string | undefined, state: string): Buffer {
	return createHmac('sha256', CURSOR_SECRET)
		.update(JSON.stringify(['ptc-cursor', binding, token ?? null, state]))
		.digest();
}
function seal(binding: unknown, token: string | undefined, state: string): string {
	const m = cursorMac(binding, token, state).toString('base64url');
	return Buffer.from(JSON.stringify({ v: 2, s: state, m })).toString('base64url');
}
function open(cursor: string, binding: unknown, token: string | undefined): string {
	try {
		if (!/^[\w-]+$/.test(cursor) || cursor.length > 16384) throw new Error('format');
		const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
		const given = Buffer.from(parsed.m, 'base64url');
		const expected = cursorMac(binding, token, parsed.s);
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('mac');
		return parsed.s;
	} catch {
		return fail(CURSOR_ERROR, 'INVALID_CURSOR');
	}
}
function canonical(params: URLSearchParams): string {
	const entries = [...params]
		.filter(([key]) => key !== 'cursor')
		.map(([key, value]) => [key.replace(/\[(?:\d*)\]$/, ''), value]);
	// qs serializes repeated expand parameters as indexed/bracket arrays.
	return JSON.stringify(entries.sort(([ak, av], [bk, bv]) => `${ak}\0${av}`.localeCompare(`${bk}\0${bv}`)));
}
/** What a Link-paginated page cursor is bound to: endpoint and effective query (the token is added by the MAC). */
function pageBinding(path: string, params: URLSearchParams): unknown {
	return ['page', path, canonical(params)];
}
function fail(message: string, code: PtcErrorCode = 'UPSTREAM_RESPONSE', retryable = false): never {
	throw new PtcError(code, message, retryable);
}
function applyCursor(url: URL, cursor: string | undefined, binding: unknown, token: string | undefined): void {
	if (!cursor) return;
	url.searchParams.set('cursor', open(cursor, binding, token));
}
function continuation(link: string | null, url: URL, binding: unknown, token: string | undefined): string | null {
	if (!link) return null;
	if (link.length > 65536) fail('invalid upstream pagination.');
	// URLs are enclosed in angle brackets, so commas inside a URL are safe.
	const parts = link.split(/,(?=\s*<)/);
	let next: URL | undefined;
	for (const part of parts) {
		const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
		const relation = match?.[2]?.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
		if (!relation || !(relation[1] ?? relation[2] ?? '').split(/\s+/).includes('next')) {
			if (!match && /\bnext\b/.test(part)) fail('invalid upstream pagination.');
			continue;
		}
		if (next || !match?.[1]) fail('invalid upstream pagination.');
		try {
			next = new URL(match[1], url);
		} catch {
			fail('invalid upstream pagination.');
		}
	}
	if (!next) return null;
	if (
		next.origin !== ORIGIN ||
		// The Hub links to the canonical case of a user/org name (HuggingFace -> huggingface).
		next.pathname.toLowerCase() !== url.pathname.toLowerCase() ||
		next.username ||
		next.password ||
		next.hash ||
		canonical(next.searchParams) !== canonical(url.searchParams)
	)
		fail('unsafe or changed upstream pagination.');
	const cursors = next.searchParams.getAll('cursor');
	const cursor = cursors[0];
	if (cursors.length !== 1 || !cursor || cursor.length > 8192 || cursor === url.searchParams.get('cursor'))
		fail('invalid upstream pagination.');
	return seal(binding, token, cursor);
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const bytes = await readBytes(response, signal, MAX_BYTES);
	const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
	return result;
}
async function readBytes(response: Response, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
	const MAX_BYTES = maxBytes;
	const length = Number(response.headers.get('content-length'));
	if (length > MAX_BYTES) {
		await response.body?.cancel();
		fail('upstream response exceeds the size budget.');
	}
	if (!response.body) fail('upstream returned no JSON body.');
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener('abort', cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const result = await reader.read();
			// Cancelling the reader on abort resolves the pending read as done: that is a
			// truncated body, never a complete one.
			signal.throwIfAborted();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > MAX_BYTES) fail('upstream response exceeds the size budget.');
			chunks.push(result.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	} finally {
		signal.removeEventListener('abort', cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
/**
 * GET a Link-paginated Hub array endpoint. The returned cursor is opaque and bound to
 * the endpoint, effective query and auth context; it is never a URL.
 */
export async function requestPage(
	path: string,
	params: URLSearchParams,
	cursor: string | undefined,
	options: PtcCallOptions,
	maxRows?: number
): Promise<{ rows: unknown[]; nextCursor: string | null }> {
	const url = new URL(path, ORIGIN);
	url.search = params.toString();
	const binding = pageBinding(path, params);
	applyCursor(url, cursor, binding, options.hfToken);
	if (options.signal?.aborted) fail('request cancelled.', 'CANCELLED');
	// Same timeout/cancellation policy as network/safe-fetch; that helper lacks
	// injection and a body-read deadline. These endpoints need no redirects.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	let onAbort: (() => void) | undefined;
	try {
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error('aborted'));
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const operation = async () => {
			const headers = new Headers({ accept: 'application/json' });
			if (options.hfToken) headers.set('authorization', `Bearer ${options.hfToken}`);
			let target = url;
			let response: Response;
			for (let hop = 0; ; hop++) {
				response = await (options.fetch ?? globalThis.fetch)(target.toString(), {
					method: 'GET',
					headers,
					signal,
					redirect: 'manual',
					credentials: 'omit',
				});
				const recased = caseOnlyRedirect(target, response.status, response.headers.get('location'));
				if (!recased || hop >= MAX_CASE_REDIRECTS) break;
				await response.body?.cancel();
				target = recased;
			}
			if (!response.ok) {
				await response.body?.cancel();
				const moved = repoMove(target, response.status, response.headers.get('location'));
				if (moved) throw new PtcRepoMovedError(moved.kind, moved.from, moved.to);
				throw ptcHttpError(response.status, 'listing', response.headers.get('x-error-message'));
			}
			// A custom fetch must not hand back a response from another location.
			if (response.url && new URL(response.url).origin !== ORIGIN) fail('unexpected upstream origin.');
			const json = await readJson(response, signal);
			if (!Array.isArray(json)) fail('invalid upstream array response.');
			const rows: unknown[] = json;
			const max = maxRows ?? (path.endsWith('/semantic-search') ? 120 : Number(params.get('limit')));
			if (rows.length > max) fail('upstream returned more records than the bounded contract.');
			return {
				rows,
				nextCursor: path.endsWith('/semantic-search')
					? null
					: continuation(response.headers.get('link'), url, binding, options.hfToken),
			};
		};
		return await Promise.race([operation(), aborted]);
	} catch (error) {
		controller.abort();
		if (options.signal?.aborted) fail('request cancelled.', 'CANCELLED');
		// Never surface raw HTTP bodies, URLs, fetch exceptions or authorization.
		if (error instanceof PtcError) throw error;
		return fail('upstream request failed, timed out, or returned malformed JSON.', 'UPSTREAM_UNAVAILABLE', true);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

const MAX_REDIRECTS = 5;
const MAX_CASE_REDIRECTS = 2;

/**
 * The Hub answers a user/org name in the wrong case with a 307/308 to the canonical case
 * (/api/users/EVALSTATE/overview -> /api/users/evalstate/overview). Such a redirect is followed even
 * when redirects are otherwise off: same origin, only the path's letter case changes, same query.
 */
export function caseOnlyRedirect(from: URL, status: number, location: string | null): URL | undefined {
	if ((status !== 307 && status !== 308) || !location) return undefined;
	let next: URL;
	try {
		next = new URL(location, from);
	} catch {
		return undefined;
	}
	if (
		next.origin !== from.origin ||
		next.username ||
		next.password ||
		next.hash ||
		next.pathname === from.pathname ||
		next.pathname.toLowerCase() !== from.pathname.toLowerCase() ||
		canonical(next.searchParams) !== canonical(from.searchParams) ||
		next.searchParams.get('cursor') !== from.searchParams.get('cursor')
	)
		return undefined;
	return next;
}

const MOVED_ROOTS = { models: 'model', datasets: 'dataset', spaces: 'space' } as const;
type MovedKind = (typeof MOVED_ROOTS)[keyof typeof MOVED_ROOTS];

/** A renamed or transferred repository. The message names the new id so a caller can retry with it. */
export class PtcRepoMovedError extends PtcError {
	constructor(
		public readonly kind: MovedKind,
		public readonly from: string,
		public readonly to: string
	) {
		super('NOT_FOUND', `${kind} ${from} has moved to ${to}; use hf://${kind}s/${to}.`);
		this.name = 'PtcRepoMovedError';
	}
}

/**
 * The Hub answers an API request for a renamed or transferred repository (or a legacy single-segment id
 * such as gpt2) with a same-origin 307/308 to the same route under the new owner/name:
 * /api/datasets/CohereForAI/aya_dataset/tree/main -> /api/datasets/CohereLabs/aya_dataset/tree/main.
 */
export function repoMove(
	from: URL,
	status: number,
	location: string | null
): { kind: MovedKind; from: string; to: string } | undefined {
	if ((status !== 307 && status !== 308) || !location) return undefined;
	let next: URL;
	try {
		next = new URL(location, from);
	} catch {
		return undefined;
	}
	if (next.origin !== from.origin || next.username || next.password || next.hash) return undefined;
	if (canonical(next.searchParams) !== canonical(from.searchParams)) return undefined;
	const [, root, ...before] = from.pathname.split('/').slice(1);
	const [api, nextRoot, ...after] = next.pathname.split('/').slice(1);
	if (from.pathname.split('/')[1] !== 'api' || api !== 'api' || root !== nextRoot || !root) return undefined;
	const kind = (MOVED_ROOTS as Record<string, MovedKind | undefined>)[root];
	if (!kind) return undefined;
	// Same route after the repository id: the id is the first 1-2 segments before and exactly 2 after.
	const suffix = after.slice(2);
	const oldLength = before.length - suffix.length;
	if (after.length < 2 || (oldLength !== 1 && oldLength !== 2)) return undefined;
	const lower = (segments: string[]) => segments.join('/').toLowerCase();
	if (lower(before.slice(oldLength)) !== lower(suffix)) return undefined;
	try {
		const old = before.slice(0, oldLength).map(decodeURIComponent).join('/');
		const moved = after.slice(0, 2).map(decodeURIComponent).join('/');
		if (!/^[\w.-]+\/[\w.-]+$/.test(moved) || old.toLowerCase() === moved.toLowerCase()) return undefined;
		return { kind, from: old, to: moved };
	} catch {
		return undefined;
	}
}

/** Redirect targets allowed for resolve downloads: Hugging Face hosts (Hub, CDN, Xet bridge) over https only. */
export function isAllowedRedirectTarget(target: URL): boolean {
	if (target.protocol !== 'https:' || target.username || target.password || target.port) return false;
	const host = target.hostname.toLowerCase();
	return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
}

/**
 * Fetch without automatic redirects. When `follow` is set, each hop is validated (https, Hugging Face
 * host, at most MAX_REDIRECTS) and Authorization is dropped once the request leaves the original host.
 */
async function fetchWithRedirectPolicy(
	url: URL,
	init: {
		method: string;
		headers: Headers;
		body: string | undefined;
		signal: AbortSignal;
		follow: boolean;
		fetch: typeof globalThis.fetch;
	}
): Promise<Response> {
	let current = url;
	const headers = new Headers(init.headers);
	let caseHops = 0;
	let keepMethod = true;
	for (let hop = 0; ; hop++) {
		const response = await init.fetch(current.toString(), {
			method: keepMethod ? init.method : 'GET',
			headers: new Headers(headers),
			body: keepMethod ? init.body : undefined,
			signal: init.signal,
			redirect: 'manual',
			credentials: 'omit',
		});
		const location = response.headers.get('location');
		// Canonical-case redirect (307/308 keep method and body): same host, so Authorization stays.
		const recased = caseOnlyRedirect(current, response.status, location);
		if (recased && caseHops < MAX_CASE_REDIRECTS) {
			await response.body?.cancel();
			caseHops++;
			current = recased;
			continue;
		}
		keepMethod = false;
		if (!init.follow || response.status < 300 || response.status >= 400 || !location) {
			if (!init.follow && response.url && new URL(response.url).origin !== url.origin) {
				fail('unexpected upstream origin.');
			}
			return response;
		}
		await response.body?.cancel();
		if (hop >= MAX_REDIRECTS) fail('too many upstream redirects.');
		let next: URL;
		try {
			next = new URL(location, current);
		} catch {
			return fail('invalid upstream redirect.');
		}
		if (!isAllowedRedirectTarget(next)) fail('upstream redirect to a disallowed host.');
		if (next.host !== url.host) headers.delete('authorization');
		current = next;
	}
}

/**
 * Opaque continuation for endpoints paged by offset/page/cursor: `state` sealed with an HMAC bound
 * to `binding` (tool + effective query) and the caller's token. Never contains the token.
 */
export function sealCursor(binding: unknown, ctx: Pick<PtcContext, 'hfToken'>, state: string): string {
	return seal(binding, ctx.hfToken, state);
}
/** The state sealed in `cursor`, or INVALID_CURSOR when it was edited, moved or issued elsewhere. */
export function openCursor(
	cursor: string | undefined,
	binding: unknown,
	ctx: Pick<PtcContext, 'hfToken'>
): string | undefined {
	if (!cursor) return undefined;
	return open(cursor, binding, ctx.hfToken);
}

export interface HubFetchRequest {
	/** HUB_ORIGIN (default) or DATASETS_SERVER_ORIGIN. */
	origin?: typeof HUB_ORIGIN | typeof DATASETS_SERVER_ORIGIN;
	path: string;
	params?: URLSearchParams;
	method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
	/** JSON request body. */
	body?: unknown;
	headers?: Record<string, string>;
	as?: 'json' | 'text' | 'bytes' | 'none';
	maxBytes?: number;
	timeoutMs?: number;
	/** Human label used in sanitized errors, e.g. "dataset rows". */
	subject?: string;
	/** Follow redirects (resolve -> CDN). Authorization is stripped cross-origin by fetch. */
	followRedirects?: boolean;
	/** Return non-2xx statuses in `status` instead of throwing (e.g. 404 for existence checks). */
	allowStatus?: number[];
}
export interface HubFetchResponse {
	status: number;
	headers: Headers;
	data: unknown;
}

/**
 * Bounded, cancellable request to the Hub or Dataset Viewer. Never returns or throws
 * raw bodies, URLs or credentials. Non-2xx responses map to sanitized PtcErrors.
 */
export async function hubFetch(request: HubFetchRequest, ctx: PtcContext): Promise<HubFetchResponse> {
	const origin = request.origin ?? HUB_ORIGIN;
	// Refuse dot-segments (raw or percent-encoded) so a path can never be normalised upward.
	if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(request.path.split('?')[0] ?? '')) {
		fail('invalid request path.', 'INVALID_ARGUMENT');
	}
	const url = new URL(request.path, origin);
	if (url.origin !== origin) fail('invalid request path.', 'INVALID_ARGUMENT');
	if (request.params) url.search = request.params.toString();
	const subject = request.subject ?? 'Hub request';
	if (ctx.signal?.aborted) fail('request cancelled.', 'CANCELLED');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS);
	const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
	try {
		const headers = new Headers({
			accept: request.as === 'text' ? 'text/plain, */*' : 'application/json',
			...request.headers,
		});
		if (ctx.hfToken) headers.set('authorization', `Bearer ${ctx.hfToken}`);
		let body: string | undefined;
		if (request.body !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(request.body);
		}
		const response = await fetchWithRedirectPolicy(url, {
			method: request.method ?? 'GET',
			headers,
			body,
			signal,
			follow: request.followRedirects === true,
			fetch: ctx.fetch ?? globalThis.fetch,
		});
		if (!response.ok) {
			await response.body?.cancel();
			const moved = repoMove(url, response.status, response.headers.get('location'));
			if (moved) throw new PtcRepoMovedError(moved.kind, moved.from, moved.to);
			if (request.allowStatus?.includes(response.status)) {
				return { status: response.status, headers: response.headers, data: undefined };
			}
			throw ptcHttpError(response.status, subject, response.headers.get('x-error-message'));
		}
		const as = request.as ?? 'json';
		if (as === 'none') {
			await response.body?.cancel();
			return { status: response.status, headers: response.headers, data: undefined };
		}
		if (!response.body)
			return { status: response.status, headers: response.headers, data: as === 'text' ? '' : undefined };
		const bytes = await readBytes(response, signal, request.maxBytes ?? MAX_BYTES);
		if (as === 'bytes') return { status: response.status, headers: response.headers, data: bytes };
		const text = new TextDecoder().decode(bytes);
		if (as === 'text') return { status: response.status, headers: response.headers, data: text };
		try {
			const json: unknown = text ? JSON.parse(text) : undefined;
			return { status: response.status, headers: response.headers, data: json };
		} catch {
			return fail(`${subject}: upstream returned malformed JSON.`);
		}
	} catch (error) {
		controller.abort();
		if (ctx.signal?.aborted) fail('request cancelled.', 'CANCELLED');
		if (error instanceof PtcError) throw error;
		return fail(`${subject}: upstream request failed or timed out.`, 'UPSTREAM_UNAVAILABLE', true);
	} finally {
		clearTimeout(timer);
	}
}
