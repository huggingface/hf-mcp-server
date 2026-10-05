/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	MAX_METRICS_RESPONSE_CAPTURE_BYTES,
	MetricsResponseCapture,
	observeMetricsResponses,
	StatelessHttpTransport,
	classifyServerDiscoverOutcome,
	classifySkillRequest,
	summarizeSubscriptionRequest,
} from '../../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { formatMetricsForAPI } from '../../../src/shared/transport-metrics.js';
import express from 'express';
import { createProgressRelay } from '../../../src/server/utils/progress-relay.js';
import { z } from 'zod';
import * as hfWhoamiClient from '../../../src/server/utils/hf-whoami-client.js';
import * as skillCatalogCache from '../../../src/server/skills/skill-catalog-cache.js';
import type { SkillCatalog, SkillEntry } from '../../../src/server/skills/skill-types.js';

describe('MetricsResponseCapture', () => {
	it('detects JSON-RPC and tool errors in bounded responses', () => {
		const rpcError = new MetricsResponseCapture();
		rpcError.add('{"jsonrpc":"2.0","id":1,');
		rpcError.add('"error":{"code":-32603,"message":"failed"}}');
		expect(rpcError.isError()).toBe(true);
		expect(rpcError.summary()).toEqual({ isError: true, jsonRpcErrorCode: -32603 });

		const toolError = new MetricsResponseCapture();
		toolError.add(
			Buffer.from(
				'{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"contains data: text"}],"isError":true}}'
			)
		);
		expect(toolError.isError()).toBe(true);

		const sseToolError = new MetricsResponseCapture();
		sseToolError.add(
			'event: message\n' +
				'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"token","progress":1}}\n\n' +
				'event: message\n' +
				'data: {"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":true}}\n\n'
		);
		expect(sseToolError.isError()).toBe(true);
	});

	it('does not concatenate or parse responses larger than the capture limit', () => {
		const capture = new MetricsResponseCapture();
		capture.add(Buffer.alloc(MAX_METRICS_RESPONSE_CAPTURE_BYTES + 1, 'x'));
		const concatSpy = vi.spyOn(Buffer, 'concat');

		expect(capture.isError()).toBeUndefined();
		expect(capture.summary()).toEqual({ isError: undefined, truncated: true });
		expect(concatSpy).not.toHaveBeenCalled();

		concatSpy.mockRestore();
	});

	it.each(['image', 'text', 'rpc'] as const)('observes oversized %s responses before serialization', async (kind) => {
		for (const isError of [false, true]) {
			const capture = new MetricsResponseCapture();
			const server = new McpServer({ name: 'capture-test', version: '1' });
			const wire = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			const originalSend = vi.spyOn(wire, 'send').mockResolvedValue();
			observeMetricsResponses(server, capture);
			await server.connect(wire);
			const content = 'A'.repeat(MAX_METRICS_RESPONSE_CAPTURE_BYTES + 4);
			const message =
				kind === 'rpc' && isError
					? { jsonrpc: '2.0' as const, id: 1, error: { code: -32603, message: content } }
					: {
							jsonrpc: '2.0' as const,
							id: 1,
							result: {
								content: [
									kind === 'image'
										? { type: 'image', mimeType: 'image/webp', data: content }
										: { type: 'text', text: content },
								],
								isError,
							},
						};
			await wire.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
			await wire.send(message);
			capture.add(JSON.stringify(message));
			expect(capture.summary()).toEqual({
				isError,
				...(kind === 'rpc' && isError ? { jsonRpcErrorCode: -32603 } : {}),
			});
			expect(originalSend).toHaveBeenCalledWith(message);
			await server.close();
		}
	});

	it('extracts negotiation error codes from JSON, SSE, and batch responses', () => {
		const json = new MetricsResponseCapture();
		json.add('{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"mismatch"}}');
		expect(json.summary()).toEqual({ isError: true, jsonRpcErrorCode: -32020 });

		const sse = new MetricsResponseCapture();
		sse.add('event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32022}}\n\n');
		expect(sse.summary()).toEqual({ isError: true, jsonRpcErrorCode: -32022 });

		const multilineSse = new MetricsResponseCapture();
		multilineSse.add(
			'event: message\n' + 'data: {"jsonrpc":"2.0","id":1,\n' + 'data: "error":{"code":-32603,"message":"failed"}}\n\n'
		);
		expect(multilineSse.summary()).toEqual({ isError: true, jsonRpcErrorCode: -32603 });

		const batch = new MetricsResponseCapture();
		batch.add('[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"error":{"code":-32600}}]');
		expect(batch.summary()).toEqual({ isError: true, jsonRpcErrorCode: -32600 });
	});

	it('counts only aggregate Skills response items', () => {
		const list = new MetricsResponseCapture();
		list.add(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: {
					skills: [
						{ uri: 'skill://private/one/SKILL.md', frontmatter: { description: 'private' } },
						{ uri: 'skill://private/two/SKILL.md', frontmatter: { description: 'private' } },
					],
				},
			})
		);
		expect(list.summary()).toEqual({ isError: false, responseItemCount: 2 });

		const get = new MetricsResponseCapture();
		get.add(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { skill: { uri: 'skill://private/one/SKILL.md', content: 'private' } },
			})
		);
		expect(get.summary()).toEqual({ isError: false, responseItemCount: 1 });
	});
});

describe('classifyServerDiscoverOutcome', () => {
	it.each([
		[200, { isError: false }, 'success'],
		[400, { isError: true, jsonRpcErrorCode: -32020 }, 'headerBodyMismatch'],
		[400, { isError: true, jsonRpcErrorCode: -32022 }, 'unsupportedVersion'],
		[400, { isError: true, jsonRpcErrorCode: -32600 }, 'invalidRequest'],
		[400, { isError: false }, 'invalidRequest'],
		[401, { isError: false }, 'authRejected'],
		[403, { isError: true, jsonRpcErrorCode: -32603 }, 'authRejected'],
		[500, { isError: false }, 'internalServerError'],
		[500, { isError: true, jsonRpcErrorCode: -32020 }, 'internalServerError'],
		[200, { isError: true, jsonRpcErrorCode: -32603 }, 'internalServerError'],
		[200, { isError: false, truncated: true }, 'otherError'],
		[200, { isError: true, jsonRpcErrorCode: -32099 }, 'otherError'],
		[429, { isError: false }, 'otherError'],
	] as const)('classifies HTTP %i with %o as %s', (httpStatus, response, expected) => {
		expect(classifyServerDiscoverOutcome({ httpStatus, response })).toBe(expected);
	});
});

