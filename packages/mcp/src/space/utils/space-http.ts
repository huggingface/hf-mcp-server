import type { Tool } from '@modelcontextprotocol/client';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from '../../network/fetch-profile.js';
import { readCappedJson } from '../../network/read-capped.js';
import { normalizeParsedTools, parseGradioSchemaResponse } from './gradio-schema.js';

const SPACE_HTTP_TIMEOUT_MS = 10_000;
/** Gradio MCP schemas are a few KB to a few hundred KB; anything larger is refused while streaming. */
export const MAX_GRADIO_SCHEMA_BYTES = 4 * 1024 * 1024;

export class SpaceHttpError extends Error {
	constructor(
		public readonly status: number,
		statusText: string
	) {
		super(`HTTP ${status}: ${statusText}`);
		this.name = 'SpaceHttpError';
	}
}

interface SpaceMetadata {
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
		throw new SpaceHttpError(response.status, response.statusText);
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

export interface FetchGradioSchemaOptions {
	/** Caller cancellation (combined with the 10 s timeout). */
	signal?: AbortSignal;
	/** Body budget, enforced while streaming (default MAX_GRADIO_SCHEMA_BYTES). */
	maxBytes?: number;
}

export async function fetchGradioSchema(
	subdomain: string,
	isPrivate: boolean,
	hfToken?: string,
	options: FetchGradioSchemaOptions = {}
): Promise<Tool[]> {
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
				...(options.signal ? { signal: options.signal } : {}),
			},
		}
	);

	if (!response.ok) {
		throw new SpaceHttpError(response.status, response.statusText);
	}

	const schemaResponse = await readCappedJson(response, options.maxBytes ?? MAX_GRADIO_SCHEMA_BYTES, options.signal);
	return normalizeParsedTools(parseGradioSchemaResponse(schemaResponse));
}
