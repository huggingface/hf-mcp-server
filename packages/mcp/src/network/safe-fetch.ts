import { assertExternalAddress } from './ip-policy.js';
import { parseAndValidateUrl, type UrlPolicy } from './url-policy.js';

export interface SafeFetchOptions {
	urlPolicy: UrlPolicy;
	timeoutMs?: number;
	maxRedirects?: number;
	externalOnly?: boolean;
	requestInit?: RequestInit;
	stripSensitiveHeadersOnCrossHostRedirect?: boolean;
}

export interface SafeFetchResult {
	response: Response;
	finalUrl: URL;
	redirectsFollowed: number;
}

const DEFAULT_TIMEOUT_MS = 12500;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-hf-authorization']);

function isRedirectStatus(status: number): boolean {
	return REDIRECT_STATUSES.has(status);
}

function dropSensitiveHeaders(headersInit: HeadersInit | undefined): Headers {
	const headers = new Headers(headersInit);
	for (const key of SENSITIVE_HEADERS) {
		headers.delete(key);
	}
	return headers;
}

function withMethodAndBody(requestInit: RequestInit, method: string, body: BodyInit | null | undefined): RequestInit {
	const nextInit: RequestInit = {
		...requestInit,
		method,
		redirect: 'manual',
	};

	if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
		nextInit.body = body;
	} else {
		delete nextInit.body;
	}

	return nextInit;
}

async function fetchWithTimeout(url: URL, requestInit: RequestInit, timeoutMs: number): Promise<Response> {
	if (timeoutMs <= 0) {
		return fetch(url.toString(), {
			...requestInit,
			redirect: 'manual',
		});
	}

	const controller = new AbortController();
	const outerSignal = requestInit.signal;
	let didTimeout = false;
	let wasExternallyAborted = false;

	const onAbort = () => {
		wasExternallyAborted = true;
		controller.abort();
	};

	if (outerSignal) {
		if (outerSignal.aborted) {
			throw new Error('Request was aborted');
		}
		outerSignal.addEventListener('abort', onAbort, { once: true });
	}

	const timeoutId = setTimeout(() => {
		didTimeout = true;
		controller.abort();
	}, timeoutMs);

	try {
		return await fetch(url.toString(), {
			...requestInit,
			signal: controller.signal,
			redirect: 'manual',
		});
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			if (wasExternallyAborted) {
				throw new Error('Request was aborted');
			}

			if (didTimeout) {
				throw new Error(`Request timed out after ${timeoutMs.toString()}ms`);
			}

			throw new Error(`Request timed out after ${timeoutMs.toString()}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		outerSignal?.removeEventListener('abort', onAbort);
	}
}

export async function safeFetch(url: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
	const {
		urlPolicy,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		externalOnly = false,
		requestInit = {},
		stripSensitiveHeadersOnCrossHostRedirect = true,
	} = options;

	if (maxRedirects < 0) {
		throw new Error('maxRedirects must be >= 0');
	}

	let currentUrl = parseAndValidateUrl(url, urlPolicy);
	if (externalOnly) {
		await assertExternalAddress(currentUrl.hostname);
	}

	const baseHeaders = new Headers(requestInit.headers);
	let currentMethod = (requestInit.method || 'GET').toUpperCase();
	let currentBody = requestInit.body;
	let redirectsFollowed = 0;

	while (true) {
		const currentInit = withMethodAndBody(
			{
				...requestInit,
				headers: baseHeaders,
			},
			currentMethod,
			currentBody
		);

		const response = await fetchWithTimeout(currentUrl, currentInit, timeoutMs);

		if (!isRedirectStatus(response.status)) {
			return {
				response,
				finalUrl: currentUrl,
				redirectsFollowed,
			};
		}

		if (redirectsFollowed >= maxRedirects) {
			throw new Error(`Redirect limit exceeded (${maxRedirects.toString()})`);
		}

		const location = response.headers.get('location');
		if (!location) {
			throw new Error(`Redirect response missing Location header (status ${response.status.toString()})`);
		}

		const nextCandidate = new URL(location, currentUrl);
		const nextUrl = parseAndValidateUrl(nextCandidate, urlPolicy);
		if (externalOnly) {
			await assertExternalAddress(nextUrl.hostname);
		}

		if (stripSensitiveHeadersOnCrossHostRedirect && currentUrl.origin !== nextUrl.origin) {
			const filtered = dropSensitiveHeaders(baseHeaders);
			baseHeaders.forEach((_, key) => {
				baseHeaders.delete(key);
			});
			filtered.forEach((value, key) => {
				baseHeaders.set(key, value);
			});
		}

		if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
			currentMethod = 'GET';
			currentBody = undefined;
			baseHeaders.delete('content-length');
			baseHeaders.delete('content-type');
		}

		redirectsFollowed += 1;
		currentUrl = nextUrl;

		await response.body?.cancel();
	}
}