describe('StatelessHttpTransport', () => {
	let transport: StatelessHttpTransport;
	const originalAnalyticsMode = process.env.ANALYTICS_MODE;
	const originalDisableTools = process.env.DISABLE_TOOLS;

	beforeEach(() => {
		if (originalAnalyticsMode === undefined) {
			delete process.env.ANALYTICS_MODE;
		} else {
			process.env.ANALYTICS_MODE = originalAnalyticsMode;
		}
		if (originalDisableTools === undefined) {
			delete process.env.DISABLE_TOOLS;
		} else {
			process.env.DISABLE_TOOLS = originalDisableTools;
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
		if (originalDisableTools === undefined) {
			delete process.env.DISABLE_TOOLS;
		} else {
			process.env.DISABLE_TOOLS = originalDisableTools;
		}
	});

	describe('legacy static Skills HTTP validation', () => {
		const uri = 'skill://test/example/SKILL.md';
		const directory = 'skill://test/example';
		let app: ReturnType<typeof express>;
		let httpServer: ReturnType<typeof app.listen>;
		let url: string;
		let factory: ReturnType<typeof vi.fn>;
		let catalogSpy: ReturnType<typeof vi.spyOn>;
		const headers: Record<string, string> = {
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json',
			'mcp-protocol-version': '2025-03-26',
		};

		beforeEach(async () => {
			vi.stubEnv('ANALYTICS_MODE', 'false');
			const entry: SkillEntry = {
				uri,
				skillPath: 'test/example',
				frontmatter: { name: 'example' },
				resources: [{ uri, digest: 'digest', size: 13 }],
			};
			catalogSpy = vi.spyOn(skillCatalogCache, 'getSkillCatalog').mockResolvedValue({
				manifestPath: '/test/skills.json',
				loadedAt: Date.now(),
				entries: [entry],
				entriesByUri: new Map([[uri, entry]]),
				resourcesByUri: new Map([
					[
						uri,
						{
							uri,
							bytes: Buffer.from('skill content'),
							mimeType: 'text/markdown',
							isText: true,
							name: 'example',
							digest: 'digest',
						},
					],
				]),
				directories: new Map([[directory, [{ uri, name: 'example', mimeType: 'text/markdown' }]]]),
			});
			app = express();
			// Exercise parsedBody even with a non-JSON Content-Type: the SDK must
			// still reject it, independently of the host's body parser policy.
			app.use(express.json({ type: () => true }));
			factory = vi.fn(async () => ({
				server: new McpServer({ name: 'fallback', version: '1.0.0' }),
				enabledToolIds: [],
			}));
			transport = new StatelessHttpTransport(factory, app);
			await transport.initialize();
			app.post('/sdk', async (req, res) => {
				const sdk = new NodeStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				try {
					await sdk.handleRequest(req, res, req.body);
				} finally {
					await sdk.close();
				}
			});
			httpServer = app.listen(0);
			await new Promise<void>((resolve, reject) => {
				httpServer.once('listening', resolve);
				httpServer.once('error', reject);
			});
			const address = httpServer.address();
			if (!address || typeof address === 'string') throw new Error('Expected TCP port');
			url = `http://127.0.0.1:${address.port}`;
		});

		afterEach(async () => {
			await transport.cleanup();
			await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
			catalogSpy.mockRestore();
			vi.unstubAllEnvs();
		});

		describe.each(['resources/read', 'resources/directory/read'])('%s', (method) => {
			const body = () => ({
				jsonrpc: '2.0',
				id: 1,
				method,
				params: { uri: method === 'resources/read' ? uri : directory },
			});

			it.each([
				['unsupported version', { 'mcp-protocol-version': '1900-01-01' }, {}, 400],
				['empty version', { 'mcp-protocol-version': '' }, {}, 400],
				['JSON-only Accept', { accept: 'application/json' }, {}, 406],
				['SSE-only Accept', { accept: 'text/event-stream' }, {}, 406],
				['wildcard Accept', { accept: '*/*' }, {}, 406],
				['wrong content type', { 'content-type': 'text/plain' }, {}, 415],
				['invalid jsonrpc', {}, { jsonrpc: '1.0' }, 400],
				['missing jsonrpc', {}, { jsonrpc: undefined }, 400],
				['null id', {}, { id: null }, 400],
				['object id', {}, { id: {} }, 400],
				['invalid params', {}, { params: [] }, 400],
				['invalid metadata', {}, { params: { uri, _meta: 'invalid' } }, 400],
				['validation ordering', { accept: '*/*', 'content-type': 'text/plain' }, {}, 406],
			])('defers %s to SDK validation', async (_name, overrides, bodyOverrides, status) => {
				const init = {
					method: 'POST',
					headers: { ...headers, ...overrides } as Record<string, string>,
					body: JSON.stringify({ ...body(), ...bodyOverrides }),
				};
				const actual = await fetch(`${url}/mcp`, init);
				const sdk = await fetch(`${url}/sdk`, init);
				expect(actual.status).toBe(status);
				expect(actual.status).toBe(sdk.status);
				const actualBody = await actual.json();
				const sdkBody = await sdk.json();
				if (Object.keys(bodyOverrides).length === 0) {
					expect(actualBody).toEqual(sdkBody);
				} else {
					// The public SDK era classifier rejects malformed envelopes before
					// the legacy transport, using Invalid Request rather than Parse Error.
					expect(actualBody).toMatchObject({
						jsonrpc: '2.0',
						id: 'id' in bodyOverrides ? null : 1,
						error: { code: -32600, message: expect.any(String) },
					});
					expect(actualBody.error.code).toBeLessThan(0);
				}
				expect(catalogSpy).not.toHaveBeenCalled();
			});

			it.each([
				['explicit version', '2025-03-26', 'application/json', 0],
				['implicit version', undefined, 'application/json; charset=utf-8', 'request-1'],
				['older version', '2024-11-05', 'Application/JSON; charset=utf-8', 2],
			])('retains fast path with %s', async (_name, version, contentType, id) => {
				const requestHeaders = { ...headers, 'content-type': contentType };
				if (version === undefined) delete requestHeaders['mcp-protocol-version'];
				else requestHeaders['mcp-protocol-version'] = version;
				const response = await fetch(`${url}/mcp`, {
					method: 'POST',
					headers: requestHeaders,
					body: JSON.stringify({ ...body(), id }),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					jsonrpc: '2.0',
					id,
					result:
						method === 'resources/read' ? { contents: [{ uri, text: 'skill content' }] } : { resources: [{ uri }] },
				});
				expect(factory).not.toHaveBeenCalled();
				expect(catalogSpy).toHaveBeenCalledOnce();
			});
		});
	});

	describe('strict token mode whoami failures', () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		});

		describe.each([
			['modern', '2026-07-28'],
			['legacy', '2025-03-26'],
		])('%s HTTP path', (_era, protocolVersion) => {
			it.each([
				['upstream HTTP failure', new hfWhoamiClient.HfWhoamiRequestError('http', 500)],
				['invalid response', new hfWhoamiClient.HfWhoamiRequestError('invalid_response')],
				['network failure', new TypeError('fetch failed')],
				['timeout', new DOMException('Request timed out', 'TimeoutError')],
			])('returns 503 without an auth challenge or building a server on %s', async (_failure, error) => {
				vi.stubEnv('MCP_STRICT_TOKEN', 'true');
				const whoamiSpy = vi.spyOn(hfWhoamiClient, 'fetchHfWhoami').mockRejectedValue(error);
				const serverFactory = vi.fn<ServerFactory>();
				const app = express();
				app.use(express.json());
				transport = new StatelessHttpTransport(serverFactory, app);
				await transport.initialize();

				const httpServer = app.listen(0);
				try {
					await new Promise<void>((resolve, reject) => {
						httpServer.once('listening', resolve);
						httpServer.once('error', reject);
					});
					const address = httpServer.address();
					if (!address || typeof address === 'string') {
						throw new Error('Expected the test server to listen on a TCP port');
					}

					const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
						method: 'POST',
						headers: {
							accept: 'application/json, text/event-stream',
							'content-type': 'application/json',
							'mcp-protocol-version': protocolVersion,
							authorization: 'Bearer hf_strict_whoami_failure',
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 1,
							method: 'tools/list',
							params: { _meta: { 'io.modelcontextprotocol/protocolVersion': protocolVersion } },
						}),
					});
					const body = await response.text();
					expect(whoamiSpy).toHaveBeenCalledExactlyOnceWith('hf_strict_whoami_failure');
					expect(serverFactory).not.toHaveBeenCalled();
					expect(response.status).toBe(503);
					expect(response.headers.get('www-authenticate')).toBeNull();
					expect(body).toBe('Service Unavailable');
				} finally {
					await new Promise<void>((resolve, reject) => {
						httpServer.close((error) => (error ? reject(error) : resolve()));
					});
					await transport.cleanup();
				}
			});
		});
	});

	describe('requestsProgress', () => {
		it.each(['progress-token', 42])('accepts valid progress token %j', (progressToken) => {
			expect(
				(transport as any).requestsProgress({
					method: 'tools/call',
					params: { _meta: { progressToken } },
				})
			).toBe(true);
		});

		it.each([undefined, null, true, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, []])(
			'rejects missing or invalid progress token %j',
			(progressToken) => {
				expect(
					(transport as any).requestsProgress({
						method: 'tools/call',
						params: { _meta: { progressToken } },
					})
				).toBe(false);
			}
		);

		it('only enables progress streaming for tool calls', () => {
			expect(
				(transport as any).requestsProgress({
					method: 'resources/read',
					params: { _meta: { progressToken: 'progress-token' } },
				})
			).toBe(false);
		});
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

		it('should reject prompts/list through the stub responder', () => {
			const result = (transport as any).shouldHandle({ method: 'prompts/list' });
			expect(result).toBe(false);
		});

		it('should reject prompts/get through the stub responder', () => {
			const result = (transport as any).shouldHandle({ method: 'prompts/get' });
			expect(result).toBe(false);
		});

		it('should retain prompt attempt names for metrics', () => {
			expect((transport as any).extractMethodForTracking({ method: 'prompts/list' })).toBe('prompts/list');
			expect(
				(transport as any).extractMethodForTracking({
					method: 'prompts/get',
					params: { name: 'Retired Prompt' },
				})
			).toBe('prompts/get:Retired Prompt');
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

		it.each(['skills/list', 'skills/get'])('should route %s through the full server', (method) => {
			expect((transport as any).shouldHandle({ method })).toBe(true);
		});

		it.each(['skills/list', 'skills/get'])('should deny %s for blocked clients', (method) => {
			expect((transport as any).shouldHandle({ method }, 'cursor-vscode')).toBe(false);
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

	describe('Skills event logging', () => {
		it.each([
			[
				{ method: 'skills/list', params: {} },
				{ methodName: 'skills/list', cursorSupplied: false },
			],
			[
				{ method: 'skills/list', params: { cursor: '' } },
				{ methodName: 'skills/list', cursorSupplied: true },
			],
			[
				{ method: 'skills/get', params: { uri: 'skill://private/SKILL.md' } },
				{ methodName: 'skills/get', cursorSupplied: false, targetUri: 'skill://private/SKILL.md' },
			],
			[
				{ method: 'resources/read', params: { uri: 'skill://private/SKILL.md' } },
				{
					methodName: 'skills/resource-read',
					cursorSupplied: false,
					targetUri: 'skill://private/SKILL.md',
				},
			],
			[
				{ method: 'resources/directory/read', params: { uri: 'skill://private', cursor: '1' } },
				{ methodName: 'skills/directory-read', cursorSupplied: true, targetUri: 'skill://private' },
			],
		])('classifies privacy-sensitive request %j', (request, expected) => {
			expect(classifySkillRequest(request)).toEqual(expected);
		});

		it.each([
			{ method: 'resources/read', params: { uri: 'hf://models/private/repo' } },
			{ method: 'resources/directory/read', params: { uri: 'hf://models/private' } },
			{ method: 'resources/read', params: { uri: 42 } },
			{ method: 'tools/list' },
			null,
		])('does not classify non-Skills request %j', (request) => {
			expect(classifySkillRequest(request)).toBeNull();
		});

		it('records an allowlisted event and isolates logger failures', () => {
			const eventLogger = vi.fn();
			transport = new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express(), eventLogger);
			const request = {
				method: 'skills/get',
				params: { uri: 'skill://private-org/private-skill/SKILL.md' },
			};

			(transport as any).recordSkillEvent(
				request,
				Date.now() - 10,
				true,
				{
					requestId: 'request-1',
					protocolEra: 'modern',
					protocolVersion: '2026-07-28',
					isAuthenticated: true,
					clientInfo: { name: 'test-client', version: '1.0.0' },
				},
				1
			);

			expect(eventLogger).toHaveBeenCalledWith(
				'skills/get',
				expect.objectContaining({
					requestId: 'request-1',
					protocolEra: 'modern',
					protocolVersion: '2026-07-28',
					isAuthenticated: true,
					clientName: 'test-client',
					clientVersion: '1.0.0',
					success: true,
					cursorSupplied: false,
					targetUri: 'skill://private-org/private-skill/SKILL.md',
					responseItemCount: 1,
				})
			);
			expect(JSON.stringify(eventLogger.mock.calls[0])).toContain('skill://private-org/private-skill/SKILL.md');

			const failingLogger = vi.fn(() => {
				throw new Error('logger unavailable');
			});
			transport = new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express(), failingLogger);
			expect(() =>
				(transport as any).recordSkillEvent(request, Date.now(), false, {
					protocolEra: 'legacy',
					isAuthenticated: false,
				})
			).not.toThrow();
		});

		it('logs successful and failed legacy static resource reads exactly once', async () => {
			const privateUri = 'skill://private-org/private-skill/SKILL.md';
			const entry: SkillEntry = {
				uri: privateUri,
				skillPath: 'private-org/private-skill',
				frontmatter: { name: 'private-skill', description: 'PRIVATE_DESCRIPTION' },
				resources: [{ uri: privateUri, digest: 'digest', size: 21 }],
			};
			const catalog: SkillCatalog = {
				manifestPath: '/private/skills.json',
				loadedAt: Date.now(),
				entries: [entry],
				entriesByUri: new Map([[privateUri, entry]]),
				resourcesByUri: new Map([
					[
						privateUri,
						{
							uri: privateUri,
							bytes: Buffer.from('PRIVATE_SKILL_CONTENT'),
							mimeType: 'text/markdown',
							isText: true,
							name: 'private-skill',
							digest: 'digest',
						},
					],
				]),
				directories: new Map([
					[
						'skill://private-org/private-skill',
						[{ uri: privateUri, name: 'private-skill', mimeType: 'text/markdown' }],
					],
				]),
			};
			const catalogSpy = vi.spyOn(skillCatalogCache, 'getSkillCatalog').mockResolvedValue(catalog);
			const eventLogger = vi.fn();
			transport = new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express(), eventLogger);
			const makeResponse = () => ({
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis(),
			});
			const context = {
				clientSessionId: 'session-1',
				protocolEra: 'legacy' as const,
				protocolVersion: '2026-07-28',
				isAuthenticated: true,
				clientInfo: { name: 'skills-client', version: '1.0.0' },
			};

			try {
				const successRequest = { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: privateUri } };
				const successResponse = makeResponse();
				await expect(
					(transport as any).tryHandleStaticResourceRequest(
						{
							headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
							body: successRequest,
						},
						successResponse,
						successRequest,
						context.clientInfo,
						Date.now(),
						context
					)
				).resolves.toBe(true);

				const failedRequest = {
					jsonrpc: '2.0',
					id: 2,
					method: 'resources/read',
					params: { uri: 'skill://private-org/missing/SKILL.md' },
				};
				const failedResponse = makeResponse();
				await expect(
					(transport as any).tryHandleStaticResourceRequest(
						{
							headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
							body: failedRequest,
						},
						failedResponse,
						failedRequest,
						context.clientInfo,
						Date.now(),
						context
					)
				).resolves.toBe(true);

				const directoryRequest = {
					jsonrpc: '2.0',
					id: 3,
					method: 'resources/directory/read',
					params: { uri: 'skill://private-org/private-skill', cursor: '0' },
				};
				const directoryResponse = makeResponse();
				await expect(
					(transport as any).tryHandleStaticResourceRequest(
						{
							headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
							body: directoryRequest,
						},
						directoryResponse,
						directoryRequest,
						context.clientInfo,
						Date.now(),
						context
					)
				).resolves.toBe(true);

				expect(eventLogger).toHaveBeenCalledTimes(3);
				expect(eventLogger.mock.calls[0]).toEqual([
					'skills/resource-read',
					expect.objectContaining({ success: true, targetUri: privateUri, responseItemCount: 1 }),
				]);
				expect(eventLogger.mock.calls[1]).toEqual([
					'skills/resource-read',
					expect.objectContaining({
						success: false,
						targetUri: 'skill://private-org/missing/SKILL.md',
						responseItemCount: undefined,
					}),
				]);
				expect(eventLogger.mock.calls[2]).toEqual([
					'skills/directory-read',
					expect.objectContaining({
						success: true,
						cursorSupplied: true,
						targetUri: 'skill://private-org/private-skill',
						responseItemCount: 1,
					}),
				]);
				expect(JSON.stringify(eventLogger.mock.calls)).not.toContain('PRIVATE_');
			} finally {
				catalogSpy.mockRestore();
			}
		});
	});

	describe('skipGradioSetup', () => {
		it('should discover Gradio apps for resource requests', () => {
			expect((transport as any).skipGradioSetup({ method: 'resources/list' })).toBe(false);
			expect(
				(transport as any).skipGradioSetup({
					method: 'resources/read',
					params: { uri: 'ui://hf-mcp-proxy/gradio-space/app' },
				})
			).toBe(false);
		});

		it('should still skip setup for initialize', () => {
			expect((transport as any).skipGradioSetup({ method: 'initialize' })).toBe(true);
		});

		it('should not skip setup for Gradio endpoint tool calls', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'gr1_predict' },
			});

			expect(result).toBe(false);
		});

		it('should not skip setup for dynamic_space invoke calls', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'dynamic_space', arguments: { operation: 'invoke' } },
			});

			expect(result).toBe(false);
		});

		it('should skip setup for normal local tool calls', () => {
			const result = (transport as any).skipGradioSetup({
				method: 'tools/call',
				params: { name: 'hub_repo_search' },
			});

			expect(result).toBe(true);
		});
	});

	describe('unsupported resource subscriptions', () => {
		it('summarizes subscription request shapes without retaining resource URIs', () => {
			expect(summarizeSubscriptionRequest('resources/subscribe', { uri: 'skill://private/SKILL.md' })).toBe(
				'uri:present'
			);
			expect(summarizeSubscriptionRequest('resources/subscribe', {})).toBe('uri:missing');
			expect(
				summarizeSubscriptionRequest('subscriptions/listen', {
					notifications: {
						toolsListChanged: true,
						resourcesListChanged: false,
						resourceSubscriptions: ['skill://private/SKILL.md', 'skill://private/OTHER.md'],
						experimentalNotification: true,
					},
				})
			).toBe(
				'notifications:toolsListChanged:true,resourcesListChanged:false,resourceSubscriptions:2-10,unknownFields:present'
			);
			expect(summarizeSubscriptionRequest('subscriptions/listen', { notifications: {} })).toBe('notifications:empty');
			expect(summarizeSubscriptionRequest('subscriptions/listen', {})).toBe('notifications:missing');
		});

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
			expect(methodMetrics).toMatchObject({ count: 1, errors: 1 });
			expect(methodMetrics?.byClient.get(clientInfo.name)?.count).toBe(1);
			expect(Array.from(transport.getMetrics().subscriptionAttempts.values())).toContainEqual(
				expect.objectContaining({
					method: 'resources/subscribe',
					protocolEra: 'legacy',
					clientName: clientInfo.name,
					clientVersion: clientInfo.version,
					requestShape: 'uri:present',
					count: 1,
				})
			);
			expect(mockServerFactory).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(200);
		});
	});

	describe('production request path', () => {
		it('logs a modern skills/list probe exactly once without retaining its response', async () => {
			const app = express();
			app.use(express.json());
			const eventLogger = vi.fn();
			const serverFactory: ServerFactory = vi.fn(async () => {
				const server = new McpServer({ name: 'skills-logging-test', version: '1.0.0' });
				server.server.setRequestHandler(
					'skills/list',
					{ params: z.looseObject({ cursor: z.string().optional() }) },
					() => ({
						skills: [
							{ uri: 'skill://private/one/SKILL.md', frontmatter: { description: 'PRIVATE_ONE' } },
							{ uri: 'skill://private/two/SKILL.md', frontmatter: { description: 'PRIVATE_TWO' } },
						],
					})
				);
				return { server, enabledToolIds: [] };
			});
			transport = new StatelessHttpTransport(serverFactory, app, eventLogger);
			await transport.initialize();

			const httpServer = app.listen(0);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected the test server to listen on a TCP port');
				}

				const client = new Client(
					{ name: 'skills-client', version: '1.0.0' },
					{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
				);
				const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
				await client.connect(clientTransport);
				await client.request({ method: 'skills/list', params: {} }, z.looseObject({ skills: z.array(z.unknown()) }));

				expect(eventLogger).toHaveBeenCalledTimes(1);
				expect(eventLogger).toHaveBeenCalledWith(
					'skills/list',
					expect.objectContaining({
						protocolEra: 'modern',
						protocolVersion: '2026-07-28',
						clientName: 'skills-client',
						clientVersion: '1.0.0',
						success: true,
						cursorSupplied: false,
						responseItemCount: 2,
					})
				);
				const serializedEvent = JSON.stringify(eventLogger.mock.calls[0]);
				expect(serializedEvent).not.toContain('skill://');
				expect(serializedEvent).not.toContain('PRIVATE_');

				await client.close();
			} finally {
				await new Promise<void>((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
				await transport.cleanup();
			}
		});

		it('logs a legacy full-server skills/list probe exactly once', async () => {
			delete process.env.ANALYTICS_MODE;
			const app = express();
			app.use(express.json());
			const eventLogger = vi.fn();
			const serverFactory: ServerFactory = vi.fn(async () => {
				const server = new McpServer({ name: 'legacy-skills-logging-test', version: '1.0.0' });
				server.server.setRequestHandler(
					'skills/list',
					{ params: z.looseObject({ cursor: z.string().optional() }) },
					() => ({
						skills: [{ uri: 'skill://private/legacy/SKILL.md', frontmatter: { description: 'PRIVATE_LEGACY' } }],
					})
				);
				return { server, enabledToolIds: [] };
			});
			transport = new StatelessHttpTransport(serverFactory, app, eventLogger);
			await transport.initialize();

			const httpServer = app.listen(0);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected the test server to listen on a TCP port');
				}

				const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-protocol-version': '2025-03-26',
						'mcp-session-id': 'legacy-session-1',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'skills/list',
						params: {},
					}),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ result: { skills: [expect.any(Object)] } });

				expect(eventLogger).toHaveBeenCalledTimes(1);
				expect(eventLogger).toHaveBeenCalledWith(
					'skills/list',
					expect.objectContaining({
						protocolEra: 'legacy',
						protocolVersion: '2025-03-26',
						clientSessionId: 'legacy-session-1',
						success: true,
						cursorSupplied: false,
						responseItemCount: 1,
					})
				);
				const serializedEvent = JSON.stringify(eventLogger.mock.calls[0]);
				expect(serializedEvent).not.toContain('skill://');
				expect(serializedEvent).not.toContain('PRIVATE_');
			} finally {
				await new Promise<void>((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
				await transport.cleanup();
			}
		});

		it('rejects modern subscription listeners through the configured SDK limit', async () => {
			const app = express();
			app.use(express.json());
			const serverFactory: ServerFactory = vi.fn(async () => ({
				server: new McpServer({ name: 'modern-subscription-test', version: '1.0.0' }),
				enabledToolIds: [],
			}));
			transport = new StatelessHttpTransport(serverFactory, app);
			await transport.initialize();

			const httpServer = app.listen(0);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected the test server to listen on a TCP port');
				}

				const client = new Client(
					{ name: 'modern-subscription-test', version: '1.0.0' },
					{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
				);
				const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
				await client.connect(clientTransport);
				const factoryCallsBeforeListen = vi.mocked(serverFactory).mock.calls.length;

				await expect(client.listen({})).rejects.toThrow('Subscription limit reached');

				expect(vi.mocked(serverFactory).mock.calls).toHaveLength(factoryCallsBeforeListen);
				expect(transport.getMetrics().methods.get('subscriptions/listen')).toMatchObject({ count: 1, errors: 1 });
				expect(Array.from(transport.getMetrics().subscriptionAttempts.values())).toContainEqual(
					expect.objectContaining({
						method: 'subscriptions/listen',
						protocolEra: 'modern',
						protocolVersion: '2026-07-28',
						clientName: 'modern-subscription-test',
						clientVersion: '1.0.0',
						requestShape: 'notifications:empty',
						count: 1,
					})
				);
				expect(
					Array.from(transport.getMetrics().clients.values()).find(
						(candidate) => candidate.name === 'modern-subscription-test'
					)
				).toMatchObject({ isConnected: false, activeConnections: 0 });
				await client.close();
			} finally {
				await new Promise<void>((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
				await transport.cleanup();
			}
		});

		it.each(['2026-07-28', '2025-03-26'])('tracks oversized tool outcomes through the SDK for %s', async (version) => {
			process.env.ANALYTICS_MODE = 'true';
			const app = express();
			app.use(express.json());
			const factory: ServerFactory = async () => {
				const server = new McpServer({ name: 'oversized-test', version: '1' });
				for (const isError of [false, true]) {
					server.registerTool(`large_${isError}`, { inputSchema: z.object({}) }, async () => ({
						content: [
							{ type: 'image', mimeType: 'image/webp', data: 'A'.repeat(MAX_METRICS_RESPONSE_CAPTURE_BYTES + 4) },
						],
						isError,
					}));
				}
				return { server, enabledToolIds: [] };
			};
			transport = new StatelessHttpTransport(factory, app);
			await transport.initialize();
			const httpServer = app.listen(0);
			const client = new Client(
				{ name: 'oversized-client', version: '1' },
				{ versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } }
			);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') throw new Error('Expected TCP address');
				await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
				for (const isError of [false, true]) {
					const result = await client.callTool({ name: `large_${isError}`, arguments: {} });
					expect(result.isError).toBe(isError);
					expect(transport.getMetrics().methods.get(`tools/call:large_${isError}`)).toMatchObject({
						count: 1,
						errors: Number(isError),
					});
				}
				const metrics = formatMetricsForAPI(transport.getMetrics(), 'streamableHttpJson', true);
				expect(metrics.clients.find((client) => client.name === 'oversized-client')).toMatchObject({
					toolCallCount: 2,
					toolCallErrorCount: 1,
				});
			} finally {
				await client.close();
				await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
			}
		});

		it('serves modern clients request-scoped with discovery, identity metrics, and streamed progress', async () => {
			process.env.ANALYTICS_MODE = 'true';
			const app = express();
			app.use(express.json());
			const factoryCalls: Array<{
				headers: Record<string, string> | null;
				settings: Parameters<ServerFactory>[1];
				skipGradio: Parameters<ServerFactory>[2];
				sessionInfo: Parameters<ServerFactory>[3];
			}> = [];
			const serverFactory: ServerFactory = vi.fn(async (headers, settings, skipGradio, sessionInfo) => {
				factoryCalls.push({ headers, settings, skipGradio, sessionInfo });
				const server = new McpServer({ name: 'modern-test', version: '1.0.0' });
				server.registerTool(
					'progress_test',
					{
						title: 'Progress Test',
						description: 'Emits progress for modern transport testing.',
						inputSchema: z.object({}),
						annotations: {
							title: 'Progress Test',
							destructiveHint: false,
							idempotentHint: false,
							readOnlyHint: true,
							openWorldHint: false,
						},
					},
					async (_params, ctx) => {
						await createProgressRelay(ctx)?.({ progress: 1, total: 2, message: 'Modern halfway' });
						return { content: [{ type: 'text', text: 'modern done' }] };
					}
				);
				return { server, enabledToolIds: [] };
			});
			transport = new StatelessHttpTransport(serverFactory, app);
			await transport.initialize();

			const httpServer = app.listen(0);
			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected the test server to listen on a TCP port');
				}

				const client = new Client(
					{ name: 'modern-contract-test', version: '1.0.0' },
					{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
				);
				const clientTransport = new StreamableHTTPClientTransport(
					new URL(`http://127.0.0.1:${address.port}/mcp?bouquet=search`)
				);
				await client.connect(clientTransport);
				expect(client.getProtocolEra()).toBe('modern');

				const progress: Array<{ progress: number; total?: number; message?: string }> = [];
				const result = await client.callTool(
					{ name: 'progress_test', arguments: {} },
					{
						onprogress: (update) => {
							progress.push(update);
						},
					}
				);
				await expect(client.callTool({ name: 'hf_fs', arguments: { cmd: 'ls', args: ['hf://'] } })).rejects.toThrow(
					'Tool hf_fs not found'
				);
				await client.close();
				const mismatchedDiscoveryResponse = await fetch(`http://127.0.0.1:${address.port}/mcp?bouquet=search`, {
					method: 'POST',
					headers: {
						Accept: 'application/json, text/event-stream',
						'Content-Type': 'application/json',
						'MCP-Protocol-Version': '2026-07-28',
						'MCP-Name': 'modern-test',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 'missing-method-header',
						method: 'server/discover',
						params: {
							_meta: {
								'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								'io.modelcontextprotocol/clientInfo': {
									name: 'malformed-modern-client',
									version: '1.0.0',
								},
								'io.modelcontextprotocol/clientCapabilities': {},
							},
						},
					}),
				});
				expect(mismatchedDiscoveryResponse.status).toBe(400);
				await expect(mismatchedDiscoveryResponse.json()).resolves.toMatchObject({
					error: { code: -32020 },
				});

				expect(result.content).toEqual([{ type: 'text', text: 'modern done' }]);
				expect(progress).toEqual([expect.objectContaining({ progress: 1, total: 2, message: 'Modern halfway' })]);
				expect(factoryCalls.length).toBeGreaterThanOrEqual(2);
				expect(factoryCalls[0]).toMatchObject({
					headers: { 'x-mcp-bouquet': 'search' },
					settings: undefined,
					skipGradio: false,
				});
				expect(factoryCalls.at(-1)?.headers).not.toHaveProperty('x-mcp-bouquet');
				expect(factoryCalls.at(-1)?.sessionInfo).toMatchObject({
					protocolEra: 'modern',
					protocolVersion: '2026-07-28',
					clientCapabilities: expect.any(Object),
					isAuthenticated: false,
					clientInfo: { name: 'modern-contract-test', version: '1.0.0' },
					requestId: expect.any(String),
				});
				expect(factoryCalls.at(-1)?.settings).toEqual({ builtInTools: ['hf_fs'], spaceTools: [] });

				const metrics = transport.getMetrics();
				expect(metrics.protocolEras.modern).toBeGreaterThanOrEqual(2);
				expect(metrics.protocolEras.legacy).toBe(0);
				expect(metrics.protocolVersions.get('modern:2026-07-28')).toMatchObject({
					era: 'modern',
					version: '2026-07-28',
					uniqueClients: 2,
					unattributedRequests: 0,
				});
				expect(metrics.methods.get('server/discover')).toMatchObject({ count: 2, errors: 1 });
				expect(metrics.serverDiscoverOutcomes?.get('success')).toMatchObject({ count: 1 });
				expect(metrics.serverDiscoverOutcomes?.get('headerBodyMismatch')).toMatchObject({ count: 1 });
				expect(metrics.methods.get('tools/call:progress_test')).toMatchObject({ count: 1, errors: 0 });
				expect(Array.from(metrics.clients.values())).toContainEqual(
					expect.objectContaining({
						name: 'modern-contract-test',
						version: '1.0.0',
						isConnected: false,
						activeConnections: 0,
						protocols: expect.any(Map),
					})
				);
				const modernClient = Array.from(metrics.clients.values()).find(
					(clientMetrics) => clientMetrics.name === 'modern-contract-test'
				);
				expect(modernClient?.protocols.get('modern:2026-07-28')).toMatchObject({
					requestCount: expect.any(Number),
				});
				expect(transport.getSessions()).toEqual([]);
			} finally {
				httpServer.close();
				await transport.cleanup();
			}
		});

		it('preserves bouquet and mix query parameters and exposes initialize dashboard metrics', async () => {
			process.env.ANALYTICS_MODE = 'true';
			const app = express();
			app.use(express.json());
			const serverFactory = vi.fn(async () => {
				const server = new McpServer({ name: 'stateless-test', version: '1.0.0' });
				server.registerTool(
					'progress_test',
					{
						title: 'Progress Test',
						description: 'Emits progress for transport testing.',
						inputSchema: z.object({}),
						annotations: {
							title: 'Progress Test',
							destructiveHint: false,
							idempotentHint: false,
							readOnlyHint: true,
							openWorldHint: false,
						},
					},
					async (_params, ctx) => {
						await createProgressRelay(ctx)?.({ progress: 1, total: 2, message: 'Halfway' });
						return { content: [{ type: 'text', text: 'done' }] };
					}
				);
				return { server, enabledToolIds: [] };
			});
			transport = new StatelessHttpTransport(serverFactory, app);
			await transport.initialize();

			const httpServer = app.listen(0);

			try {
				await new Promise<void>((resolve, reject) => {
					httpServer.once('listening', resolve);
					httpServer.once('error', reject);
				});
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					throw new Error('Expected the test server to listen on a TCP port');
				}

				const response = await fetch(`http://127.0.0.1:${address.port}/mcp?bouquet=search&mix=sandbox`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'initialize',
						params: {
							protocolVersion: '2025-03-26',
							capabilities: {},
							clientInfo: { name: 'contract-test', version: '1.0.0' },
						},
					}),
				});

				expect(response.status).toBe(200);
				const sessionId = response.headers.get('mcp-session-id');
				expect(sessionId).toBeTruthy();
				expect(serverFactory).toHaveBeenCalledTimes(1);
				expect(serverFactory.mock.calls[0]?.[0]).toMatchObject({
					'x-mcp-bouquet': 'search',
					'x-mcp-mix': 'sandbox',
				});

				const metrics = transport.getMetrics();
				expect(metrics.protocolEras).toEqual({ legacy: 1, modern: 0 });
				expect(metrics.protocolVersions.get('legacy:2025-03-26')).toMatchObject({
					requestCount: 1,
					uniqueClients: 1,
					unattributedRequests: 0,
				});
				expect(metrics.methods.get('initialize')).toMatchObject({ count: 1, errors: 0 });
				expect(metrics.sessions.created).toBe(1);
				expect(metrics.connections.active).toBe(1);
				expect(transport.getSessions()).toHaveLength(1);

				const dashboardMetrics = formatMetricsForAPI(metrics, 'streamableHttpJson', true, [
					{
						id: sessionId ?? '',
						connectedAt: transport.getSessions()[0]?.connectedAt.toISOString() ?? '',
						lastActivity: transport.getSessions()[0]?.lastActivity.toISOString() ?? '',
						requestCount: 1,
						clientInfo: { name: 'contract-test', version: '1.0.0' },
						isConnected: true,
						connectionStatus: 'Connected',
					},
				]);
				expect(dashboardMetrics.methods).toContainEqual(
					expect.objectContaining({ method: 'initialize', count: 1, errors: 0 })
				);
				expect(dashboardMetrics.sessions).toHaveLength(1);

				const progressResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-session-id': sessionId ?? '',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 2,
						method: 'tools/call',
						params: {
							name: 'progress_test',
							arguments: {},
							_meta: { progressToken: 'test-token' },
						},
					}),
				});
				expect(progressResponse.status).toBe(200);
				expect(progressResponse.headers.get('content-type')).toContain('text/event-stream');
				const progressBody = await progressResponse.text();
				expect(progressBody).toContain('"method":"notifications/progress"');
				expect(progressBody).toContain('"progressToken":"test-token"');
				expect(progressBody).toContain('"message":"Halfway"');
				expect(progressBody).toContain('"result":{"content":[{"type":"text","text":"done"}]}');

				const jsonToolResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-session-id': sessionId ?? '',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 3,
						method: 'tools/call',
						params: { name: 'progress_test', arguments: {} },
					}),
				});
				expect(jsonToolResponse.status).toBe(200);
				expect(jsonToolResponse.headers.get('content-type')).toContain('application/json');
				expect(await jsonToolResponse.json()).toMatchObject({
					result: { content: [{ type: 'text', text: 'done' }] },
				});
				expect(transport.getMetrics().methods.get('tools/call:progress_test')).toMatchObject({
					count: 2,
					errors: 0,
				});

				const unknownToolResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-session-id': sessionId ?? '',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 4,
						method: 'tools/call',
						params: { name: 'missing_tool', arguments: {} },
					}),
				});
				expect(unknownToolResponse.status).toBe(200);
				expect(await unknownToolResponse.json()).toMatchObject({
					error: { code: -32602, message: 'Tool missing_tool not found' },
				});
				expect(transport.getMetrics().methods.get('tools/call:missing_tool')).toMatchObject({
					count: 1,
					errors: 1,
				});

				const directKnownToolResponse = await fetch(`http://127.0.0.1:${address.port}/mcp?bouquet=search`, {
					method: 'POST',
					headers: {
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
						'mcp-session-id': sessionId ?? '',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 5,
						method: 'tools/call',
						params: { name: 'hf_fs', arguments: { cmd: 'ls', args: ['hf://'] } },
					}),
				});
				expect(directKnownToolResponse.status).toBe(200);
				expect(await directKnownToolResponse.json()).toMatchObject({
					error: { code: -32602, message: 'Tool hf_fs not found' },
				});
				expect(serverFactory.mock.calls.at(-1)?.[0]).not.toHaveProperty('x-mcp-bouquet');
				expect(serverFactory.mock.calls.at(-1)?.[1]).toEqual({
					builtInTools: ['hf_fs'],
					spaceTools: [],
				});

				expect(serverFactory.mock.calls.slice(1).every((factoryCall) => factoryCall[1]?.spaceTools.length === 0)).toBe(
					true
				);

				const deleteResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
					method: 'DELETE',
					headers: { 'mcp-session-id': sessionId ?? '' },
				});
				expect(deleteResponse.status).toBe(200);
				expect(transport.getMetrics().sessions.deleted).toBe(1);
				expect(transport.getMetrics().connections.active).toBe(0);
				expect(transport.getSessions()).toHaveLength(0);
				expect(Array.from(transport.getMetrics().clients.values())[0]).toMatchObject({
					isConnected: false,
					activeConnections: 0,
				});
			} finally {
				await new Promise<void>((resolve, reject) => {
					httpServer.close((error) => (error ? reject(error) : resolve()));
				});
			}
		});
	});

	describe('unsupported prompts', () => {
		it('logs prompts/get attempts without building a prompt-capable server', async () => {
			const mockServerFactory = vi.fn() as unknown as ServerFactory;
			transport = new StatelessHttpTransport(mockServerFactory, express());
			const req = {
				headers: {},
				query: {},
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'prompts/get',
					params: { name: 'Retired Prompt' },
				},
				ip: '127.0.0.1',
			};
			const res = {
				set: vi.fn().mockReturnThis(),
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await (transport as any).handleJsonRpcRequest(req, res);

			expect(transport.getMetrics().methods.get('prompts/get:Retired Prompt')).toMatchObject({
				count: 1,
				errors: 1,
			});
			expect(mockServerFactory).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(
				expect.objectContaining({
					error: expect.objectContaining({ message: 'prompts/get is not supported' }),
				})
			);
		});
	});

	describe('exact protocol tool errors', () => {
		it.each([200, 500])(
			'does not infer legacy errors from unobserved oversized HTTP %s responses',
			async (statusCode) => {
				const server = new McpServer({ name: 'fallback-test', version: '1' });
				transport = new StatelessHttpTransport(async () => ({ server, enabledToolIds: [] }), express());
				const payload = JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { content: [{ type: 'text', text: 'A'.repeat(MAX_METRICS_RESPONSE_CAPTURE_BYTES + 4) }] },
				});
				const end = vi.fn();
				const handler = vi
					.spyOn(NodeStreamableHTTPServerTransport.prototype, 'handleRequest')
					.mockImplementation(async (_req, res) => {
						res.end(payload);
					});
				try {
					await (transport as any).handleJsonRpcRequest(
						{
							headers: { 'mcp-protocol-version': '2025-06-18' },
							query: {},
							ip: '127.0.0.1',
							body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hf_fs', arguments: {} } },
						},
						{
							statusCode,
							headersSent: false,
							write: vi.fn(),
							end,
							on: vi.fn(),
							set: vi.fn().mockReturnThis(),
							status: vi.fn().mockReturnThis(),
							json: vi.fn().mockReturnThis(),
						}
					);
					expect(end).toHaveBeenCalledWith(payload);
					expect(transport.getMetrics().methods.get('tools/call:hf_fs')).toMatchObject({
						count: 1,
						errors: statusCode >= 400 ? 1 : 0,
					});
				} finally {
					handler.mockRestore();
					await server.close();
				}
			}
		);

		it.each(['result', 'exception'] as const)(
			'attributes legacy %s errors despite a session protocol change',
			async (failure) => {
				process.env.ANALYTICS_MODE = 'true';
				const server = new McpServer({ name: 'test', version: '1' });
				vi.spyOn(server, 'connect').mockResolvedValue(undefined);
				const factory = vi.fn().mockResolvedValue({ server });
				transport = new StatelessHttpTransport(factory, express());
				const internal = transport as any;
				const client = { name: 'legacy-client', version: '1' };
				internal.createAnalyticsSession('session-1', false, '127.0.0.1', '2025-06-18');
				internal.updateAnalyticsSessionClientInfo('session-1', client);
				internal.associateSessionWithClient(client);
				const handler = vi
					.spyOn(NodeStreamableHTTPServerTransport.prototype, 'handleRequest')
					.mockImplementation(async (_req, res) => {
						// A concurrent request renegotiates this client's session before completion.
						internal.analyticsSessions.get('session-1').protocolVersion = '2025-11-25';
						internal.metrics.trackProtocolRequest('legacy', '2025-11-25');
						internal.metrics.trackClientProtocol(client, 'legacy', '2025-11-25');
						if (failure === 'exception') throw new Error('dispatch failed');
						res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } }));
					});
				try {
					await internal.handleJsonRpcRequest(
						{
							headers: { 'mcp-session-id': 'session-1', 'mcp-protocol-version': '2025-06-18' },
							query: {},
							ip: '127.0.0.1',
							body: {
								jsonrpc: '2.0',
								id: 1,
								method: 'tools/call',
								params: { name: 'hf_fs', arguments: { cmd: 'ls' } },
							},
						},
						{
							write: vi.fn(),
							end: vi.fn(),
							on: vi.fn(),
							headersSent: false,
							set: vi.fn().mockReturnThis(),
							status: vi.fn().mockReturnThis(),
							json: vi.fn().mockReturnThis(),
						}
					);
					const result = formatMetricsForAPI(transport.getMetrics(), 'streamableHttpJson', true).clients[0];
					expect(result).toMatchObject({ toolCallCount: 1, toolCallErrorCount: 1, toolCallErrorRate: 100 });
					expect(result?.protocols).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								version: '2025-06-18',
								toolCallCount: 1,
								toolCallErrorCount: 1,
								toolCallErrorRate: 100,
							}),
							expect.objectContaining({
								version: '2025-11-25',
								toolCallCount: 0,
								toolCallErrorCount: 0,
								toolCallErrorRate: 0,
							}),
						])
					);
				} finally {
					handler.mockRestore();
					vi.mocked(server.connect).mockRestore();
					await server.close();
				}
			}
		);

		it.each([
			[200, false, true],
			[200, true, true],
			[500, false, true],
			[200, false, false],
			[200, true, false],
			[500, false, false],
		] as const)(
			'counts oversized response errors for HTTP %s, isError %s, observed %s',
			async (statusCode, isError, observed) => {
				const internal = transport as any;
				const payload = JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: {
						content: [
							{ type: 'image', mimeType: 'image/webp', data: 'A'.repeat(MAX_METRICS_RESPONSE_CAPTURE_BYTES + 4) },
						],
						isError,
					},
				});
				const end = vi.fn();
				internal.modernNodeHandler = async (_req: any, res: any) => {
					if (observed) internal.modernRequestStorage.getStore().responseCapture.observe(JSON.parse(payload));
					res.end(payload);
				};
				await internal.handleModernRequest(
					{
						headers: {},
						query: {},
						ip: '127.0.0.1',
						body: {
							jsonrpc: '2.0',
							id: 1,
							method: 'tools/call',
							params: {
								name: 'image_generate',
								arguments: {},
								_meta: {
									'io.modelcontextprotocol/clientInfo': { name: 'image-client', version: '1' },
									'io.modelcontextprotocol/protocolVersion': '2026-07-28',
								},
							},
						},
					},
					{
						statusCode,
						headersSent: false,
						write: vi.fn(),
						end,
						set: vi.fn().mockReturnThis(),
						status: vi.fn().mockReturnThis(),
						json: vi.fn().mockReturnThis(),
					}
				);
				expect(end).toHaveBeenCalledWith(payload);
				const metrics = formatMetricsForAPI(transport.getMetrics(), 'streamableHttpJson', true);
				const errors = statusCode >= 400 || (observed && isError) ? 1 : 0;
				expect(metrics.methods.find((method) => method.method === 'tools/call:image_generate')).toMatchObject({
					count: 1,
					errors,
					errorRate: errors * 100,
				});
				expect(metrics.clients[0]).toMatchObject({ toolCallCount: 1, toolCallErrorCount: errors });
			}
		);

		it.each(['result', 'exception'] as const)(
			'attributes modern %s errors to the in-flight request protocol',
			async (failure) => {
				const client = { name: 'mixed-client', version: '1' };
				const internal = transport as any;
				const request = (version: string) => ({
					headers: {},
					query: {},
					ip: '127.0.0.1',
					body: {
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: {
							name: 'hf_fs',
							arguments: { cmd: 'ls' },
							_meta: {
								'io.modelcontextprotocol/clientInfo': client,
								'io.modelcontextprotocol/protocolVersion': version,
							},
						},
					},
				});
				const response = () => ({
					statusCode: 200,
					headersSent: false,
					write: vi.fn(),
					end: vi.fn(),
					set: vi.fn().mockReturnThis(),
					status: vi.fn().mockReturnThis(),
					json: vi.fn().mockReturnThis(),
				});
				internal.modernNodeHandler = async (req: any, res: any) => {
					if (req.body.params._meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28') {
						await internal.handleModernRequest(request('newer-version'), response());
						if (failure === 'exception') throw new Error('dispatch failed');
						res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [] } }));
					} else {
						res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
					}
				};
				await internal.handleModernRequest(request('2026-07-28'), response());
				const result = formatMetricsForAPI(transport.getMetrics(), 'streamableHttpJson', true).clients[0];
				expect(result).toMatchObject({ toolCallCount: 2, toolCallErrorCount: 1, toolCallErrorRate: 50 });
				expect(result?.protocols).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							version: '2026-07-28',
							toolCallCount: 1,
							toolCallErrorCount: 1,
							toolCallErrorRate: 100,
						}),
						expect.objectContaining({
							version: 'newer-version',
							toolCallCount: 1,
							toolCallErrorCount: 0,
							toolCallErrorRate: 0,
						}),
					])
				);
			}
		);
	});

	describe('disabled tools', () => {
		it('rejects modern disabled calls before dispatch', async () => {
			process.env.DISABLE_TOOLS = 'hub_repo_search';
			const mockServerFactory = vi.fn() as unknown as ServerFactory;
			transport = new StatelessHttpTransport(mockServerFactory, express());

			const req = {
				headers: {},
				query: {},
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'hub_repo_search',
						arguments: { query: 'bert' },
						_meta: {
							'io.modelcontextprotocol/clientInfo': { name: 'disabled-client', version: '1' },
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						},
					},
				},
				ip: '127.0.0.1',
			};
			const res = {
				set: vi.fn().mockReturnThis(),
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await (transport as any).handleModernRequest(req, res);

			expect(formatMetricsForAPI(transport.getMetrics(), 'streamableHttpJson', true).clients[0]).toMatchObject({
				toolCallCount: 1,
				toolCallErrorCount: 1,
				toolCallErrorRate: 100,
				activeConnections: 0,
				protocols: [
					expect.objectContaining({
						version: '2026-07-28',
						toolCallCount: 1,
						toolCallErrorCount: 1,
						toolCallErrorRate: 100,
					}),
				],
			});
			expect(mockServerFactory).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(
				expect.objectContaining({
					error: expect.objectContaining({
						message: 'Invalid params: Tool hub_repo_search is disabled by server configuration',
					}),
				})
			);
		});

		it('rejects disabled calls before dispatch and records a dashboard error', async () => {
			process.env.DISABLE_TOOLS = 'hub_repo_search';
			const mockServerFactory = vi.fn() as unknown as ServerFactory;
			transport = new StatelessHttpTransport(mockServerFactory, express());

			const req = {
				headers: {},
				query: {},
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'hub_repo_search', arguments: { query: 'bert' } },
				},
				ip: '127.0.0.1',
			};
			const res = {
				set: vi.fn().mockReturnThis(),
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			};

			await (transport as any).handleJsonRpcRequest(req, res);

			const methodMetrics = transport.getMetrics().methods.get('tools/call:hub_repo_search');
			expect(methodMetrics).toMatchObject({ count: 1, errors: 1 });
			expect(mockServerFactory).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(
				expect.objectContaining({
					error: expect.objectContaining({
						message: 'Invalid params: Tool hub_repo_search is disabled by server configuration',
					}),
				})
			);
		});
	});
});
