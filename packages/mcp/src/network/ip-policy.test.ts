import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertExternalAddress, isIpInternalOrReserved } from './ip-policy.js';

const { lookupMock } = vi.hoisted(() => ({
	lookupMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
	lookup: lookupMock,
}));

describe('ip-policy', () => {
	afterEach(() => {
		lookupMock.mockReset();
		delete process.env.ALLOW_INTERNAL_ADDRESS_HOSTS;
	});

	it('classifies internal/reserved IPv4 ranges', () => {
		expect(isIpInternalOrReserved('127.0.0.1')).toBe(true);
		expect(isIpInternalOrReserved('10.1.2.3')).toBe(true);
		expect(isIpInternalOrReserved('172.20.10.2')).toBe(true);
		expect(isIpInternalOrReserved('192.168.1.1')).toBe(true);
		expect(isIpInternalOrReserved('8.8.8.8')).toBe(false);
	});

	it('classifies internal/reserved IPv6 ranges', () => {
		expect(isIpInternalOrReserved('::1')).toBe(true);
		expect(isIpInternalOrReserved('fc00::1')).toBe(true);
		expect(isIpInternalOrReserved('fe80::1')).toBe(true);
		expect(isIpInternalOrReserved('2001:db8::1')).toBe(true);
		expect(isIpInternalOrReserved('2607:f8b0:4005:80a::200e')).toBe(false);
	});

	it('blocks internal literal addresses in assertExternalAddress', async () => {
		await expect(assertExternalAddress('127.0.0.1')).rejects.toThrow('Blocked internal or reserved address');
		await expect(assertExternalAddress('::1')).rejects.toThrow('Blocked internal or reserved address');
	});

	it('allows external literal addresses in assertExternalAddress', async () => {
		await expect(assertExternalAddress('8.8.8.8')).resolves.toBeUndefined();
	});

	it('blocks hostnames resolving to internal addresses by default', async () => {
		lookupMock.mockResolvedValue([{ address: '10.0.246.93' }]);

		await expect(assertExternalAddress('huggingface.co')).rejects.toThrow(
			'Blocked internal or reserved address for hostname huggingface.co: 10.0.246.93'
		);
	});

	it('allows allowlisted hostnames to resolve to internal addresses', async () => {
		process.env.ALLOW_INTERNAL_ADDRESS_HOSTS = 'huggingface.co,*.hf.space';
		lookupMock.mockResolvedValue([{ address: '10.0.246.93' }]);

		await expect(assertExternalAddress('huggingface.co')).resolves.toBeUndefined();
		await expect(assertExternalAddress('demo.hf.space')).resolves.toBeUndefined();
	});
});
