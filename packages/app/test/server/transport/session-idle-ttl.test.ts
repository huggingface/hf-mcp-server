import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerFactory } from '../../../src/server/transport/base-transport.js';
import {
	DEFAULT_SESSION_MAX,
	MAX_SESSIONS_EXPIRED_PER_PASS,
	StatelessHttpTransport,
	sessionIdleTtlMs,
	sessionMax,
} from '../../../src/server/transport/stateless-http-transport.js';
import type { SessionMetadata } from '../../../src/server/transport/base-transport.js';
import { resumeGapBucket } from '../../../src/shared/transport-metrics.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-13T00:00:00Z');

interface SessionInternals {
	createAnalyticsSession(sessionId: string, isAuthenticated: boolean, ipAddress?: string): void;
	touchAnalyticsSession(sessionId: string, session: SessionMetadata): void;
	updateAnalyticsSessionClientInfo(sessionId: string, clientInfo: { name: string; version: string }): void;
	handleJsonRpcRequest(req: unknown, res: unknown): Promise<void>;
}

function createTransport(env: Record<string, string>): StatelessHttpTransport {
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
	return new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express());
}

const internals = (transport: StatelessHttpTransport) => transport as unknown as SessionInternals;

/** Fake the clock but leave setImmediate real so each sweep chunk can be observed separately. */
function useFakeClockWithRealImmediates(): void {
	vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

const nextImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Simulate a resumed request: the hot path passes the session it already looked up. */
function touch(transport: StatelessHttpTransport, sessionId: string): void {
	const session = transport.getSessions().find((s) => s.id === sessionId);
	if (!session) throw new Error(`no session ${sessionId}`);
	internals(transport).touchAnalyticsSession(sessionId, session);
}

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
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: ' 0.5 ' })).toBe(HOUR / 2);
	});

	it('rejects unit suffixes and exponents instead of misreading them', () => {
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '1d' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '12hrs' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '1e1' })).toBe(0);
		expect(sessionIdleTtlMs({ SESSION_IDLE_TTL_HOURS: '.5' })).toBe(0);
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
		touch(transport, 'old-active');

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

	it('drains a backlog larger than one chunk across setImmediate continuations', async () => {
		useFakeClockWithRealImmediates();
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		await transport.initialize();
		const backlog = MAX_SESSIONS_EXPIRED_PER_PASS + 2;
		for (let i = 0; i < backlog; i++) internals(transport).createAnalyticsSession(`s${String(i)}`, false);
		const expire = vi.spyOn(transport, 'expireIdleSessions');

		// Earlier five-minute ticks find nothing due; the tick after the TTL takes a full
		// first chunk, then the remainder runs on the immediate that follows.
		vi.advanceTimersByTime(HOUR - 60_000);
		expire.mockClear();
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(expire).toHaveBeenCalledTimes(1);
		expect(transport.getSessionCount()).toBe(2);
		await nextImmediate();
		expect(expire).toHaveBeenCalledTimes(2);
		expect(transport.getSessionCount()).toBe(0);
		expect(transport.getMetrics().sessions?.expired).toBe(backlog);
		expect(transport.getMetrics().connections.active).toBe(0);
		await transport.cleanup();
	});

	it('stops a chunked sweep when cleanup runs between chunks', async () => {
		useFakeClockWithRealImmediates();
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		await transport.initialize();
		for (let i = 0; i < MAX_SESSIONS_EXPIRED_PER_PASS + 1; i++) {
			internals(transport).createAnalyticsSession(`s${String(i)}`, false);
		}
		const expire = vi.spyOn(transport, 'expireIdleSessions');

		vi.advanceTimersByTime(HOUR - 60_000);
		expire.mockClear();
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(expire).toHaveBeenCalledTimes(1);
		expect(transport.getSessionCount()).toBe(1);
		// cleanup() clears the timer synchronously, before the pending continuation fires.
		await transport.cleanup();
		await nextImmediate();
		vi.advanceTimersByTime(HOUR);
		expect(expire).toHaveBeenCalledTimes(1);
	});

	it('does not revive a session the sweep removed while its request was in flight', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_IDLE_TTL_HOURS: '1' });
		internals(transport).createAnalyticsSession('racy', false);
		const session = transport.getSessions()[0];
		if (!session) throw new Error('missing session');
		expect(transport.expireIdleSessions(T0 + 2 * HOUR)).toBe(1);

		internals(transport).touchAnalyticsSession('racy', session);
		expect(transport.getSessionCount()).toBe(0);
		await transport.cleanup();
	});
});

describe('session cap and resume gaps', () => {
	it('parses SESSION_MAX with a safe default', () => {
		expect(sessionMax({})).toBe(DEFAULT_SESSION_MAX);
		expect(sessionMax({ SESSION_MAX: '0' })).toBe(0);
		expect(sessionMax({ SESSION_MAX: '500' })).toBe(500);
		expect(sessionMax({ SESSION_MAX: 'lots' })).toBe(DEFAULT_SESSION_MAX);
	});

	it('falls back to the default rather than truncating non-canonical SESSION_MAX spellings', () => {
		for (const raw of ['1e6', '1_000_000', '1,000,000', '0.5', '-1', '5k']) {
			expect(sessionMax({ SESSION_MAX: raw }), raw).toBe(DEFAULT_SESSION_MAX);
		}
	});

	it('evicts the least recently active sessions beyond SESSION_MAX', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true', SESSION_MAX: '2' });
		const session = internals(transport);
		session.createAnalyticsSession('a', false);
		session.createAnalyticsSession('b', false);
		vi.setSystemTime(T0 + 1000);
		touch(transport, 'a');
		session.createAnalyticsSession('c', false);

		expect(transport.getSessions().map((s) => s.id)).toEqual(['a', 'c']);
		expect(transport.getMetrics().sessions).toMatchObject({ created: 3, evicted: 1, expired: 0 });
		expect(transport.getMetrics().connections.active).toBe(2);
		await transport.cleanup();
	});

	it('records the idle gap before each resumed request', async () => {
		vi.useFakeTimers({ now: T0 });
		const transport = createTransport({ ANALYTICS_MODE: 'true' });
		const session = internals(transport);
		session.createAnalyticsSession('s', false);
		vi.setSystemTime(T0 + 30_000);
		touch(transport, 's');
		vi.setSystemTime(T0 + 30_000 + 2 * HOUR);
		touch(transport, 's');

		expect(transport.getMetrics().sessions?.resumeGaps).toMatchObject({ '<1m': 1, '1-6h': 1, '>3d': 0 });
		await transport.cleanup();
	});

	it('buckets resume gaps', () => {
		const minute = 60_000;
		expect([0, minute, 10 * minute, HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR].map((gap) => resumeGapBucket(gap))).toEqual([
			'<1m',
			'1-10m',
			'10-60m',
			'1-6h',
			'6-24h',
			'1-3d',
			'>3d',
		]);
	});
});
