import { describe, expect, it } from 'vitest';
import { assertExternalAddress, isIpInternalOrReserved } from './ip-policy.js';

describe('ip-policy', () => {
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
});
