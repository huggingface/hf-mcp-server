/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatelessHttpTransport } from '../../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import express from 'express';

describe('StatelessHttpTransport', () => {
	let transport: StatelessHttpTransport;
	const originalAnalyticsMode = process.env.ANALYTICS_MODE;

	beforeEach(() => {
		if (originalAnalyticsMode === undefined) {
			delete process.env.ANALYTICS_MODE;
		} else {
			process.env.ANALYTICS_MODE = originalAnalyticsMode;
		}
		// Create a minimal instance for testing private methods
		const mockServerFactory = vi.fn() as unknown as ServerFactory;
		const mockApp = express();
		transport = new StatelessHttpTransport(mockServerFactory, mockApp);
	});

	afterEach(() => {
		if (originalAnalyticsMode === undefined) {
			delete process.env.ANALYTICS_MODE;
		} else {
			process.env.ANALYTICS_MODE = originalAnalyticsMode;
		}
	});

	describe('shouldHandle', () => {
		it('should handle tools/list requests', () => {
			const result = (transport as any).shouldHandle({ method: 'tools/list' });
			expect(result).toBe(true);
		});

		it('should handle tools/call requests', () => {
			const result = (transport as any).shouldHandle({ method: 'tools/call' });
			expect(result).toBe(true);
		});

		it('should handle initialize requests', () => {
			const result = (transport as any).shouldHandle({ method: 'initialize' });
			expect(result).toBe(true);
		});

		it('should not handle ping requests', () => {
			const result = (transport as any).shouldHandle({ method: 'ping' });
			expect(result).toBe(false);
		});

		it('should handle prompts/list requests', () => {
			const result = (transport as any).shouldHandle({ method: 'prompts/list' });
			expect(result).toBe(true);
		});

		it('should handle prompts/get requests', () => {
			const result = (transport as any).shouldHandle({ method: 'prompts/get' });
			expect(result).toBe(true);
		});

		it('should handle resources/list requests for non-openai-mcp clients', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/list' });
			expect(result).toBe(true);
		});

		it('should handle resources/list requests for openai-mcp client', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/list' }, 'openai-mcp');
			expect(result).toBe(true);
		});

		it('should handle resources/read requests for non-openai-mcp clients', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/read' });
			expect(result).toBe(true);
		});

		it('should handle resources/read requests for openai-mcp client', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/read' }, 'openai-mcp');
			expect(result).toBe(true);
		});

		it('should handle resources/templates/list requests for non-openai-mcp clients', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/templates/list' });
			expect(result).toBe(true);
		});

		it('should handle resources/templates/list requests for openai-mcp client', () => {
			const result = (transport as any).shouldHandle({ method: 'resources/templates/list' }, 'openai-mcp');
			expect(result).toBe(true);
		});

		it('should handle undefined method gracefully', () => {
			const result = (transport as any).shouldHandle({});
			expect(result).toBe(false);
		});

		it('should handle undefined body gracefully', () => {
			const result = (transport as any).shouldHandle(undefined);
			expect(result).toBe(false);
		});

		it('should handle null body gracefully', () => {
			const result = (transport as any).shouldHandle(null);
			expect(result).toBe(false);
		});
	});

	describe('skipGradioSetup', () => {
		it('should not skip setup for gradio_files calls because it is registered by the Gradio proxy layer', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'gradio_files' },
			});

			expect(result).toBe(false);
		});

		it('should not skip setup for Gradio endpoint tool calls', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'gr1_predict' },
			});

			expect(result).toBe(false);
		});

		it('should not skip setup for dynamic_space invoke calls that need streaming/progress handling', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'dynamic_space', arguments: { operation: 'invoke' } },
			});

			expect(result).toBe(false);
		});

		it('should skip setup for normal local tool calls', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'hf_model_search' },
			});

			expect(result).toBe(true);
		});
	});

	describe('unsupported resource subscriptions', () => {
		it('includes resource URIs in tracked method names', () => {
			expect(
				(transport as any).extractMethodForTracking({
					method: 'resources/read',
					params: { uri: 'skill://example/SKILL.md' },
				})
			).toBe('resources/read:skill://example/SKILL.md');

			expect(
				(transport as any).extractMethodForTracking({
					method: 'resources/subscribe',
					params: { uri: 'skill://example/SKILL.md' },
				})
			).toBe('resources/subscribe:skill://example/SKILL.md');

			expect(
				(transport as any).extractMethodForTracking({
					method: 'resources/unsubscribe',
					params: { uri: 'skill://example/SKILL.md' },
				})
			).toBe('resources/unsubscribe:skill://example/SKILL.md');
		});

		it('attributes early resources/subscribe rejections to known analytics session client info', async () => {
			process.env.ANALYTICS_MODE = 'true';
			const mockServerFactory = vi.fn() as unknown as ServerFactory;
			transport = new StatelessHttpTransport(mockServerFactory, express());

			const sessionId = 'session-1';
			const clientInfo = { name: 'cursor-vscode', version: '1.2.3' };
			(transport as any).createAnalyticsSession(sessionId, false, '127.0.0.1');
			(transport as any).updateAnalyticsSessionClientInfo(sessionId, clientInfo);

			const req = {
				headers: { 'mcp-session-id': sessionId },
				query: {},
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'resources/subscribe',
					params: { uri: 'skill://example/SKILL.md' },
				},
				ip: '127.0.0.1',
			};
			const res = {
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis(),
			};

			await (transport as any).handleJsonRpcRequest(req, res);

			const methodMetrics = transport.getMetrics().methods.get('resources/subscribe:skill://example/SKILL.md');
			expect(methodMetrics?.count).toBe(1);
			expect(methodMetrics?.byClient.get(clientInfo.name)?.count).toBe(1);
			expect(mockServerFactory).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(200);
		});
	});
});
