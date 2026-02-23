export interface UrlPathRules {
	requiredPrefix?: string;
}

export type UrlProtocol = 'https:' | 'http:';

export interface UrlQueryRules {
	allowAny?: boolean;
	allowKeys?: ReadonlySet<string>;
}

export interface UrlPolicy {
	allowedProtocols: ReadonlySet<UrlProtocol>;
	allowedHosts?: ReadonlySet<string>;
	allowSubdomainsOf?: readonly string[];
	requireDefaultPort?: boolean;
	pathRules?: UrlPathRules;
	queryRules?: UrlQueryRules;
	allowCredentials?: boolean;
	customValidator?: (url: URL) => void;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;
const ENCODED_BYTE_RE = /%[0-9a-f]{2}/i;
const INVALID_PERCENT_ENCODING_RE = /%(?![0-9a-f]{2})/i;

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, '');
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error('URL contains invalid percent-encoding');
	}
}

function collectDecodedPathVariants(pathname: string): string[] {
	const variants = [pathname];
	let current = pathname;

	for (let i = 0; i < 2; i += 1) {
		if (!current.includes('%')) {
			break;
		}

		const decoded = safeDecodeURIComponent(current);
		if (decoded === current) {
			break;
		}

		variants.push(decoded);
		current = decoded;
	}

	return variants;
}

function hasDotSegments(pathname: string): boolean {
	const normalized = pathname.replace(/\\/g, '/');
	const segments = normalized.split('/');
	return segments.some((segment) => segment === '.' || segment === '..');
}

function matchesRequiredPrefix(pathname: string, requiredPrefix: string): boolean {
	const normalizedPath = pathname.replace(/\\/g, '/');
	const normalizedPrefix = requiredPrefix.replace(/\\/g, '/');

	if (normalizedPath === normalizedPrefix) {
		return true;
	}

	if (normalizedPrefix.endsWith('/') && normalizedPath === normalizedPrefix.slice(0, -1)) {
		return true;
	}

	return normalizedPath.startsWith(normalizedPrefix);
}

function assertHostAllowed(hostname: string, policy: UrlPolicy): void {
	if (!policy.allowedHosts && (!policy.allowSubdomainsOf || policy.allowSubdomainsOf.length === 0)) {
		return;
	}

	const normalized = normalizeHostname(hostname);

	if (policy.allowedHosts) {
		for (const host of policy.allowedHosts) {
			if (normalizeHostname(host) === normalized) {
				return;
			}
		}
	}

	if (policy.allowSubdomainsOf) {
		for (const domain of policy.allowSubdomainsOf) {
			const normalizedDomain = normalizeHostname(domain);
			if (normalized === normalizedDomain || normalized.endsWith(`.${normalizedDomain}`)) {
				return;
			}
		}
	}

	throw new Error(`URL hostname is not allowed: ${hostname}`);
}

function assertPathAllowed(url: URL, pathRules?: UrlPathRules): void {
	const pathname = url.pathname;

	if (pathname.includes('%') && INVALID_PERCENT_ENCODING_RE.test(pathname)) {
		throw new Error('URL path contains invalid percent-encoding');
	}

	const variants = collectDecodedPathVariants(pathname);

	const hasEncodedSeparators = variants.some((variant) => ENCODED_SEPARATOR_RE.test(variant));
	if (hasEncodedSeparators) {
		throw new Error('URL path contains encoded separators');
	}

	const hasUnsafeDotSegments = variants.some((variant) => hasDotSegments(variant));
	if (hasUnsafeDotSegments) {
		throw new Error('URL path contains dot-segments');
	}

	if (variants.length > 1) {
		const decodedOnce = variants[1] ?? '';
		if (ENCODED_BYTE_RE.test(decodedOnce)) {
			throw new Error('URL path appears to use double-encoding');
		}
	}

	if (pathRules?.requiredPrefix) {
		const hasPrefix = variants.some((variant) => matchesRequiredPrefix(variant, pathRules.requiredPrefix ?? ''));
		if (!hasPrefix) {
			throw new Error(`URL path must start with ${pathRules.requiredPrefix}`);
		}
	}
}

function assertQueryAllowed(url: URL, policy: UrlPolicy): void {
	const rules = policy.queryRules;
	if (!rules || rules.allowAny === true) {
		return;
	}

	if (!rules.allowKeys) {
		if (url.search.length > 0) {
			throw new Error('URL query string is not allowed');
		}
		return;
	}

	for (const key of url.searchParams.keys()) {
		if (!rules.allowKeys.has(key)) {
			throw new Error(`URL query parameter is not allowed: ${key}`);
		}
	}
}

