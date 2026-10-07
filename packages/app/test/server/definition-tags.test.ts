import { describe, it, expect, vi } from 'vitest';
import { McpServer, type Tool, type ServerContext, type HandlerResultTypeMap } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
	toolsTag,
	discoverTag,
	installDefinitionTags,
	TAG,
	KNOWN_TAGS,
	TAG_MISMATCH,
	definitionTagsStats,
	resetDefinitionTagsStats,
	definitionTagsMemoKey,
	checkKnownTagsAgainstMemo,
	resetDefinitionTagsMemo,
	MEMO_TTL_MS,
} from '../../src/server/definition-tags/index.js';
import { recallTag, rememberTag } from '../../src/server/definition-tags/memo.js';

const STALE_TOOLS = { 'tools/list': `sha256:${'0'.repeat(64)}` };

const tool: Tool = {
	name: 'a',
	inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
	_meta: { semantic: true },
};

const discovery = (instructions?: string) => ({
	supportedVersions: ['2026-07-28'],
	capabilities: { tools: { listChanged: false } },
	...(instructions !== undefined ? { instructions } : {}),
});

describe('definition tags', () => {
	it('rejects duplicate names, even with identical definitions', () => {
		for (const duplicate of [tool, { ...tool, description: 'different' }]) {
			expect(() => toolsTag([tool, { ...tool, name: 'b' }, duplicate])).toThrow('Duplicate tool name: a');
		}
	});
	it('canonicalizes keys and collection order, not semantic array order', () => {
		const other = { ...tool, name: 'b' };
		expect(toolsTag([tool, other])).toBe(
			toolsTag([other, { _meta: { semantic: true }, inputSchema: tool.inputSchema, name: 'a' }])
		);
	});
	it('preserves semantic array ordering', () => {
		const first = { ...tool, inputSchema: { type: 'object' as const, required: ['x', 'y'] } };
		const second = { ...tool, inputSchema: { type: 'object' as const, required: ['y', 'x'] } };
		expect(toolsTag([first])).not.toBe(toolsTag([second]));
	});
	it('includes schemas and semantic metadata', () => {
		const base = toolsTag([tool]);
		for (const changed of [
			{ ...tool, outputSchema: { type: 'object' as const } },
			{ ...tool, _meta: { semantic: false } },
			{ ...tool, description: 'new' },
			{ ...tool, inputSchema: { type: 'object' as const } },
		]) {
			expect(toolsTag([changed])).not.toBe(base);
		}
	});
	it('tags discovery over instructions, capabilities and supported versions, not the envelope', () => {
		const base = discoverTag(discovery('exact\n'));
		expect(discoverTag(discovery('exact'))).not.toBe(base);
		expect(discoverTag({ ...discovery('exact\n'), supportedVersions: ['2026-07-28', '2027-01-01'] })).not.toBe(base);
		expect(discoverTag({ ...discovery('exact\n'), capabilities: {} })).not.toBe(base);
		// Absent and empty instructions differ.
		expect(discoverTag(discovery())).not.toBe(discoverTag(discovery('')));
		expect(
			discoverTag({
				...discovery('exact\n'),
				resultType: 'complete',
				_meta: { x: 1 },
				ttlMs: 5,
				cacheScope: 'public',
				tag: 'old',
				nextCursor: '2',
			})
		).toBe(base);
	});
	it('separates methods: an empty tool list and empty discovery never share a tag', () => {
		expect(toolsTag([])).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(toolsTag([])).not.toBe(discoverTag({ tools: [] }));
	});
});

// InMemoryTransport negotiates the legacy era; invoke the decorated discovery
// handler directly here. Modern wire behavior is covered by the HTTP tests.
function discoveryReader(server: McpServer) {
	const register = vi.spyOn(server.server, 'setRequestHandler');
	return async () => {
		const registration = register.mock.calls.findLast(([method]) => method === 'server/discover');
		if (!registration) throw new Error('Missing discovery handler');
		const handler = registration[1] as (
			request: { method: 'server/discover' },
			ctx: ServerContext
		) => HandlerResultTypeMap['server/discover'] | Promise<HandlerResultTypeMap['server/discover']>;
		return handler({ method: 'server/discover' }, {} as ServerContext);
	};
}

