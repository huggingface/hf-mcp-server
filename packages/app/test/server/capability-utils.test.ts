import { describe, expect, it } from 'vitest';
import type { McpServer, ServerCapabilities } from '@modelcontextprotocol/server';
import { registerCapabilities } from '../../src/server/utils/capability-utils.js';

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

describe('registerCapabilities', () => {
	it('advertises resources with explicit subscribe:false + the skills extension when skills present', () => {
		const { server, getCaps } = makeServer();
		registerCapabilities(server, { hasSkills: true });
		const caps = getCaps();
		expect(caps.prompts).toBeUndefined();
		expect(caps.resources).toEqual({ subscribe: false, listChanged: false });
		expect(caps.extensions).toEqual({ 'io.modelcontextprotocol/skills': { directoryRead: true } });
		expect(caps.tools).toEqual({ listChanged: false });
	});

	it('advertises no resources or skills extension for a denied client (hasSkills/hasResources false)', () => {
		const { server, getCaps } = makeServer();
		registerCapabilities(server, { hasSkills: false, hasResources: false });
		const caps = getCaps();
		expect(caps.prompts).toBeUndefined();
		expect(caps.resources).toBeUndefined();
		expect(caps.extensions).toBeUndefined();
	});
});
