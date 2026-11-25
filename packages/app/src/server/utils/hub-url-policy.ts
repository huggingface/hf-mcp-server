import {
	createHuggingFaceHubPolicy,
	createLocalhostHttpPolicy,
	NETWORK_FETCH_PROFILES,
	parseAndValidateUrl,
	type SafeFetchProfile,
} from '@llmindset/hf-mcp/network';

function isLoopbackHubUrlAllowed(): boolean {
	return (
		process.env.NODE_ENV === 'test' ||
		process.env.NODE_ENV === 'development' ||
		process.env.ALLOW_LOOPBACK_HUB_URL === 'true'
	);
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		return (
			parsed.protocol === 'http:' &&
			(parsed.hostname === '127.0.0.1' ||
				parsed.hostname === 'localhost' ||
				parsed.hostname === '::1' ||
				parsed.hostname === '[::1]')
		);
	} catch {
		return false;
	}
}

export function validateConfiguredHubUrl(rawUrl: string, settingName: string): string {
	if (isLoopbackHttpUrl(rawUrl)) {
		if (!isLoopbackHubUrlAllowed()) {
			throw new Error(`${settingName} cannot target loopback HTTP in production unless ALLOW_LOOPBACK_HUB_URL=true`);
		}
		parseAndValidateUrl(rawUrl, createLocalhostHttpPolicy());
		return rawUrl;
	}

	try {
		parseAndValidateUrl(rawUrl, createHuggingFaceHubPolicy());
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${settingName}: ${reason}`, { cause: error });
	}
	return rawUrl;
}

export function resolveValidatedHubFetchTarget(
	rawUrl: string,
	settingName: string
): {
	url: string;
	profile: SafeFetchProfile;
} {
	if (isLoopbackHttpUrl(rawUrl)) {
		if (!isLoopbackHubUrlAllowed()) {
			throw new Error(`${settingName} cannot target loopback HTTP in production unless ALLOW_LOOPBACK_HUB_URL=true`);
		}
		return { url: rawUrl, profile: NETWORK_FETCH_PROFILES.localhostHttp() };
	}
	// Non-loopback URLs are validated by fetchWithProfile against NETWORK_FETCH_PROFILES.hfHub().
	return { url: rawUrl, profile: NETWORK_FETCH_PROFILES.hfHub() };
}
