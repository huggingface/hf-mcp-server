#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

const DEFAULT_SERVER_URL = 'https://huggingface.co/mcp?login';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8090/oauth/callback';
const DEFAULT_SCOPE = 'read-mcp';
const METADATA_PATH = '/oauth/client-metadata.json';
const MAX_METADATA_BYTES = 5 * 1024;
const MAX_REDIRECTS = 5;

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const { values } = parseArgs({
	args,
	options: {
		server: { type: 'string', short: 's', default: DEFAULT_SERVER_URL },
		'redirect-uri': { type: 'string', default: DEFAULT_REDIRECT_URI },
		scope: { type: 'string', default: DEFAULT_SCOPE },
		cimd: { type: 'boolean', default: false },
		'client-metadata-url': { type: 'string' },
		'inspect-auth-url': { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false },
	},
	strict: true,
});

function printHelp() {
	console.log(`HF MCP OAuth diagnostics

Usage:
  pnpm oauth:diagnose
  pnpm oauth:diagnose -- --cimd
  pnpm oauth:diagnose -- --server http://127.0.0.1:3000/mcp?login
  pnpm oauth:diagnose -- --client-metadata-url https://client.example/oauth/metadata.json
  pnpm oauth:diagnose -- --inspect-auth-url 'https://huggingface.co/oauth/authorize?...'

Options:
  -s, --server URL              MCP server URL (default: ${DEFAULT_SERVER_URL})
      --redirect-uri URL        Loopback callback (default: ${DEFAULT_REDIRECT_URI})
      --scope SCOPES            Space-separated scopes (default: ${DEFAULT_SCOPE})
      --cimd                    Serve CIMD metadata through a temporary cloudflared tunnel
      --client-metadata-url URL Use an existing public HTTPS CIMD document
      --inspect-auth-url URL    Inspect another client's authorization URL, then exit
  -h, --help                    Show this help

Tokens, authorization codes, and client secrets are never printed or persisted.`);
}

function parseLoopbackRedirect(value) {
	const url = new URL(value);
	if (url.protocol !== 'http:') {
		throw new Error(`The diagnostic callback must use http://, got ${url.protocol}`);
	}
	if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
		throw new Error(`The diagnostic callback must be loopback, got ${url.hostname}`);
	}
	if (!url.port) {
		throw new Error('The diagnostic callback needs an explicit port');
	}
	if (url.port === '0' || url.username || url.password || url.search || url.hash) {
		throw new Error('The diagnostic callback cannot use port 0, credentials, a query string, or a fragment');
	}
	return url;
}

function parseCimdUrl(clientId) {
	try {
		const url = new URL(clientId);
		if (
			url.protocol !== 'https:' ||
			url.pathname === '/' ||
			url.username ||
			url.password ||
			url.hash ||
			url.href !== clientId
		) {
			return;
		}
		return url;
	} catch {
		return;
	}
}

function isCimdClientId(clientId) {
	return Boolean(parseCimdUrl(clientId));
}

function clientMetadata(clientId, redirectUri, scope) {
	const metadata = {
		client_name: 'HF MCP OAuth diagnostic',
		redirect_uris: [redirectUri],
		grant_types: ['authorization_code'],
		response_types: ['code'],
		application_type: 'native',
		scope,
	};
	if (clientId) {
		return {
			client_id: clientId,
			...metadata,
			token_endpoint_auth_method: 'none',
		};
	}
	return {
		...metadata,
		token_endpoint_auth_method: 'client_secret_post',
	};
}

function isPublicIp(address) {
	const version = isIP(address);
	if (version === 4) {
		const [a, b, c] = address.split('.').map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0 && [0, 2].includes(c)) ||
			(a === 192 && b === 168) ||
			(a === 198 && [18, 19].includes(b)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224
		);
	}
	if (version === 6) {
		const normalized = address.toLowerCase();
		if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice(7));
		return !(
			normalized === '::' ||
			normalized === '::1' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith('ff') ||
			normalized.startsWith('2001:db8:')
		);
	}
	return false;
}

async function assertPublicCimdUrl(value) {
	const url = parseCimdUrl(value);
	if (!url) {
		throw new Error(`CIMD client_id must be a canonical public HTTPS URL with a non-root path: ${value}`);
	}
	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
		throw new Error(`CIMD client_id resolves to a non-public address: ${value}`);
	}
	return url;
}

