import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HfWhoamiRequestError,
	fetchHfWhoami,
	type HfWhoamiResponse,
} from '../../../src/server/utils/hf-whoami-client.js';
import { logger } from '../../../src/server/utils/logger.js';
import { BaseTransport, type ServerFactory } from '../../../src/server/transport/base-transport.js';

vi.mock('../../../src/server/utils/hf-whoami-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/server/utils/hf-whoami-client.js')>();
	return {
		...actual,
		fetchHfWhoami: vi.fn(),
	};
});

vi.mock('../../../src/server/utils/logger.js', () => ({
	logger: {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	},
}));

class AuthTestTransport extends BaseTransport {
	override async initialize(): Promise<void> {}

	override async cleanup(): Promise<void> {}

	validate(headers: Record<string, string>) {
		return this.validateAuthAndTrackMetrics(headers);
	}
}

const authenticatedUser = {
	id: 'user-id',
	type: 'user',
	name: 'alice',
	orgs: [],
	auth: { type: 'oauth', expiresAt: '2027-08-05T00:00:00.000Z' },
} satisfies HfWhoamiResponse;

function assertNoTokenInLogs(token: string): void {
	const logged = JSON.stringify(
		[
			...vi.mocked(logger.trace).mock.calls,
			...vi.mocked(logger.debug).mock.calls,
			...vi.mocked(logger.info).mock.calls,
			...vi.mocked(logger.warn).mock.calls,
			...vi.mocked(logger.error).mock.calls,
			...vi.mocked(logger.fatal).mock.calls,
		],
	);
	expect(logged).not.toContain(token);
}

describe('BaseTransport whoami authentication', () => {
	let transport: AuthTestTransport;

	beforeEach(() => {
		vi.mocked(fetchHfWhoami).mockReset();
		delete process.env.MCP_STRICT_TOKEN;
		transport = new AuthTestTransport(vi.fn() as unknown as ServerFactory, {} as Express);
	});

	it('uses the direct whoami client and tracks an authenticated connection', async () => {
		vi.mocked(fetchHfWhoami).mockResolvedValue(authenticatedUser);

		const result = await transport.validate({ authorization: 'Bearer hf_oauth_token' });

		expect(fetchHfWhoami).toHaveBeenCalledWith('hf_oauth_token');
		expect(result).toEqual({
			shouldContinue: true,
			userIdentified: true,
			authenticatedUser,
		});
		expect(transport.getMetrics().connections.authenticated).toBe(1);
	});

	it('rejects only a direct whoami 401 as unauthorized', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));

		const result = await transport.validate({ authorization: 'Bearer invalid-token' });

		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 401,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.unauthorized).toBe(1);
	});

	it('retains fail-open behavior for non-401 upstream failures', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 500));

		const result = await transport.validate({ authorization: 'Bearer hf_token' });

		expect(result).toEqual({
			shouldContinue: true,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.authenticated).toBe(0);
		expect(transport.getMetrics().connections.unauthorized).toBeUndefined();
	});

	it('does not include the token value in logs when whoami rejects the token', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));

		await transport.validate({ authorization: 'Bearer secret-token-abc' });

		assertNoTokenInLogs('secret-token-abc');
	});
});

describe('BaseTransport strict token mode', () => {
	let transport: AuthTestTransport;

	beforeEach(() => {
		vi.mocked(fetchHfWhoami).mockReset();
		delete process.env.MCP_STRICT_TOKEN;
		transport = new AuthTestTransport(vi.fn() as unknown as ServerFactory, {} as Express);
	});

	afterEach(() => {
		delete process.env.MCP_STRICT_TOKEN;
	});

	it('keeps the default fail-open behavior when strict mode is disabled', async () => {
		const result = await transport.validate({});

		expect(fetchHfWhoami).not.toHaveBeenCalled();
		expect(result).toEqual({
			shouldContinue: true,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.anonymous).toBe(1);
	});

	it('rejects a token-less request with 401 when strict mode is enabled', async () => {
		process.env.MCP_STRICT_TOKEN = 'true';

		const result = await transport.validate({});

		expect(fetchHfWhoami).not.toHaveBeenCalled();
		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 401,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.unauthorized).toBe(1);
		expect(transport.getMetrics().connections.anonymous).toBe(0);
	});

	it('rejects an empty bearer token with 401 when strict mode is enabled', async () => {
		process.env.MCP_STRICT_TOKEN = 'true';

		const result = await transport.validate({ authorization: 'Bearer' });

		expect(fetchHfWhoami).not.toHaveBeenCalled();
		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 401,
			userIdentified: false,
		});
	});

	it('rejects a whitespace-only bearer token with 401 when strict mode is enabled', async () => {
		process.env.MCP_STRICT_TOKEN = 'true';

		const result = await transport.validate({ authorization: 'Bearer    ' });

		expect(fetchHfWhoami).not.toHaveBeenCalled();
		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 401,
			userIdentified: false,
		});
	});

	it('validates a supplied token through whoami when strict mode is enabled', async () => {
		process.env.MCP_STRICT_TOKEN = 'true';
		vi.mocked(fetchHfWhoami).mockResolvedValue(authenticatedUser);

		const result = await transport.validate({ authorization: 'Bearer hf_valid_token' });

		expect(fetchHfWhoami).toHaveBeenCalledWith('hf_valid_token');
		expect(result).toEqual({
			shouldContinue: true,
			userIdentified: true,
			authenticatedUser,
		});
		expect(transport.getMetrics().connections.authenticated).toBe(1);
	});

	it('does not include token values in logs when rejecting in strict mode', async () => {
		process.env.MCP_STRICT_TOKEN = 'true';
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));

		await transport.validate({});
		await transport.validate({ authorization: 'Bearer secret-token-xyz' });

		assertNoTokenInLogs('secret-token-xyz');
	});
});
