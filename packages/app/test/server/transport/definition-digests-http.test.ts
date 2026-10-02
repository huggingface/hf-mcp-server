import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { StatelessHttpTransport } from '../../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import {
	installDefinitionDigests,
	definitionDigestsCacheHints,
	definitionDigests,
	DIGEST,
	KNOWN_DIGESTS,
	DIGEST_MISMATCH,
	setDefinitionDigestsTestSalt,
} from '../../../src/server/definition-digests/index.js';
import { BOUQUET_FALLBACK } from '../../../src/shared/settings.js';

const STALE = { 'tools/list': `sha256:${'0'.repeat(64)}` };
const ERAS = ['2026-07-28', '2025-11-25'] as const;

/** Mirrors mcp-server.ts: digests and cache hints only when the transport grants a policy. */
function createFixtureFactory() {
	const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
	const factory = vi.fn<ServerFactory>(async (_headers, settings, _skipGradio, sessionInfo) => {
		const policy = sessionInfo?.definitionDigests;
		const server = new McpServer(
			{ name: 'digest-http-test', version: '1' },
			{ instructions: 'exact', ...(policy ? { cacheHints: definitionDigestsCacheHints(policy) } : {}) }
		);
		if (policy) installDefinitionDigests(server, 'exact', { salt: policy.salt });
		if (process.env.DISABLE_TOOLS !== 'hf_whoami')
			server.registerTool('hf_whoami', { inputSchema: z.object({}) }, callback);
		if (!settings) server.registerTool('extra', { inputSchema: z.object({}) }, callback);
		return { server, enabledToolIds: [] };
	});
	return { factory, callback };
}

