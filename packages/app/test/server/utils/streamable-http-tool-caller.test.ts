import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client';

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	request: vi.fn(),
	close: vi.fn(),
	transportOptions: undefined as StreamableHTTPClientTransportOptions | undefined,
}));

vi.mock('@modelcontextprotocol/client', () => ({
	Client: class {
		connect = mocks.connect;
		request = mocks.request;
		close = mocks.close;
	},
	StreamableHTTPClientTransport: class {
		constructor(_url: URL, options?: StreamableHTTPClientTransportOptions) {
			mocks.transportOptions = options;
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
		mocks.transportOptions = undefined;
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
		mocks.transportOptions = undefined;
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

describe('streamable proxy auth headers', () => {
	const SPACE_URL = 'https://someone-some-space.hf.space/gradio_api/mcp/';
	const EXTERNAL_URL = 'https://example.com/mcp';

	function sentHeaders(): Record<string, string> {
		return (mocks.transportOptions?.requestInit?.headers ?? {}) as Record<string, string>;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.transportOptions = undefined;
		mocks.request.mockResolvedValue({ content: [], contents: [], isError: false });
	});

	it('does not send the Hub token in Authorization to a Space', async () => {
		await readStreamableHttpResource(SPACE_URL, 'ui://upstream/app.html', 'hf_test_token');

		expect(sentHeaders()['X-HF-Authorization']).toBe('Bearer hf_test_token');
		expect(sentHeaders().Authorization).toBeUndefined();
	});

	it('applies the same rule on the tool-call path to a Space', async () => {
		await callStreamableHttpTool(SPACE_URL, 'predict', {}, 'hf_test_token');

		expect(sentHeaders().Authorization).toBeUndefined();
	});

	it('still sends Authorization to a non-Space upstream', async () => {
		await callStreamableHttpTool(EXTERNAL_URL, 'predict', {}, 'hf_test_token');

		expect(sentHeaders()['X-HF-Authorization']).toBe('Bearer hf_test_token');
		expect(sentHeaders().Authorization).toBe('Bearer hf_test_token');
	});

	it('sends no auth headers when there is no token', async () => {
		await readStreamableHttpResource(SPACE_URL, 'ui://upstream/app.html', undefined);

		expect(mocks.transportOptions?.requestInit).toBeUndefined();
	});
});
