export interface ExternalAddressOptions {
	allowDnsRebindMitigation?: boolean;
}

const INTERNAL_ADDRESS_HOST_ALLOWLIST_ENV = 'ALLOW_INTERNAL_ADDRESS_HOSTS';

function normalizeHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.+$/, '');
}

function getInternalAddressHostAllowlist(): string[] {
	const raw = process.env[INTERNAL_ADDRESS_HOST_ALLOWLIST_ENV];
	if (!raw) {
		return [];
	}

	return raw
		.split(',')
		.map((entry) => normalizeHostname(entry))
		.filter((entry) => entry.length > 0);
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
	if (pattern.startsWith('*.')) {
		const baseDomain = pattern.slice(2);
		if (!baseDomain) {
			return false;
		}
		return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
	}

	return hostname === pattern;
}

function isInternalAddressAllowedForHostname(hostname: string): boolean {
	const normalizedHostname = normalizeHostname(hostname);
	if (!normalizedHostname) {
		return false;
	}

	const allowlist = getInternalAddressHostAllowlist();
	if (allowlist.length === 0) {
		return false;
	}

	return allowlist.some((pattern) => hostnameMatchesPattern(normalizedHostname, pattern));
}

function normalizeIpLiteral(host: string): string {
	if (host.startsWith('[') && host.endsWith(']')) {
		return host.slice(1, -1);
	}
	return host;
}

function parseIpv4ToInt(ip: string): number {
	const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
		throw new Error(`Invalid IPv4 address: ${ip}`);
	}

	return parts.reduce((acc, part) => acc * 256 + part, 0);
}

function ipv4InRange(ipValue: number, start: string, end: string): boolean {
	const startValue = parseIpv4ToInt(start);
	const endValue = parseIpv4ToInt(end);
	return ipValue >= startValue && ipValue <= endValue;
}

function isIpv4InternalOrReserved(ip: string): boolean {
	const value = parseIpv4ToInt(ip);

	return (
		ipv4InRange(value, '0.0.0.0', '0.255.255.255') ||
		ipv4InRange(value, '10.0.0.0', '10.255.255.255') ||
		ipv4InRange(value, '100.64.0.0', '100.127.255.255') ||
		ipv4InRange(value, '127.0.0.0', '127.255.255.255') ||
		ipv4InRange(value, '169.254.0.0', '169.254.255.255') ||
		ipv4InRange(value, '172.16.0.0', '172.31.255.255') ||
		ipv4InRange(value, '192.0.0.0', '192.0.0.255') ||
		ipv4InRange(value, '192.0.2.0', '192.0.2.255') ||
		ipv4InRange(value, '192.88.99.0', '192.88.99.255') ||
		ipv4InRange(value, '192.168.0.0', '192.168.255.255') ||
		ipv4InRange(value, '198.18.0.0', '198.19.255.255') ||
		ipv4InRange(value, '198.51.100.0', '198.51.100.255') ||
		ipv4InRange(value, '203.0.113.0', '203.0.113.255') ||
		ipv4InRange(value, '224.0.0.0', '239.255.255.255') ||
		ipv4InRange(value, '240.0.0.0', '255.255.255.255')
	);
}

function parseIpv6ToBigInt(ip: string): bigint {
	const zoneIndex = ip.indexOf('%');
	const zoneStripped = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;

	let working = zoneStripped;
	if (working.includes('.')) {
		const lastColon = working.lastIndexOf(':');
		if (lastColon < 0) {
			throw new Error(`Invalid IPv6 address: ${ip}`);
		}
		const ipv4Part = working.slice(lastColon + 1);
		const ipv4Value = parseIpv4ToInt(ipv4Part);
		const high = ((ipv4Value >>> 16) & 0xffff).toString(16);
		const low = (ipv4Value & 0xffff).toString(16);
		working = `${working.slice(0, lastColon)}:${high}:${low}`;
	}

	const split = working.split('::');
	if (split.length > 2) {
		throw new Error(`Invalid IPv6 address: ${ip}`);
	}

	const left = split[0] ? split[0].split(':').filter(Boolean) : [];
	const right = split[1] ? split[1].split(':').filter(Boolean) : [];
	const missingCount = 8 - (left.length + right.length);

	if (split.length === 1 && missingCount !== 0) {
		throw new Error(`Invalid IPv6 address: ${ip}`);
	}

	if (missingCount < 0) {
		throw new Error(`Invalid IPv6 address: ${ip}`);
	}

	const full = [...left, ...Array.from({ length: missingCount }, () => '0'), ...right];
	if (full.length !== 8) {
		throw new Error(`Invalid IPv6 address: ${ip}`);
	}

	let value = 0n;
	for (const part of full) {
		const segment = Number.parseInt(part, 16);
		if (Number.isNaN(segment) || segment < 0 || segment > 0xffff) {
			throw new Error(`Invalid IPv6 address: ${ip}`);
		}
		value = (value << 16n) + BigInt(segment);
	}

	return value;
}

