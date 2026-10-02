import { describe, it, expect, vi } from 'vitest';
import { McpServer, type Tool, type ServerContext, type HandlerResultTypeMap } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
	definitionDigests,
	installDefinitionDigests,
	DIGEST,
	KNOWN_DIGESTS,
	DIGEST_MISMATCH,
	METHOD_OF,
	definitionDigestsStats,
	resetDefinitionDigestsStats,
} from '../../src/server/definition-digests/index.js';

const tool: Tool = {
	name: 'a',
	inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
	_meta: { semantic: true },
};

describe('definition digests', () => {
	it('rejects duplicate names, even with identical definitions', () => {
		for (const duplicate of [tool, { ...tool, description: 'different' }]) {
			expect(() => definitionDigests([tool, { ...tool, name: 'b' }, duplicate])).toThrow('Duplicate tool name: a');
		}
	});
	it('canonicalizes keys and collection order, not semantic array order', () => {
		const other = { ...tool, name: 'b' };
		expect(definitionDigests([tool, other])).toEqual(
			definitionDigests([other, { _meta: { semantic: true }, inputSchema: tool.inputSchema, name: 'a' }])
		);
	});
	it('preserves semantic array ordering', () => {
		const first = { ...tool, inputSchema: { type: 'object' as const, required: ['x', 'y'] } };
		const second = { ...tool, inputSchema: { type: 'object' as const, required: ['y', 'x'] } };
		expect(definitionDigests([first]).tools).not.toBe(definitionDigests([second]).tools);
	});
	it('includes schemas and semantic metadata; separates instructions and absent/empty', () => {
		const base = definitionDigests([tool], 'exact\n');
		for (const changed of [
			{ ...tool, outputSchema: { type: 'object' as const } },
			{ ...tool, _meta: { semantic: false } },
			{ ...tool, description: 'new' },
			{ ...tool, inputSchema: { type: 'object' as const } },
		]) {
			expect(definitionDigests([changed], 'exact\n').tools).not.toBe(base.tools);
		}
		expect(definitionDigests([tool], 'exact').instructions).not.toBe(base.instructions);
		expect(definitionDigests([tool], 'different').tools).toBe(base.tools);
		expect(definitionDigests([]).instructions).not.toBe(definitionDigests([], '').instructions);
		expect(definitionDigests([], '').tools).not.toBe(definitionDigests([], '').instructions);
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

/** What a client does: hold one digest per result, keyed by the method that produced it. */
async function held(client: Client, discover?: () => Promise<HandlerResultTypeMap['server/discover']>) {
	const tools = (await client.listTools())[DIGEST] as string;
	if (!discover) return { [METHOD_OF.tools]: tools };
	return { [METHOD_OF.tools]: tools, [METHOD_OF.instructions]: (await discover())[DIGEST] as string };
}

/** Internal {tools, instructions} shape -> wire shape keyed by method. */
function wire(v: { tools?: string; instructions?: string }) {
	return {
		...(v.tools !== undefined ? { [METHOD_OF.tools]: v.tools } : {}),
		...(v.instructions !== undefined ? { [METHOD_OF.instructions]: v.instructions } : {}),
	};
}

async function fixture() {
	const server = new McpServer(
		{ name: 'digest-test', version: '1' },
		{ instructions: 'exact', capabilities: { experimental: { existing: { enabled: true } } } }
	);
	const discover = discoveryReader(server);
	installDefinitionDigests(server, 'exact');
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
		const finalize = installDefinitionDigests(server);
		finalize();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			expect((await client.listTools())[DIGEST]).toBe(definitionDigests([]).tools);
			await expect(
				client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_DIGESTS]: { 'tools/list': `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: DIGEST_MISMATCH });
			await expect(
				client.callTool({ name: 'unknown', _meta: { [KNOWN_DIGESTS]: wire(definitionDigests([])) } })
			).rejects.toMatchObject({ code: -32602 });
		} finally {
			await client.close();
			await server.close();
		}
	});
	it('preserves existing capabilities without advertising digests and executes matching and opportunistic calls', async () => {
		const f = await fixture();
		try {
			const digests = await held(f.client);
			expect(f.client.getServerCapabilities()?.experimental).toEqual({
				existing: { enabled: true },
			});
			for (const meta of [undefined, {}, { [KNOWN_DIGESTS]: {} }, { [KNOWN_DIGESTS]: digests }]) {
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
	])('ignores pre-SEP request metadata %s: %j', async (key, value) => {
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
			const digests = await held(f.client, f.discover);
			for (const known of [
				{ [METHOD_OF.tools]: digests[METHOD_OF.tools] },
				{ [METHOD_OF.instructions]: digests[METHOD_OF.instructions] },
			]) {
				await f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DIGESTS]: known },
				});
			}
			await expect(
				f.client.callTool({
					name: 'unknown',
					_meta: { [KNOWN_DIGESTS]: { 'server/discover': `sha256:${'0'.repeat(64)}` } },
				})
			).rejects.toMatchObject({ code: DIGEST_MISMATCH });
			f.registered.disable();
			await expect(
				f.client.callTool({ name: 'a', _meta: { [KNOWN_DIGESTS]: { 'tools/list': digests['tools/list'] } } })
			).rejects.toMatchObject({ code: DIGEST_MISMATCH });
			expect((await f.client.listTools()).tools).toEqual([]);
			expect(f.callback).toHaveBeenCalledTimes(2);
		} finally {
			await f.close();
		}
	});
	it('rejects stale digests before lookup, argument validation, and callback; tracks live registry', async () => {
		const f = await fixture();
		try {
			const digests = await held(f.client);
			f.registered.update({ description: 'changed' });
			for (const name of ['a', 'unknown']) {
				const rejection = f.client.callTool({
					name,
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DIGESTS]: digests },
				});
				// Stale targets are named; replacement digests are not handed out.
				await expect(rejection).rejects.toMatchObject({
					code: DIGEST_MISMATCH,
					data: { staleDigests: ['tools/list'] },
				});
				await expect(rejection).rejects.not.toHaveProperty('data.current');
			}
			await expect(
				f.client.callTool({ name: 'a', arguments: { x: 42 }, _meta: { [KNOWN_DIGESTS]: digests } })
			).rejects.toMatchObject({ code: DIGEST_MISMATCH });
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
	])('ignores hints that make no claim about digested targets: %j', async (value) => {
		const f = await fixture();
		try {
			expect(
				await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_DIGESTS]: value } })
			).toMatchObject({ content: [{ text: 'done' }] });
			expect(f.callback).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});
	it('checks digested targets alongside unknown ones, and treats unrecognized strings as stale', async () => {
		const f = await fixture();
		try {
			const tools = (await held(f.client))['tools/list'];
			await f.client.callTool({
				name: 'a',
				arguments: { x: 'ok' },
				_meta: { [KNOWN_DIGESTS]: { 'tools/list': tools, 'prompts/list': 'sha256:elsewhere' } },
			});
			for (const stale of ['', 'not-a-digest', tools.toUpperCase()]) {
				await expect(
					f.client.callTool({
						name: 'a',
						arguments: { x: 'ok' },
						_meta: { [KNOWN_DIGESTS]: { 'tools/list': stale } },
					})
				).rejects.toMatchObject({ code: DIGEST_MISMATCH, data: { staleDigests: ['tools/list'] } });
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
			expect(result[DIGEST]).toBe(definitionDigests(result.tools).tools);
		} finally {
			await f.close();
		}
	});
	it.each([undefined, '', 'replacement', 'exact'])(
		'digests discovery only for the checked instructions: %j',
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
				// The tools digest is never on discovery; it belongs to tools/list.
				expect(result[DIGEST]).toBe(instructions === 'exact' ? definitionDigests([], 'exact').instructions : undefined);
			} finally {
				await f.close();
			}
		}
	);
	it.each([undefined, ''])('preserves configured discovery instructions presence: %j', async (instructions) => {
		const server = new McpServer({ name: 'empty', version: '1' }, { instructions });
		const discover = discoveryReader(server);
		installDefinitionDigests(server, instructions)();
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const result = await discover();
			expect(Object.hasOwn(result, 'instructions')).toBe(instructions !== undefined);
			expect(result.instructions).toBe(instructions);
			expect(result[DIGEST]).toBe(definitionDigests([], instructions).instructions);
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
			expect(second[DIGEST]).toBe(first[DIGEST]);
		} finally {
			await f.close();
		}
	});
});

describe('salted digests', () => {
	it('changes every digest without changing definitions; unsalted input is unchanged', () => {
		const unsalted = definitionDigests([tool], 'exact');
		expect(definitionDigests([tool], 'exact', '')).toEqual(unsalted);
		const salted = definitionDigests([tool], 'exact', 's1');
		expect(salted.tools).not.toBe(unsalted.tools);
		expect(salted.instructions).not.toBe(unsalted.instructions);
		expect(definitionDigests([tool], 'exact', 's2').tools).not.toBe(salted.tools);
	});
	it('uses the salt for listing, discovery and checks consistently', async () => {
		const server = new McpServer({ name: 'salted', version: '1' }, { instructions: 'exact' });
		const discover = discoveryReader(server);
		installDefinitionDigests(server, 'exact', { salt: 's1' });
		const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'done' }] }));
		server.registerTool('a', { inputSchema: z.object({}) }, callback);
		const client = new Client({ name: 'test', version: '1' });
		const [c, s] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(s), client.connect(c)]);
		try {
			const listing = await client.listTools();
			const expected = definitionDigests(listing.tools, 'exact', 's1');
			expect(listing[DIGEST]).toBe(expected.tools);
			expect((await discover())[DIGEST]).toBe(expected.instructions);
			await client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_DIGESTS]: wire(expected) } });
			const unsalted = definitionDigests(listing.tools, 'exact');
			await expect(
				client.callTool({ name: 'a', arguments: {}, _meta: { [KNOWN_DIGESTS]: wire(unsalted) } })
			).rejects.toMatchObject({ code: DIGEST_MISMATCH, data: { staleDigests: ['tools/list', 'server/discover'] } });
			expect(callback).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe('activity counters', () => {
	it('counts digested lists and checked calls by outcome and stale target', async () => {
		resetDefinitionDigestsStats();
		const f = await fixture();
		try {
			const digests = await held(f.client, f.discover);
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' }, _meta: { [KNOWN_DIGESTS]: digests } });
			await f.client.callTool({ name: 'a', arguments: { x: 'ok' } });
			await expect(
				f.client.callTool({
					name: 'a',
					arguments: { x: 'ok' },
					_meta: { [KNOWN_DIGESTS]: { 'tools/list': 'stale', 'server/discover': 'stale' } },
				})
			).rejects.toMatchObject({ code: DIGEST_MISMATCH });
			expect(definitionDigestsStats()).toMatchObject({
				digestedDiscoveries: 1,
				checkedCalls: 2,
				matched: 1,
				mismatched: 1,
				staleTools: 1,
				staleInstructions: 1,
				lastCheckedAt: expect.any(String),
				lastMismatchAt: expect.any(String),
			});
			expect(definitionDigestsStats().digestedLists).toBeGreaterThanOrEqual(1);
		} finally {
			await f.close();
		}
	});
});
