import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HfDatasetLogger } from '../../../src/server/utils/hf-dataset-transport.js';
import {
	fetchHfWhoami,
	HfWhoamiRequestError,
	isHfWhoamiUnauthorizedError,
} from '../../../src/server/utils/hf-whoami-client.js';
import {
	startMockHub,
	type MockHubCommit,
	type MockHubHandle,
	type MockHubOptions,
	type MockHubUploadedFile,
} from '../../support/mock-hub.js';

const TEST_DATASET_ID = 'hf-internal/mcp-test-logs';
const TEST_LOGGING_TOKEN = 'hf_logging_token_for_mock_hub_test_12345';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Mock Hub integration (dataset log-drop & whoami)', () => {
	let mockHub: MockHubHandle;
	const originalLoggingHubUrl = process.env.LOGGING_HUB_URL;
	const originalHfWhoamiUrl = process.env.HF_WHOAMI_URL;
	const activeLoggers: HfDatasetLogger[] = [];

	beforeAll(async () => {
		const options: MockHubOptions = {};
		mockHub = await startMockHub(options);
	});

	afterAll(async () => {
		await mockHub.close();
	});

	beforeEach(() => {
		mockHub.reset();
		delete process.env.LOGGING_HUB_URL;
		delete process.env.HF_WHOAMI_URL;
	});

	afterEach(async () => {
		while (activeLoggers.length > 0) {
			const logger = activeLoggers.pop();
			if (logger) {
				await logger.destroy();
			}
		}

		if (originalLoggingHubUrl === undefined) {
			delete process.env.LOGGING_HUB_URL;
		} else {
			process.env.LOGGING_HUB_URL = originalLoggingHubUrl;
		}

		if (originalHfWhoamiUrl === undefined) {
			delete process.env.HF_WHOAMI_URL;
		} else {
			process.env.HF_WHOAMI_URL = originalHfWhoamiUrl;
		}
	});

	describe('HfDatasetLogger real uploadFile against Mock Hub', () => {
		it.each([
			{ logType: 'Query', expectedFolder: 'queries', useEnv: false },
			{ logType: 'System', expectedFolder: 'sessions', useEnv: true },
			{ logType: 'Skill', expectedFolder: 'skills', useEnv: false },
			{ logType: 'Logs', expectedFolder: 'logs', useEnv: true },
		])(
			'uploads $logType entries to $expectedFolder/ with token redaction',
			async ({ logType, expectedFolder, useEnv }) => {
				if (useEnv) {
					process.env.LOGGING_HUB_URL = mockHub.baseUrl;
				}

				const logger = new HfDatasetLogger({
					loggingToken: TEST_LOGGING_TOKEN,
					datasetId: TEST_DATASET_ID,
					...(useEnv ? {} : { hubUrl: mockHub.baseUrl }),
					batchSize: 2,
					flushInterval: 60_000,
					logType,
				});
				activeLoggers.push(logger);

				const leakedPat = 'hf_abcdefghijklmnopqrstuvwxyz12345678';
				const leakedOauth = 'hf_oauth_header123.payload456.signature789';

				logger.processLog({
					level: 30,
					time: Date.now(),
					msg: `First ${logType} entry with ${leakedPat}`,
					event: `${logType.toLowerCase()}_1`,
					authorization: `Bearer ${leakedPat}`,
				});
				logger.processLog({
					level: 30,
					time: Date.now(),
					msg: `Second ${logType} entry with ${leakedOauth}`,
					event: `${logType.toLowerCase()}_2`,
					note: `contains ${leakedOauth}`,
				});

				await waitFor(() => mockHub.uploadedFiles.length === 1);

				const commit: MockHubCommit | undefined = mockHub.commits[0];
				const uploaded: MockHubUploadedFile | undefined = mockHub.uploadedFiles[0];
				expect(commit).toBeDefined();
				expect(uploaded).toBeDefined();
				expect(uploaded?.repo).toBe(TEST_DATASET_ID);
				expect(uploaded?.path).toMatch(new RegExp(`^${expectedFolder}/\\d{4}-\\d{2}-\\d{2}/logs-.*\\.jsonl$`));
				expect(uploaded?.entries).toHaveLength(2);
				expect(uploaded?.rawContent).not.toContain(leakedPat);
				expect(uploaded?.rawContent).not.toContain(leakedOauth);
				expect(uploaded?.rawContent).toContain('REDACTED_TOKEN');
				expect(uploaded?.rawContent).toContain('<redacted>');
			}
		);

		it('recovers from transient 500 upload failure and uploads buffered + newly arrived entries with zero loss', async () => {
			mockHub.setFailUploadsCount(1);

			const logger = new HfDatasetLogger({
				loggingToken: TEST_LOGGING_TOKEN,
				datasetId: TEST_DATASET_ID,
				hubUrl: mockHub.baseUrl,
				batchSize: 2,
				flushInterval: 100,
				logType: 'Query',
			});
			activeLoggers.push(logger);

			// Trigger initial batch upload (will fail with simulated 500)
			logger.processLog({ level: 30, time: Date.now(), msg: 'entry-1', seq: 1 });
			logger.processLog({ level: 30, time: Date.now(), msg: 'entry-2', seq: 2 });

			// Immediately enqueue additional entries while failure/retry is pending
			logger.processLog({ level: 30, time: Date.now(), msg: 'entry-3', seq: 3 });
			logger.processLog({ level: 30, time: Date.now(), msg: 'entry-4', seq: 4 });

			await waitFor(() => {
				const totalEntries = mockHub.uploadedFiles.reduce((sum, file) => sum + file.entries.length, 0);
				return totalEntries === 4;
			});

			const allSeqs = mockHub.uploadedFiles
				.flatMap((file) => file.entries)
				.map((entry) => entry.seq)
				.sort((a, b) => Number(a) - Number(b));

			expect(allSeqs).toEqual([1, 2, 3, 4]);
			expect(logger.getStatus().bufferSize).toBe(0);
		});
	});

	describe('fetchHfWhoami against Mock Hub via HF_WHOAMI_URL', () => {
		beforeEach(() => {
			process.env.HF_WHOAMI_URL = mockHub.whoamiUrl;
		});

		it('resolves OAuth tokens to a valid user HfWhoamiResponse', async () => {
			const response = await fetchHfWhoami('hf_oauth_1');
			expect(response.type).toBe('user');
			expect(response.name).toBe('oauth_user_1');
			expect(response.auth.type).toBe('oauth');
		});

		it('resolves PAT tokens to a valid user HfWhoamiResponse', async () => {
			const response = await fetchHfWhoami('hf_pat_demo');
			expect(response.type).toBe('user');
			expect(response.name).toBe('pat_user_pat_demo');
			expect(response.auth.type).toBe('access_token');
			expect(response.auth.accessToken?.role).toBe('write');
		});

		it('resolves app tokens to a valid app HfWhoamiResponse', async () => {
			const response = await fetchHfWhoami('hf_app_runner1');
			expect(response.type).toBe('app');
			expect(response.name).toBe('app_runner1');
			expect(response.auth.type).toBe('app_token');
		});

		it('throws HfWhoamiRequestError(401) for invalid tokens', async () => {
			const error = await fetchHfWhoami('hf_invalid_token').catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(HfWhoamiRequestError);
			expect(error).toMatchObject({ kind: 'http', statusCode: 401 });
			expect(isHfWhoamiUnauthorizedError(error)).toBe(true);
		});

		it('throws HfWhoamiRequestError(503) during a simulated Hub outage', async () => {
			mockHub.setWhoamiOutage(true);
			const error = await fetchHfWhoami('hf_oauth_1').catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(HfWhoamiRequestError);
			expect(error).toMatchObject({ kind: 'http', statusCode: 503 });
			expect(isHfWhoamiUnauthorizedError(error)).toBe(false);
		});
	});

	describe('Hub URL allowlist & production loopback HTTP gate', () => {
		const originalNodeEnv = process.env.NODE_ENV;
		const originalAllowLoopback = process.env.ALLOW_LOOPBACK_HUB_URL;

		afterEach(() => {
			process.env.NODE_ENV = originalNodeEnv;
			if (originalAllowLoopback === undefined) {
				delete process.env.ALLOW_LOOPBACK_HUB_URL;
			} else {
				process.env.ALLOW_LOOPBACK_HUB_URL = originalAllowLoopback;
			}
		});

		it.each(['https://evil.example', 'http://huggingface.co', 'https://user:pass@huggingface.co'])(
			'rejects untrusted or insecure LOGGING_HUB_URL (%s)',
			(badUrl) => {
				expect(
					() =>
						new HfDatasetLogger({
							loggingToken: TEST_LOGGING_TOKEN,
							datasetId: TEST_DATASET_ID,
							hubUrl: badUrl,
							logType: 'Query',
						})
				).toThrow(/Invalid LOGGING_HUB_URL/);
			}
		);

		it('rejects loopback HTTP for HF_WHOAMI_URL and LOGGING_HUB_URL in production unless ALLOW_LOOPBACK_HUB_URL=true', async () => {
			process.env.NODE_ENV = 'production';
			delete process.env.ALLOW_LOOPBACK_HUB_URL;

			expect(
				() =>
					new HfDatasetLogger({
						loggingToken: TEST_LOGGING_TOKEN,
						datasetId: TEST_DATASET_ID,
						hubUrl: mockHub.baseUrl,
						logType: 'Query',
					})
			).toThrow(/ALLOW_LOOPBACK_HUB_URL=true/);

			process.env.HF_WHOAMI_URL = mockHub.whoamiUrl;
			await expect(fetchHfWhoami('hf_oauth_1')).rejects.toThrow(/ALLOW_LOOPBACK_HUB_URL=true/);

			// Explicit opt-in permits local mock-Hub harnesses under NODE_ENV=production
			process.env.ALLOW_LOOPBACK_HUB_URL = 'true';
			const response = await fetchHfWhoami('hf_oauth_1');
			expect(response.name).toBe('oauth_user_1');

			const logger = new HfDatasetLogger({
				loggingToken: TEST_LOGGING_TOKEN,
				datasetId: TEST_DATASET_ID,
				hubUrl: mockHub.baseUrl,
				logType: 'Query',
			});
			activeLoggers.push(logger);
		});
	});
});