async function fetchPublicUrl(value) {
	let current = value;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		await assertPublicCimdUrl(current);
		const response = await fetch(current, {
			headers: { Accept: 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(15_000),
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return { response, finalUrl: current };
		}
		await response.body?.cancel();
		const location = response.headers.get('location');
		if (!location) throw new Error(`HTTP ${response.status} redirect has no Location header`);
		current = new URL(location, current).href;
	}
	throw new Error(`CIMD fetch exceeded ${MAX_REDIRECTS} redirects`);
}

async function readLimitedBody(response) {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_METADATA_BYTES) {
			await reader.cancel();
			throw new Error(`document exceeds ${MAX_METADATA_BYTES} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function inspectCimd(clientId, redirectUri) {
	console.log('\nCIMD metadata document');
	console.log(`  URL: ${clientId}`);

	let response;
	let finalUrl;
	let body;
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			({ response, finalUrl } = await fetchPublicUrl(clientId));
			body = await readLimitedBody(response);
			break;
		} catch (error) {
			lastError = error;
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	if (!response || finalUrl === undefined || body === undefined) {
		console.log(`  FAIL fetch: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
		return false;
	}

	const size = Buffer.byteLength(body);
	const contentType = response.headers.get('content-type') ?? '';
	console.log(`  HTTP: ${response.status} ${response.statusText}`);
	console.log(`  final URL: ${finalUrl}`);
	console.log(`  content-type: ${contentType || '(missing)'}`);
	console.log(`  size: ${size} bytes`);

	let metadata;
	try {
		metadata = JSON.parse(body);
	} catch {
		console.log('  FAIL body is not JSON');
		return false;
	}
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		console.log('  FAIL body is not a JSON object');
		return false;
	}

	const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
	const grantTypes = Array.isArray(metadata.grant_types) ? metadata.grant_types : [];
	const responseTypes = Array.isArray(metadata.response_types) ? metadata.response_types : [];
	const tokenAuthMethod = metadata.token_endpoint_auth_method;
	const checks = [
		['HTTP status is 200', response.status === 200],
		['response stayed on the client_id URL', finalUrl === clientId],
		['response has a JSON media type', /^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(contentType)],
		['document is at most 5 KiB', size <= MAX_METADATA_BYTES],
		['document client_id exactly matches URL', metadata.client_id === clientId],
		[
			'document client_name is a string when present',
			metadata.client_name === undefined || typeof metadata.client_name === 'string',
		],
		['document redirect_uris is an array of strings', redirectUris.every((value) => typeof value === 'string')],
		['requested redirect_uri is registered exactly', !redirectUri || redirectUris.includes(redirectUri)],
		['document supports the authorization_code grant', grantTypes.includes('authorization_code')],
		['document supports the code response type', responseTypes.includes('code')],
		['document contains no client_secret', metadata.client_secret === undefined],
		['document contains no client_secret_expires_at', metadata.client_secret_expires_at === undefined],
		['document uses public-client token authentication', tokenAuthMethod === 'none'],
	];

	for (const [label, passed] of checks) {
		console.log(`  ${passed ? 'PASS' : 'FAIL'} ${label}`);
	}
	console.log(`  client_name: ${metadata.client_name ?? '(missing)'}`);
	console.log(`  redirect_uris: ${redirectUris.length ? JSON.stringify(redirectUris) : '(missing)'}`);
	return checks.every(([, passed]) => passed);
}

async function waitForPublicUrl(url, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const { response } = await fetchPublicUrl(url);
			await response.body?.cancel();
			if (response.ok) return;
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
	);
}

