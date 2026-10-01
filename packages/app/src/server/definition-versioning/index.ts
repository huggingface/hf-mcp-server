import { createHash } from 'node:crypto';
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
import { recordCheckedCall, recordVersionedDiscovery, recordVersionedList } from './stats.js';

export {
	definitionVersioningCacheHints,
	definitionVersioningPolicy,
	definitionVersionsTestEnabled,
	setDefinitionVersionsTestSalt,
	type DefinitionVersioningPolicy,
} from './policy.js';
export { definitionVersioningStats, resetDefinitionVersioningStats } from './stats.js';

/**
 * Results carry a single top-level `digest` field beside `ttlMs`/`cacheScope`
 * (proposed addition to CacheableResult). What it covers is fixed by the result
 * type: `tools/list` digests the tool list, `server/discover` digests the
 * instructions. The key is implied, so it is not on the wire in the response.
 */
export const DIGEST = 'digest';
/** Request `_meta` key: a map from collection key to the digest the client holds. */
export const KNOWN_DIGESTS = 'huggingface.co/known-digests';
/**
 * Application error code for a digest mismatch. Outside JSON-RPC's
 * reserved range (-32768..-32000), so it cannot collide with protocol codes.
 */
export const DIGEST_MISMATCH = -32987;

export interface DefinitionVersions {
	tools: string;
	instructions: string;
}

const TARGETS = ['tools', 'instructions'] as const satisfies readonly (keyof DefinitionVersions)[];

// Canonicalize the JSON wire representation: undefined object properties are absent,
// array order is semantic, and object keys are sorted independently of insertion order.
function canonical(value: unknown): string {
	const json: unknown = JSON.parse(JSON.stringify(value));
	function encode(item: unknown): string {
		if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
		if (item !== null && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
				.join(',')}}`;
		}
		return JSON.stringify(item);
	}
	return encode(json);
}

function digest(target: string, value: unknown, salt: string): string {
	const hash = createHash('sha256').update(`huggingface.co/definition-versioning/v1/${target}\n`);
	// A salt changes every version without changing definitions (deploy-wide
	// invalidation or test rotation). Unsalted digests keep their v1 input.
	if (salt) hash.update(`salt:${salt}\n`);
	return `sha256:${hash.update(canonical(value)).digest('hex')}`;
}

export function definitionVersions(tools: readonly Tool[], instructions?: string, salt = ''): DefinitionVersions {
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
		names.add(tool.name);
	}
	return {
		tools: digest(
			'tools',
			[...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
			salt
		),
		instructions: digest(
			'instructions',
			instructions === undefined ? { present: false } : { present: true, value: instructions },
			salt
		),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Presence of the key (any value) on a tools/call. */
export function hasKnownDigests(request: unknown): boolean {
	if (!record(request) || request.method !== 'tools/call' || !record(request.params)) return false;
	return record(request.params._meta) && Object.hasOwn(request.params._meta, KNOWN_DIGESTS);
}

/**
 * Known digests are advisory hints. Unknown keys (e.g. `prompts`, valid in the
 * SEP but not digested here) and non-string values make no claim and are ignored;
 * a non-object value is treated as no hint. Any string is compared for equality, so
 * an unrecognized digest is simply stale.
 */
function parseKnownDigests(meta: Record<string, unknown> | undefined): Partial<DefinitionVersions> {
	const value = meta?.[KNOWN_DIGESTS];
	if (!record(value)) return {};
	const known: Partial<DefinitionVersions> = {};
	for (const target of TARGETS) {
		const version = value[target];
		if (typeof version === 'string') known[target] = version;
	}
	return known;
}

type Handler<M extends RequestMethod> = (
	request: RequestTypeMap[M],
	ctx: ServerContext
) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>;

export interface DefinitionVersioningOptions {
	/** Mixed into every digest; empty means unsalted. Fixed for the server instance. */
	salt?: string;
}

/** Install before first registerTool; call the returned finalizer after registration. */
export function installDefinitionVersioning(
	server: McpServer,
	instructions?: string,
	options: DefinitionVersioningOptions = {}
): () => void {
	const low = server.server;
	const register = low.setRequestHandler.bind(low);
	const salt = options.salt ?? '';
	let hasToolHandlers = false;
	let list: Handler<'tools/list'> = () => ({ tools: [] });
	const snapshot = async (ctx: ServerContext) =>
		definitionVersions((await list({ method: 'tools/list' }, ctx)).tools, instructions, salt);

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
				// Pagination would require a collection-wide versioning strategy.
				recordVersionedList();
				return { ...result, [DIGEST]: definitionVersions(result.tools, undefined, salt).tools };
			});
		} else if (method === 'tools/call') {
			const call = handler as Handler<'tools/call'>;
			register('tools/call', async (request, ctx) => {
				const known = parseKnownDigests(request.params._meta);
				if (Object.keys(known).length) {
					const current = await snapshot(ctx);
					const stale = TARGETS.filter((target) => known[target] !== undefined && known[target] !== current[target]);
					recordCheckedCall(stale);
					if (stale.length) {
						// Name the stale keys, but do not hand out replacement digests:
						// clients must refetch the definitions a digest describes.
						throw new ProtocolError(DIGEST_MISMATCH, 'Definitions changed; refresh them before retrying.', { stale });
					}
				}
				return call(request, ctx);
			});
		} else if (method === 'server/discover') {
			const discover = handler as Handler<'server/discover'>;
			register('server/discover', async (request, ctx) => {
				const result = await discover(request, ctx);
				// A discover result digests its instructions and nothing else; the tools
				// digest comes from tools/list. Calls are checked against the configured
				// instructions, so only advertise a digest when discovery returns that
				// same text; a divergent handler must not cause every checked call to fail.
				if (result.instructions !== instructions) return result;
				recordVersionedDiscovery();
				return { ...result, [DIGEST]: definitionVersions([], instructions, salt).instructions };
			});
		} else {
			Reflect.apply(register, low, [method, handler]);
		}
	}) as typeof low.setRequestHandler;

	// Matches SDK 2.0's constructor discovery response. HTTP serving entries later
	// install their own discover handler, which the adapter above also decorates.
	low.setRequestHandler('server/discover', () => ({
		supportedVersions: SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version >= '2026-07-28'),
		capabilities: low.getCapabilities(),
		...(instructions !== undefined ? { instructions } : {}),
	}));

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
