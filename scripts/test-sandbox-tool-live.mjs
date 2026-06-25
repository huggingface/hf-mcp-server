#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import {
	assert,
	callTool,
	findFreePort,
	listTools,
	parseJsonCodeBlock,
	startJsonServer,
	textContent,
	waitForHttp,
} from './sandbox-e2e-utils.mjs';

const token = process.env.HF_TOKEN || process.env.DEFAULT_HF_TOKEN;
if (!token) {
	throw new Error('Set HF_TOKEN or DEFAULT_HF_TOKEN to run the live sandbox e2e.');
}

const port = Number(process.env.PORT) || (await findFreePort());
const baseUrl = `http://127.0.0.1:${port}`;
const server = startJsonServer(port);
let handle;

async function sandbox(operation, args) {
	const result = await callTool(baseUrl, '?mix=sandbox', 'hf_sandbox', { operation, args }, token);
	const text = textContent(result);
	if (result.isError) {
		throw new Error(`hf_sandbox ${operation} failed: ${text}`);
	}
	return parseJsonCodeBlock(text);
}

async function sandboxExec(args) {
	const result = await callTool(baseUrl, '?mix=sandbox', 'hf_sandbox_exec', args, token);
	const text = textContent(result);
	if (result.isError) {
		throw new Error(`hf_sandbox_exec failed: ${text}`);
	}
	return parseJsonCodeBlock(text);
}

try {
	await waitForHttp(`${baseUrl}/mcp`);

	const defaultTools = await listTools(baseUrl, '', token);
	assert(!defaultTools.includes('hf_sandbox'), 'hf_sandbox must not be exposed without sandbox mix/bouquet');
	assert(!defaultTools.includes('hf_sandbox_exec'), 'hf_sandbox_exec must not be exposed without sandbox mix/bouquet');
	const sandboxTools = await listTools(baseUrl, '?mix=sandbox', token);
	assert(sandboxTools.includes('hf_sandbox'), 'hf_sandbox must be exposed with ?mix=sandbox');
	assert(sandboxTools.includes('hf_sandbox_exec'), 'hf_sandbox_exec must be exposed with ?mix=sandbox');

	const createResult = await sandbox('create', {
		name: `sandbox-${Date.now().toString(36)}`,
		timeout: process.env.SANDBOX_TIMEOUT || '30m',
		flavor: process.env.SANDBOX_FLAVOR || 'cpu-basic',
		image: process.env.SANDBOX_IMAGE || 'python:3.12',
	});
	handle = createResult.handle;
	assert(typeof handle === 'string' && handle.startsWith('hfsb1:'), 'create should return a portable hfsb1 handle');
	assert(handle.split(':').length === 4, 'sandbox handle should not include the fixed port');
	console.log(`created ${createResult.job_url}`);

	const deadline = Date.now() + Number(process.env.SANDBOX_READY_TIMEOUT_MS || 240000);
	let status;
	while (Date.now() < deadline) {
		status = await sandbox('status', { handle });
		if (status.health?.ok === true) {
			break;
		}
		await sleep(5000);
	}
	assert(status?.health?.ok === true, `sandbox did not become healthy: ${JSON.stringify(status)}`);

	const execResult = await sandboxExec({
		handle,
		cmd: 'python -c "print(6 * 7)"',
	});
	assert(execResult.returncode === 0, `exec returned ${execResult.returncode}: ${execResult.stderr}`);
	assert(execResult.stdout.trim() === '42', `unexpected exec stdout: ${execResult.stdout}`);

	await sandbox('write', {
		handle,
		path: 'message.txt',
		content: 'tada! sandbox tool\n',
	});
	const readResult = await sandbox('read', {
		handle,
		path: 'message.txt',
	});
	assert(readResult.content === 'tada! sandbox tool\n', `unexpected read content: ${readResult.content}`);

	await sandbox('terminate', { handle });
	handle = undefined;
	console.log('sandbox live e2e passed');
} catch (error) {
	console.error(server.getOutput());
	throw error;
} finally {
	if (handle) {
		try {
			await sandbox('terminate', { handle });
		} catch (error) {
			console.error(
				`failed to terminate sandbox <redacted>: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	await server.stop();
}
