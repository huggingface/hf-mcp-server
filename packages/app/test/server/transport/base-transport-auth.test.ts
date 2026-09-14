import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HfWhoamiRequestError,
	fetchHfWhoami,
	type HfWhoamiResponse,
} from '../../../src/server/utils/hf-whoami-client.js';
import { BaseTransport, type ServerFactory } from '../../../src/server/transport/base-transport.js';

vi.mock('../../../src/server/utils/hf-whoami-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/server/utils/hf-whoami-client.js')>();
	return {
		...actual,
		fetchHfWhoami: vi.fn(),
	};
});

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
	auth: { type: 'access_token', expiresAt: '2027-08-05T00:00:00.000Z' },
} satisfies HfWhoamiResponse;

describe('BaseTransport whoami authentication', () => {
	let transport: AuthTestTransport;

	beforeEach(() => {
		vi.mocked(fetchHfWhoami).mockReset();
		transport = new AuthTestTransport(vi.fn() as unknown as ServerFactory, {} as Express);
	});

	it('uses the direct whoami client and tracks an authenticated connection', async () => {
		vi.mocked(fetchHfWhoami).mockResolvedValue(authenticatedUser);

		const result = await transport.validate({ authorization: 'Bearer hf_pat_token' });

		expect(fetchHfWhoami).toHaveBeenCalledWith('hf_pat_token');
		expect(result).toEqual({
			shouldContinue: true,
			userIdentified: true,
			authenticatedUser,
		});
		expect(transport.getMetrics().connections.authenticated).toBe(1);
	});

	it('rejects a direct whoami 401 as unauthorized', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 401));

		const result = await transport.validate({ authorization: 'Bearer invalid-token' });

		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 401,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.unauthorized).toBe(1);
	});

	it('fails closed for non-401 upstream failures', async () => {
		vi.mocked(fetchHfWhoami).mockRejectedValue(new HfWhoamiRequestError('http', 500));

		const result = await transport.validate({ authorization: 'Bearer hf_token' });

		expect(result).toEqual({
			shouldContinue: false,
			statusCode: 503,
			userIdentified: false,
		});
		expect(transport.getMetrics().connections.authenticated).toBe(0);
		expect(transport.getMetrics().connections.unauthorized).toBeUndefined();
	});
});
