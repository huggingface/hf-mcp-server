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
	Protocol: class {},
}));

vi.mock('../src/logger.js', () => ({
	logger: {
		trace: vi.fn(),
	},
}));

vi.mock('../src/network/fetch-profile.js', () => ({
	NETWORK_FETCH_PROFILES: {
		gradioMcpHost: () => ({}),
	},
	fetchWithProfile: vi.fn(),
}));

vi.mock('../src/network/url-policy.js', () => ({
	createGradioMcpPolicy: () => ({}),
	parseAndValidateUrl: (url: string) => new URL(url),
}));

import { callGradioToolWithHeaders } from '../src/space/utils/gradio-caller.js';

describe('callGradioToolWithHeaders progress handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.GRADIO_SKIP_INITIALIZE;
		mocks.request.mockResolvedValue({ content: [], isError: false });
	});

	it('requests upstream progress and resets the timeout when progress arrives', async () => {
		const onProgress = vi.fn().mockResolvedValue(undefined);
		await callGradioToolWithHeaders('https://example.hf.space/gradio_api/mcp/', 'predict', {}, undefined, {
			onProgress,
		});

		expect(mocks.request).toHaveBeenCalledWith(
			{
				method: 'tools/call',
				params: {
					name: 'predict',
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