/** What a client does: hold one tag per result, keyed by the method that produced it. */
async function held(
	client: Client,
	discover?: () => Promise<HandlerResultTypeMap['server/discover']>
): Promise<Record<string, string>> {
	const tools = (await client.listTools())[TAG] as string;
	if (!discover) return { 'tools/list': tools };
	return { 'tools/list': tools, 'server/discover': (await discover())[TAG] as string };
}

async function fixture() {
	const server = new McpServer(
		{ name: 'tag-test', version: '1' },
		{ instructions: 'exact', capabilities: { experimental: { existing: { enabled: true } } } }
	);
	const discover = discoveryReader(server);
	installDefinitionTags(server, 'exact');
	const validate = vi.fn(() => true);
	const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
	const registered = server.registerTool('a', { inputSchema: z.object({ x: z.string().refine(validate) }) }, callback);
	const client = new Client({ name: 'test', version: '1' });
	const [c, s] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(s), client.connect(c)]);
	return {
		server,
		discover,
		client,
		callback,
		validate,
		registered,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe('pre-dispatch guard', () => {
	it('guards an empty registry when all registration is skipped', async () => {
		const server = new McpServer({ name: 'empty', version: '1' });
		const finalize = installDefinitionTags(server);
		finalize();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			expect((await client.listTools())[TAG]).toBe(toolsTag([]));
			await expect(
				client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_TAGS]: { 'tools/list': `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			await expect(
				client.callTool({ name: 'unknown', _meta: { [KNOWN_TAGS]: { 'tools/list': toolsTag([]) } } })
			).rejects.toMatchObject({ code: -32602 });
		} finally {
			await client.close();
			await server.close();
		}
	});
	it('preserves existing capabilities without advertising tags and executes matching and opportunistic calls', async () => {
		const f = await fixture();
		try {
			const tags = await held(f.client);
			expect(f.client.getServerCapabilities()?.experimental).toEqual({
				existing: { enabled: true },
			});
			for (const meta of [undefined, {}, { [KNOWN_TAGS]: {} }, { [KNOWN_TAGS]: tags }]) {
				expect(await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: meta })).toMatchObject({
					content: [{ text: 'done' }],
				});
			}
			expect(f.callback).toHaveBeenCalledTimes(4);
		} finally {
			await f.close();
		}
	});
	it.each([
		['huggingface.co/expected-definition-versions', null],
		['huggingface.co/expected-definition-versions', { tools: `sha256:${'0'.repeat(64)}` }],
		['huggingface.co/known-digests', { 'tools/list': `sha256:${'0'.repeat(64)}` }],
		['io.modelcontextprotocol/knownDigests', { 'tools/list': `sha256:${'0'.repeat(64)}` }],
	])('ignores superseded request metadata %s: %j', async (key, value) => {
		const f = await fixture();
		try {
			expect(
				await f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [key]: value },
				})
			).toMatchObject({ content: [{ text: 'done' }] });
			expect(f.callback).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('checks either target independently and detects disabled tools', async () => {
		const f = await fixture();
		try {
			const tags = await held(f.client, f.discover);
			for (const known of [{ 'tools/list': tags['tools/list'] }, { 'server/discover': tags['server/discover'] }]) {
				await f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_TAGS]: known },
				});
			}
			await expect(
				f.client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_TAGS]: { 'server/discover': `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			f.registered.disable();
			await expect(
				f.client.callTool({ name: 'a', _meta: { [KNOWN_TAGS]: { 'tools/list': tags['tools/list'] } } })
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			expect((await f.client.listTools()).tools).toEqual([]);
			expect(f.callback).toHaveBeenCalledTimes(2);
		} finally {
			await f.close();
		}
	});
	it('rejects stale tags before lookup, argument validation, and callback; tracks live registry', async () => {
		const f = await fixture();
		try {
			const tags = await held(f.client);
			f.registered.update({ description: 'changed' });
			for (const name of ['a', 'unknown']) {
				const rejection = f.client.callTool({
					name,
					arguments: { x: 'ok' },
					_meta: { [KNOWN_TAGS]: tags },
				});
				// The client's own stale tag is echoed; replacement tags are not handed out.
				await expect(rejection).rejects.toMatchObject({
					code: TAG_MISMATCH,
					data: { staleTags: { 'tools/list': tags['tools/list'] } },
				});
				await expect(rejection).rejects.not.toHaveProperty('data.current');
			}
			await expect(
				f.client.callTool({ name: 'a', arguments: { x: 42 }, _meta: { [KNOWN_TAGS]: tags } })
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			expect(f.validate).not.toHaveBeenCalled();
			expect(f.callback).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
	it.each([
		null,
		[],
		'bad',
		{ 'tools/list': 1 },
		{ unknown: `sha256:${'0'.repeat(64)}` },
		{ 'prompts/list': 'p', 'resources/list': 'r' },
		// Pre-method keys make no claim.
		{ tools: `sha256:${'0'.repeat(64)}`, instructions: `sha256:${'0'.repeat(64)}` },
	])('ignores hints that make no claim about tagged targets: %j', async (value) => {
		const f = await fixture();
		try {
			expect(
				await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_TAGS]: value } })
			).toMatchObject({ content: [{ text: 'done' }] });
			expect(f.callback).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('checks tagged targets alongside unknown ones, and treats unrecognized strings as stale', async () => {
		const f = await fixture();
		try {
			const tools = (await held(f.client))['tools/list'];
			await f.client.callTool({
				name: 'a',
				arguments: { x: 'ok' },
				_meta: { [KNOWN_TAGS]: { 'tools/list': tools, 'prompts/list': 'sha256:elsewhere' } },
			});
			for (const stale of ['', 'not-a-tag', tools.toUpperCase()]) {
				await expect(
					f.client.callTool({
						name: 'a',
						arguments: { x: 'ok' },
						_meta: { [KNOWN_TAGS]: { 'tools/list': stale } },
					})
				).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: { 'tools/list': stale } } });
			}
			expect(f.callback).toHaveBeenCalledTimes(1);
			expect(f.validate).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('lists once and hashes exactly the returned tools, without instructions', async () => {
		const f = await fixture();
		try {
			const list = vi.fn(() => ({ tools: [{ ...tool, description: String(list.mock.calls.length) }] }));
			f.server.server.setRequestHandler('tools/list', list);
			const result = await f.client.listTools();
			expect(list).toHaveBeenCalledTimes(1);
			expect(result[TAG]).toBe(toolsTag(result.tools));
		} finally {
			await f.close();
		}
	});
	it.each([undefined, '', 'replacement', 'exact'])(
		'tags whatever discovery returns, and checks calls against the same handler: %j',
		async (instructions) => {
			const f = await fixture();
			try {
				f.server.server.setRequestHandler('server/discover', () => ({
					supportedVersions: ['2026-07-28'],
					capabilities: f.server.server.getCapabilities(),
					...(instructions !== undefined ? { instructions } : {}),
					_meta: { existing: 'yes' },
				}));
				const result = await f.discover();
				expect(result.instructions).toBe(instructions);
				expect(result._meta).toEqual({ existing: 'yes' });
				// The tools tag is never on discovery; it belongs to tools/list.
				expect(result[TAG]).toBe(
					discoverTag({
						supportedVersions: ['2026-07-28'],
						capabilities: f.server.server.getCapabilities(),
						...(instructions !== undefined ? { instructions } : {}),
					})
				);
				expect(
					await f.client.callTool({
						name: 'a',
						arguments: { x: 'ok' },
						_meta: { [KNOWN_TAGS]: { 'server/discover': result[TAG] } },
					})
				).toMatchObject({ content: [{ text: 'done' }] });
			} finally {
				await f.close();
			}
		}
	);
	it('detects a discovery change on the next checked call', async () => {
		const f = await fixture();
		try {
			const tag = (await f.discover())[TAG] as string;
			// e.g. a deploy that changes supported versions while instructions stay the same.
			f.server.server.setRequestHandler('server/discover', () => ({
				supportedVersions: ['2026-07-28', '2099-01-01'],
				capabilities: f.server.server.getCapabilities(),
				instructions: 'exact',
			}));
			await expect(
				f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_TAGS]: { 'server/discover': tag } } })
			).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: { 'server/discover': tag } } });
			expect(f.callback).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
	it.each([undefined, ''])('preserves configured discovery instructions presence: %j', async (instructions) => {
		const server = new McpServer({ name: 'empty', version: '1' }, { instructions });
		const discover = discoveryReader(server);
		installDefinitionTags(server, instructions)();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const result = await discover();
			expect(Object.hasOwn(result, 'instructions')).toBe(instructions !== undefined);
			expect(result.instructions).toBe(instructions);
			expect(result[TAG]).toBe(
				discoverTag({
					supportedVersions: result.supportedVersions,
					capabilities: result.capabilities,
					...(instructions !== undefined ? { instructions } : {}),
				})
			);
		} finally {
			await client.close();
			await server.close();
		}
	});
	it('ignores envelope TTL/cursors and preserves list metadata', async () => {
		const f = await fixture();
		try {
			let ttl = 10;
			f.server.server.setRequestHandler('tools/list', () => ({
				tools: [tool],
				nextCursor: String(ttl),
				_meta: { ttl, existing: 'yes' },
			}));
			const first = await f.client.listTools();
			ttl = 20;
			const second = await f.client.listTools();
			expect(second._meta).toEqual({ ttl: 20, existing: 'yes' });
			expect(second[TAG]).toBe(first[TAG]);
		} finally {
			await f.close();
		}
	});
});

