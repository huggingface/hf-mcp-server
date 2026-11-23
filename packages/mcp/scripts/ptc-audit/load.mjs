/**
 * Load the PTC tool list: from the built registry (default; full output contracts with field docs)
 * or from a live server's tools/list (advertised schemas, as models see them).
 */
import { z } from 'zod';

const DIST = new URL('../../dist/ptc/index.js', import.meta.url);

export async function loadRegistry() {
	const ptc = await import(DIST.href);
	return { ptc, tools: registryTools(ptc) };
}

/** JSON-schema view of a registry module (dist/ptc/index.js, or src/ptc/index.ts under vitest). */
export function registryTools(ptc) {
	return ptc.PTC_TOOLS.map((t) => ({
		name: t.name,
		family: t.family,
		access: t.access,
		description: t.description,
		inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
		outputSchema: z.toJSONSchema(t.output, { io: 'output' }),
	}));
}

export async function mcpRequest(endpoint, method, params, headers = {}) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
	});
	const text = await response.text();
	const body = text.startsWith('{')
		? text
		: (text
				.split('\n')
				.find((l) => l.startsWith('data: '))
				?.slice(6) ?? '{}');
	const json = JSON.parse(body);
	if (json.error) throw new Error(`${method}: ${json.error.message}`);
	return json.result;
}

export async function loadLive(endpoint) {
	const result = await mcpRequest(endpoint, 'tools/list', {});
	return result.tools.map((t) => ({
		name: t.name,
		family: undefined,
		access: undefined,
		description: t.description,
		inputSchema: t.inputSchema,
		outputSchema: t.outputSchema ?? {},
	}));
}