function createDiagnosticFetch(scope, serverUrl) {
	const scopes = scope.split(' ');
	const allowedOrigins = new Set([serverUrl.origin, 'https://huggingface.co']);
	let reported = false;
	return async (input, init) => {
		const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		if (!allowedOrigins.has(requestUrl.origin)) {
			throw new Error(`OAuth discovery refused unexpected origin: ${requestUrl.origin}`);
		}
		const response = await fetch(input, {
			...init,
			redirect: 'manual',
			signal: init?.signal ?? AbortSignal.timeout(30_000),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			throw new Error(`OAuth request unexpectedly redirected: ${requestUrl}`);
		}
		if (!requestUrl.pathname.startsWith('/.well-known/oauth-protected-resource')) return response;

		const metadata = JSON.parse(await readLimitedBody(response));
		metadata.scopes_supported = scopes;
		const headers = new Headers(response.headers);
		headers.delete('content-encoding');
		headers.delete('content-length');
		headers.delete('etag');
		if (!reported) {
			reported = true;
			console.log(`OAuth diagnostic scopes: ${scope}`);
		}
		return new Response(JSON.stringify(metadata), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

async function inspectAuthorizationUrl(value) {
	const url = new URL(value);
	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');

	console.log('OAuth authorization request');
	console.log(`  endpoint: ${url.origin}${url.pathname}`);
	console.log(`  client_id: ${clientId ?? '(missing)'}`);
	console.log(`  redirect_uri: ${redirectUri ?? '(missing)'}`);
	console.log(`  scope: ${url.searchParams.get('scope') ?? '(missing)'}`);
	console.log(`  resource: ${url.searchParams.get('resource') ?? '(missing)'}`);

	if (!clientId) {
		console.log('  FAIL authorization request has no client_id');
		return false;
	}
	try {
		const parsedClientId = new URL(clientId);
		if (['http:', 'https:'].includes(parsedClientId.protocol) && !parseCimdUrl(clientId)) {
			console.log('  FAIL URL-based client_id is not a canonical public HTTPS URL with a non-root path');
			return false;
		}
	} catch {
		// Opaque client IDs are valid for pre-registration and dynamic registration.
	}
	if (!isCimdClientId(clientId)) {
		console.log('  registration mode: opaque client_id (pre-registered or dynamic registration), not CIMD');
		return true;
	}

	console.log('  registration mode: CIMD (client_id is the metadata document URL)');
	return inspectCimd(clientId, redirectUri);
}

function startCloudflared(target) {
	return new Promise((resolve, reject) => {
		const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		let settled = false;
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill('SIGTERM');
				reject(new Error(`Timed out waiting for cloudflared tunnel URL\n${output}`));
			}
		}, 30_000);

		const onData = (chunk) => {
			const text = chunk.toString();
			output += text;
			const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
			if (match && !settled) {
				settled = true;
				clearTimeout(timeout);
				resolve({
					child,
					url: match[0],
					stop: async () => {
						if (child.exitCode !== null) return;
						const exited = new Promise((done) => child.once('exit', done));
						child.kill('SIGTERM');
						await Promise.race([
							exited,
							new Promise((done) =>
								setTimeout(() => {
									if (child.exitCode === null) child.kill('SIGKILL');
									done();
								}, 5_000)
							),
						]);
					},
				});
			}
		};

		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.once('error', (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`Unable to start cloudflared: ${error.message}. Install it or use --client-metadata-url.`));
			}
		});
		child.once('exit', (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`cloudflared exited with code ${String(code)}\n${output}`));
			}
		});
	});
}

function createMetadataServer(getMetadata) {
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (requestUrl.pathname !== METADATA_PATH) {
			response.writeHead(404);
			response.end('Not found');
			return;
		}

		const metadata = getMetadata();
		if (!metadata) {
			response.writeHead(503, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'CIMD tunnel is still starting' }));
			return;
		}
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		});
		response.end(JSON.stringify(metadata));
	});

	return {
		listen: () =>
			new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => {
					const address = server.address();
					if (!address || typeof address === 'string') {
						reject(new Error('Unable to determine metadata server port'));
						return;
					}
					resolve(`http://127.0.0.1:${address.port}`);
				});
			}),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function createCallbackServer(redirectUrl, expectedState) {
	let resolveCallback;
	let rejectCallback;
	const callback = new Promise((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	void callback.catch(() => {});

	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? '/', redirectUrl.origin);

		if (requestUrl.pathname !== redirectUrl.pathname) {
			response.writeHead(404);
			response.end('Not found');
			return;
		}

		const error = requestUrl.searchParams.get('error');
		const errorDescription = requestUrl.searchParams.get('error_description');
		const state = requestUrl.searchParams.get('state');
		if (state !== expectedState) {
			response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('OAuth callback ignored: state mismatch');
			return;
		}
		if (error) {
			response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end(`OAuth failed: ${error}${errorDescription ? `: ${errorDescription}` : ''}`);
			rejectCallback(
				new Error(`OAuth authorization failed: ${error}${errorDescription ? `: ${errorDescription}` : ''}`)
			);
			return;
		}

		const code = requestUrl.searchParams.get('code');
		if (!code) {
			response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('OAuth failed: missing authorization code');
			rejectCallback(new Error('OAuth callback did not contain an authorization code'));
			return;
		}

		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		response.end('<h1>OAuth succeeded</h1><p>You can close this window and return to the terminal.</p>');
		resolveCallback(requestUrl.searchParams);
	});

	return {
		callback,
		listen: () =>
			new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(Number(redirectUrl.port), redirectUrl.hostname.replace(/^\[|\]$/g, ''), resolve);
			}),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

class DiagnosticOAuthProvider {
	constructor(redirectUrl, metadataUrl, onAuthorizationUrl, state, scope) {
		this.redirectUrl = redirectUrl;
		this.clientMetadataUrl = metadataUrl;
		this.onAuthorizationUrl = onAuthorizationUrl;
		this.oauthState = state;
		this.scope = scope;
	}

	get clientMetadata() {
		return clientMetadata(this.clientMetadataUrl, String(this.redirectUrl), this.scope);
	}

