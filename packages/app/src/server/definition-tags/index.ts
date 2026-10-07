import {
	ProtocolError,
	ProtocolErrorCode,
	SUPPORTED_PROTOCOL_VERSIONS,
	type McpServer,
	type Tool,
	type RequestTypeMap,
	type HandlerResultTypeMap,
	type ServerContext,
	type RequestMethod,
} from '@modelcontextprotocol/server';
import { recordCheckedCall, recordTaggedDiscovery, recordTaggedList } from './stats.js';
import { recallTag, rememberTag } from './memo.js';
import { definitionTag, sortedUnique, TAGGED_METHODS, type StaleTags, type TaggedMethod } from './tag.js';

export {
	definitionTagsCacheHints,
	definitionTagsEnabled,
	definitionTagsSalt,
	definitionTagsPolicy,
	definitionTagsTestEnabled,
	setDefinitionTagsTestSalt,
	type DefinitionTagsPolicy,
} from './policy.js';
export { definitionTagsStats, resetDefinitionTagsStats } from './stats.js';
export { definitionTagsMemoKey, resetDefinitionTagsMemo, MEMO_TTL_MS } from './memo.js';
export { definitionTag, sortedUnique, TAGGED_METHODS, type StaleTags, type TaggedMethod } from './tag.js';

/**
 * Results carry a single top-level `tag` field beside `ttlMs`/`cacheScope`
 * (proposed addition to CacheableResult). What it covers is fixed by the method
 * that produced the result, so the method is not on the wire in the response.
 */
export const TAG = 'tag';
/** Request `_meta` key: a map from the method that produced each tag to the tag the client holds. */
export const KNOWN_TAGS = 'io.modelcontextprotocol/knownTags';
/**
 * Application error code for a tag mismatch. Outside JSON-RPC's
 * reserved range (-32768..-32000), so it cannot collide with protocol codes.
 * The SEP has not allocated a standard code yet.
 */
export const TAG_MISMATCH = -32987;

/**
 * Result-envelope fields a tag never covers: the tag covers the payload with
 * these removed.
 */
const ENVELOPE = new Set(['resultType', '_meta', 'ttlMs', 'cacheScope', TAG, 'nextCursor']);

/** Tag for the complete tool list. Order is not significant. */
export function toolsTag(tools: readonly Tool[], salt = ''): string {
	return definitionTag('tools/list', { tools: sortedUnique(tools, (tool) => tool.name, 'tool name') }, salt);
}

/**
 * Tag for a `server/discover` result: `supportedVersions`, `capabilities` and
 * `instructions` together, i.e. the payload without the envelope. Absent and
 * empty instructions differ.
 */
export function discoverTag(result: Readonly<Record<string, unknown>>, salt = ''): string {
	return definitionTag('server/discover', payload(result), salt);
}

function payload(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(result).filter(([key]) => !ENVELOPE.has(key)));
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Presence of the key (any value) on a tools/call. */
export function hasKnownTags(request: unknown): boolean {
	if (!record(request) || request.method !== 'tools/call' || !record(request.params)) return false;
	return record(request.params._meta) && Object.hasOwn(request.params._meta, KNOWN_TAGS);
}

/**
 * Known tags are advisory hints, keyed by method. Methods this server does not tag
 * or check (e.g. `prompts/list`, `skills/list`) and non-string values make no claim
 * and are ignored; a non-object value is treated as no hint. Any string is compared
 * for equality, so an unrecognized tag is simply stale.
 */
function parseKnownTags(meta: Record<string, unknown> | undefined): StaleTags {
	const value = meta?.[KNOWN_TAGS];
	if (!record(value)) return {};
	const known: StaleTags = {};
	for (const method of TAGGED_METHODS) {
		const tag = value[method];
		if (typeof tag === 'string') known[method] = tag;
	}
	return known;
}

type Handler<M extends RequestMethod> = (
	request: RequestTypeMap[M],
	ctx: ServerContext
) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>;

export interface DefinitionTagsOptions {
	/** Mixed into every tag; empty means unsalted. Fixed for the server instance. */
	salt?: string;
	/**
	 * Memo key for this request's selection. Tags computed by this (full-selection)
	 * server are remembered under it, so later checked calls can compare strings.
	 */
	memoKey?: string;
	/**
	 * The transport already checked the known tags against the memo and they all
	 * matched; the call may run on a reduced (shortcut) server, so it must not be
	 * re-checked here, and nothing it computes is remembered.
	 */
	verified?: boolean;
}

export type MemoVerdict = { kind: 'match' } | { kind: 'stale'; staleTags: StaleTags } | { kind: 'unknown' };

/**
 * Checks a request's known tags against the memo. `match`: every claim matches a
 * remembered current tag (or there is no claim at all). `stale`: at least one claim
 * differs from a remembered current tag. `unknown`: something needs computing.
 */
