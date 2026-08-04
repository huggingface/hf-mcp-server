import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { WebServer } from '../../src/server/web-server.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

const mocks = vi.hoisted(() => ({
	executeJobs: vi.fn(),
}));

vi.mock('@llmindset/hf-mcp', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@llmindset/hf-mcp')>();

	return {
		...actual,
		HfJobsTool: class {
			execute = mocks.executeJobs;
		},
	};
});

const transportInfo: TransportInfo = {
	transport: 'streamableHttpJson',
	port: 3000,
	defaultHfTokenSet: false,
	externalApiMode: false,
	stdioClient: null,
};

describe('Jobs progress wiring', () => {
	beforeEach(() => {
		mocks.executeJobs.mockImplementation(
			async (
				_params: unknown,
				options?: { onProgress?: (progress: { progress?: number; message?: string }) => void | Promise<void> }
			) => {
				await options?.onProgress?.({ progress: 0, message: 'Submitting job.' });
				await options?.onProgress?.({ message: 'job: running' });
				return {
					formatted: 'Job completed.',
					totalResults: 1,
					resultsShared: 1,
				};
			}
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('relays HfJobsTool progress through the registered MCP handler', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(new WebServer(), apiClient);
		const { server } = await factory({
			authorization: 'Bearer test-token',
			'x-mcp-bouquet': 'jobs',
		});
		const client = new Client({ name: 'jobs-progress-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const progress: Array<{ progress: number; message?: string }> = [];

		try {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('hf_jobs');
			const result = await client.callTool(
				{
					name: 'hf_jobs',
					arguments: { operation: 'logs', args: { job_id: 'job-123' } },
				},
				{
					onprogress: (update) => {
						progress.push(update);
					},
				}
			);

			expect(result.content).toEqual([{ type: 'text', text: 'Job completed.' }]);
			expect(progress).toEqual([
				expect.objectContaining({ progress: 0, message: 'Submitting job.' }),
				expect.objectContaining({ progress: 1, message: 'job: running' }),
			]);
			expect(mocks.executeJobs).toHaveBeenCalledOnce();
		} finally {
			await client.close();
			await server.close();
		}
	});
});
