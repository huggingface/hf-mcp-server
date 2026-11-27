import { PTC_TOOLS, type PtcAccess } from '@llmindset/hf-mcp';
import {
	PTC_BOUQUETS,
	type PtcBouquet,
	type PtcBouquetMetrics,
	type PtcClientMetrics,
	type PtcMetricsResponse,
} from '../../shared/ptc-metrics.js';
import { forward } from '../cluster/ipc.js';

const MAX_CLIENTS = 500;

interface ToolCounter {
	calls: number;
	errors: number;
	totalDurationMs: number;
	lastCalled: string | null;
}

interface Client {
	name?: string;
	version?: string;
}

function emptyBouquetMetrics(): PtcBouquetMetrics {
	return {
		requests: 0,
		toolCalls: 0,
		toolErrors: 0,
		access: { anonymous: 0, authenticated: 0, write: 0 },
		lastSeen: null,
	};
}

function normalizeBouquet(bouquet?: string): PtcBouquet {
	return bouquet !== undefined && (PTC_BOUQUETS as readonly string[]).includes(bouquet)
		? (bouquet as PtcBouquet)
		: 'ptc';
}

function emptyState() {
	return {
		startedAt: new Date().toISOString(),
		requests: 0,
		access: { anonymous: 0, authenticated: 0, write: 0 } as Record<PtcAccess, number>,
		bouquets: {
			ptc: emptyBouquetMetrics(),
			codemode: emptyBouquetMetrics(),
			openaiptc: emptyBouquetMetrics(),
		} as Record<PtcBouquet, PtcBouquetMetrics>,
		tools: new Map<string, ToolCounter>(),
		clients: new Map<string, PtcClientMetrics>(),
		errorCodes: {} as Record<string, number>,
	};
}

let state = emptyState();

function clientEntry(client: Client, bouquet: PtcBouquet, now: string): PtcClientMetrics {
	const name = (typeof client?.name === 'string' ? client.name.slice(0, 120) : '') || 'unknown';
	const version = typeof client?.version === 'string' ? client.version.slice(0, 60) : '';
	const key = JSON.stringify([bouquet, name, version]);
	let entry = state.clients.get(key);
	if (!entry) {
		if (state.clients.size >= MAX_CLIENTS) {
			// Evict the least recently seen client.
			const oldest = [...state.clients.entries()].sort((a, b) => a[1].lastSeen.localeCompare(b[1].lastSeen))[0];
			if (oldest) state.clients.delete(oldest[0]);
		}
		entry = {
			name,
			version,
			bouquet,
			requests: 0,
			toolCalls: 0,
			toolErrors: 0,
			anonymousRequests: 0,
			firstSeen: now,
			lastSeen: now,
		};
		state.clients.set(key, entry);
	}
	entry.lastSeen = now;
	return entry;
}

/** One MCP request served with a PTC bouquet (`ptc`, `codemode`, or `openaiptc`). */
export const recordPtcRequest = forward(
	'ptc.recordRequest',
	(client: Client, access: PtcAccess, bouquet: PtcBouquet = 'ptc'): void => {
		const now = new Date().toISOString();
		const b = normalizeBouquet(bouquet);
		const entry = clientEntry(client, b, now);
		const bMetrics = state.bouquets[b];
		state.requests += 1;
		state.access[access] += 1;
		bMetrics.requests += 1;
		bMetrics.access[access] += 1;
		bMetrics.lastSeen = now;
		entry.requests += 1;
		if (access === 'anonymous') entry.anonymousRequests += 1;
	}
);

/** One PTC tool call. */
export const recordPtcToolCall = forward(
	'ptc.recordToolCall',
	(client: Client, tool: string, durationMs: number, errorCode?: string, bouquet: PtcBouquet = 'ptc'): void => {
		const now = new Date().toISOString();
		const b = normalizeBouquet(bouquet);
		const bMetrics = state.bouquets[b];
		const counter = state.tools.get(tool) ?? { calls: 0, errors: 0, totalDurationMs: 0, lastCalled: null };
		counter.calls += 1;
		counter.totalDurationMs += durationMs;
		counter.lastCalled = now;
		bMetrics.toolCalls += 1;
		bMetrics.lastSeen = now;
		const entry = clientEntry(client, b, now);
		entry.toolCalls += 1;
		if (errorCode) {
			counter.errors += 1;
			bMetrics.toolErrors += 1;
			entry.toolErrors += 1;
			state.errorCodes[errorCode] = (state.errorCodes[errorCode] ?? 0) + 1;
		}
		state.tools.set(tool, counter);
	}
);

export function getPtcMetrics(): PtcMetricsResponse {
	const tools = PTC_TOOLS.map((tool) => {
		const counter = state.tools.get(tool.name);
		return {
			name: tool.name,
			family: tool.family,
			calls: counter?.calls ?? 0,
			errors: counter?.errors ?? 0,
			avgDurationMs: counter?.calls ? Math.round(counter.totalDurationMs / counter.calls) : 0,
			lastCalled: counter?.lastCalled ?? null,
		};
	});
	const bouquets = Object.fromEntries(
		PTC_BOUQUETS.map((b) => [
			b,
			{
				...state.bouquets[b],
				access: { ...state.bouquets[b].access },
			},
		])
	) as Record<PtcBouquet, PtcBouquetMetrics>;
	return {
		startedAt: state.startedAt,
		requests: state.requests,
		toolCalls: tools.reduce((sum, tool) => sum + tool.calls, 0),
		toolErrors: tools.reduce((sum, tool) => sum + tool.errors, 0),
		access: { ...state.access },
		bouquets,
		tools,
		clients: [...state.clients.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((c) => ({ ...c })),
		errorCodes: { ...state.errorCodes },
	};
}

export function resetPtcMetricsForTests(): void {
	state = emptyState();
}
