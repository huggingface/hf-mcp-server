import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	StatelessHttpTransport,
	classifyMcpEventOutcome,
	classifyMcpEventRequest,
} from '../../src/server/transport/stateless-http-transport.js';
import type { ServerFactory } from '../../src/server/transport/base-transport.js';
import { eventsLiveMetrics } from '../../src/server/utils/events-live-metrics.js';
import type { EventsMetricsFilters } from '../../src/shared/events-metrics.js';

const filters: EventsMetricsFilters = { window: '1h', method: 'all', outcome: 'all', client: 'events-hook-test' };

describe('MCP Events request & outcome classification', () => {
	it('normalizes known and unknown event names and tracks cursor/maxAgeMs presence', () => {
		expect(classifyMcpEventRequest({ method: 'events/list', params: {} })).toEqual({
			methodName: 'events/list',
			cursorSupplied: false,
			maxAgeMsSupplied: false,
		});
		expect(
			classifyMcpEventRequest({
				method: 'events/poll',
				params: { name: 'job.status_changed', cursor: 'RUNNING', maxAgeMs: 5000, arguments: { job_id: 'secret' } },
			})
		).toEqual({
			methodName: 'events/poll',
			eventName: 'job.status_changed',
			cursorSupplied: true,
			maxAgeMsSupplied: true,
		});
		expect(
			classifyMcpEventRequest({
				method: 'events/poll',
				params: { name: 'custom.unknown.event' },
			})
		).toEqual({
			methodName: 'events/poll',
			eventName: '[unknown]',
			cursorSupplied: false,
			maxAgeMsSupplied: false,
		});
		expect(classifyMcpEventRequest({ method: 'tools/call', params: { name: 'hf_jobs' } })).toBeNull();
	});

	it('classifies poll delivery, truncation, empty polls, and JSON-RPC error codes', () => {
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/list',
				httpStatus: 200,
				response: { isError: false, eventsCount: 1 },
			})
		).toBe('ok');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: false, eventsCount: 1, eventsTruncated: false },
			})
		).toBe('delivered');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: false, eventsCount: 0, eventsTruncated: false },
			})
		).toBe('empty');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: false, eventsCount: 0, eventsTruncated: true },
			})
		).toBe('truncated');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: true, jsonRpcErrorCode: -32023 },
			})
		).toBe('not_found');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: true, jsonRpcErrorCode: -32024 },
			})
		).toBe('forbidden');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/poll',
				httpStatus: 200,
				response: { isError: true, jsonRpcErrorCode: -32602 },
			})
		).toBe('invalid_params');
		expect(
			classifyMcpEventOutcome({
				methodName: 'events/list',
				httpStatus: 200,
				response: { isError: true, jsonRpcErrorCode: -32601 },
			})
		).toBe('method_not_found');
	});
});

describe('MCP Events live metrics hook', () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each(['disabled', 'throws'])('counts each classified event once when historical logger %s', (mode) => {
		vi.stubEnv('LOG_MCP_EVENTS', 'false');
		const historical = vi.fn(() => {
			if (mode === 'throws') throw new Error('historical unavailable');
		});
		const transport = new StatelessHttpTransport(vi.fn() as unknown as ServerFactory, express(), undefined, {
			mcpEventLogger: historical,
		});
		const hook = transport as unknown as {
			recordMcpEvent(
				request: { method: string; params?: Record<string, unknown> },
				start: number,
				httpStatus: number,
				context: { protocolEra: 'modern'; isAuthenticated: boolean; clientInfo: { name: string; version: string } },
				response?: { isError: boolean; eventsCount?: number; eventsTruncated?: boolean; jsonRpcErrorCode?: number }
			): void;
		};

		const before = eventsLiveMetrics.snapshot(filters).totals;
		const context = {
			protocolEra: 'modern' as const,
			isAuthenticated: true,
			clientInfo: { name: 'events-hook-test', version: '1' },
		};

		hook.recordMcpEvent({ method: 'events/list', params: {} }, Date.now(), 200, context, {
			isError: false,
			eventsCount: 1,
		});
		hook.recordMcpEvent(
			{ method: 'events/poll', params: { name: 'job.status_changed', cursor: 'RUNNING' } },
			Date.now(),
			200,
			context,
			{ isError: false, eventsCount: 1, eventsTruncated: false }
		);
		hook.recordMcpEvent(
			{ method: 'events/poll', params: { name: 'job.status_changed', cursor: 'COMPLETED' } },
			Date.now(),
			200,
			context,
			{ isError: false, eventsCount: 0, eventsTruncated: false }
		);
		hook.recordMcpEvent(
			{ method: 'events/poll', params: { name: 'job.status_changed', cursor: 'bad' } },
			Date.now(),
			200,
			context,
			{ isError: false, eventsCount: 0, eventsTruncated: true }
		);
		hook.recordMcpEvent({ method: 'events/poll', params: { name: 'other.event' } }, Date.now(), 200, context, {
			isError: true,
			jsonRpcErrorCode: -32023,
		});
		// Non-event request should be ignored
		hook.recordMcpEvent({ method: 'tools/list', params: {} }, Date.now(), 200, context, { isError: false });

		const after = eventsLiveMetrics.snapshot(filters).totals;
		expect(after.requests - before.requests).toBe(5);
		expect(after.successes - before.successes).toBe(4);
		expect(after.failures - before.failures).toBe(1);
		expect(after.deliveredPolls - before.deliveredPolls).toBe(1);
		expect(after.emptyPolls - before.emptyPolls).toBe(1);
		expect(after.truncatedPolls - before.truncatedPolls).toBe(1);
		expect(after.deliveredEvents - before.deliveredEvents).toBe(1);
		expect(historical).toHaveBeenCalledTimes(5);
	});
});
