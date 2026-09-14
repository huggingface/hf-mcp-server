import { Buffer } from 'node:buffer';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CREATE_REPO_TOOL_ID, HF_FILES_FLAG, HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID } from '@llmindset/hf-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { fetchHfWhoami, type HfWhoamiResponse } from '../../src/server/utils/hf-whoami-client.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

const originalDisabledTools = process.env.DISABLE_TOOLS;

afterEach(() => {
	if (originalDisabledTools === undefined) delete process.env.DISABLE_TOOLS;
	else process.env.DISABLE_TOOLS = originalDisabledTools;
});

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

function oauthToken(scopes?: string[] | string): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify(scopes === undefined ? {} : { scope: scopes })).toString('base64url');
	return `hf_oauth_${header}.${payload}.signature`;
}

function authenticatedUser(authType: string): HfWhoamiResponse {
	return {
		id: 'user-id',
		type: 'user',
		name: 'alice',
		orgs: [],
		auth: { type: authType },
	};
}

interface InspectToolsOptions {
	token: string;
	authType?: string;
	verified?: boolean;
	builtInTools?: string[];
}

async function inspectTools({
	token,
	authType = 'oauth',
	verified = true,
	builtInTools = [HF_FILES_FLAG],
}: InspectToolsOptions): Promise<{ enabledToolIds: string[]; toolNames: string[] }> {
	const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
	const factory = createServerFactory(apiClient);
	if (verified) vi.mocked(fetchHfWhoami).mockResolvedValue(authenticatedUser(authType));
	else vi.mocked(fetchHfWhoami).mockRejectedValue(new Error('Hub unavailable'));
	const result = await factory(
		{ authorization: `Bearer ${token}` },
		{ builtInTools, spaceTools: [] },
		true,
		verified ? { authenticatedUser: authenticatedUser(authType) } : {}
	);
	const client = new Client({ name: 'hf-files-create-repo-test', version: '1.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([result.server.connect(serverTransport), client.connect(clientTransport)]);

	try {
		return {
			enabledToolIds: result.enabledToolIds ?? [],
			toolNames: (await client.listTools()).tools.map((tool) => tool.name),
		};
	} finally {
		await client.close();
		await result.server.close();
	}
}

describe('hf_files create_repo wiring', () => {
	it.each(['contribute-repos', 'write-repos'])(
		'auto-enables create_repo for a verified OAuth token with the %s scope',
		async (scope) => {
			const result = await inspectTools({ token: oauthToken(['read-mcp', scope]) });

			expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID, CREATE_REPO_TOOL_ID]);
			expect(result.toolNames).toEqual(['hf_whoami', CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
		}
	);

	it('does not auto-enable create_repo without a repository-write OAuth scope', async () => {
		const result = await inspectTools({ token: oauthToken(['read-mcp', 'openid', 'read-repos']) });

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});

	it('requires an exact repository-write OAuth scope', async () => {
		const result = await inspectTools({
			token: oauthToken(['read-mcp', 'contribute-repos-extra', 'write-repos-admin']),
		});

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});

	it('accepts a repository-write scope from a space-delimited OAuth claim', async () => {
		const result = await inspectTools({ token: oauthToken('openid read-mcp write-repos') });

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID, CREATE_REPO_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});

	it('does not auto-enable create_repo when hf_files is off', async () => {
		const result = await inspectTools({ token: oauthToken(['read-mcp', 'write-repos']), builtInTools: [] });

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID]);
	});

	it('fails closed when a verified OAuth token has no readable scope claim', async () => {
		await expect(inspectTools({ token: oauthToken() })).rejects.toMatchObject({ statusCode: 403 });
	});

	it('does not auto-enable create_repo for a verified non-OAuth credential', async () => {
		const result = await inspectTools({ token: 'hf_personal-token', authType: 'access_token' });

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});

	it('does not trust repository-write scopes without a verified OAuth identity', async () => {
		await expect(
			inspectTools({ token: oauthToken(['read-mcp', 'contribute-repos']), verified: false })
		).rejects.toMatchObject({ statusCode: 503 });
	});

	it('does not duplicate an explicitly selected create_repo tool', async () => {
		const result = await inspectTools({
			token: oauthToken(['read-mcp', 'contribute-repos']),
			builtInTools: [HF_FILES_FLAG, CREATE_REPO_TOOL_ID],
		});

		expect(result.enabledToolIds).toEqual([CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});

	it('preserves an explicitly selected create_repo tool for a PAT', async () => {
		const result = await inspectTools({
			token: 'hf_personal-token',
			authType: 'access_token',
			builtInTools: [CREATE_REPO_TOOL_ID],
		});

		expect(result.enabledToolIds).toEqual([CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', CREATE_REPO_TOOL_ID, HF_FS_TOOL_ID]);
	});

	it('respects DISABLE_TOOLS for the auto-enabled create_repo tool', async () => {
		process.env.DISABLE_TOOLS = CREATE_REPO_TOOL_ID;
		const result = await inspectTools({ token: oauthToken(['read-mcp', 'write-repos']) });

		expect(result.enabledToolIds).toEqual([HF_FS_TOOL_ID, CREATE_REPO_TOOL_ID]);
		expect(result.toolNames).toEqual(['hf_whoami', HF_FS_TOOL_ID, HF_FS_WRITE_TOOL_ID]);
	});
});
