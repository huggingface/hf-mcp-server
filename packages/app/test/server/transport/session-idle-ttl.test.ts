import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import { StatelessHttpTransport, sessionIdleTtlMs } from '../../../src/server/transport/stateless-http-transport.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-13T00:00:00Z');

interface SessionInternals {
	createAnalyticsSession(sessionId: string, isAuthenticated: boolean, ipAddress?: string): void;
	updateAnalyticsSessionActivity(sessionId: string): void;
	updateAnalyticsSessionClientInfo(sessionId: string, clientInfo: { name: string; version: string }): void;
	handleJsonRpcRequest(req: unknown, res: unknown): Promise<void>;
}

function createTransport(env: Record<string, string>): StatelessHttpTransport {
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
	return new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express());
}

const internals = (transport: StatelessHttpTransport) => transport as unknown as SessionInternals;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('sessionIdleTtlMs', () => {
	it('parses hours, allows fractions, and disables on unset or invalid values', () => {
		expect(sessionIdleTtlMs({})).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '0' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '-1' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: 'soon' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '24' })).toBe(24 * HOUR);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '0.5' })).toBe(HOUR / 2);
	});
});

describe('legacy analytics session idle expiry', () => {
	it('expires only sessions idle beyond the TTL, counting activity as a touch', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '24' });
		const session = internals(transport);
		const client = { name: 'legacy-client', version: '1.0.0' };

		session.createAnalyticsSession('old-idle', false);
		session.createAnalyticsSession('old-active', false);
		session.updateAnalyticsSessionClientInfo('old-active', client);
		vi.setSystemTime(T0 + 2 * HOUR);
		session.createAnalyticsSession('recent', false);
		// Created first but used recently: must survive and move behind 'recent'.
		vi.setSystemTime(T0 + 23 * HOUR);
		session.updateAnalyticsSessionActivity('old-active');

		expect(transport.expireIdleSessions(T0 + 24 * HOUR + 1)).toBe(1);
		expect(transport.getSessions().map((s) => s.id)).toEqual(['recent', 'old-active']);

		expect(transport.expireIdleSessions(T0 + 26 * HOUR + 1)).toBe(1);
		expect(transport.getSessions().map((s) => s.id)).toEqual(['old-active']);

		const metrics = transport.getMetrics();
		expect(metrics.sessions).toMatchObject({ created: 3, deleted: 0, expired: 2 });
		expect(metrics.connections.active).toBe(1);
		await transport.cleanup();
	});

	it('answers a request for an expired session with 404 so the client re-initializes', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		internals(transport).createAnalyticsSession('expired-session', false);
		expect(transport.expireIdleSessions(T0 + 2 * HOUR)).toBe(1);

		const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
		await internals(transport).handleJsonRpcRequest(
			{
				headers: { 'mcp-session-id': 'expired-session' },
				query: {},
				body: { jsonrpc: '2.0', id: 1, method: 'ping' },
				ip: '127.0.0.1',
			},
			res
		);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(transport.getMetrics().sessions?.resumedFailed).toBe(1);
		await transport.cleanup();
	});

	it('never expires sessions when the TTL is unset or analytics mode is off', async () => {
		vi.useFakeTimers({ now: T0 });
		const noTtl = createTransport({ ANALYTICS_MODE: 'true' });
		internals(noTtl).createAnalyticsSession('kept', false);
		expect(noTtl.expireIdleSessions(T0 + 1000 * HOUR)).toBe(0);
		expect(noTtl.getSessionCount()).toBe(1);

		const noAnalytics = createTransport({ ANALYTICS_MODE: 'false', SESSION_IDLE_TTL_HOURS: '1' });
		expect(noAnalytics.expireIdleSessions(T0 + 1000 * HOUR)).toBe(0);
		await noTtl.cleanup();
		await noAnalytics.cleanup();
	});

	it('expires a large backlog in bounded chunks', () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		for (let i = 0; i < 5; i++) internals(transport).createAnalyticsSession(`s${String(i)}`, false);

		expect(transport.expireIdleSessions(T0 + 2 * HOUR, 2)).toBe(2);
		expect(transport.getSessionCount()).toBe(3);
		expect(transport.expireIdleSessions(T0 + 2 * HOUR, 10)).toBe(3);
		expect(transport.getMetrics().sessions?.expired).toBe(5);
	});

	it('sweeps on a timer once initialized', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		await transport.initialize();
		internals(transport).createAnalyticsSession('idle', false);

		// TTL/12 = 5 minutes between sweeps.
		await vi.advanceTimersByTimeAsync(HOUR + 5 * 60 * 1000);
		expect(transport.getSessionCount()).toBe(0);
		expect(transport.getMetrics().sessions?.expired).toBe(1);
		await transport.cleanup();
	});
});
