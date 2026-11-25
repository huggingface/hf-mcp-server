#!/usr/bin/env node

/**
 * Local zero-dependency cluster load harness.
 *
 * Usage:
 *   node scripts/load/run-cluster-load.mjs --workers 0,1,2,4,8 --duration 10 --concurrency 128 --drivers 4
 *
 * For each worker count, spins up an embedded local Mock Hub (whoami-v2 + dataset
 * preupload/commit log drop), launches `packages/app/dist/server/streamableHttp.js`,
 * drives mixed legacy + modern + PTC + authenticated/unauthenticated traffic across
 * `--drivers` client worker threads, checks exact metric parity, JSON-RPC body
 * validity, worker request distribution, and dataset log rows flushed on SIGTERM,
 * and prints a markdown summary table.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker as ThreadWorker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'app', 'dist', 'server', 'streamableHttp.js');

function modernHeaders(method, token) {
	return {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': '2026-07-28',
		'MCP-Method': method,
		'User-Agent': 'load-harness/1.0',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

function modernBody(id, method) {
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		method,
		params: {
			_meta: {
				'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientInfo': { name: 'load-harness', version: '1.0' },
				'io.modelcontextprotocol/clientCapabilities': {},
			},
		},
	});
}

async function runDriverSlots({ baseUrl, stopAt, slotStart, slotCount }) {
	const latenciesMs = [];
	const workerHits = {};
	let totalRequests = 0;
	let unexpected5xx = 0;
	let unexpectedStatus = 0;
	let clientErrors = 0;

	const record = async (res, startedAt, expectedStatus, expectJsonRpcResult = false) => {
		const text = await res.text();
		const elapsed = performance.now() - startedAt;
		latenciesMs.push(elapsed);
		totalRequests++;
		const w = res.headers.get('x-mcp-worker') || 'unknown';
		workerHits[w] = (workerHits[w] || 0) + 1;
		if (res.status >= 500) unexpected5xx++;
		if (res.status !== expectedStatus) {
			unexpectedStatus++;
			return;
		}
		if (expectJsonRpcResult) {
			try {
				const parsed = JSON.parse(text);
				if (!parsed || typeof parsed !== 'object' || 'error' in parsed || !('result' in parsed)) {
					unexpectedStatus++;
				}
			} catch {
				unexpectedStatus++;
			}
		}
	};

	const driver = async (slotId) => {
		let seq = 1;
		let iter = 0;
		while (Date.now() < stopAt) {
			const kind = (iter++ + slotId) % 5;
			try {
				if (kind === 0) {
					// Full legacy session lifecycle: initialize -> notifications/initialized -> ping -> tools/list -> DELETE
					const t0 = performance.now();
					const initRes = await fetch(`${baseUrl}/mcp?gradio=none`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Accept: 'application/json, text/event-stream',
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: seq++,
							method: 'initialize',
							params: {
								protocolVersion: '2025-06-18',
								capabilities: {},
								clientInfo: { name: 'load-legacy', version: '1.0' },
							},
						}),
					});
					const sid = initRes.headers.get('mcp-session-id');
					await record(initRes, t0, 200, true);
					if (!sid) {
						unexpectedStatus++;
						continue;
					}

					const legacyHeaders = {
						'Content-Type': 'application/json',
						Accept: 'application/json, text/event-stream',
						'Mcp-Session-Id': sid,
						'Mcp-Protocol-Version': '2025-06-18',
					};

					for (const [reqBody, urlPath, expected, checkRpc] of [
						[{ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, '/mcp?gradio=none', 202, false],
						[{ jsonrpc: '2.0', id: seq++, method: 'ping', params: {} }, '/mcp?gradio=none', 200, true],
						[{ jsonrpc: '2.0', id: seq++, method: 'tools/list', params: {} }, '/mcp?gradio=none', 200, true],
					]) {
						const t = performance.now();
						const r = await fetch(`${baseUrl}${urlPath}`, {
							method: 'POST',
							headers: legacyHeaders,
							body: JSON.stringify(reqBody),
						});
						await record(r, t, expected, checkRpc);
					}

					const tDel = performance.now();
					const delRes = await fetch(`${baseUrl}/mcp`, {
						method: 'DELETE',
						headers: { 'Mcp-Session-Id': sid },
					});
					await record(delRes, tDel, 200, false);
				} else if (kind === 1) {
					const t = performance.now();
					const r = await fetch(`${baseUrl}/mcp?gradio=none`, {
						method: 'POST',
						headers: modernHeaders('server/discover', 'hf_oauth_alice'),
						body: modernBody(seq++, 'server/discover'),
					});
					await record(r, t, 200, true);
				} else if (kind === 2) {
					const t = performance.now();
					const r = await fetch(`${baseUrl}/mcp?gradio=none`, {
						method: 'POST',
						headers: modernHeaders('tools/list', 'hf_pat_bob'),
						body: modernBody(seq++, 'tools/list'),
					});
					await record(r, t, 200, true);
				} else if (kind === 3) {
					const t = performance.now();
					const r = await fetch(`${baseUrl}/mcp?bouquet=ptc`, {
						method: 'POST',
						headers: modernHeaders('tools/list'),
						body: modernBody(seq++, 'tools/list'),
					});
					await record(r, t, 200, true);
				} else {
					const t = performance.now();
					const r = await fetch(`${baseUrl}/mcp?gradio=none`, {
						method: 'POST',
						headers: modernHeaders('tools/list', 'hf_invalid_token'),
						body: modernBody(seq++, 'tools/list'),
					});
					await record(r, t, 401, false);
				}
			} catch {
				clientErrors++;
			}
		}
	};

	await Promise.all(Array.from({ length: slotCount }, (_, i) => driver(slotStart + i)));
	return { latenciesMs, workerHits, totalRequests, unexpected5xx, unexpectedStatus, clientErrors };
}

if (!isMainThread) {
	const result = await runDriverSlots(workerData);
	parentPort.postMessage(result);
	process.exit(0);
}

const { values } = parseArgs({
	options: {
		workers: { type: 'string', default: '0,1,2,4' },
		duration: { type: 'string', default: '10' },
		concurrency: { type: 'string', default: '32' },
		drivers: { type: 'string', default: '4' },
	},
	args: process.argv.slice(2),
});

const workerCounts = values.workers
	.split(',')
	.map((s) => Number.parseInt(s.trim(), 10))
	.filter((n) => Number.isFinite(n) && n >= 0);
const durationSec = Math.max(1, Number.parseInt(values.duration, 10) || 10);
const concurrency = Math.max(1, Number.parseInt(values.concurrency, 10) || 32);
const driverThreads = Math.max(1, Math.min(concurrency, Number.parseInt(values.drivers, 10) || 4));

if (!existsSync(DIST_ENTRY)) {
	console.error(`Missing compiled server at ${DIST_ENTRY}. Run "pnpm build" first.`);
	process.exit(1);
}

async function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createNetServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close(() => reject(new Error('Failed to allocate port')));
				return;
			}
			const { port } = addr;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
		srv.on('error', reject);
	});
}

async function startEmbeddedMockHub() {
	let uploadedEntries = 0;
	let uploadedFiles = 0;

	const readBody = (req) =>
		new Promise((resolve, reject) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c));
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});

	const server = createHttpServer(async (req, res) => {
		try {
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			if (req.method === 'GET' && url.pathname === '/api/whoami-v2') {
				const auth = req.headers.authorization || '';
				const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
				const token = match?.[1];
				if (!token || token.startsWith('hf_invalid') || !token.startsWith('hf_')) {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Invalid credentials' }));
					return;
				}
				const isOauth = token.startsWith('hf_oauth_');
				const name = isOauth ? token.slice('hf_oauth_'.length) : token.slice('hf_'.length);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						id: `${name}-id`,
						type: 'user',
						name,
						orgs: [],
						auth: { type: isOauth ? 'oauth' : 'access_token' },
					})
				);
				return;
			}

			if (req.method === 'POST' && /^\/api\/datasets\/[^/]+\/[^/]+\/preupload\/[^/]+$/.test(url.pathname)) {
				const body = JSON.parse((await readBody(req)) || '{}');
				const files = (body.files || []).map((f) => ({ path: f.path, uploadMode: 'regular', shouldIgnore: false }));
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ files }));
				return;
			}

			if (req.method === 'POST' && /^\/api\/datasets\/[^/]+\/[^/]+\/commit\/[^/]+$/.test(url.pathname)) {
				const body = await readBody(req);
				for (const line of body.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const parsed = JSON.parse(trimmed);
					if (parsed.key === 'file' && parsed.value?.content) {
						uploadedFiles++;
						const raw =
							parsed.value.encoding === 'base64'
								? Buffer.from(parsed.value.content, 'base64').toString('utf8')
								: parsed.value.content;
						const count = raw.split('\n').filter((l) => l.trim().length > 0).length;
						uploadedEntries += count;
					}
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ commitOid: 'deadbeef', commitUrl: 'http://127.0.0.1/commit/deadbeef' }));
				return;
			}

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: String(err) }));
		}
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
	return {
		baseUrl,
		whoamiUrl: `${baseUrl}/api/whoami-v2`,
		getStats: () => ({ uploadedFiles, uploadedEntries }),
		resetStats: () => {
			uploadedFiles = 0;
			uploadedEntries = 0;
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function percentile(sorted, p) {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

async function waitForReady(baseUrl, workers) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/api/transport-metrics`, {
				headers: { 'X-Metrics-Password': 'loadpass' },
			});
			if (res.ok) {
				const json = await res.json();
				if (workers === 0) return;
				const cluster = json.runtimeMetrics?.cluster;
				if (cluster?.enabled && cluster.activeWorkers === workers) return;
			}
		} catch {
			// Server still booting
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`Server with MCP_WORKERS=${String(workers)} did not become ready within 15s`);
}

function spawnDriverThread(data) {
	return new Promise((resolve, reject) => {
		const w = new ThreadWorker(__filename, { workerData: data });
		w.once('message', resolve);
		w.once('error', reject);
	});
}

async function runScenario(mockHub, workers) {
	mockHub.resetStats();
	const port = await getFreePort();
	const baseUrl = `http://127.0.0.1:${String(port)}`;

	const env = {
		...process.env,
		NODE_ENV: 'production',
		MCP_WORKERS: String(workers),
		ANALYTICS_MODE: 'true',
		MCP_WORKER_HEADER: 'true',
		METRICS_PAGE_PASSWORD: 'loadpass',
		LOGGING_DATASET_ID: 'hf-internal/mcp-cluster-load',
		LOGGING_HF_TOKEN: 'hf_load_logging_token',
		LOGGING_HUB_URL: mockHub.baseUrl,
		LOGGING_FLUSH_INTERVAL: '60000',
		HF_WHOAMI_URL: mockHub.whoamiUrl,
		ALLOW_LOOPBACK_HUB_URL: 'true',
		SHUTDOWN_GRACE_MS: '15000',
	};
	delete env.VITEST;
	delete env.VITEST_POOL_ID;
	delete env.VITEST_WORKER_ID;
	delete env.USER_CONFIG_API;
	delete env.PROXY_TOOLS_CSV;
	delete env.HF_TOKEN;
	delete env.DEFAULT_HF_TOKEN;

	const child = spawn(process.execPath, [DIST_ENTRY, '--port', String(port)], {
		env,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr?.on('data', (c) => {
		stderr += c.toString('utf8');
	});

	try {
		await waitForReady(baseUrl, workers);

		// Hermetic warmup
		const warmupRes = await fetch(`${baseUrl}/mcp?gradio=none`, {
			method: 'POST',
			headers: modernHeaders('server/discover'),
			body: modernBody(1, 'server/discover'),
		});
		await warmupRes.text();

		const stopAt = Date.now() + durationSec * 1000;
		const startWall = performance.now();

		const threadJobs = [];
		let assigned = 0;
		for (let t = 0; t < driverThreads; t++) {
			const remainingThreads = driverThreads - t;
			const count = Math.ceil((concurrency - assigned) / remainingThreads);
			if (count > 0) {
				threadJobs.push(
					spawnDriverThread({
						baseUrl,
						stopAt,
						slotStart: assigned,
						slotCount: count,
					})
				);
				assigned += count;
			}
		}

		const partials = await Promise.all(threadJobs);
		const elapsedSec = (performance.now() - startWall) / 1000;

		const latenciesMs = [];
		const workerHits = new Map();
		let totalRequests = 0;
		let unexpected5xx = 0;
		let unexpectedStatus = 0;
		let clientErrors = 0;

		for (const p of partials) {
			for (const l of p.latenciesMs) latenciesMs.push(l);
			for (const [w, c] of Object.entries(p.workerHits)) {
				workerHits.set(w, (workerHits.get(w) || 0) + c);
			}
			totalRequests += p.totalRequests;
			unexpected5xx += p.unexpected5xx;
			unexpectedStatus += p.unexpectedStatus;
			clientErrors += p.clientErrors;
		}

		// Poll past the 1.5s /api/transport-metrics cache TTL + 100ms IPC batch flush for exact parity
		const expectedReported = totalRequests + 1; // +1 warmup request
		let metricsJson = {};
		const pollDeadline = Date.now() + 3_500;
		while (Date.now() < pollDeadline) {
			const metricsRes = await fetch(`${baseUrl}/api/transport-metrics`, {
				headers: { 'X-Metrics-Password': 'loadpass' },
			});
			metricsJson = await metricsRes.json();
			if ((metricsJson.requests?.total ?? 0) === expectedReported) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		const ptcRes = await fetch(`${baseUrl}/api/ptc-metrics`, {
			headers: { 'X-Metrics-Password': 'loadpass' },
		});
		const ptcJson = await ptcRes.json();

		// Graceful SIGTERM and wait for exit
		const exitCode = await new Promise((resolve) => {
			child.once('exit', (code) => resolve(code));
			child.kill('SIGTERM');
		});

		latenciesMs.sort((a, b) => a - b);
		const rps = totalRequests / elapsedSec;
		const p50 = percentile(latenciesMs, 50);
		const p95 = percentile(latenciesMs, 95);
		const p99 = percentile(latenciesMs, 99);
		const hubStats = mockHub.getStats();

		const workerDist = Array.from(workerHits.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([w, c]) => `${w}:${Math.round((c / Math.max(1, totalRequests)) * 100)}%`)
			.join(' ');

		return {
			workers,
			totalRequests,
			expectedReported,
			rps,
			p50,
			p95,
			p99,
			unexpected5xx,
			unexpectedStatus,
			clientErrors,
			reportedTotal: metricsJson.requests?.total ?? 0,
			uniqueUsers: metricsJson.connections?.uniqueUsers ?? 0,
			ptcRequests: ptcJson.requests ?? 0,
			ipcDropped: metricsJson.runtimeMetrics?.cluster?.ipcDropped ?? 0,
			uploadedEntries: hubStats.uploadedEntries,
			workerDist,
			exitCode,
			stderr,
		};
	} finally {
		if (child.exitCode === null) {
			child.kill('SIGKILL');
		}
	}
}

async function main() {
	const mockHub = await startEmbeddedMockHub();
	const results = [];
	try {
		console.log(
			`Running cluster load harness: workers=[${workerCounts.join(',')}], duration=${String(durationSec)}s, concurrency=${String(concurrency)}, drivers=${String(driverThreads)}`
		);
		for (const w of workerCounts) {
			const res = await runScenario(mockHub, w);
			results.push(res);
		}
	} finally {
		await mockHub.close();
	}

	console.log('');
	console.log(
		'| Workers | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | 5xx | BadStatus | Client Req | Reported Req | Users | PTC | IPC Drop | Log Rows | Exit | Worker Share |'
	);
	console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
	for (const r of results) {
		console.log(
			`| ${String(r.workers)} | ${r.rps.toFixed(1)} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${String(r.unexpected5xx)} | ${String(r.unexpectedStatus)} | ${String(r.totalRequests)} | ${String(r.reportedTotal)} | ${String(r.uniqueUsers)} | ${String(r.ptcRequests)} | ${String(r.ipcDropped)} | ${String(r.uploadedEntries)} | ${String(r.exitCode)} | ${r.workerDist} |`
		);
	}

	const failures = [];
	for (const r of results) {
		const reasons = [];
		if (r.unexpected5xx > 0) reasons.push(`5xx=${String(r.unexpected5xx)}`);
		if (r.unexpectedStatus > 0) reasons.push(`badStatus=${String(r.unexpectedStatus)}`);
		if (r.clientErrors > 0) reasons.push(`clientErrors=${String(r.clientErrors)}`);
		if (r.exitCode !== 0) reasons.push(`exitCode=${String(r.exitCode)}`);
		if (r.reportedTotal !== r.expectedReported) {
			reasons.push(`reportedTotal=${String(r.reportedTotal)}!=expected(${String(r.expectedReported)})`);
		}
		if (r.ptcRequests === 0) reasons.push('ptcRequests=0');
		if (r.uniqueUsers < 2) reasons.push(`uniqueUsers=${String(r.uniqueUsers)}<2`);
		if (r.ipcDropped > 0) reasons.push(`ipcDropped=${String(r.ipcDropped)}`);
		if (r.uploadedEntries === 0) reasons.push('uploadedEntries=0');
		if (reasons.length > 0) {
			failures.push(`workers=${String(r.workers)}: ${reasons.join(', ')}`);
		}
	}
	if (failures.length > 0) {
		console.error(`Load harness failed:\n- ${failures.join('\n- ')}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
