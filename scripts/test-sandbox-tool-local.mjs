#!/usr/bin/env node
import {
	assert,
	callTool,
	findFreePort,
	listTools,
	startJsonServer,
	textContent,
	waitForHttp,
} from './sandbox-e2e-utils.mjs';

const port = Number(process.env.PORT) || (await findFreePort());
const baseUrl = `http://127.0.0.1:${port}`;
const server = startJsonServer(port);

try {
	await waitForHttp(`${baseUrl}/mcp`);

	const defaultTools = await listTools(baseUrl, '');
	assert(!defaultTools.includes('hf_sandbox'), 'hf_sandbox must not be exposed without sandbox mix/bouquet');
	assert(!defaultTools.includes('hf_sandbox_exec'), 'hf_sandbox_exec must not be exposed without sandbox mix/bouquet');

	const mixTools = await listTools(baseUrl, '?mix=sandbox');
	assert(mixTools.includes('hf_sandbox'), 'hf_sandbox must be exposed with ?mix=sandbox');
	assert(mixTools.includes('hf_sandbox_exec'), 'hf_sandbox_exec must be exposed with ?mix=sandbox');

	const bouquetTools = await listTools(baseUrl, '?bouquet=sandbox');
	assert(bouquetTools.includes('hf_sandbox'), 'hf_sandbox must be exposed with ?bouquet=sandbox');
	assert(bouquetTools.includes('hf_sandbox_exec'), 'hf_sandbox_exec must be exposed with ?bouquet=sandbox');
	assert(!bouquetTools.includes('hf_jobs'), 'sandbox bouquet should not also expose hf_jobs');
	assert(!bouquetTools.includes('hub_repo_search'), 'sandbox bouquet should not expose default search tools');

	const unauthenticated = await callTool(
		baseUrl,
		'?mix=sandbox',
		'hf_sandbox',
		{ operation: 'create', args: { name: 'local-sandbox-check' } },
		undefined
	);
	assert(unauthenticated.isError === true, 'unauthenticated sandbox create should return an MCP tool error');
	assert(
		textContent(unauthenticated).includes('require authentication'),
		'auth error should explain that auth is required'
	);

	console.log('sandbox local e2e passed');
} catch (error) {
	console.error(server.getOutput());
	throw error;
} finally {
	await server.stop();
}
