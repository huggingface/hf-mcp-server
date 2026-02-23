import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from '../../network/fetch-profile.js';
import { normalizeParsedTools, parseGradioSchemaResponse } from './gradio-schema.js';

const SPACE_HTTP_TIMEOUT_MS = 10_000;

export interface SpaceMetadata {
	subdomain: string;
	private: boolean;
}

export async function fetchSpaceMetadata(spaceName: string, hfToken?: string): Promise<SpaceMetadata> {
	const url = `https://huggingface.co/api/spaces/${spaceName}`;
	const headers: Record<string, string> = {};

	if (hfToken) {
		headers['Authorization'] = `Bearer ${hfToken}`;
	}

	const { response } = await fetchWithProfile(url, NETWORK_FETCH_PROFILES.hfHub(), {
		timeoutMs: SPACE_HTTP_TIMEOUT_MS,
		requestInit: {
			headers,
		},
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const info = (await response.json()) as {
		subdomain?: string;
		private?: boolean;
	};

	if (!info.subdomain) {
		throw new Error('Space does not have a subdomain');
	}

	return {
		subdomain: info.subdomain,
		private: info.private || false,
	};
}

export async function fetchGradioSchema(subdomain: string, isPrivate: boolean, hfToken?: string): Promise<Tool[]> {
	const schemaUrl = `https://${subdomain}.hf.space/gradio_api/mcp/schema`;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	if (isPrivate && hfToken) {
		headers['X-HF-Authorization'] = `Bearer ${hfToken}`;
	}

	const { response } = await fetchWithProfile(
		schemaUrl,
		NETWORK_FETCH_PROFILES.gradioSchemaHost(`${subdomain}.hf.space`),
		{
			timeoutMs: SPACE_HTTP_TIMEOUT_MS,
			requestInit: {
				method: 'GET',
				headers,
			},
		}
	);

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const schemaResponse = (await response.json()) as unknown;
	return normalizeParsedTools(parseGradioSchemaResponse(schemaResponse));
}
