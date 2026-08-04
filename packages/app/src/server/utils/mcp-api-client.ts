import { logger } from './logger.js';
import type { AppSettings } from '../../shared/settings.js';
import { BOUQUET_FALLBACK, DEFAULT_SETTINGS } from '../../shared/settings.js';
import type { TransportInfo } from '../../shared/transport-info.js';
import {
	fetchWithProfile,
	isLocalhostHostname,
	NETWORK_FETCH_PROFILES,
	parseAndValidateUrl,
} from '@llmindset/hf-mcp/network';
import { apiMetrics } from '../utils/api-metrics.js';

export interface ApiClientConfig {
	type: 'static' | 'external';
	externalUrl?: string;
	hfToken?: string;
}

export class McpApiClient {
	private config: ApiClientConfig;
	private transportInfo: TransportInfo | null = null;

	constructor(config: ApiClientConfig, transportInfo?: TransportInfo) {
		this.config = config;
		this.transportInfo = transportInfo || null;
	}

	getTransportInfo(): TransportInfo | null {
		return this.transportInfo;
	}

	async getSettings(overrideToken?: string): Promise<AppSettings> {
		const apiTimeout = process.env.HF_API_TIMEOUT ? parseInt(process.env.HF_API_TIMEOUT, 10) : 12500;

		switch (this.config.type) {
			case 'static':
				return {
					builtInTools: [...DEFAULT_SETTINGS.builtInTools],
					spaceTools: DEFAULT_SETTINGS.spaceTools.map((spaceTool) => ({ ...spaceTool })),
				};

			case 'external':
				if (!this.config.externalUrl) {
					logger.error('externalUrl required for external mode');
					return BOUQUET_FALLBACK;
				}
				try {
					const token = overrideToken || this.config.hfToken;
					if (!token || token.trim() === '') {
						// Record anonymous access (successful fallback usage)
						apiMetrics.recordCall(false, 200);
						logger.debug('No HF token available for external config API - using fallback');
						return BOUQUET_FALLBACK;
					}

					const headers: Record<string, string> = {};
					const hasToken = true; // We know we have a token at this point

					headers['Authorization'] = `Bearer ${token}`;

					// Add timeout using HF_API_TIMEOUT or default to 12.5 seconds
					headers['accept'] = 'application/json';
					headers['cache-control'] = 'no-cache';

					const parsedExternalUrl = new URL(this.config.externalUrl);
					const externalIsLocalhost = isLocalhostHostname(parsedExternalUrl.hostname);
					if (!externalIsLocalhost && parsedExternalUrl.protocol === 'http:') {
						throw new Error('External settings URL must use HTTPS unless it is localhost');
					}

					const externalProfile = externalIsLocalhost
						? NETWORK_FETCH_PROFILES.localhostHttp()
						: NETWORK_FETCH_PROFILES.externalHttps();
					parseAndValidateUrl(this.config.externalUrl, externalProfile.urlPolicy);

					logger.debug(`Fetching external settings from ${this.config.externalUrl} with timeout ${apiTimeout}ms`);
					const { response } = await fetchWithProfile(this.config.externalUrl, externalProfile, {
						timeoutMs: apiTimeout,
						requestInit: {
							headers,
						},
					});

					if (!response.ok) {
						// Record metrics for error responses
						apiMetrics.recordCall(hasToken, response.status);

						// Debug level logging for auth errors
						if (response.status === 401 || response.status === 403) {
							logger.debug(`External config API ${response.status} ${response.statusText}: ${this.config.externalUrl}`);
						}

						logger.debug(
							`Failed to fetch external settings: ${response.status.toString()} ${response.statusText} - using fallback bouquet`
						);
						return BOUQUET_FALLBACK;
					}

					// Record metrics for successful responses
					apiMetrics.recordCall(hasToken, response.status);
					return (await response.json()) as AppSettings;
				} catch (error) {
					logger.warn({ error }, 'Error fetching settings from external API - defaulting to fallback bouquet');
					return BOUQUET_FALLBACK;
				}

			default:
				logger.error(`Unknown API client type: ${String(this.config.type)}`);
				return BOUQUET_FALLBACK;
		}
	}
}
