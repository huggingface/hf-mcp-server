import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsCounter } from '../../../src/shared/transport-metrics.js';
import { IpcTimeoutError } from '../../../src/server/cluster/ipc.js';
import {
	ClusterSessionStore,
	DEFAULT_SESSION_IDLE_TTL_HOURS,
	DEFAULT_SESSION_MAX,
	LocalSessionStore,
	MAX_CLIENT_CAPABILITIES_BYTES,
	MAX_SESSIONS_EXPIRED_PER_PASS,
	sessionIdleTtlMs,
	sessionMax,
	SessionRegistry,
	type SessionStore,
} from '../../../src/server/sessions/session-registry.js';
import { StatelessHttpTransport } from '../../../src/server/transport/stateless-http-transport.js';
import { writeRelayedMainLogLine } from '../../../src/server/utils/logger.js';

describe('SessionRegistry env parsing', () => {
	it('defaults SESSION_IDLE_TTL_HOURS to 24h when unset or blank', () => {
		expect(sessionIdleTtlMs({})).toBe(DEFAULT_SESSION_IDLE_TTL_HOURS * 60 * 60 * 1000);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '   ' })).toBe(24 * 60 * 60 * 1000);
	});

	it('disables idle TTL when SESSION_IDLE_TTL_HOURS=0 and supports fractional hours', () => {
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '0' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '0.5' })).toBe(30 * 60 * 1000);
	});

	it('falls back to default 24h on malformed SESSION_IDLE_TTL_HOURS', () => {
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '24h' })).toBe(24 * 60 * 60 * 1000);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '1e6' })).toBe(24 * 60 * 60 * 1000);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '-5' })).toBe(24 * 60 * 60 * 1000);
	});

	it('parses SESSION_MAX with default 1_000_000, 0 disables cap, and rejects non-integers', () => {
		expect(sessionMax({})).toBe(DEFAULT_SESSION_MAX);
		expect(sessionMax({ SESSION_MAX: '0' })).toBe(0);
		expect(sessionMax({ SESSION_MAX: '2500' })).toBe(2500);
		expect(sessionMax({ SESSION_MAX: '1e6' })).toBe(DEFAULT_SESSION_MAX);
		expect(sessionMax({ SESSION_MAX: '12.5' })).toBe(DEFAULT_SESSION_MAX);
	});
});

