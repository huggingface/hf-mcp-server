import { afterEach, expect, it, vi } from 'vitest';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('pino', () => ({
	default: Object.assign(() => ({ info }), { stdTimeFunctions: { isoTime: () => '' } }),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	info.mockReset();
});

it('serializes canonical fields and correlation without changing unrelated query events', async () => {
	vi.stubEnv('NODE_ENV', 'production');
	vi.stubEnv('VITEST', 'false');
	vi.stubEnv('LOG_QUERY_EVENTS', 'true');
	vi.stubEnv('LOGGING_DATASET_ID', 'test/dataset');
	vi.stubEnv('LOGGING_HF_TOKEN', 'test-token');
	const { logToolQuery } = await import('../../../src/server/utils/query-logger.js');
	logToolQuery(
		'dynamic_space',
		'invoke',
		{},
		{
			requestId: 'request',
			clientSessionId: 'session',
			protocolEra: 'modern',
			dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
			dynamicSpaceStage: 'configuration',
			dynamicSpaceErrorCode: 'invoke_disabled',
			success: false,
			durationMs: 1.6,
		}
	);
	const entry = JSON.parse(JSON.stringify(info.mock.calls[0]?.[0]));
	expect(entry).toMatchObject({
		methodName: 'dynamic_space',
		query: 'invoke',
		parameters: '{}',
		requestId: 'request',
		clientSessionId: 'session',
		protocolEra: 'modern',
		dynamicSpaceReportingSchema: 'dynamic_space_outcome_v1',
		dynamicSpaceStage: 'configuration',
		dynamicSpaceErrorCode: 'invoke_disabled',
		success: false,
		durationMs: 2,
	});
	logToolQuery('other', 'search', {});
	const unrelated = JSON.parse(JSON.stringify(info.mock.calls[1]?.[0]));
	expect(unrelated).not.toHaveProperty('dynamicSpaceReportingSchema');
	expect(unrelated).not.toHaveProperty('dynamicSpaceStage');
	expect(unrelated).not.toHaveProperty('dynamicSpaceErrorCode');
});