function isIpv6InCidr(ipValue: bigint, prefixValue: bigint, prefixLength: number): boolean {
	const hostBits = 128n - BigInt(prefixLength);
	const mask = ((1n << BigInt(prefixLength)) - 1n) << hostBits;
	return (ipValue & mask) === (prefixValue & mask);
}

function isIpv6InternalOrReserved(ip: string): boolean {
	const value = parseIpv6ToBigInt(ip);

	if (value === 0n || value === 1n) {
		return true;
	}

	// IPv4-mapped IPv6 ::ffff:a.b.c.d
	if (value >> 32n === 0xffffn) {
		const ipv4Value = Number(value & 0xffffffffn);
		const octet1 = (ipv4Value >>> 24) & 0xff;
		const octet2 = (ipv4Value >>> 16) & 0xff;
		const octet3 = (ipv4Value >>> 8) & 0xff;
		const octet4 = ipv4Value & 0xff;
		return isIpv4InternalOrReserved(
			`${octet1.toString()}.${octet2.toString()}.${octet3.toString()}.${octet4.toString()}`
		);
	}

	return (
		isIpv6InCidr(value, 0xfc00n << 112n, 7) || // Unique local
		isIpv6InCidr(value, 0xfe80n << 112n, 10) || // Link-local
		isIpv6InCidr(value, 0xff00n << 112n, 8) || // Multicast
		isIpv6InCidr(value, 0x20010db8n << 96n, 32) || // Documentation
		isIpv6InCidr(value, 0x20010010n << 96n, 28) // ORCHID
	);
}

export function isIpInternalOrReserved(ip: string): boolean {
	const normalizedIp = normalizeIpLiteral(ip);
	const ipVersion = detectIpVersion(normalizedIp);
	if (ipVersion === 0) {
		throw new Error(`Invalid IP address: ${ip}`);
	}

	if (ipVersion === 4) {
		return isIpv4InternalOrReserved(normalizedIp);
	}

	return isIpv6InternalOrReserved(normalizedIp);
}

async function lookupAll(hostname: string): Promise<string[]> {
	const { lookup } = await import('node:dns/promises');
	const results = await lookup(hostname, { all: true, verbatim: true });
	return results.map((entry) => entry.address);
}

function detectIpVersion(candidate: string): 0 | 4 | 6 {
	try {
		parseIpv4ToInt(candidate);
		return 4;
	} catch {
		// continue to ipv6 parsing
	}

	try {
		parseIpv6ToBigInt(candidate);
		return 6;
	} catch {
		return 0;
	}
}

export async function assertExternalAddress(hostname: string, options: ExternalAddressOptions = {}): Promise<void> {
	const { allowDnsRebindMitigation = true } = options;
	const normalized = normalizeHostname(hostname);

	if (!normalized) {
		throw new Error('Hostname is required for external address check');
	}

	const allowInternalAddress = isInternalAddressAllowedForHostname(normalized);

	const ipLiteral = normalizeIpLiteral(normalized);
	const ipVersion = detectIpVersion(ipLiteral);
	if (ipVersion !== 0) {
		if (isIpInternalOrReserved(ipLiteral)) {
			throw new Error(`Blocked internal or reserved address: ${ipLiteral}`);
		}
		return;
	}

	const firstLookup = await lookupAll(normalized);
	if (firstLookup.length === 0) {
		throw new Error(`No DNS records found for hostname: ${normalized}`);
	}

	for (const address of firstLookup) {
		if (isIpInternalOrReserved(address) && !allowInternalAddress) {
			throw new Error(`Blocked internal or reserved address for hostname ${normalized}: ${address}`);
		}
	}

	if (allowDnsRebindMitigation) {
		const secondLookup = await lookupAll(normalized);
		for (const address of secondLookup) {
			if (isIpInternalOrReserved(address) && !allowInternalAddress) {
				throw new Error(`Blocked internal or reserved address for hostname ${normalized}: ${address}`);
			}
		}
	}
}
