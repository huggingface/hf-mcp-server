import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { fetchWithProfile, NETWORK_FETCH_PROFILES, parseAndValidateUrl } from '@llmindset/hf-mcp/network';
import { isClusterWorker, remote } from '../cluster/ipc.js';
import { logger } from './logger.js';

type ProxyToolResponseType = 'JSON' | 'SSE';

export interface ProxyToolSource {
	proxyId: string;
	url: string;
	responseType: ProxyToolResponseType;
	allowAnonymous?: boolean;
	forwardHfToken?: boolean;
}

export interface ProxyToolDefinition {
	proxyId: string;
	toolName: string;
	upstreamToolName: string;
	url: string;
	allowAnonymous?: boolean;
	forwardHfToken?: boolean;
	description?: string;
	inputSchema?: ProxyToolInputSchema;
	meta?: Record<string, unknown>;
}

export interface ProxyToolInputSchema {
	type?: string;
	properties?: Record<string, ProxyToolSchemaProperty>;
	required?: string[];
	[key: string]: unknown;
}

interface ProxyToolSchemaProperty {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	[key: string]: unknown;
}

const PROXY_TOOLS_ENV_VAR = 'PROXY_TOOLS_CSV';
const PROXY_TOKEN_ENV_VAR = 'PROXY_TOKEN';
const VALID_RESPONSE_TYPES = new Set<ProxyToolResponseType>(['JSON', 'SSE']);
const PROXY_SCHEMA_TIMEOUT_MS = 10_000;
const CLUSTER_PROXY_SNAPSHOT_TIMEOUT_MS = 30_000;

const PROXY_CSV_SOURCE_PROFILE = NETWORK_FETCH_PROFILES.externalHttps();
const PROXY_TOOL_URL_POLICY = NETWORK_FETCH_PROFILES.httpOrHttpsPermissive().urlPolicy;

let cachedTools: ProxyToolDefinition[] | null = null;
let cachedConfigPromise: Promise<ProxyToolDefinition[]> | null = null;
let verifiedClusterSnapshot: ProxyToolDefinition[] | null = null;
let clusterSnapshotPromise: Promise<ProxyDiscoveryResult> | null = null;

interface ProxyDiscoveryResult {
	tools: ProxyToolDefinition[];
	complete: boolean;
}

export function getProxyToolsConfig(): ProxyToolDefinition[] {
	return cachedTools ?? [];
}

async function discoverProxyTools(source: string): Promise<ProxyDiscoveryResult> {
	let content: string;
	if (source.startsWith('https://')) {
		try {
			const { response } = await fetchWithProfile(source, PROXY_CSV_SOURCE_PROFILE, {
				timeoutMs: PROXY_SCHEMA_TIMEOUT_MS,
			});
			if (!response.ok) {
				logger.error({ status: response.status, source }, 'Failed to fetch proxy tools CSV');
				return { tools: [], complete: false };
			}
			content = await response.text();
		} catch (error) {
			logger.error({ error, source }, 'Error fetching proxy tools CSV');
			return { tools: [], complete: false };
		}
	} else {
		try {
			content = await readFile(source, 'utf8');
		} catch (error) {
			logger.error({ error, source }, 'Proxy tools CSV file not found');
			return { tools: [], complete: false };
		}
	}

	const parsedSources = parseProxyToolsCsv(content);
	const { tools: toolDefinitions, complete } = await loadProxyToolSchemas(parsedSources);
	if (parsedSources.length > 0 && toolDefinitions.length === 0) {
		logger.error('Proxy tools configured but no tool schemas were loaded');
	}
	logger.info({ toolCount: toolDefinitions.length, complete }, 'Loaded proxy tools configuration');
	return { tools: toolDefinitions, complete };
}