async function withClient(
	factory: ServerFactory,
	query: string,
	version: (typeof ERAS)[number],
	run: (client: Client) => Promise<void>,
	requestHeaders?: Record<string, string>
): Promise<void> {
	const app = express();
	app.use(express.json());
	const transport = new StatelessHttpTransport(factory, app);
	await transport.initialize();
	const http = app.listen(0);
	await new Promise<void>((resolve) => http.once('listening', resolve));
	const address = http.address();
	if (!address || typeof address === 'string') throw new Error('Missing port');
	const client = new Client(
		{ name: 'definition-test', version: '1' },
		{ versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } }
	);
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp?${query}`), {
				requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
			})
		);
		await run(client);
	} finally {
		await client.close();
		await transport.cleanup();
		await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
	}
}

describe('HTTP definition digests context', () => {
	it.each(ERAS)(
		'eligible (named bouquet): full listing for checked calls, unchecked optimization kept (%s)',
		async (version) => {
			const { factory, callback } = createFixtureFactory();
			await withClient(factory, 'bouquet=search&mix=sandbox', version, async (client) => {
				const listing = await client.listTools();
				const digests = { 'tools/list': listing[DIGEST] as string };
				expect(digests['tools/list']).toBeDefined();
				expect(listing.tools.map((tool) => tool.name)).toEqual(['hf_whoami', 'extra']);
				expect(factory.mock.calls.at(-1)?.[3]?.definitionDigests).toBeDefined();
				if (version === '2026-07-28') {
					// Private even though anonymous: signed-in callers get a longer list.
					expect(listing).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
					const discovery = await client.request({ method: 'server/discover' });
					expect(discovery).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
					// Keyed by result type: discovery digests instructions, tools/list digests tools.
					expect(discovery[DIGEST]).toBe(definitionDigests([], discovery.instructions).instructions);
					expect(digests).toEqual({ 'tools/list': definitionDigests(listing.tools).tools });
					expect(discovery.instructions).toBe('exact');
					// Eligible discovery selects exactly what tools/list selects.
					expect(factory.mock.calls.at(-1)?.slice(0, 3)).toEqual([
						expect.objectContaining({ 'x-mcp-bouquet': 'search', 'x-mcp-mix': 'sandbox' }),
						undefined,
						false,
					]);
				}
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: digests } });
				expect(factory.mock.calls.at(-1)?.slice(0, 3)).toEqual([
					expect.objectContaining({ 'x-mcp-bouquet': 'search', 'x-mcp-mix': 'sandbox' }),
					undefined,
					false,
				]);
				for (const name of ['hf_whoami', 'missing']) {
					await expect(
						client.callTool({ name, arguments: {}, _meta: { [KNOWN_DIGESTS]: STALE } })
					).rejects.toMatchObject({ code: DIGEST_MISMATCH, data: { staleDigests: ['tools/list'] } });
				}
				// A malformed hint makes no claim: the call runs (on the full path, since the key is present).
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: null } });
				expect(factory.mock.calls.at(-1)?.[1]).toBeUndefined();
				expect(factory.mock.calls.at(-1)?.[2]).toBe(false);
				expect(callback).toHaveBeenCalledTimes(2);
				const previousDisabled = process.env.DISABLE_TOOLS;
				process.env.DISABLE_TOOLS = 'hf_whoami';
				try {
					await expect(
						client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: digests } })
					).rejects.toMatchObject({ code: DIGEST_MISMATCH });
				} finally {
					if (previousDisabled === undefined) delete process.env.DISABLE_TOOLS;
					else process.env.DISABLE_TOOLS = previousDisabled;
				}

				await client.callTool({ name: 'hf_whoami', arguments: {} });
				expect(factory.mock.calls.at(-1)?.[0]).not.toHaveProperty('x-mcp-bouquet');
				expect(factory.mock.calls.at(-1)?.[0]).not.toHaveProperty('x-mcp-mix');
				expect(factory.mock.calls.at(-1)?.[1]).toEqual({ builtInTools: [], spaceTools: [] });
				expect(factory.mock.calls.at(-1)?.[2]).toBe(true);
				expect(callback).toHaveBeenCalledTimes(3);
			});
		}
	);

	it.each(ERAS)('ineligible (explicit gradio): no digests, hints ignored, shortcuts kept (%s)', async (version) => {
		const { factory, callback } = createFixtureFactory();
		await withClient(factory, 'bouquet=search&gradio=owner/space', version, async (client) => {
			const listing = await client.listTools();
			expect(listing[DIGEST]).toBeUndefined();
			expect(factory.mock.calls.at(-1)?.[3]?.definitionDigests).toBeUndefined();
			if (version === '2026-07-28') {
				expect(listing).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
				const discovery = await client.request({ method: 'server/discover' });
				expect(discovery[DIGEST]).toBeUndefined();
				// The cheap discovery selection is retained.
				expect(factory.mock.calls.at(-1)?.slice(1, 3)).toEqual([BOUQUET_FALLBACK, true]);
			}
			// A stale hint is ignored and the direct-call shortcut still applies.
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: STALE } });
			expect(factory.mock.calls.at(-1)?.[1]).toEqual({ builtInTools: [], spaceTools: [] });
			expect(factory.mock.calls.at(-1)?.[2]).toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
		});
	});

	it('changes digests when the runtime test salt changes, for a connected client', async () => {
		const previous = process.env.DEFINITION_DIGESTS_TEST;
		process.env.DEFINITION_DIGESTS_TEST = 'true';
		try {
			const { factory, callback } = createFixtureFactory();
			await withClient(factory, 'bouquet=search', '2026-07-28', async (client) => {
				const first = { 'tools/list': (await client.listTools())[DIGEST] };
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: first } });
				setDefinitionDigestsTestSalt('bumped');
				await expect(
					client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: first } })
				).rejects.toMatchObject({ code: DIGEST_MISMATCH, data: { staleDigests: ['tools/list'] } });
				// The list carries a TTL, so a client must refresh past its cache after a mismatch.
				const second = { 'tools/list': (await client.listTools(undefined, { cacheMode: 'refresh' }))[DIGEST] };
				expect(second).not.toEqual(first);
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_DIGESTS]: second } });
				expect(callback).toHaveBeenCalledTimes(2);
			});
		} finally {
			setDefinitionDigestsTestSalt('');
			if (previous === undefined) delete process.env.DEFINITION_DIGESTS_TEST;
			else process.env.DEFINITION_DIGESTS_TEST = previous;
		}
	});

	it('treats ?anon requests as anonymous even when the client sends a token', async () => {
		const { factory } = createFixtureFactory();
		await withClient(
			factory,
			'anon',
			'2026-07-28',
			async (client) => {
				const listing = await client.listTools();
				expect(listing[DIGEST]).toBeDefined();
				expect(listing).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
				const [headers, , , sessionInfo] = factory.mock.calls.at(-1) ?? [];
				expect(headers).not.toHaveProperty('authorization');
				expect(sessionInfo).toMatchObject({ isAuthenticated: false, definitionDigests: expect.any(Object) });
			},
			{ Authorization: 'Bearer hf_should_be_ignored' }
		);
	});
});
