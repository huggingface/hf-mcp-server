import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ServerCapabilities } from '@modelcontextprotocol/client';
import { HF_FS_TOOL_ID, REPO_SEARCH_TOOL_ID } from '@llmindset/hf-mcp';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { WebServer } from '../../src/server/web-server.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

const originalDisabledTools = process.env.DISABLE_TOOLS;

afterEach(() => {
	if (originalDisabledTools === undefined) delete process.env.DISABLE_TOOLS;
	else process.env.DISABLE_TOOLS = originalDisabledTools;
});

const transportInfo: TransportInfo = {
	transport: 'streamableHttpJson',
	port: 3000,
	defaultHfTokenSet: false,
	externalApiMode: false,
	stdioClient: null,
};

async function inspectSearchBouquet(): Promise<{
	toolNames: string[];
	toolsCapability: ServerCapabilities['tools'];
}> {
	const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
	const factory = createServerFactory(new WebServer(), apiClient);
	const { server } = await factory({ 'x-mcp-bouquet': 'search' });
	const client = new Client({ name: 'test-client', version: '1.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	try {
		return {
			toolNames: (await client.listTools()).tools.map((tool) => tool.name),
			toolsCapability: client.getServerCapabilities()?.tools,
		};
	} finally {
		await client.close();
		await server.close();
	}
}

describe('immutable tool registration', () => {
	it('registers only fixed and selected tools', async () => {
		const result = await inspectSearchBouquet();
		expect(result.toolNames).toEqual(['hf_whoami', REPO_SEARCH_TOOL_ID, HF_FS_TOOL_ID]);
		expect(result.toolsCapability).toEqual({ listChanged: false });
	});

	it('does not register tools disabled by server configuration', async () => {
		process.env.DISABLE_TOOLS = REPO_SEARCH_TOOL_ID;
		expect((await inspectSearchBouquet()).toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID]);
	});

	it('does not advertise Skills resources on the long-lived STDIO server', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(new WebServer(), apiClient);
		const { server } = await factory(null);
		const client = new Client({ name: 'stdio-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			expect(client.getServerCapabilities()?.resources).toBeUndefined();
			expect(client.getServerCapabilities()?.extensions).toBeUndefined();
		} finally {
			await client.close();
			await server.close();
		}
	});
});