export function checkKnownTagsAgainstMemo(request: unknown, memoKey: string, now = Date.now()): MemoVerdict {
	if (!record(request) || !record(request.params)) return { kind: 'unknown' };
	const known = parseKnownTags(record(request.params._meta) ? request.params._meta : undefined);
	const stale: StaleTags = {};
	let unknown = false;
	for (const method of TAGGED_METHODS) {
		const sent = known[method];
		if (sent === undefined) continue;
		const current = recallTag(memoKey, method, now);
		if (current === undefined) unknown = true;
		else if (current !== sent) stale[method] = sent;
	}
	const staleMethods = Object.keys(stale) as TaggedMethod[];
	if (staleMethods.length) {
		recordCheckedCall(staleMethods, true);
		return { kind: 'stale', staleTags: stale };
	}
	if (unknown) return { kind: 'unknown' };
	recordCheckedCall([], true);
	return { kind: 'match' };
}

/** The JSON-RPC error for a tag mismatch: echoes the client's stale tags, never the current ones. */
export const TAG_MISMATCH_MESSAGE = 'Definitions changed; refresh them before retrying.';

/** Install before first registerTool; call the returned finalizer after registration. */
export function installDefinitionTags(
	server: McpServer,
	instructions?: string,
	options: DefinitionTagsOptions = {}
): () => void {
	const low = server.server;
	const register = low.setRequestHandler.bind(low);
	const salt = options.salt ?? '';
	const remember = (method: TaggedMethod, tag: string): string => {
		if (options.memoKey !== undefined && !options.verified) rememberTag(options.memoKey, method, tag);
		return tag;
	};
	let hasToolHandlers = false;
	let list: Handler<'tools/list'> = () => ({ tools: [] });
	// Replaced when the SDK (or a serving entry) registers its own discovery handler.
	// Checks call the same handler that answers discovery, so they agree by construction.
	let discover: Handler<'server/discover'> = () => ({
		supportedVersions: SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version >= '2026-07-28'),
		capabilities: low.getCapabilities(),
		...(instructions !== undefined ? { instructions } : {}),
	});
	const current: Record<TaggedMethod, (ctx: ServerContext) => Promise<string>> = {
		'tools/list': async (ctx) =>
			remember('tools/list', toolsTag((await list({ method: 'tools/list' }, ctx)).tools, salt)),
		'server/discover': async (ctx) =>
			remember('server/discover', discoverTag(await discover({ method: 'server/discover' }, ctx), salt)),
	};

	// The cast is confined to the overload-dispatch seam; intercepted handlers are
	// typed by method, and custom-schema registrations pass through untouched.
	low.setRequestHandler = ((method: string, handler: unknown, customHandler?: unknown) => {
		if (customHandler !== undefined) {
			Reflect.apply(register, low, [method, handler, customHandler]);
		} else if (method === 'tools/list') {
			hasToolHandlers = true;
			list = handler as Handler<'tools/list'>;
			register('tools/list', async (request, ctx) => {
				const result = await list(request, ctx);
				// Current listings are unpaginated: result.tools is the complete registry.
				// Pagination would need the same collection-wide tag on every page.
				recordTaggedList();
				return { ...result, [TAG]: remember('tools/list', toolsTag(result.tools, salt)) };
			});
		} else if (method === 'tools/call') {
			const call = handler as Handler<'tools/call'>;
			register('tools/call', async (request, ctx) => {
				const known = options.verified ? {} : parseKnownTags(request.params._meta);
				const sent = TAGGED_METHODS.filter((m) => known[m] !== undefined);
				if (sent.length) {
					// Only compute what the client vouched for.
					const stale: StaleTags = {};
					for (const m of sent) {
						if (known[m] !== (await current[m](ctx))) stale[m] = known[m];
					}
					const staleMethods = Object.keys(stale) as TaggedMethod[];
					recordCheckedCall(staleMethods);
					if (staleMethods.length) {
						// Echo the client's own stale tags, never the current ones:
						// clients must refetch the definitions a tag describes.
						throw new ProtocolError(TAG_MISMATCH, TAG_MISMATCH_MESSAGE, {
							staleTags: stale,
						});
					}
				}
				return call(request, ctx);
			});
		} else if (method === 'server/discover') {
			discover = handler as Handler<'server/discover'>;
			register('server/discover', async (request, ctx) => {
				const result = await discover(request, ctx);
				// Covers supportedVersions, capabilities and instructions; the tools
				// tag comes from tools/list.
				recordTaggedDiscovery();
				return { ...result, [TAG]: remember('server/discover', discoverTag(result, salt)) };
			});
		} else {
			Reflect.apply(register, low, [method, handler]);
		}
	}) as typeof low.setRequestHandler;

	// Matches SDK 2.0's constructor discovery response. HTTP serving entries later
	// install their own discover handler, which the adapter above also decorates.
	low.setRequestHandler('server/discover', discover);

	return () => {
		// With every tool disabled by configuration, registerTool is never called.
		// Install empty-registry handlers only after registration, so we do not
		// conflict with the high-level SDK's assertCanSetRequestHandler checks.
		if (hasToolHandlers) return;
		low.registerCapabilities({ tools: { listChanged: false } });
		low.setRequestHandler('tools/list', () => ({ tools: [] }));
		low.setRequestHandler('tools/call', (request) => {
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
		});
	};
}