describe('salted tags', () => {
	it('changes every tag without changing definitions; unsalted input is unchanged', () => {
		expect(toolsTag([tool], '')).toBe(toolsTag([tool]));
		expect(discoverTag(discovery('exact'), '')).toBe(discoverTag(discovery('exact')));
		expect(toolsTag([tool], 's1')).not.toBe(toolsTag([tool]));
		expect(discoverTag(discovery('exact'), 's1')).not.toBe(discoverTag(discovery('exact')));
		expect(toolsTag([tool], 's2')).not.toBe(toolsTag([tool], 's1'));
	});
	it('uses the salt for listing, discovery and checks consistently', async () => {
		const server = new McpServer({ name: 'salted', version: '1' }, { instructions: 'exact' });
		const discover = discoveryReader(server);
		installDefinitionTags(server, 'exact', { salt: 's1' });
		const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
		server.registerTool('a', { inputSchema: z.object({}) }, callback);
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const listing = await client.listTools();
			const discovered = await discover();
			const { [TAG]: discoveredTag, ...discoveryPayload } = discovered;
			expect(listing[TAG]).toBe(toolsTag(listing.tools, 's1'));
			expect(discoveredTag).toBe(discoverTag(discoveryPayload, 's1'));
			await client.callTool({
				name: 'a',
				arguments: {},
				_meta: { [KNOWN_TAGS]: { 'tools/list': listing[TAG], 'server/discover': discoveredTag } },
			});
			const unsalted = { 'tools/list': toolsTag(listing.tools), 'server/discover': discoverTag(discoveryPayload) };
			await expect(
				client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_TAGS]: unsalted } })
			).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: unsalted } });
			expect(callback).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe('activity counters', () => {
	it('counts tagged lists and checked calls by outcome and stale target', async () => {
		resetDefinitionTagsStats();
		const f = await fixture();
		try {
			const tags = await held(f.client, f.discover);
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_TAGS]: tags } });
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' } });
			await expect(
				f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_TAGS]: { 'tools/list': 'stale', 'server/discover': 'stale' } },
				})
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			expect(definitionTagsStats()).toMatchObject({
				taggedDiscoveries: 1,
				checkedCalls: 2,
				matched: 1,
				mismatched: 1,
				staleTools: 1,
				staleDiscovery: 1,
				lastCheckedAt: expect.any(String),
				lastMismatchAt: expect.any(String),
			});
			expect(definitionTagsStats().taggedLists).toBeGreaterThanOrEqual(1);
		} finally {
			await f.close();
		}
	});
});

