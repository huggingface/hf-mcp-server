import { PTC_TOOLS, type PtcAccess } from '@llmindset/hf-mcp';
import type { PtcClientMetrics, PtcMetricsResponse } from '../../shared/ptc-metrics.js';
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

function emptyState() {
	return {
		startedAt: new Date().toISOString(),
		requests: 0,
		access: { anonymous: 0, authenticated: 0, write: 0 } as Record<PtcAccess, number>,
		tools: new Map<string, ToolCounter>(),
		clients: new Map<string, PtcClientMetrics>(),
		errorCodes: {} as Record<string, number>,
	};
}

let state = emptyState();

function clientEntry(client: Client, now: string): PtcClientMetrics {
	const name = (typeof client?.name === 'string' ? client.name.slice(0, 120) : '') || 'unknown';
	const version = typeof client?.version === 'string' ? client.version.slice(0, 60) : '';
	const key = JSON.stringify([name, version]);
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

/** One MCP request served with the PTC bouquet. */
export const recordPtcRequest = forward('ptc.recordRequest', (client: Client, access: PtcAccess): void => {
	const entry = clientEntry(client, new Date().toISOString());
	state.requests += 1;
	state.access[access] += 1;
	entry.requests += 1;
	if (access === 'anonymous') entry.anonymousRequests += 1;
});

/** One PTC tool call. */
export const recordPtcToolCall = forward(
	'ptc.recordToolCall',
	(client: Client, tool: string, durationMs: number, errorCode?: string): void => {
		const now = new Date().toISOString();
		const counter = state.tools.get(tool) ?? { calls: 0, errors: 0, totalDurationMs: 0, lastCalled: null };
		counter.calls += 1;
		counter.totalDurationMs += durationMs;
		counter.lastCalled = now;
		const entry = clientEntry(client, now);
		entry.toolCalls += 1;
		if (errorCode) {
			counter.errors += 1;
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
	return {
		startedAt: state.startedAt,
		requests: state.requests,
		toolCalls: tools.reduce((sum, tool) => sum + tool.calls, 0),
		toolErrors: tools.reduce((sum, tool) => sum + tool.errors, 0),
		access: { ...state.access },
		tools,
		clients: [...state.clients.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((c) => ({ ...c })),
		errorCodes: { ...state.errorCodes },
	};
}

export function resetPtcMetricsForTests(): void {
	state = emptyState();
}