async function loadClusterProxyToolsSnapshot(): Promise<ProxyDiscoveryResult> {
	if (verifiedClusterSnapshot) {
		return { tools: verifiedClusterSnapshot, complete: true };
	}
	if (clusterSnapshotPromise) {
		return clusterSnapshotPromise;
	}

	clusterSnapshotPromise = (async () => {
		try {
			const source = process.env[PROXY_TOOLS_ENV_VAR]?.trim();
			if (!source) {
				verifiedClusterSnapshot = [];
				return { tools: verifiedClusterSnapshot, complete: true };
			}
			const result = await discoverProxyTools(source);
			if (result.complete) {
				verifiedClusterSnapshot = result.tools;
			} else {
				logger.warn(
					{ toolCount: result.tools.length },
					'Proxy tools discovery was incomplete; booting cluster workers with degraded snapshot and leaving primary snapshot unverified for retry'
				);
			}
			return result;
		} finally {
			if (!verifiedClusterSnapshot) {
				clusterSnapshotPromise = null;
			}
		}
	})();

	return clusterSnapshotPromise;
}

const remoteClusterProxyTools = remote(
	'config.proxyTools',
	() => loadClusterProxyToolsSnapshot(),
	CLUSTER_PROXY_SNAPSHOT_TIMEOUT_MS
);

export async function loadProxyToolsConfig(): Promise<ProxyToolDefinition[]> {
	if (cachedTools) {
		return cachedTools;
	}
	if (cachedConfigPromise) {
		return cachedConfigPromise;
	}

	cachedConfigPromise = (async () => {
		const source = process.env[PROXY_TOOLS_ENV_VAR]?.trim();
		if (!source) {
			cachedTools = [];
			logger.debug({ envVar: PROXY_TOOLS_ENV_VAR }, 'Proxy tools CSV not configured');
			return cachedTools;
		}

		if (isClusterWorker) {
			try {
				const snapshot = await remoteClusterProxyTools();
				cachedTools = snapshot.tools;
				return cachedTools;
			} catch (error) {
				cachedConfigPromise = null;
				throw error;
			}
		}

		const result = await discoverProxyTools(source);
		cachedTools = result.tools;
		return cachedTools;
	})();

	return cachedConfigPromise;
}

async function loadProxyToolSchemas(sources: ProxyToolSource[]): Promise<ProxyDiscoveryResult> {
	if (sources.length === 0) {
		return { tools: [], complete: true };
	}

	// PROXY_TOKEN is an explicit discovery credential; forwardHfToken governs caller credentials at runtime only.
	const hfToken = getProxyToken();
	const schemaTasks = sources.map((source) =>
		Promise.race([fetchProxyToolSchemas(source, hfToken), createTimeout(PROXY_SCHEMA_TIMEOUT_MS)]).catch(
			(error: unknown) => {
				logger.error({ error, proxyId: source.proxyId, url: source.url }, 'Failed to fetch proxy tool schemas');
				return { tools: [] as ProxyToolDefinition[], ok: false };
			}
		)
	);

	const results = await Promise.all(schemaTasks);
	return {
		tools: results.flatMap((result) => result.tools),
		complete: results.every((result) => result.ok),
	};
}

export function getProxyToken(): string | undefined {
	return process.env[PROXY_TOKEN_ENV_VAR];
}

async function fetchProxyToolSchemas(
	source: ProxyToolSource,
	hfToken: string | undefined
): Promise<{ tools: ProxyToolDefinition[]; ok: boolean }> {
	const client = new Client(
		{
			name: 'hf-mcp-proxy-loader',
			version: '1.0.0',
		},
		{ capabilities: {} }
	);

	const headers = buildAuthHeaders(hfToken);
	const transport = new StreamableHTTPClientTransport(new URL(source.url), {
		requestInit: headers ? { headers } : undefined,
	});

	try {
		await client.connect(transport, { timeout: PROXY_SCHEMA_TIMEOUT_MS });
		const result = await client.listTools({}, { timeout: PROXY_SCHEMA_TIMEOUT_MS });
		const tools = result.tools || [];

		if (tools.length === 0) {
			logger.error({ proxyId: source.proxyId, url: source.url }, 'No tools returned from proxy server');
			return { tools: [], ok: false };
		}

		const definitions = tools
			.map((tool) => buildProxyToolDefinition(source, tool, tools.length === 1 ? source.proxyId : tool.name))
			.filter((tool): tool is ProxyToolDefinition => Boolean(tool));
		return { tools: definitions, ok: definitions.length > 0 };
	} catch (error) {
		logger.error({ error, proxyId: source.proxyId, url: source.url }, 'Proxy tool schema fetch failed');
		return { tools: [], ok: false };
	} finally {
		try {
			await client.close();
		} catch (error) {
			logger.debug({ error, proxyId: source.proxyId, url: source.url }, 'Failed to close proxy tool client');
		}
	}
}

