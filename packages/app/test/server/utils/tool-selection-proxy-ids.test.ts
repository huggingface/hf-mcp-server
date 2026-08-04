import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpApiClient } from '../../../src/server/utils/mcp-api-client.js';
import { ToolSelectionStrategy } from '../../../src/server/utils/tool-selection-strategy.js';

vi.mock('../../../src/server/utils/proxy-tools-config.js', () => ({
	getProxyToolsConfig: () => [
		{
			proxyId: 'multi_tool_proxy',
			toolName: 'proxy_tool_one',
			upstreamToolName: 'upstream_one',
			url: 'https://proxy.example/mcp',
		},
		{
			proxyId: 'multi_tool_proxy',
			toolName: 'proxy_tool_two',
			upstreamToolName: 'upstream_two',
			url: 'https://proxy.example/mcp',
		},
	],
}));

describe('ToolSelectionStrategy proxy source IDs', () => {
	let strategy: ToolSelectionStrategy;

	beforeEach(() => {
		strategy = new ToolSelectionStrategy(new McpApiClient({ type: 'static' }));
	});

	it('preserves a multi-tool proxy source ID returned by external settings', async () => {
		const result = await strategy.selectTools({
			headers: {},
			hfToken: 'hf_test_token',
			userSettings: {
				builtInTools: ['multi_tool_proxy'],
				spaceTools: [],
			},
		});

		expect(result.enabledToolIds).toContain('multi_tool_proxy');
	});
});
