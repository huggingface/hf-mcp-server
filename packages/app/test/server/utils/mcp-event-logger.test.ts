import { describe, expect, it } from 'vitest';
import { buildMcpEventLogEntry, type McpEventLoggerOptions } from '../../../src/server/utils/mcp-event-logger.js';

describe('buildMcpEventLogEntry', () => {
	it('retains allowlisted event protocol telemetry while excluding payloads and job identifiers', () => {
		const excludedValues = {
			jobId: 'job-secret-123',
			namespace: 'private-org',
			cursor: 'RUNNING',
			payload: 'PRIVATE_JOB_MESSAGE',
			errorMessage: 'Unknown job: job-secret-123',
		};
		const options = {
			clientSessionId: 'session-1',
			requestId: 'request-1',
			protocolEra: 'modern',
			protocolVersion: '2026-07-28',
			userHash: 'user-hash',
			isAuthenticated: true,
			clientName: 'test-client',
			clientVersion: '1.2.3',
			eventName: 'job.status_changed',
			durationMs: 18.7,
			success: true,
			outcome: 'delivered',
			cursorSupplied: true,
			maxAgeMsSupplied: true,
			deliveredEventCount: 1,
			truncated: false,
			...excludedValues,
		} satisfies McpEventLoggerOptions & typeof excludedValues;

		const entry = buildMcpEventLogEntry('events/poll', options);

		expect(entry).toMatchObject({
			clientSessionId: 'session-1',
			requestId: 'request-1',
			protocolEra: 'modern',
			protocolVersion: '2026-07-28',
			userHash: 'user-hash',
			name: 'test-client',
			version: '1.2.3',
			methodName: 'events/poll',
			eventName: 'job.status_changed',
			authorized: true,
			durationMs: 19,
			success: true,
			outcome: 'delivered',
			errorCode: null,
			cursorSupplied: true,
			maxAgeMsSupplied: true,
			deliveredEventCount: 1,
			truncated: false,
		});
		expect(Object.keys(entry).sort()).toEqual(
			[
				'authorized',
				'clientSessionId',
				'cursorSupplied',
				'deliveredEventCount',
				'durationMs',
				'errorCode',
				'eventName',
				'maxAgeMsSupplied',
				'mcpServerSessionId',
				'methodName',
				'name',
				'outcome',
				'protocolEra',
				'protocolVersion',
				'requestId',
				'serverBuildSha',
				'serverVersion',
				'success',
				'truncated',
				'userHash',
				'version',
			].sort()
		);

		const serialized = JSON.stringify(entry);
		for (const excludedValue of Object.values(excludedValues)) {
			expect(serialized).not.toContain(excludedValue);
		}
	});

	it('normalizes duration, error codes, and invalid delivered counts', () => {
		const entry = buildMcpEventLogEntry('events/poll', {
			protocolEra: 'modern',
			isAuthenticated: false,
			durationMs: -3.2,
			success: false,
			outcome: 'not_found',
			errorCode: -32023,
			cursorSupplied: false,
			maxAgeMsSupplied: false,
			deliveredEventCount: Number.NaN,
		});

		expect(entry.durationMs).toBe(0);
		expect(entry.eventName).toBeNull();
		expect(entry.errorCode).toBe(-32023);
		expect(entry.deliveredEventCount).toBeNull();
		expect(entry.truncated).toBeNull();
	});
});