function buildProxyToolDefinition(source: ProxyToolSource, tool: Tool, toolName: string): ProxyToolDefinition | null {
	const inputSchema = tool.inputSchema as ProxyToolInputSchema | undefined;
	if (!inputSchema || inputSchema.type !== 'object') {
		logger.error({ proxyId: source.proxyId, toolName: tool.name }, 'Proxy tool schema missing or invalid');
		return null;
	}

	return {
		proxyId: source.proxyId,
		toolName,
		upstreamToolName: tool.name,
		url: source.url,
		allowAnonymous: source.allowAnonymous ?? false,
		forwardHfToken: source.forwardHfToken ?? true,
		description: tool.description,
		inputSchema,
		meta: tool._meta,
	};
}

function buildAuthHeaders(hfToken?: string): Record<string, string> | undefined {
	if (!hfToken) {
		return undefined;
	}

	return {
		Authorization: `Bearer ${hfToken}`,
		'X-HF-Authorization': `Bearer ${hfToken}`,
	};
}

function createTimeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(() => {
			reject(new Error(`Connection timeout after ${ms.toString()}ms`));
		}, ms);
	});
}

export function parseProxyToolsCsv(content: string): ProxyToolSource[] {
	const lines = content.split(/\r?\n/);
	const results: ProxyToolSource[] = [];
	const seen = new Set<string>();

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const fields = parseCsvLine(line);
		if (fields.length < 3) {
			logger.warn({ line }, 'Skipping proxy tools CSV row with insufficient fields');
			continue;
		}

		const [proxyIdRaw, urlRaw, responseTypeRaw] = fields;
		if (!proxyIdRaw || !urlRaw || !responseTypeRaw) {
			logger.warn({ line }, 'Skipping proxy tools CSV row with missing values');
			continue;
		}

		const proxyId = proxyIdRaw.trim();
		if (['proxy_id', 'tool_name'].includes(proxyId.toLowerCase())) {
			continue;
		}

		if (seen.has(proxyId)) {
			logger.warn({ proxyId }, 'Duplicate proxy id encountered, skipping');
			continue;
		}

		const url = urlRaw.trim();
		let parsedUrl: URL;
		try {
			parsedUrl = parseAndValidateUrl(url, PROXY_TOOL_URL_POLICY);
		} catch (error) {
			logger.warn({ proxyId, url, error }, 'Skipping proxy tool with invalid URL');
			continue;
		}

		const responseType = responseTypeRaw.trim().toUpperCase() as ProxyToolResponseType;
		if (!VALID_RESPONSE_TYPES.has(responseType)) {
			logger.warn({ proxyId, responseType }, 'Skipping proxy tool with invalid response_type');
			continue;
		}

		// Optional columns are positional: allow_anonymous, then forward_hf_token.
		const allowAnonymous = parseCsvBoolean(fields[3], false);
		const forwardHfToken = parseCsvBoolean(fields[4], true);
		if (allowAnonymous === undefined || forwardHfToken === undefined) {
			logger.warn(
				{ proxyId },
				'Skipping proxy tools CSV row with invalid allow_anonymous or forward_hf_token (expected true/false)'
			);
			continue;
		}

		results.push({
			proxyId,
			url: parsedUrl.toString(),
			responseType,
			allowAnonymous,
			forwardHfToken,
		});
		seen.add(proxyId);
	}

	return results;
}

function parseCsvBoolean(value: string | undefined, defaultValue: boolean): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) {
		return defaultValue;
	}
	if (normalized === 'true') {
		return true;
	}
	if (normalized === 'false') {
		return false;
	}
	return undefined;
}

function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i += 1;
				continue;
			}
			inQuotes = !inQuotes;
			continue;
		}

		if (char === ',' && !inQuotes) {
			fields.push(current.trim());
			current = '';
			continue;
		}

		current += char;
	}

	fields.push(current.trim());

	return fields;
}
