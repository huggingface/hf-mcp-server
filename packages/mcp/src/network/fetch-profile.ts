import { safeFetch, type SafeFetchResult } from './safe-fetch.js';
import {
	createExternalHttpsPolicy,
	createGradioMcpHostPolicy,
	createGradioSchemaHostPolicy,
	createHfDocsPolicy,
	createHttpOrHttpsPolicy,
	createHuggingFaceHubPolicy,
	createLocalhostHttpPolicy,
	isLocalhostHostname,
	type UrlProtocol,
	type UrlPolicy,
} from './url-policy.js';

const DEFAULT_TIMEOUT_MS = 12_500;
const DEFAULT_MAX_REDIRECTS = 3;

export interface SafeFetchProfile {
	urlPolicy: UrlPolicy;
	timeoutMs: number;
	maxRedirects: number;
	externalOnly: boolean;
}

export interface FetchWithProfileOptions {
	requestInit?: RequestInit;
	timeoutMs?: number;
}

export async function fetchWithProfile(
	url: string | URL,
	profile: SafeFetchProfile,
	options: FetchWithProfileOptions = {}
): Promise<SafeFetchResult> {
	return safeFetch(url, {
		urlPolicy: profile.urlPolicy,
		timeoutMs: options.timeoutMs ?? profile.timeoutMs,
		maxRedirects: profile.maxRedirects,
		externalOnly: profile.externalOnly,
		requestInit: options.requestInit,
	});
}

export const NETWORK_FETCH_PROFILES = {
	externalHttps(): SafeFetchProfile {
		return {
			urlPolicy: createExternalHttpsPolicy(),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxRedirects: DEFAULT_MAX_REDIRECTS,
			externalOnly: true,
		};
	},
	httpOrHttpsPermissive(): SafeFetchProfile {
		return {
			urlPolicy: createHttpOrHttpsPolicy(),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxRedirects: DEFAULT_MAX_REDIRECTS,
			externalOnly: false,
		};
	},
	streamableProxy(): SafeFetchProfile {
		return {
			urlPolicy: createHttpOrHttpsPolicy(),
			timeoutMs: 0,
			maxRedirects: DEFAULT_MAX_REDIRECTS,
			externalOnly: false,
		};
	},
	hfHub(): SafeFetchProfile {
		return {
			urlPolicy: createHuggingFaceHubPolicy(),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxRedirects: DEFAULT_MAX_REDIRECTS,
			externalOnly: true,
		};
	},
	hfDocs(): SafeFetchProfile {
		return {
			urlPolicy: createHfDocsPolicy(),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxRedirects: 5,
			externalOnly: true,
		};
	},
	localhostHttp(): SafeFetchProfile {
		return {
			urlPolicy: createLocalhostHttpPolicy(),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			maxRedirects: 2,
			externalOnly: false,
		};
	},
	gradioSchemaHost(hostname: string): SafeFetchProfile {
		return {
			urlPolicy: createGradioSchemaHostPolicy(hostname),
			timeoutMs: 10_000,
			maxRedirects: 2,
			externalOnly: !isLocalhostHostname(hostname),
		};
	},
	gradioMcpHost(
		hostname: string,
		allowedProtocol: UrlProtocol
	): SafeFetchProfile {
		return {
			urlPolicy: createGradioMcpHostPolicy(hostname, allowedProtocol),
			timeoutMs: 0,
			maxRedirects: 0,
			externalOnly: !isLocalhostHostname(hostname) && process.env.NODE_ENV !== 'test',
		};
	},
};
