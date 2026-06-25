import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export async function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Unable to allocate a TCP port')));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

export async function waitForHttp(url, timeoutMs = 30000) {
	const started = Date.now();
	let lastError;
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(url);
			if (response.status < 500) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	throw new Error(
		`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
	);
}

export function startJsonServer(port, extraEnv = {}) {
	const child = spawn('node', ['packages/app/dist/server/streamableHttp.js', '--json', '--port', String(port)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'test',
			...extraEnv,
		},
	});

	let output = '';
	child.stdout.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		output += chunk.toString();
	});

	return {
		child,
		getOutput: () => output,
		stop: async () => {
			if (child.exitCode !== null) {
				return;
			}
			child.kill('SIGTERM');
			await Promise.race([
				new Promise((resolve) => child.once('exit', resolve)),
				sleep(5000).then(() => {
					child.kill('SIGKILL');
				}),
			]);
		},
	};
}

export async function rpc(baseUrl, query, body, token) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${baseUrl}/mcp${query}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: body.id ?? 1,
			method: body.method,
			params: body.params,
		}),
	});
	const text = await response.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`Non-JSON response (${response.status}): ${text}`);
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
	}
	if (payload.error) {
		throw new Error(`JSON-RPC error: ${JSON.stringify(payload.error)}`);
	}
	return payload.result;
}

export function toolNames(listResult) {
	return (listResult.tools ?? []).map((tool) => tool.name).sort();
}

export async function listTools(baseUrl, query, token) {
	return toolNames(await rpc(baseUrl, query, { method: 'tools/list' }, token));
}

export async function callTool(baseUrl, query, name, args, token) {
	return rpc(
		baseUrl,
		query,
		{
			method: 'tools/call',
			params: {
				name,
				arguments: args,
			},
		},
		token
	);
}

export function textContent(callResult) {
	return (callResult.content ?? [])
		.filter((entry) => entry.type === 'text')
		.map((entry) => entry.text)
		.join('\n');
}

export function parseJsonCodeBlock(text) {
	const match = text.match(/^```json\n([\s\S]*)\n```$/);
	if (!match?.[1]) {
		throw new Error(`Expected JSON code block, got: ${text}`);
	}
	return JSON.parse(match[1]);
}

export function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}