	state() {
		return this.oauthState;
	}

	clientInformation() {
		return this.clientInfo;
	}

	saveClientInformation(clientInfo) {
		this.clientInfo = clientInfo;
		const mode = isCimdClientId(clientInfo.client_id) ? 'CIMD' : 'dynamic registration';
		console.log(`\nClient registration mode: ${mode}`);
		console.log(`  client_id: ${clientInfo.client_id}`);
		if (Array.isArray(clientInfo.redirect_uris)) {
			console.log(`  registered redirect_uris: ${JSON.stringify(clientInfo.redirect_uris)}`);
		}
		console.log(`  client secret returned: ${clientInfo.client_secret ? 'yes (redacted)' : 'no'}`);
	}

	tokens() {
		return this.oauthTokens;
	}

	saveTokens(tokens) {
		this.oauthTokens = tokens;
		console.log('\nToken exchange succeeded (tokens redacted and kept in memory only).');
	}

	async redirectToAuthorization(url) {
		await this.onAuthorizationUrl(url);
	}

	saveCodeVerifier(verifier) {
		this.verifier = verifier;
	}

	codeVerifier() {
		if (!this.verifier) throw new Error('No PKCE code verifier was saved');
		return this.verifier;
	}
}

async function main() {
	if (values.help) {
		printHelp();
		return;
	}
	if (values['inspect-auth-url']) {
		const passed = await inspectAuthorizationUrl(values['inspect-auth-url']);
		if (!passed) process.exitCode = 1;
		return;
	}
	if (values.cimd && values['client-metadata-url']) {
		throw new Error('Use either --cimd or --client-metadata-url, not both');
	}

	const serverUrl = new URL(values.server);
	const redirectUrl = parseLoopbackRedirect(values['redirect-uri']);
	const scope = values.scope.trim().split(/\s+/).filter(Boolean).join(' ');
	if (!scope) throw new Error('--scope must contain at least one scope');
	const state = randomBytes(24).toString('base64url');
	let metadata;
	const callbackServer = createCallbackServer(redirectUrl, state);
	const metadataServer = createMetadataServer(() => metadata);
	let tunnel;
	let transport;

	await callbackServer.listen();
	console.log(`OAuth callback listening at ${redirectUrl}`);

	try {
		let metadataUrl = values['client-metadata-url'];
		if (values.cimd) {
			const metadataOrigin = await metadataServer.listen();
			console.log('Starting temporary public HTTPS tunnel for the CIMD document...');
			tunnel = await startCloudflared(metadataOrigin);
			metadataUrl = `${tunnel.url}${METADATA_PATH}`;
			metadata = clientMetadata(metadataUrl, String(redirectUrl), scope);
			console.log(`CIMD document exposed at ${metadataUrl}`);
			await waitForPublicUrl(metadataUrl);
			if (!(await inspectCimd(metadataUrl, String(redirectUrl)))) {
				throw new Error('Generated CIMD document failed validation');
			}
		} else if (metadataUrl) {
			if (!(await inspectCimd(metadataUrl, String(redirectUrl)))) {
				throw new Error('CIMD document failed validation');
			}
		}

		const provider = new DiagnosticOAuthProvider(
			String(redirectUrl),
			metadataUrl,
			async (url) => {
				console.log(`\nOpen this URL in a browser:\n\n${url}\n`);
				const passed = await inspectAuthorizationUrl(String(url));
				if (!passed) console.log('\nThe authorization request has CIMD validation failures.');
			},
			state,
			scope
		);
		const diagnosticFetch = createDiagnosticFetch(scope, serverUrl);
		let client;
		const connect = async () => {
			client = new Client({ name: 'hf-mcp-oauth-diagnostic', version: '1.0.0' });
			transport = new StreamableHTTPClientTransport(serverUrl, {
				authProvider: provider,
				fetch: diagnosticFetch,
			});
			await client.connect(transport);
		};

		console.log(`Connecting to MCP server ${serverUrl}...`);
		try {
			await connect();
		} catch (error) {
			if (!(error instanceof UnauthorizedError)) throw error;
			const callbackParams = await callbackServer.callback;
			await transport.finishAuth(callbackParams);
			await transport.close().catch(() => {});
			await connect();
		}

		if (!client) throw new Error('MCP client was not initialized');
		const { tools } = await client.listTools();
		console.log(`\nAuthenticated MCP connection succeeded; server returned ${tools.length} tools.`);
		await client.close();
	} finally {
		if (transport) await transport.close().catch(() => {});
		if (tunnel) await tunnel.stop();
		await metadataServer.close().catch(() => {});
		await callbackServer.close();
	}
}

main().catch((error) => {
	console.error(`\nOAuth diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
