import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	request: vi.fn(),
	close: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', () => ({
	Client: class {
		connect = mocks.connect;
		request = mocks.request;
		close = mocks.close;
	},
	StreamableHTTPClientTransport: class {},
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

		expect(mocks.request).toHaveBeenCalledWith(
			{
				method: 'resources/read',
				params: { uri: 'ui://upstream/app.html' },
			}
		);
		expect(result.contents[0]?.text).toBe('<main>App</main>');
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});