describe('SessionRegistry semantics', () => {
	it('distinguishes non-mutating peek from atomic touch (TTL, LRU, requestCount, resumeGaps)', () => {
		const metrics = new MetricsCounter();
		const registry = new SessionRegistry({ metrics, idleTtlMs: 60_000, maxSessions: 2 });
		const t0 = 1_000_000;

		registry.create({ id: 's1', isAuthenticated: true, clientInfo: { name: 'cli', version: '1.0' } }, t0);
		registry.create({ id: 's2', isAuthenticated: false, clientInfo: { name: 'cli', version: '1.0' } }, t0 + 1_000);

		// Peek s1 at t0 + 30_000: must NOT renew lastActivityMs, increment requestCount, change LRU order, or record resumeGap
		const peeked = registry.peek('s1', t0 + 30_000);
		expect(peeked).toBeDefined();
		expect(peeked?.lastActivityMs).toBe(t0);
		expect(peeked?.requestCount).toBe(1);
		expect(metrics.getMetrics().sessions?.resumeGaps['<1m']).toBe(0);

		// Creating s3 evicts s1 (proving peek did NOT refresh s1's LRU position)
		registry.create({ id: 's3', isAuthenticated: false, clientInfo: { name: 'cli', version: '1.0' } }, t0 + 31_000);
		expect(registry.peek('s1', t0 + 31_000)).toBeUndefined();
		expect(metrics.getMetrics().sessions?.evicted).toBe(1);

		// Touch s2 at t0 + 35_000 (gap = 34s -> '<1m') refreshes activity, requestCount, and LRU
		const touched = registry.touch('s2', t0 + 35_000);
		expect(touched?.lastActivityMs).toBe(t0 + 35_000);
		expect(touched?.requestCount).toBe(2);
		expect(metrics.getMetrics().sessions?.resumeGaps['<1m']).toBe(1);

		// Creating s4 evicts s3 (not s2, because touch moved s2 to the MRU end)
		registry.create({ id: 's4', isAuthenticated: false }, t0 + 36_000);
		expect(registry.peek('s3', t0 + 36_000)).toBeUndefined();
		expect(registry.peek('s2', t0 + 36_000)).toBeDefined();

		// Peek past TTL expires s2 and returns undefined
		expect(registry.peek('s2', t0 + 35_000 + 60_001)).toBeUndefined();
		expect(metrics.getMetrics().sessions?.expired).toBe(1);

		registry.stop();
	});

	it('keeps client connection gauge balanced across create, delete, expire, and evict', () => {
		const metrics = new MetricsCounter();
		const registry = new SessionRegistry({ metrics, idleTtlMs: 10_000, maxSessions: 3 });
		const clientInfo = { name: 'gauge-client', version: '2.0' };
		const t0 = 500_000;

		registry.create({ id: 'a', isAuthenticated: true, clientInfo }, t0);
		registry.create({ id: 'b', isAuthenticated: true, clientInfo }, t0 + 1_000);
		registry.create({ id: 'c', isAuthenticated: true, clientInfo }, t0 + 2_000);
		expect(metrics.getMetrics().clients.get('gauge-client 2.0')?.activeConnections).toBe(3);
		expect(metrics.getMetrics().connections.active).toBe(3);

		// Evict 'a' by creating 'd'
		registry.create({ id: 'd', isAuthenticated: true, clientInfo }, t0 + 3_000);
		expect(metrics.getMetrics().clients.get('gauge-client 2.0')?.activeConnections).toBe(3);
		expect(metrics.getMetrics().sessions?.evicted).toBe(1);

		// Delete 'b'
		const deleted = registry.delete('b', t0 + 4_000);
		expect(deleted?.id).toBe('b');
		expect(metrics.getMetrics().clients.get('gauge-client 2.0')?.activeConnections).toBe(2);
		expect(metrics.getMetrics().sessions?.deleted).toBe(1);

		// Expire remaining 'c' and 'd'
		const expired = registry.expireIdleSessions(t0 + 20_000, MAX_SESSIONS_EXPIRED_PER_PASS);
		expect(expired).toBe(2);
		expect(metrics.getMetrics().clients.get('gauge-client 2.0')?.activeConnections).toBe(0);
		expect(metrics.getMetrics().connections.active).toBe(0);
		expect(metrics.getMetrics().sessions?.expired).toBe(2);

		registry.stop();
	});

	it('bounds list(limit) without copying all entries and distinguishes LocalSessionStore vs ClusterSessionStore cleanup', async () => {
		const metrics = new MetricsCounter();
		const registry = new SessionRegistry({ metrics, idleTtlMs: 0, maxSessions: 0 });
		for (let i = 0; i < 10; i++) {
			registry.create({ id: `s-${i}`, isAuthenticated: false });
		}

		const listed = registry.list(3);
		expect(listed.total).toBe(10);
		expect(listed.sessions).toHaveLength(3);
		expect(listed.sessions[0]?.connectedAt).toBeInstanceOf(Date);

		// ClusterSessionStore.cleanup() must NOT clear primary registry
		const clusterStore = new ClusterSessionStore(registry);
		expect(clusterStore.ownsRegistry).toBe(false);
		await clusterStore.cleanup();
		expect(registry.size).toBe(10);

		// LocalSessionStore.cleanup() clears local registry
		const localStore = new LocalSessionStore(registry);
		expect(localStore.ownsRegistry).toBe(true);
		await localStore.cleanup();
		expect(registry.size).toBe(0);
	});
});

