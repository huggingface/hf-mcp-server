import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { StatelessHttpTransport } from '../../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import {
	installDefinitionTags,
	definitionTagsCacheHints,
	toolsTag,
	discoverTag,
	TAG,
	KNOWN_TAGS,
	TAG_MISMATCH,
	setDefinitionTagsTestSalt,
	resetDefinitionTagsMemo,
	definitionTagsStats,
} from '../../../src/server/definition-tags/index.js';
import { BOUQUET_FALLBACK } from '../../../src/shared/settings.js';

const STALE = { 'tools/list': `sha256:${'0'.repeat(64)}` };
const ERAS = ['2026-07-28', '2025-11-25'] as const;

/** Mirrors mcp-server.ts: tags and cache hints only when the transport grants a policy. */
function createFixtureFactory() {
	const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
	const factory = vi.fn<ServerFactory>(async (_headers, settings, _skipGradio, sessionInfo) => {
		const policy = sessionInfo?.definitionTags;
		const server = new McpServer(
			{ name: 'tag-http-test', version: '1' },
			{ instructions: 'exact', ...(policy ? { cacheHints: definitionTagsCacheHints(policy) } : {}) }
		);
		if (policy)
			installDefinitionTags(server, 'exact', { salt: policy.salt, memoKey: policy.memoKey, verified: policy.verified });
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

describe('HTTP definition tags context', () => {
	it.each(ERAS)('eligible (named bouquet): tags, discovery, and memo-checked calls (%s)', async (version) => {
		resetDefinitionTagsMemo();
		const { factory, callback } = createFixtureFactory();
		const SHORTCUT = [{ builtInTools: [], spaceTools: [] }, true];
		const FULL = [undefined, false];
		const lastPath = () => factory.mock.calls.at(-1)?.slice(1, 3);
		await withClient(factory, 'bouquet=search&mix=sandbox', version, async (client) => {
			const listing = await client.listTools();
			const tags: Record<string, string> = { 'tools/list': listing[TAG] as string };
			expect(tags['tools/list']).toBe(toolsTag(listing.tools));
			expect(listing.tools.map((tool) => tool.name)).toEqual(['hf_whoami', 'extra']);
			expect(factory.mock.calls.at(-1)?.[3]?.definitionTags).toMatchObject({ memoKey: expect.any(String) });
			if (version === '2026-07-28') {
				// Private even though anonymous: signed-in callers get a longer list.
				expect(listing).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
				const discovery = await client.request({ method: 'server/discover' });
				expect(discovery).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
				// Keyed by method: discovery tags its payload, tools/list tags the tools.
				const { ttlMs: _ttl, cacheScope: _scope, [TAG]: discoveryTag, _meta: _m, ...payload } = discovery;
				expect(discoveryTag).toBe(discoverTag(payload));
				expect(payload).toHaveProperty('capabilities');
				expect(payload).toHaveProperty('supportedVersions');
				expect(discovery.instructions).toBe('exact');
				// Eligible discovery selects exactly what tools/list selects.
				expect(factory.mock.calls.at(-1)?.slice(0, 3)).toEqual([
					expect.objectContaining({ 'x-mcp-bouquet': 'search', 'x-mcp-mix': 'sandbox' }),
					undefined,
					false,
				]);
				tags['server/discover'] = discoveryTag as string;
			}

			// Warm memo: a matching checked call is a string comparison and keeps the shortcut.
			const before = definitionTagsStats().memoChecks;
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: tags } });
			expect(lastPath()).toEqual(SHORTCUT);
			expect(definitionTagsStats().memoChecks).toBe(before + 1);

			// A remembered mismatch is rejected without building a server.
			const built = factory.mock.calls.length;
			for (const name of ['hf_whoami', 'missing']) {
				await expect(client.callTool({ name, arguments: {}, _meta: { [KNOWN_TAGS]: STALE } })).rejects.toMatchObject({
					code: TAG_MISMATCH,
					data: { staleTags: STALE },
				});
			}
			if (version === '2026-07-28') {
				await expect(
					client.callTool({
						name: 'hf_whoami',
						arguments: {},
						_meta: { [KNOWN_TAGS]: { 'server/discover': 'sha256:old' } },
					})
				).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: { 'server/discover': 'sha256:old' } } });
			}
			expect(factory.mock.calls.length).toBe(built);

			// A malformed hint makes no claim: the call runs on the shortcut.
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: null } });
			expect(lastPath()).toEqual(SHORTCUT);

			// Cold memo (restart, expiry): one full build computes and remembers, then shortcuts resume.
			resetDefinitionTagsMemo();
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: tags } });
			expect(lastPath()).toEqual(FULL);
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: tags } });
			expect(lastPath()).toEqual(SHORTCUT);
			resetDefinitionTagsMemo();
			await expect(
				client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: STALE } })
			).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: STALE } });
			expect(lastPath()).toEqual(FULL);
			expect(callback).toHaveBeenCalledTimes(4);

			// Changing an input to the tool list changes the memo key, so the call takes the full path.
			const previousDisabled = process.env.DISABLE_TOOLS;
			process.env.DISABLE_TOOLS = 'hf_whoami';
			try {
				await expect(
					client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: tags } })
				).rejects.toMatchObject({ code: TAG_MISMATCH });
			} finally {
				if (previousDisabled === undefined) delete process.env.DISABLE_TOOLS;
				else process.env.DISABLE_TOOLS = previousDisabled;
			}

			// Unchecked calls keep the shortcut and drop discovery selection headers.
			await client.callTool({ name: 'hf_whoami', arguments: {} });
			expect(factory.mock.calls.at(-1)?.[0]).not.toHaveProperty('x-mcp-bouquet');
			expect(factory.mock.calls.at(-1)?.[0]).not.toHaveProperty('x-mcp-mix');
			expect(lastPath()).toEqual(SHORTCUT);
			expect(callback).toHaveBeenCalledTimes(5);
		});
	});

	it.each(ERAS)('ineligible (explicit gradio): no tags, hints ignored, shortcuts kept (%s)', async (version) => {
		const { factory, callback } = createFixtureFactory();
		await withClient(factory, 'bouquet=search&gradio=owner/space', version, async (client) => {
			const listing = await client.listTools();
			expect(listing[TAG]).toBeUndefined();
			expect(factory.mock.calls.at(-1)?.[3]?.definitionTags).toBeUndefined();
			if (version === '2026-07-28') {
				expect(listing).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
				const discovery = await client.request({ method: 'server/discover' });
				expect(discovery[TAG]).toBeUndefined();
				// The cheap discovery selection is retained.
				expect(factory.mock.calls.at(-1)?.slice(1, 3)).toEqual([BOUQUET_FALLBACK, true]);
			}
			// A stale hint is ignored and the direct-call shortcut still applies.
			await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: STALE } });
			expect(factory.mock.calls.at(-1)?.[1]).toEqual({ builtInTools: [], spaceTools: [] });
			expect(factory.mock.calls.at(-1)?.[2]).toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
		});
	});

	it('changes tags when the runtime test salt changes, for a connected client', async () => {
		const previous = process.env.DEFINITION_TAGS_TEST;
		process.env.DEFINITION_TAGS_TEST = 'true';
		try {
			const { factory, callback } = createFixtureFactory();
			await withClient(factory, 'bouquet=search', '2026-07-28', async (client) => {
				const first = { 'tools/list': (await client.listTools())[TAG] };
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: first } });
				setDefinitionTagsTestSalt('bumped');
				await expect(
					client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: first } })
				).rejects.toMatchObject({ code: TAG_MISMATCH, data: { staleTags: first } });
				// The list carries a TTL, so a client must refresh past its cache after a mismatch.
				const second = { 'tools/list': (await client.listTools(undefined, { cacheMode: 'refresh' }))[TAG] };
				expect(second).not.toEqual(first);
				await client.callTool({ name: 'hf_whoami', arguments: {}, _meta: { [KNOWN_TAGS]: second } });
				expect(callback).toHaveBeenCalledTimes(2);
			});
		} finally {
			setDefinitionTagsTestSalt('');
			if (previous === undefined) delete process.env.DEFINITION_TAGS_TEST;
			else process.env.DEFINITION_TAGS_TEST = previous;
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
				expect(listing[TAG]).toBeDefined();
				expect(listing).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
				const [headers, , , sessionInfo] = factory.mock.calls.at(-1) ?? [];
				expect(headers).not.toHaveProperty('authorization');
				expect(sessionInfo).toMatchObject({ isAuthenticated: false, definitionTags: expect.any(Object) });
			},
			{ Authorization: 'Bearer hf_should_be_ignored' }
		);
	});
});
