import { describe, it, expect, vi } from 'vitest';
import {
	formatMetricsForAPI,
	hashUserIdentity,
	MetricsCounter,
	isInitializeRequest,
} from '../../src/shared/transport-metrics.js';

describe('isInitializeRequest', () => {
	it('should identify initialize requests', () => {
		expect(isInitializeRequest('initialize')).toBe(true);
		expect(isInitializeRequest('notifications/initialized')).toBe(false);
		expect(isInitializeRequest('tools/list')).toBe(false);
	});
});

describe('MetricsCounter', () => {
	it('uses actual uptime for rolling throughput before a window is full', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
			const metrics = new MetricsCounter();
			for (let request = 0; request < 30; request++) {
				metrics.trackRequest();
			}

			vi.advanceTimersByTime(30 * 60 * 1000);
			const requests = metrics.getMetrics().requests;

			expect(requests.lastMinute).toBe(0);
			expect(requests.lastHour).toBe(1);
			expect(requests.last3Hours).toBe(1);
			expect(requests.averagePerMinute).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('tracks legacy and modern protocol requests independently', () => {
		const metrics = new MetricsCounter();

		metrics.trackProtocolRequest('legacy', '2025-06-18');
		metrics.trackProtocolRequest('modern', '2026-07-28');
		metrics.trackProtocolRequest('modern', '2026-07-28');

		expect(metrics.getMetrics().protocolEras).toEqual({ legacy: 1, modern: 2 });
		expect(metrics.getMetrics().protocolVersions.get('modern:2026-07-28')).toMatchObject({
			requestCount: 2,
			uniqueClients: 0,
			uniqueUsers: 0,
			unattributedRequests: 2,
		});
	});

	it('aggregates exact protocols and hashed users by client', () => {
		const metrics = new MetricsCounter();
		const client = { name: 'test-client', version: '1.2.3' };
		metrics.trackProtocolRequest('modern', '2026-07-28');
		metrics.associateSessionWithClient(client);
		metrics.trackClientProtocol(client, 'modern', '2026-07-28');
		const userHash = metrics.trackAuthenticatedUser('Example-User', 'modern', '2026-07-28', client);
		metrics.trackAuthenticatedUser('example-user', 'modern', '2026-07-28', client);

		expect(userHash).toBe(hashUserIdentity('example-user'));
		expect(userHash).not.toContain('example-user');
		const response = formatMetricsForAPI(metrics.getMetrics(), 'streamableHttpJson', true);
		expect(response.connections.uniqueUsers).toBe(1);
		expect(response.protocolVersions).toEqual([
			expect.objectContaining({
				era: 'modern',
				version: '2026-07-28',
				requestCount: 1,
				uniqueClients: 1,
				uniqueUsers: 1,
				unattributedRequests: 0,
			}),
		]);
		expect(response.clients[0]).toMatchObject({
			uniqueUserCount: 1,
			protocols: [expect.objectContaining({ era: 'modern', version: '2026-07-28', requestCount: 1 })],
		});
	});

	it('attributes tool calls to the exact protocol used by a client', () => {
		const metrics = new MetricsCounter();
		const client = { name: 'mcp', version: '0.1.0' };
		metrics.associateSessionWithClient(client);

		for (const protocolVersion of ['2025-06-18', '2025-11-25']) {
			metrics.trackProtocolRequest('legacy', protocolVersion);
			metrics.trackClientProtocol(client, 'legacy', protocolVersion);
		}
		metrics.trackProtocolToolCall('legacy', '2025-11-25', client);
		metrics.trackProtocolToolCall('legacy', '2025-11-25', client);
		metrics.trackProtocolToolCall('legacy', '2025-06-18', client);

		const response = formatMetricsForAPI(metrics.getMetrics(), 'streamableHttpJson', true);
		const protocols = response.clients[0]?.protocols;

		expect(protocols).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: '2025-11-25', requestCount: 1, toolCallCount: 2 }),
				expect.objectContaining({ version: '2025-06-18', requestCount: 1, toolCallCount: 1 }),
			])
		);
		expect(response.protocolVersions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: '2025-11-25', toolCallCount: 2 }),
				expect.objectContaining({ version: '2025-06-18', toolCallCount: 1 }),
			])
		);
	});

	it('bounds unexpected protocol-version cardinality', () => {
		const metrics = new MetricsCounter();
		for (let index = 0; index < 40; index++) {
			metrics.trackProtocolRequest('modern', `unexpected-${index}`);
		}

		expect(metrics.getMetrics().protocolVersions.size).toBe(33);
		expect(metrics.getMetrics().protocolVersions.get('modern:__other__')?.requestCount).toBe(8);
	});

	it('buckets method details after too many distinct values for a base method', () => {
		const metrics = new MetricsCounter();

		for (let i = 0; i < 500; i++) {
			metrics.trackMethod(`resources/subscribe:skill://example/${i}`);
		}

		metrics.trackMethod('resources/subscribe:skill://example/500');
		metrics.trackMethod('resources/subscribe:skill://example/501');
		metrics.trackMethod('resources/read:skill://example/0');

		const methodMetrics = metrics.getMetrics().methods;
		expect(methodMetrics.size).toBe(502);
		expect(methodMetrics.get('resources/subscribe:skill://example/0')?.count).toBe(1);
		expect(methodMetrics.get('resources/subscribe:__unexpected__')?.count).toBe(2);
		expect(methodMetrics.get('resources/read:skill://example/0')?.count).toBe(1);
	});

	it('continues tracking previously seen method details after the bucket is full', () => {
		const metrics = new MetricsCounter();

		for (let i = 0; i < 500; i++) {
			metrics.trackMethod(`tools/call:tool_${i}`);
		}

		metrics.trackMethod('tools/call:tool_42');
		metrics.trackMethod('tools/call:tool_500');

		const methodMetrics = metrics.getMetrics().methods;
		expect(methodMetrics.get('tools/call:tool_42')?.count).toBe(2);
		expect(methodMetrics.get('tools/call:__unexpected__')?.count).toBe(1);
	});

	it('aggregates sanitized subscription attempt behavior by client and protocol', () => {
		const metrics = new MetricsCounter();
		const attempt = {
			method: 'subscriptions/listen' as const,
			protocolEra: 'modern' as const,
			protocolVersion: '2026-07-28',
			clientName: 'go-sdk',
			clientVersion: '1.2.3',
			requestShape: 'notifications:resourceSubscriptions:1',
		};

		metrics.trackSubscriptionAttempt(attempt);
		metrics.trackSubscriptionAttempt(attempt);

		expect(formatMetricsForAPI(metrics.getMetrics(), 'streamableHttpJson', true).subscriptionAttempts).toEqual([
			expect.objectContaining({
				...attempt,
				count: 2,
				firstSeen: expect.any(String),
				lastSeen: expect.any(String),
			}),
		]);
	});

	it('bounds subscription attempt dimensions and client identity lengths', () => {
		const metrics = new MetricsCounter();

		for (let index = 0; index < 502; index++) {
			metrics.trackSubscriptionAttempt({
				method: 'resources/subscribe',
				protocolEra: 'legacy',
				protocolVersion: '2025-11-25',
				clientName: `client-${index}-${'x'.repeat(200)}`,
				clientVersion: '1.0.0',
				requestShape: 'uri:present',
			});
		}

		const attempts = Array.from(metrics.getMetrics().subscriptionAttempts.values());
		expect(attempts).toHaveLength(501);
		expect(attempts[0]?.clientName).toHaveLength(120);
		expect(attempts).toContainEqual(
			expect.objectContaining({
				method: 'resources/subscribe',
				protocolVersion: '__other__',
				requestShape: '__other__',
				count: 2,
			})
		);
	});

	it('handles malformed and oversized subscription dimensions defensively', () => {
		const metrics = new MetricsCounter();

		expect(() =>
			metrics.trackSubscriptionAttempt({
				method: 'subscriptions/listen',
				protocolEra: 'modern',
				protocolVersion: `version-${'x'.repeat(200)}`,
				clientName: 42 as unknown as string,
				clientVersion: `version-${'x'.repeat(200)}`,
				requestShape: `shape-${'x'.repeat(200)}`,
			})
		).not.toThrow();

		const attempt = Array.from(metrics.getMetrics().subscriptionAttempts.values())[0];
		expect(attempt?.protocolVersion).toHaveLength(120);
		expect(attempt?.clientName).toBeUndefined();
		expect(attempt?.clientVersion).toHaveLength(120);
		expect(attempt?.requestShape).toHaveLength(120);
	});
});