function assertPortAllowed(url: URL, policy: UrlPolicy): void {
	if (!policy.requireDefaultPort || url.port.length === 0) {
		return;
	}

	const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
	if (!defaultPort || url.port !== defaultPort) {
		throw new Error(`URL port is not allowed for protocol ${url.protocol}`);
	}
}

export function validateUrlAgainstPolicy(url: URL, policy: UrlPolicy): void {
	if (!policy.allowedProtocols.has(url.protocol as UrlProtocol)) {
		throw new Error(`URL protocol is not allowed: ${url.protocol}`);
	}

	if (!policy.allowCredentials && (url.username.length > 0 || url.password.length > 0)) {
		throw new Error('URL credentials are not allowed');
	}

	assertHostAllowed(url.hostname, policy);
	assertPortAllowed(url, policy);
	assertPathAllowed(url, policy.pathRules);
	assertQueryAllowed(url, policy);

	policy.customValidator?.(url);
}

export function parseAndValidateUrl(input: string | URL, policy: UrlPolicy): URL {
	const parsed = input instanceof URL ? new URL(input.toString()) : new URL(input.trim());
	validateUrlAgainstPolicy(parsed, policy);
	return parsed;
}

export function createHfDocsPolicy(): UrlPolicy {
	const hfHosts = new Set(['huggingface.co', 'www.huggingface.co']);

	return {
		allowedProtocols: new Set(['https:']),
		allowedHosts: new Set(['huggingface.co', 'www.huggingface.co', 'gradio.app', 'www.gradio.app']),
		allowCredentials: false,
		queryRules: { allowAny: true },
		customValidator: (url) => {
			const host = normalizeHostname(url.hostname);
			if (hfHosts.has(host) && !matchesRequiredPrefix(url.pathname, '/docs/')) {
				throw new Error('Hugging Face docs URLs must remain under /docs/');
			}
		},
	};
}

export function createGradioMcpPolicy(): UrlPolicy {
	return {
		allowedProtocols: new Set(['https:', 'http:']),
		pathRules: {
			requiredPrefix: '/gradio_api/mcp',
		},
		allowCredentials: false,
		queryRules: { allowAny: true },
		customValidator: (url) => {
			const enforceLocalHttpOnly = process.env.NODE_ENV === 'production';
			if (enforceLocalHttpOnly && url.protocol === 'http:' && !isLocalhostHostname(url.hostname)) {
				throw new Error('HTTP is only allowed for localhost Gradio MCP endpoints');
			}
		},
	};
}

export function isLocalhostHostname(hostname: string): boolean {
	return LOCALHOST_HOSTS.has(normalizeHostname(hostname));
}

export function createExternalHttpsPolicy(): UrlPolicy {
	return {
		allowedProtocols: new Set(['https:']),
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}

export function createHuggingFaceHubPolicy(): UrlPolicy {
	return {
		allowedProtocols: new Set(['https:']),
		allowedHosts: new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']),
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}

export function createLocalhostHttpPolicy(): UrlPolicy {
	return {
		allowedProtocols: new Set(['https:', 'http:']),
		allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]']),
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}

export function createExactHostPolicy(hostname: string, allowedProtocol: UrlProtocol): UrlPolicy {
	return {
		allowedProtocols: new Set([allowedProtocol]),
		allowedHosts: new Set([hostname.toLowerCase()]),
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}

export function createHostPrefixPolicy(
	hostname: string,
	requiredPrefix: string,
	allowedProtocol: UrlProtocol = 'https:'
): UrlPolicy {
	return {
		allowedProtocols: new Set([allowedProtocol]),
		allowedHosts: new Set([hostname.toLowerCase()]),
		pathRules: {
			requiredPrefix,
		},
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}

export function createGradioMcpHostPolicy(
	hostname: string,
	allowedProtocol: UrlProtocol
): UrlPolicy {
	return createHostPrefixPolicy(hostname, '/gradio_api/mcp', allowedProtocol);
}

export function createGradioSchemaHostPolicy(hostname: string): UrlPolicy {
	return createHostPrefixPolicy(hostname, '/gradio_api/mcp/schema');
}

export function createHttpOrHttpsPolicy(): UrlPolicy {
	return {
		allowedProtocols: new Set(['https:', 'http:']),
		allowCredentials: false,
		queryRules: { allowAny: true },
	};
}