describe('tag memo', () => {
	const headers = { 'x-mcp-bouquet': 'search', 'user-agent': 'ua/1' };
	const key = (overrides: Partial<Parameters<typeof definitionTagsMemoKey>[0]> = {}) =>
		definitionTagsMemoKey({ headers, salt: '', clientName: 'c', protocolVersion: '2026-07-28', ...overrides });

	it('keys by every selection input, and refuses tokens without an identified user', () => {
		const base = key();
		expect(base).toBeDefined();
		expect(key({ headers: { 'user-agent': 'ua/1', 'x-mcp-bouquet': 'search' } })).toBe(base);
		for (const changed of [
			key({ headers: { ...headers, 'x-mcp-mix': 'sandbox' } }),
			key({ headers: { ...headers, 'x-mcp-no-image-content': 'true' } }),
			key({ headers: { ...headers, 'user-agent': 'ua/2' } }),
			key({ salt: 's1' }),
			key({ clientName: 'other' }),
			key({ protocolVersion: '2025-11-25' }),
			key({ disabledTools: 'hf_whoami' }),
			key({ headers: { ...headers, authorization: 'Bearer hf_x' }, userName: 'alice' }),
		]) {
			expect(changed).toBeDefined();
			expect(changed).not.toBe(base);
		}
		expect(key({ headers: { ...headers, authorization: 'Bearer hf_x' }, userName: 'alice' })).not.toBe(
			key({ headers: { ...headers, authorization: 'Bearer hf_y' }, userName: 'bob' })
		);
		expect(key({ headers: { ...headers, authorization: 'Bearer hf_x' } })).toBeUndefined();
	});

	it('answers match, stale or unknown from remembered tags, and expires them', () => {
		resetDefinitionTagsMemo();
		const k = key() as string;
		const call = (known: unknown) => ({ method: 'tools/call', params: { name: 'a', _meta: { [KNOWN_TAGS]: known } } });
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't1' }), k)).toEqual({ kind: 'unknown' });
		rememberTag(k, 'tools/list', 't1', 1_000);
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't1' }), k, 1_001)).toEqual({ kind: 'match' });
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't0' }), k, 1_001)).toEqual({
			kind: 'stale',
			staleTags: { 'tools/list': 't0' },
		});
		// A claim with nothing remembered still needs computing, unless another claim is already stale.
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't1', 'server/discover': 'd' }), k, 1_001)).toEqual({
			kind: 'unknown',
		});
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't0', 'server/discover': 'd' }), k, 1_001)).toEqual({
			kind: 'stale',
			staleTags: { 'tools/list': 't0' },
		});
		// No claim about tagged methods: nothing to check.
		expect(checkKnownTagsAgainstMemo(call({ 'prompts/list': 'p' }), k, 1_001)).toEqual({ kind: 'match' });
		expect(checkKnownTagsAgainstMemo(call({ 'tools/list': 't1' }), k, 1_000 + MEMO_TTL_MS)).toEqual({
			kind: 'unknown',
		});
	});

	it('remembers tags computed by a full server, and neither checks nor remembers when verified', async () => {
		resetDefinitionTagsMemo();
		const k = key() as string;
		const make = async (verified: boolean) => {
			const server = new McpServer({ name: 'memo', version: '1' }, { instructions: 'exact' });
			installDefinitionTags(server, 'exact', { memoKey: k, verified });
			const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
			server.registerTool('a', { inputSchema: z.object({}) }, callback);
			const client = new Client({ name: 'test', version: '1' });
			const [c, s] = InMemoryTransport.createLinkedPair();
			await Promise.all([server.connect(s), client.connect(c)]);
			return { client, callback, close: () => Promise.all([client.close(), server.close()]) };
		};
		const verified = await make(true);
		try {
			await verified.client.listTools();
			expect(recallTag(k, 'tools/list')).toBeUndefined();
			await verified.client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_TAGS]: STALE_TOOLS } });
			expect(verified.callback).toHaveBeenCalledTimes(1);
		} finally {
			await verified.close();
		}
		const full = await make(false);
		try {
			await expect(
				full.client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_TAGS]: STALE_TOOLS } })
			).rejects.toMatchObject({ code: TAG_MISMATCH });
			const listed = (await full.client.listTools())[TAG];
			expect(recallTag(k, 'tools/list')).toBe(listed);
		} finally {
			await full.close();
		}
	});
});
