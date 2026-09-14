import { Buffer } from 'node:buffer';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { hfWhoamiOutputSchema } from '../../src/server/output-schemas/hf-whoami-output-schema.js';
import { fetchHfWhoami, type HfWhoamiResponse } from '../../src/server/utils/hf-whoami-client.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

vi.mock('../../src/server/utils/hf-whoami-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/server/utils/hf-whoami-client.js')>();
	return { ...actual, fetchHfWhoami: vi.fn() };
});

const transportInfo: TransportInfo = {
	transport: 'streamableHttpJson',
	port: 3000,
	defaultHfTokenSet: false,
	externalApiMode: false,
	stdioClient: null,
};

function oauthToken(scopes: string[]): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({ scope: scopes })).toString('base64url');
	return `hf_oauth_${header}.${payload}.signature`;
}

describe('hf_whoami MCP wiring', () => {
	it('advertises its output schema and returns equivalent Markdown and structured data', async () => {
		const token = oauthToken(['openid', 'profile', 'read-mcp']);
		const authenticatedUser = {
			id: 'user-id',
			type: 'user',
			name: 'alice',
			fullname: 'Alice Example',
			email: 'alice@example.com',
			emailVerified: true,
			isPro: true,
			canPay: true,
			avatarUrl: 'https://cdn.example/alice.png',
			periodEnd: null,
			billingMode: 'prepaid',
			orgs: [
				{
					id: 'org-id',
					type: 'org',
					name: 'example-org',
					fullname: 'Example Org',
					email: null,
					canPay: true,
					avatarUrl: 'https://cdn.example/org.png',
					periodEnd: null,
					roleInOrg: 'admin',
				},
			],
			auth: { type: 'oauth' },
		} satisfies HfWhoamiResponse;
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(apiClient);
		vi.mocked(fetchHfWhoami).mockResolvedValue(authenticatedUser);
		const { server } = await factory({ authorization: `Bearer ${token}` }, { builtInTools: [], spaceTools: [] }, true, {
			authenticatedUser,
		});
		const client = new Client({ name: 'hf-whoami-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		try {
			expect(client.getServerVersion()?.name).toBe('huggingface.co/mcp');
			const advertised = (await client.listTools()).tools.find((tool) => tool.name === 'hf_whoami');
			expect(advertised).toBeDefined();
			expect(advertised).toMatchObject({
				title: 'Hugging Face User Info',
				description:
					'Inspect the current Hugging Face authentication context, including the account, visible organization memberships, and credential access details. Read-only and never returns credential values.',
			});
			expect(advertised?.annotations).toEqual({
				title: 'Hugging Face User Info',
				destructiveHint: false,
				idempotentHint: false,
				readOnlyHint: true,
				openWorldHint: false,
			});
			expect(advertised?.outputSchema).toMatchObject({
				type: 'object',
				oneOf: [
					{
						type: 'object',
						properties: {
							status: { const: 'authenticated' },
							account: { type: 'object' },
							organizations: { type: 'array' },
							credential: expect.any(Object),
						},
					},
					{
						type: 'object',
						properties: {
							status: { const: 'anonymous' },
							account: { type: 'null' },
							organizations: { type: 'array' },
							credential: { type: 'null' },
							guidance: { type: 'string' },
						},
					},
					{
						type: 'object',
						properties: {
							status: { const: 'authentication_unverified' },
							account: { type: 'null' },
							organizations: { type: 'array' },
							credential: { type: 'null' },
							guidance: { type: 'string' },
						},
					},
				],
			});

			const result = await client.callTool({ name: 'hf_whoami', arguments: {} });
			expect(hfWhoamiOutputSchema.safeParse(result.structuredContent).success).toBe(true);
			expect(result.structuredContent).toMatchObject({
				status: 'authenticated',
				account: { id: 'user-id', name: 'alice' },
				organizations: [{ id: 'org-id', name: 'example-org', role: 'admin' }],
				credential: {
					type: 'oauth',
					scopes: ['openid', 'profile', 'read-mcp'],
				},
			});
			expect(result.structuredContent).not.toHaveProperty('identity');
			expect(result.structuredContent).not.toHaveProperty('authentication');
			expect(result.content).toHaveLength(1);
			expect(result.content?.[0]).toMatchObject({ type: 'text' });
			const markdown = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
			expect(markdown).toContain('Authenticated as [@alice]');
			expect(markdown).not.toContain('Alice Example');
			expect(markdown).toContain('Example Org');
			expect(markdown).toContain('`read-mcp`');
			expect(markdown).not.toContain('available for this MCP resource');
			expect(JSON.stringify(result)).not.toContain(token);
			expect(JSON.stringify(result)).not.toContain('alice@example.com');
			expect(JSON.stringify(result)).not.toContain('Alice Example');
		} finally {
			await client.close();
			await server.close();
		}
	});

	it('fails construction for a supplied unverifiable credential', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
		const factory = createServerFactory(new McpApiClient({ type: 'static' }, transportInfo));
		await expect(
			factory({ authorization: 'Bearer hf_unverified-token' }, { builtInTools: [], spaceTools: [] }, true, {})
		).rejects.toMatchObject({ statusCode: 503 });
	});
});
