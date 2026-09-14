import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createServerFactory } from '../../src/server/mcp-server.js';
import { McpApiClient } from '../../src/server/utils/mcp-api-client.js';
import type { TransportInfo } from '../../src/shared/transport-info.js';

const mocks = vi.hoisted(() => ({
	executeJobs: vi.fn(),
}));

vi.mock('@llmindset/hf-mcp', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@llmindset/hf-mcp')>();

	return {
		...actual,
		HF_JOBS_TOOL_CONFIG: {
			...actual.HF_JOBS_TOOL_CONFIG,
			outputSchema: z.object({
				operation: z.literal('logs').optional(),
				outcome: z.object({
					kind: z.literal('logs'),
					job_id: z.string(),
					lines: z.array(z.string()),
					finished: z.boolean(),
					truncated: z.boolean(),
				}),
				total_results: z.number().int().nonnegative(),
				results_shared: z.number().int().nonnegative(),
			}),
		},
		HfJobsTool: class {
			execute = mocks.executeJobs;
		},
	};
});

vi.mock('../../src/server/utils/hf-whoami-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/server/utils/hf-whoami-client.js')>();
	return {
		...actual,
		fetchHfWhoami: vi.fn().mockResolvedValue({
			id: 'user-id',
			type: 'user',
			name: 'alice',
			orgs: [],
			auth: { type: 'access_token' },
		}),
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
					structuredContent: {
						operation: 'logs',
						outcome: {
							kind: 'logs',
							job_id: 'job-123',
							lines: ['Job completed.'],
							finished: true,
							truncated: false,
						},
						total_results: 1,
						results_shared: 1,
					},
				};
			}
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('relays HfJobsTool progress through the registered MCP handler', async () => {
		const apiClient = new McpApiClient({ type: 'static' }, transportInfo);
		const factory = createServerFactory(apiClient);
		const { server } = await factory({
			authorization: 'Bearer test-token',
			'x-mcp-bouquet': 'jobs',
		});
		const client = new Client({ name: 'jobs-progress-test', version: '1.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const progress: Array<{ progress: number; message?: string }> = [];

		try {
			const advertisedTool = (await client.listTools()).tools.find((tool) => tool.name === 'hf_jobs');
			expect(advertisedTool?.outputSchema).toMatchObject({
				type: 'object',
				properties: {
					outcome: expect.any(Object),
					total_results: { type: 'integer', minimum: 0 },
					results_shared: { type: 'integer', minimum: 0 },
				},
				required: ['outcome', 'total_results', 'results_shared'],
			});
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
			expect(result.structuredContent).toEqual({
				operation: 'logs',
				outcome: {
					kind: 'logs',
					job_id: 'job-123',
					lines: ['Job completed.'],
					finished: true,
					truncated: false,
				},
				total_results: 1,
				results_shared: 1,
			});
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
