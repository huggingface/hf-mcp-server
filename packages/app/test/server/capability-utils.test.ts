import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { registerCapabilities } from '../../src/server/utils/capability-utils.js';
import type { McpApiClient } from '../../src/server/utils/mcp-api-client.js';

function makeServer(): { server: McpServer; getCaps: () => ServerCapabilities } {
	let captured: ServerCapabilities = {};
	const inner = {
		_capabilities: {} as Record<string, unknown>,
		registerCapabilities(caps: ServerCapabilities) {
			captured = caps;
		},
	};
	const server = { server: inner } as unknown as McpServer;
	return { server, getCaps: () => captured };
}

const apiClient = { getTransportInfo: () => ({ jsonResponseEnabled: true }) } as unknown as McpApiClient;

describe('registerCapabilities', () => {
	it('advertises resources with explicit subscribe:false + the skills extension when skills present', () => {
		const { server, getCaps } = makeServer();
		registerCapabilities(server, apiClient, { hasSkills: true });
		const caps = getCaps();
		expect(caps.resources).toEqual({ subscribe: false, listChanged: false });
		expect(caps.extensions).toEqual({ 'io.modelcontextprotocol/skills': { directoryRead: true } });
	});

	it('advertises no resources or skills extension for a denied client (hasSkills/hasResources false)', () => {
		const { server, getCaps } = makeServer();
		registerCapabilities(server, apiClient, { hasSkills: false, hasResources: false });
		const caps = getCaps();
		expect(caps.resources).toBeUndefined();
		expect(caps.extensions).toBeUndefined();
	});
});
