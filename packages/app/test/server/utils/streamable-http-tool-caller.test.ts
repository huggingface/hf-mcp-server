import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	request: vi.fn(),
	close: vi.fn(),
	transport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', () => ({
	Client: class {
		connect = mocks.connect;
		request = mocks.request;
		close = mocks.close;
	},
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.transport(url, options);
		}
	},
}));

vi.mock('@llmindset/hf-mcp/network', () => ({
	NETWORK_FETCH_PROFILES: {
		streamableProxy: () => ({ urlPolicy: {} }),
	},
	parseAndValidateUrl: (url: string) => new URL(url),
	fetchWithProfile: vi.fn(),
}));

vi.mock('../../../src/server/utils/logger.js', () => ({
	logger: {
		trace: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import {
	callStreamableHttpTool,
	readStreamableHttpResource,
} from '../../../src/server/utils/streamable-http-tool-caller.js';

describe('callStreamableHttpTool', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.request.mockResolvedValue({ content: [], isError: false });
	});

	it('requests upstream progress and resets the timeout when progress arrives', async () => {
		const onProgress = vi.fn().mockResolvedValue(undefined);
		await callStreamableHttpTool('https://example.com/mcp', 'csv_tool', {}, undefined, onProgress);

		expect(mocks.request).toHaveBeenCalledWith(
			{
				method: 'tools/call',
				params: {
					name: 'csv_tool',
					arguments: {},
				},
			},
			expect.objectContaining({
				onprogress: expect.any(Function),
				resetTimeoutOnProgress: true,
			})
		);
		const requestOptions = mocks.request.mock.calls[0]?.[1] as {
			onprogress: (progress: { progress: number; total?: number; message?: string }) => void;
		};
		const progress = { progress: 1, total: 2, message: 'Halfway' };
		requestOptions.onprogress(progress);
		await Promise.resolve();
		expect(onProgress).toHaveBeenCalledWith(progress);
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});

describe('readStreamableHttpResource', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.request.mockResolvedValue({
			contents: [{ uri: 'ui://upstream/app.html', mimeType: 'text/html', text: '<main>App</main>' }],
		});
	});

	it('forwards the upstream resource URI and closes the client', async () => {
		const result = await readStreamableHttpResource(
			'https://example.com/mcp',
			'ui://upstream/app.html',
			'hf_test_token'
		);

		expect(mocks.request).toHaveBeenCalledWith({
			method: 'resources/read',
			params: { uri: 'ui://upstream/app.html' },
		});
		expect(result.contents[0]?.text).toBe('<main>App</main>');
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});

describe('upstream credential headers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('HF_TOKEN', 'hf_dummy_environment_token');
		vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_dummy_default_token');
		vi.stubEnv('PROXY_TOKEN', 'hf_dummy_startup_token');
		vi.stubEnv('LOGGING_HF_TOKEN', 'hf_dummy_logging_token');
		mocks.request.mockResolvedValue({ content: [], contents: [] });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const operation of ['tool', 'resource'] as const) {
		it.each([undefined, 'hf_dummy_caller_token'])(
			`${operation} sends only an explicitly supplied credential, with token=%s`,
			async (token) => {
				if (operation === 'tool') {
					await callStreamableHttpTool('https://example.com/mcp', 'ask', {}, token);
				} else {
					await readStreamableHttpResource('https://example.com/mcp', 'ui://upstream/app.html', token);
				}

				expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(
					new URL('https://example.com/mcp'),
					expect.objectContaining({
						requestInit: token
							? { headers: { Authorization: `Bearer ${token}`, 'X-HF-Authorization': `Bearer ${token}` } }
							: undefined,
					})
				);
			}
		);
	}
});
