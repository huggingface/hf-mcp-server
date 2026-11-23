import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { isProxyToolEnabled, registerProxyToolsFromConfig } from '../../src/server/mcp-proxy.js';

describe('isProxyToolEnabled', () => {
	const config = {
		proxyId: 'hf_bucket_upload',
		toolName: 'upload_file',
		meta: undefined,
	};

	it('registers all proxy tools when no enabled set is provided', () => {
		expect(isProxyToolEnabled(config, null)).toBe(true);
	});

	it('registers a proxy tool when its individual tool name is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['upload_file']))).toBe(true);
	});

	it('registers a proxy tool when its proxy id group is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['hf_bucket_upload']))).toBe(true);
	});

	it('skips a proxy tool when neither its tool name nor proxy id is enabled', () => {
		expect(isProxyToolEnabled(config, new Set(['hf_hub_query']))).toBe(false);
	});

	it('conservatively annotates tools with unknown upstream behavior', async () => {
		const server = new McpServer({ name: 'proxy-annotation-test', version: '1.0.0' });
		registerProxyToolsFromConfig(
			server,
			[
				{
					proxyId: 'remote',
					allowAnonymous: true,
					toolName: 'remote_action',
					upstreamToolName: 'action',
					url: 'https://example.com/mcp',
					inputSchema: { type: 'object', properties: {} },
				},
			],
			undefined
		);

		const client = new Client({ name: 'test-client', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			const tool = (await client.listTools()).tools[0];
			expect(tool?.annotations).toEqual({
				title: 'remote - action',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			});
		} finally {
			await client.close();
			await server.close();
		}
	});
});