describe('StatelessHttpTransport session store integration', () => {
	const originalAnalyticsMode = process.env.ANALYTICS_MODE;
	let server: http.Server | undefined;
	let transport: StatelessHttpTransport | undefined;

	beforeEach(() => {
		process.env.ANALYTICS_MODE = 'true';
	});

	afterEach(async () => {
		if (transport) {
			await transport.cleanup();
			transport = undefined;
		}
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		if (originalAnalyticsMode === undefined) {
			delete process.env.ANALYTICS_MODE;
		} else {
			process.env.ANALYTICS_MODE = originalAnalyticsMode;
		}
	});

	async function startTransportServer(
		sessionStore: SessionStore
	): Promise<{ baseUrl: string; transport: StatelessHttpTransport }> {
		const app = express();
		app.use(express.json());
		const serverFactory = vi.fn(async () => ({
			server: new McpServer({ name: 'test-server', version: '1.0.0' }),
		}));
		const metrics = new MetricsCounter();
		const created = new StatelessHttpTransport(serverFactory, app, vi.fn(), { metrics, sessionStore });
		await created.initialize();
		transport = created;

		server = http.createServer(app);
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
		const { port } = server.address() as AddressInfo;
		return { baseUrl: `http://127.0.0.1:${port}`, transport: created };
	}

	it('returns HTTP 503 with Retry-After: 1 on IpcTimeoutError from create, peek, touch, and delete', async () => {
		const timeoutStore: SessionStore = {
			ownsRegistry: false,
			create: vi.fn(() => Promise.reject(new IpcTimeoutError('create timeout'))),
			peek: vi.fn(() => Promise.reject(new IpcTimeoutError('peek timeout'))),
			touch: vi.fn(() => Promise.reject(new IpcTimeoutError('touch timeout'))),
			delete: vi.fn(() => Promise.reject(new IpcTimeoutError('delete timeout'))),
			getLocalCount: () => 0,
			getLocalSessions: () => [],
			startSweep: () => undefined,
			cleanup: () => Promise.resolve(),
		};

		const { baseUrl, transport: tr } = await startTransportServer(timeoutStore);

		// 1. initialize -> create timeout -> 503
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-03-26',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-03-26',
					capabilities: {},
					clientInfo: { name: 'test-client', version: '1.0' },
				},
			}),
		});
		expect(initRes.status).toBe(503);
		expect(initRes.headers.get('retry-after')).toBe('1');
		expect(await initRes.json()).toEqual({
			jsonrpc: '2.0',
			error: { code: -32603, message: 'Session registry temporarily unavailable' },
			id: 1,
		});

		// 2. unsupported subscribe with session ID -> peek timeout -> 503
		const peekRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-03-26',
				'Mcp-Session-Id': 'sess-123',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'resources/subscribe',
				params: { uri: 'skill://demo' },
			}),
		});
		expect(peekRes.status).toBe(503);
		expect(peekRes.headers.get('retry-after')).toBe('1');

		// 3. normal non-initialize with session ID -> single touch (no peek) timeout -> 503
		const touchRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-03-26',
				'Mcp-Session-Id': 'sess-123',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
		});
		expect(touchRes.status).toBe(503);
		expect(touchRes.headers.get('retry-after')).toBe('1');
		expect(timeoutStore.peek).toHaveBeenCalledTimes(1);

		// 4. DELETE -> delete timeout -> 503
		const delRes = await fetch(`${baseUrl}/mcp`, {
			method: 'DELETE',
			headers: { 'Mcp-Session-Id': 'sess-123' },
		});
		expect(delRes.status).toBe(503);
		expect(delRes.headers.get('retry-after')).toBe('1');

		expect(tr.getMetrics().sessions?.rpcFailures).toBe(4);
	});

	it('relays raw main log lines cleanly', () => {
		const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		try {
			writeRelayedMainLogLine('{"level":30,"msg":"relayed"}');
		} finally {
			spy.mockRestore();
		}
	});

	it('forwards explicit limit > 500 through StatelessHttpTransport.getSessions(limit)', async () => {
		process.env.ANALYTICS_MODE = 'true';
		const app = express();
		const serverFactory = vi.fn() as unknown as ServerFactory;
		const transport = new StatelessHttpTransport(serverFactory, app);
		const store = (transport as unknown as { sessionStore: LocalSessionStore }).sessionStore;

		for (let i = 0; i < 850; i++) {
			await store.create({ id: `s-${String(i)}`, isAuthenticated: false, ipAddress: '127.0.0.1' });
		}

		expect(transport.getSessions().length).toBe(500);
		expect(transport.getSessions(800).length).toBe(800);
		await transport.cleanup();
	});

	it('caps oversized clientCapabilities (>4 KB) to {_truncated: true} while preserving normal capabilities', () => {
		const metrics = new MetricsCounter();
		const registry = new SessionRegistry({ metrics });

		const smallCaps = { roots: { listChanged: true }, sampling: {} };
		const normalRecord = registry.create({
			id: 'small-caps',
			isAuthenticated: false,
			clientCapabilities: smallCaps,
		});
		expect(normalRecord.clientCapabilities).toEqual(smallCaps);

		const hugeCaps = { experimental: { payload: 'x'.repeat(MAX_CLIENT_CAPABILITIES_BYTES + 100) } };
		const truncatedRecord = registry.create({
			id: 'huge-caps',
			isAuthenticated: false,
			clientCapabilities: hugeCaps,
		});
		expect(truncatedRecord.clientCapabilities).toEqual({ _truncated: true });
		expect(registry.peek('huge-caps')?.clientCapabilities).toEqual({ _truncated: true });
		expect(registry.touch('huge-caps')?.clientCapabilities).toEqual({ _truncated: true });
	});

	it('skips sessionStore lookup on 401 auth rejection and uses a single touch RPC on valid legacy requests', async () => {
		const store = new LocalSessionStore(new SessionRegistry({ metrics: new MetricsCounter() }));
		await store.create({
			id: 'sess-auth-check',
			isAuthenticated: false,
			protocolEra: 'legacy',
			protocolVersion: '2025-03-26',
		});
		const peekSpy = vi.spyOn(store, 'peek');
		const touchSpy = vi.spyOn(store, 'touch');

		const { baseUrl } = await startTransportServer(store);

		const unauthRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-03-26',
				'Mcp-Session-Id': 'sess-auth-check',
				'X-MCP-Force-Auth': 'true',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		expect(unauthRes.status).toBe(401);
		expect(peekSpy).not.toHaveBeenCalled();
		expect(touchSpy).not.toHaveBeenCalled();

		const validRes = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2025-03-26',
				'Mcp-Session-Id': 'sess-auth-check',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
		});
		expect(validRes.status).toBe(200);
		expect(peekSpy).not.toHaveBeenCalled();
		expect(touchSpy).toHaveBeenCalledExactlyOnceWith('sess-auth-check');
	});
});
