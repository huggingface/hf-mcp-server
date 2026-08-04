import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	HfDatasetLogger,
	type HfDatasetTransportOptions,
	type LogEntry,
	redactHfTokens,
	redactSensitiveLogValues,
} from '../../../src/server/utils/hf-dataset-transport.js';
import type { CommitOutput } from '@huggingface/hub';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

describe('HfDatasetLogger', () => {
	let logger: HfDatasetLogger;
	let testTempDir: string;

	beforeEach(() => {
		// Create isolated temp directory for each test
		testTempDir = join(tmpdir(), `hf-test-${Date.now()}`);
		mkdirSync(testTempDir, { recursive: true });
	});

	afterEach(async () => {
		if (logger) {
			await logger.destroy();
		}
		// Clean up temp directory
		if (existsSync(testTempDir)) {
			rmSync(testTempDir, { recursive: true, force: true });
		}
	});

	function createTestLogger(options: Partial<HfDatasetTransportOptions> = {}) {
		// Create a stub upload function that tracks calls
		const uploadCalls: unknown[] = [];
		const uploadStub = async (params: unknown): Promise<CommitOutput> => {
			uploadCalls.push(params);
			return {
				commit: { url: 'test-url', oid: 'test-oid' },
				hookOutput: 'test-hook-output',
			};
		};

		const logger = new HfDatasetLogger({
			loggingToken: 'test-token',
			datasetId: 'test/dataset',
			batchSize: 3,
			flushInterval: 1000, // Short interval for testing
			uploadFunction: uploadStub,
			...options,
		});

		// Attach the calls array to the logger for test access
		(logger as unknown as { uploadCalls: unknown[] }).uploadCalls = uploadCalls;
		return logger;
	}

	describe('Basic Buffer Management', () => {
		it('should buffer logs and flush when batch size is reached', async () => {
			logger = createTestLogger({ batchSize: 2 });

			// Add logs to reach batch size
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 1' });
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 2' });

			// Wait for flush to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should have triggered upload
			expect((logger as unknown as { uploadCalls: unknown[] }).uploadCalls.length).toBe(1);

			// Buffer should be empty after flush
			expect(logger.getStatus().bufferSize).toBe(0);
		});

		it('should flush logs on timer interval', async () => {
			logger = createTestLogger({ flushInterval: 100 }); // Very short interval

			// Add a single log (below batch size)
			logger.processLog({ level: 30, time: Date.now(), msg: 'Timer test' });

			expect(logger.getStatus().bufferSize).toBe(1);

			// Wait for timer flush
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should have triggered upload
			expect((logger as unknown as { uploadCalls: unknown[] }).uploadCalls.length).toBe(1);
		});

		it('should drop oldest logs when buffer exceeds maximum size', async () => {
			logger = createTestLogger({ batchSize: 20000, flushInterval: 60000 }); // Prevent auto-flush

			// Add logs to exceed buffer capacity (maxBufferSize = 10000)
			for (let i = 0; i < 10002; i++) {
				logger.processLog({
					level: 30,
					time: Date.now(),
					msg: `Message ${i}`,
				});
			}

			// Wait a bit to ensure all logs are processed
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Buffer should be at max size (10000), not 10002
			expect(logger.getStatus().bufferSize).toBe(10000);
		});
	});

	describe('Upload Behavior', () => {
		it('should not upload when buffer is empty', async () => {
			logger = createTestLogger();

			// Trigger manual flush with empty buffer
			await (logger as unknown as { flush: () => Promise<void> }).flush();

			// Should not upload
			expect((logger as unknown as { uploadCalls: unknown[] }).uploadCalls.length).toBe(0);
		});

		it('should handle upload failures gracefully', async () => {
			const failingUpload = async () => {
				throw new Error('Upload failed');
			};

			logger = createTestLogger({ uploadFunction: failingUpload });

			// Add logs
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test' });

			// Trigger flush
			await (logger as unknown as { flush: () => Promise<void> }).flush();

			// Logger should still be functional after failure
			expect(logger.getStatus().uploadInProgress).toBe(false);
			expect(logger.getStatus().bufferSize).toBe(1); // Logs should be retained for retry
		});

		it('should retry logs after 409 conflict error', async () => {
			let attemptCount = 0;
			const conflictThenSuccessUpload = async (params: unknown): Promise<CommitOutput> => {
				attemptCount++;
				if (attemptCount === 1) {
					// First attempt: simulate 409 conflict
					const error = new Error('Conflict');
					(error as unknown as { status: number }).status = 409;
					throw error;
				}
				// Second attempt: succeed
				return {
					commit: { url: 'test-url', oid: 'test-oid' },
					hookOutput: 'test-hook-output',
				};
			};

			logger = createTestLogger({
				uploadFunction: conflictThenSuccessUpload,
				batchSize: 10, // Prevent auto-flush
				flushInterval: 60000, // Prevent timer flush
			});

			// Add logs
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 409 retry' });

			// First flush should fail with 409
			await (logger as unknown as { flush: () => Promise<void> }).flush();
			expect(logger.getStatus().bufferSize).toBe(1); // Logs retained
			expect(attemptCount).toBe(1); // First attempt made

			// Second flush should succeed
			await (logger as unknown as { flush: () => Promise<void> }).flush();
			expect(logger.getStatus().bufferSize).toBe(0); // Logs uploaded successfully
			expect(attemptCount).toBe(2); // Two attempts made
		});

		it('should serialize concurrent uploads without dropping newly buffered logs', async () => {
			let uploadCallCount = 0;
			const uploadResolvers: Array<(result: CommitOutput) => void> = [];
			const slowUpload = (): Promise<CommitOutput> => {
				uploadCallCount++;
				return new Promise((resolve) => {
					uploadResolvers.push(resolve);
				});
			};
			const uploadResult: CommitOutput = {
				commit: { url: 'test-url', oid: 'test-oid' },
				hookOutput: 'test-hook-output',
			};

			logger = createTestLogger({ uploadFunction: slowUpload, batchSize: 1 });

			// Add log to trigger flush
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 1' });

			expect(logger.getStatus().uploadInProgress).toBe(true);
			expect(uploadCallCount).toBe(1);

			// Try to flush again while upload is in progress
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 2' });
			await (logger as unknown as { flush: () => Promise<void> }).flush();
			expect(uploadCallCount).toBe(1);

			uploadResolvers[0]?.(uploadResult);
			await new Promise((resolve) => setImmediate(resolve));

			expect(uploadCallCount).toBe(2);
			uploadResolvers[1]?.(uploadResult);
			await new Promise((resolve) => setImmediate(resolve));
			expect(logger.getStatus().bufferSize).toBe(0);
		}, 3000);
	});

	describe('Error Resilience', () => {
		it('should handle malformed log entries gracefully', () => {
			logger = createTestLogger();

			// Test various malformed inputs - none should crash
			expect(() => logger.processLog(null as unknown as LogEntry)).not.toThrow();
			expect(() => logger.processLog(undefined as unknown as LogEntry)).not.toThrow();
			expect(() => logger.processLog({} as LogEntry)).not.toThrow();
			expect(() => logger.processLog({ level: 'invalid' } as unknown as LogEntry)).not.toThrow();

			// Test circular reference
			const circularObj = { level: 30, time: Date.now(), msg: 'test' };
			(circularObj as unknown as { circular: unknown }).circular = circularObj;
			expect(() => logger.processLog(circularObj as LogEntry)).not.toThrow();

			// Logger should still be functional
			expect(logger.getStatus()).toBeDefined();
		});

		it('should handle concurrent processLog calls', async () => {
			logger = createTestLogger({ batchSize: 50 });

			// Simulate concurrent logging
			const promises = [];
			for (let i = 0; i < 100; i++) {
				promises.push(
					Promise.resolve().then(() => {
						logger.processLog({
							level: 30,
							time: Date.now(),
							msg: `Concurrent message ${i}`,
						});
					})
				);
			}

			// Should handle all concurrent calls without crashing
			await Promise.all(promises);

			const status = logger.getStatus();
			expect(status).toBeDefined();
			expect(status.bufferSize).toBeLessThanOrEqual(10000); // Should respect max buffer size
		});
	});

	describe('Status and Health Check', () => {
		it('should provide accurate status information', () => {
			logger = createTestLogger();

			// Add some logs
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 1' });
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test 2' });

			const status = logger.getStatus();

			expect(status).toHaveProperty('bufferSize');
			expect(status).toHaveProperty('uploadInProgress');
			expect(status).toHaveProperty('sessionId');

			expect(status.bufferSize).toBe(2);
			expect(status.uploadInProgress).toBe(false);
			expect(status.sessionId).toBeDefined();
		});
	});

	describe('Shutdown Behavior', () => {
		it('should flush remaining logs on shutdown', async () => {
			logger = createTestLogger();

			// Add logs
			logger.processLog({ level: 30, time: Date.now(), msg: 'Shutdown test' });

			// Destroy logger
			await logger.destroy();

			// Should have flushed logs
			expect((logger as unknown as { uploadCalls: unknown[] }).uploadCalls.length).toBe(1);
		});

		it('should handle shutdown gracefully even if flush fails', async () => {
			const failingUpload = async () => {
				throw new Error('Upload failed');
			};

			logger = createTestLogger({ uploadFunction: failingUpload });

			// Add logs
			logger.processLog({ level: 30, time: Date.now(), msg: 'Test' });

			// Destroy should not throw even if flush fails
			await expect(logger.destroy()).resolves.not.toThrow();
		});
	});

	describe('Memory Management', () => {
		it('should maintain reasonable memory usage under load', () => {
			logger = createTestLogger({ batchSize: 50 });

			// Add many logs
			for (let i = 0; i < 2000; i++) {
				logger.processLog({
					level: 30,
					time: Date.now(),
					msg: `Load test message ${i}`,
				});
			}

			const status = logger.getStatus();
			// Should not accumulate unlimited logs
			expect(status.bufferSize).toBeLessThanOrEqual(10000);
		});

		it('should handle large log messages efficiently', () => {
			logger = createTestLogger({ batchSize: 2 });

			// Create large log message
			const largeMessage = 'x'.repeat(10000);

			expect(() => {
				logger.processLog({
					level: 30,
					time: Date.now(),
					msg: largeMessage,
				});
			}).not.toThrow();

			const status = logger.getStatus();
			expect(status.bufferSize).toBe(1);
		});
	});

	describe('Token redaction', () => {
		it('redacts supported Hugging Face credential formats without corrupting identifiers', () => {
			const credentials = [
				`hf_${'a'.repeat(34)}`,
				`hf_app_${'b'.repeat(32)}`,
				`hf_oauth_${'c'.repeat(32)}.${'d'.repeat(32)}.${'e'.repeat(32)}`,
				`hf_oauth__refresh_${'f'.repeat(34)}`,
				`hf_jwt_${'g'.repeat(32)}.${'h'.repeat(32)}.${'i'.repeat(32)}`,
				`hf_s3_${'j'.repeat(32)}.${'k'.repeat(32)}.${'l'.repeat(32)}`,
				`oauth_app_secret_${'m'.repeat(34)}`,
			];
			for (const credential of credentials) {
				expect(redactHfTokens(`Bearer ${credential} extra`)).toBe('Bearer REDACTED_TOKEN extra');
			}
			for (const identifier of [
				'hf_sandbox',
				'hf_sandbox_exec',
				'hf_sandbox_fs',
				'hf_semantic_search',
				'hf_oauth_config',
				'hf_jwt_debug',
				'hf_s3_client',
			]) {
				expect(redactHfTokens(identifier)).toBe(identifier);
			}
			expect(redactHfTokens(`hf_${'a'.repeat(35)}`)).toBe(`hf_${'a'.repeat(35)}`);
		});

		it('redacts nested sensitive values while preserving their keys', () => {
			expect(
				redactSensitiveLogValues({
					secrets: { HF_TOKEN: `hf_oauth_${'a'.repeat(64)}` },
					environment: { SAFE: 'value' },
					nested: {
						access_token: `hf_${'b'.repeat(34)}`,
						clientSecret: 'secret',
						'x-api-key': 'key',
						label: 'keep',
					},
				})
			).toEqual({
				secrets: '<redacted>',
				environment: '<redacted>',
				nested: {
					access_token: '<redacted>',
					clientSecret: '<redacted>',
					'x-api-key': '<redacted>',
					label: 'keep',
				},
			});
		});

		it('redacts tokens before upload', async () => {
			const uploadCalls: unknown[] = [];
			const uploadStub = async (params: unknown): Promise<CommitOutput> => {
				uploadCalls.push(params);
				return {
					commit: { url: 'test-url', oid: 'test-oid' },
					hookOutput: 'test-hook-output',
				};
			};

			logger = new HfDatasetLogger({
				loggingToken: 'test-token',
				datasetId: 'test/dataset',
				batchSize: 10,
				flushInterval: 60000,
				uploadFunction: uploadStub,
			});

			logger.processLog({
				level: 30,
				time: Date.now(),
				msg: `Contains hf_oauth_${'x'.repeat(32)}.${'y'.repeat(32)}.${'z'.repeat(32)} in message`,
				apiKey: 'non-hf-secret',
			});

			await (logger as unknown as { flush: () => Promise<void> }).flush();

			const blobContent = uploadCalls[0] as {
				file: { content: Blob };
			};
			const uploaded = await blobContent.file.content.text();

			expect(uploaded).toContain('REDACTED_TOKEN');
			expect(uploaded).not.toContain('hf_oauth_');
			expect(uploaded).not.toContain('non-hf-secret');
		});
	});
});
