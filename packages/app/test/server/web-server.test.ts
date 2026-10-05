import * as skillCatalogCache from '../../src/server/skills/skill-catalog-cache.js';
import type { SkillsMetricsResponse } from '../../src/shared/skills-metrics.js';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../../src/server/web-server.js';
import type { BaseTransport, SessionMetadata } from '../../src/server/transport/base-transport.js';
import { MetricsCounter } from '../../src/shared/transport-metrics.js';
import { SERVER_CARD_PATH } from '../../src/server/server-card.js';
import { createMetricsPageAuth, METRICS_PAGE_AUTH_COOKIE_NAME } from '../../src/server/utils/metrics-page-auth.js';
import { recordHfFsLiveMetrics, resetHfFsLiveMetricsForTests } from '../../src/server/utils/hf-fs-live-metrics.js';
import {
	getDefinitionDigestsTestSalt,
	setDefinitionDigestsTestSalt,
} from '../../src/server/definition-digests/policy.js';
import {
	recordDynamicSpaceLiveMetrics,
	resetDynamicSpaceLiveMetricsForTests,
} from '../../src/server/utils/dynamic-space-live-metrics.js';
import type { DynamicSpaceLiveMetricsResponse } from '../../src/shared/dynamic-space-metrics.js';
import type { DefinitionDigestsStatus } from '../../src/shared/definition-digests-status.js';

const METRICS_PASSWORD = 'test metrics password & secret';

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.listen(0, (error?: Error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function webServerPort(webServer: WebServer): number {
	const server = (webServer as unknown as { server: Server | null }).server;
	const address = server?.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected WebServer to listen on a TCP port');
	}
	return address.port;
}

describe('WebServer', () => {
	const servers: Server[] = [];
	const webServers: WebServer[] = [];

	beforeEach(() => {
		resetHfFsLiveMetricsForTests();
		resetDynamicSpaceLiveMetricsForTests();
	});

	afterEach(async () => {
		await Promise.allSettled(webServers.map((server) => server.stop()));
		await Promise.allSettled(servers.map((server) => close(server)));
		webServers.length = 0;
		servers.length = 0;
	});

	it('rejects startup when Express cannot bind the requested port', async () => {
		const blocker = createServer();
		servers.push(blocker);
		await listen(blocker);

		const address = blocker.address();
		if (!address || typeof address === 'string') {
			throw new Error('Expected the blocker to listen on a TCP port');
		}

		const webServer = new WebServer();
		webServers.push(webServer);

		await expect(webServer.start(address.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
		await expect(webServer.start(0)).resolves.toBeUndefined();
	});

	it('omits analytics session details from stateless transport metrics', async () => {
		recordDynamicSpaceLiveMetrics('invoke', true);
		recordDynamicSpaceLiveMetrics('view_parameters', false, 'schema');
		recordHfFsLiveMetrics({
			hfFsReportingSchema: 'hf_fs_batch_v1',
			hfFsBatchOutcome: 'complete',
			hfFsOperationsRequested: 2,
			hfFsOperationsCompleted: 2,
			hfFsOperationsSucceeded: 2,
			hfFsRequestErrorCount: 0,
			hfFsTargetErrorCount: 0,
			hfFsPolicyLimitErrorCount: 0,
			hfFsServiceErrorCount: 0,
			hfFsOperationErrorsJson: '[]',
		});
		const webServer = new WebServer();
		webServers.push(webServer);
		const getSessions = vi.fn(() => [testSession()]);
		webServer.setTransport({
			getMetrics: () => new MetricsCounter().getMetrics(),
			getSessions,
		} as unknown as BaseTransport);
		webServer.setTransportInfo({
			transport: 'streamableHttpJson',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		webServer.setupApiRoutes();
		await webServer.start(0);

		const response = await fetch(`http://localhost:${webServerPort(webServer).toString()}/api/transport-metrics`);
		const body = (await response.json()) as {
			dynamicSpaceMetrics?: DynamicSpaceLiveMetricsResponse;
			sessions?: unknown[];
			hfFsMetrics?: { batches: { total: number }; operations: { completed: number; succeeded: number } };
		};

		expect(response.status).toBe(200);
		expect(body.sessions).toEqual([]);
		expect(body.hfFsMetrics).toMatchObject({
			batches: { total: 1 },
			operations: { completed: 2, succeeded: 2 },
		});
		expect(body.dynamicSpaceMetrics).toMatchObject({
			reportingSchema: 'dynamic_space_outcome_v1',
			calls: { total: 2, succeeded: 1, failed: 1 },
			operations: { invoke: { total: 1, succeeded: 1, failed: 0 } },
			failuresByStage: { schema: 1 },
		});
		expect(getSessions).not.toHaveBeenCalled();
	});

	it('retains session details in STDIO transport metrics', async () => {
		const webServer = new WebServer();
		webServers.push(webServer);
		const getSessions = vi.fn(() => [testSession()]);
		webServer.setTransport({
			getMetrics: () => new MetricsCounter().getMetrics(),
			getSessions,
		} as unknown as BaseTransport);
		webServer.setTransportInfo({
			transport: 'stdio',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		webServer.setupApiRoutes();
		await webServer.start(0);

		const response = await fetch(`http://localhost:${webServerPort(webServer).toString()}/api/transport-metrics`);
		const body = (await response.json()) as { sessions?: Array<{ id: string }> };

		expect(response.status).toBe(200);
		expect(body.sessions).toEqual([expect.objectContaining({ id: 'session-1' })]);
		expect(getSessions).toHaveBeenCalledOnce();
	});

	it('does not expose Server Card discovery in STDIO mode', async () => {
		const webServer = new WebServer();
		webServers.push(webServer);
		webServer.setTransportInfo({
			transport: 'stdio',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		await webServer.setupStaticFiles(false);
		await webServer.start(0);

		const cardUrl = `http://localhost:${webServerPort(webServer).toString()}${SERVER_CARD_PATH}`;
		const response = await fetch(cardUrl);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).not.toContain('text/html');

		const crossOriginResponse = await fetch(cardUrl, {
			headers: { Origin: 'https://catalog-client.example' },
		});
		expect(crossOriginResponse.status).toBe(403);
		expect(crossOriginResponse.headers.get('access-control-allow-origin')).not.toBe('*');
	});

	it('redirects the root to MCP and serves the public dashboard at /metrics when authentication is disabled', async () => {
		const webServer = new WebServer();
		webServers.push(webServer);
		await webServer.setupStaticFiles(false);
		await webServer.start(0);
		const baseUrl = `http://localhost:${webServerPort(webServer).toString()}`;

		const rootResponse = await fetch(baseUrl, { redirect: 'manual' });
		expect(rootResponse.status).toBe(302);
		expect(rootResponse.headers.get('location')).toBe('/mcp');

		const metricsResponse = await fetch(`${baseUrl}/metrics`);
		expect(metricsResponse.status).toBe(200);
		expect(metricsResponse.headers.get('content-type')).toContain('text/html');
		expect(await metricsResponse.text()).toContain('<div id="root"></div>');
	});

	it('protects dashboard APIs while allowing header and query scraper credentials', async () => {
		const webServer = protectedWebServer();
		webServers.push(webServer);
		webServer.setupApiRoutes();
		await webServer.start(0);
		const baseUrl = `http://localhost:${webServerPort(webServer).toString()}`;

		for (const path of ['/api/transport', '/api/sessions', '/api/transport-metrics', '/api/skills-metrics']) {
			const response = await fetch(`${baseUrl}${path}`);
			expect(response.status).toBe(401);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(await response.json()).toEqual({ error: 'Metrics page authentication required' });
		}

		const headerResponse = await fetch(`${baseUrl}/api/transport`, {
			headers: { 'X-Metrics-Password': METRICS_PASSWORD },
		});
		expect(headerResponse.status).toBe(200);

		const query = new URLSearchParams({ metrics_password: METRICS_PASSWORD });
		const queryResponse = await fetch(`${baseUrl}/api/transport-metrics?${query.toString()}`);
		expect(queryResponse.status).toBe(200);
		expect(queryResponse.headers.get('cache-control')).toBe('no-store, private');
	});

	it('serves read-only Skills health and validated live metrics behind the same auth', async () => {
		const load = vi.spyOn(skillCatalogCache, 'getSkillCatalog');
		const health = vi.spyOn(skillCatalogCache, 'getSkillCatalogStatus');
		try {
			const webServer = protectedWebServer();
			webServers.push(webServer);
			webServer.setupApiRoutes();
			await webServer.start(0);
			const url = `http://localhost:${webServerPort(webServer).toString()}/api/skills-metrics`;
			expect((await fetch(url)).status).toBe(401);
			expect(health).not.toHaveBeenCalled();
			const headers = { 'X-Metrics-Password': METRICS_PASSWORD };
			for (const suffix of [
				'?window=no',
				'?method=no',
				'?outcome=no',
				'?client=x&client=y',
				'?extra=x',
				`?client=${'x'.repeat(129)}`,
			]) {
				const response = await fetch(url + suffix, { headers });
				expect(response.status).toBe(400);
				expect(response.headers.get('cache-control')).toBe('no-store');
			}
			expect(health).not.toHaveBeenCalled();
			webServer.setTransportInfo({
				transport: 'streamableHttpJson',
				defaultHfTokenSet: false,
				stdioClient: null,
			});
			const response = await fetch(url + '?window=15m&method=skills%2Fget&outcome=success&client=TEST', { headers });
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as SkillsMetricsResponse;
			expect(body).toMatchObject({
				supported: true,
				unsupportedReason: null,
				snapshot: { state: 'not-loaded' },
				live: { filters: { window: '15m', method: 'skills/get', outcome: 'success', client: 'TEST' } },
			});
			const queryResponse = await fetch(url + '?' + new URLSearchParams({ metrics_password: METRICS_PASSWORD }));
			expect(queryResponse.status).toBe(200);
			expect(((await queryResponse.json()) as SkillsMetricsResponse).live?.filters.window).toBe('1h');
			webServer.setTransportInfo({ transport: 'stdio', defaultHfTokenSet: false, stdioClient: null });
			const unsupported = await fetch(url, { headers });
			expect(await unsupported.json()).toMatchObject({
				transport: 'stdio',
				supported: false,
				live: null,
				unsupportedReason: expect.stringContaining('stdio'),
			});
			expect(load).not.toHaveBeenCalled();
		} finally {
			load.mockRestore();
			health.mockRestore();
		}
	});

	it('serves definition-digests test controls only in test mode, behind API authentication', async () => {
		const previous = process.env.DEFINITION_DIGESTS_TEST;
		const webServer = protectedWebServer();
		webServers.push(webServer);
		webServer.setupApiRoutes();
		await webServer.start(0);
		const base = `http://localhost:${webServerPort(webServer).toString()}/api/definition-digests`;
		const auth = { 'X-Metrics-Password': METRICS_PASSWORD };
		const json = async (response: Response) => (await response.json()) as DefinitionDigestsStatus;
		try {
			delete process.env.DEFINITION_DIGESTS_TEST;
			expect((await fetch(base, { headers: auth })).status).toBe(404);
			expect((await fetch(`${base}/salt`, { method: 'POST', headers: auth })).status).toBe(404);

			process.env.DEFINITION_DIGESTS_TEST = 'true';
			expect((await fetch(`${base}/salt`, { method: 'POST' })).status).toBe(401);
			expect(getDefinitionDigestsTestSalt()).toBe('');

			const initial = await json(await fetch(base, { headers: auth }));
			expect(initial).toMatchObject({ enabled: true, testSalt: '', errorCode: -32987, stats: { checkedCalls: 0 } });

			const set = await json(await fetch(`${base}/salt?value=abc`, { method: 'POST', headers: auth }));
			expect(set).toMatchObject({ testSalt: 'abc', testSaltUpdatedAt: expect.any(String) });

			const random = await json(await fetch(`${base}/salt`, { method: 'POST', headers: auth }));
			expect(random.testSalt).toMatch(/^[0-9a-f]{8}$/);

			const invalid = await fetch(`${base}/salt?value=${encodeURIComponent('has space')}`, {
				method: 'POST',
				headers: auth,
			});
			expect(invalid.status).toBe(400);
			expect(getDefinitionDigestsTestSalt()).toBe(random.testSalt);

			expect(await json(await fetch(`${base}/salt`, { method: 'DELETE', headers: auth }))).toMatchObject({
				testSalt: '',
			});
			const reset = await json(await fetch(`${base}/stats`, { method: 'DELETE', headers: auth }));
			expect(reset.stats).toMatchObject({ checkedCalls: 0, mismatched: 0, since: expect.any(String) });
		} finally {
			setDefinitionDigestsTestSalt('');
			if (previous === undefined) delete process.env.DEFINITION_DIGESTS_TEST;
			else process.env.DEFINITION_DIGESTS_TEST = previous;
		}
	});

	it('does not call the metrics handler before an API request is authenticated', async () => {
		const getMetrics = vi.fn(() => new MetricsCounter().getMetrics());
		const webServer = protectedWebServer(getMetrics);
		webServers.push(webServer);
		webServer.setupApiRoutes();
		await webServer.start(0);

		const response = await fetch(
			`http://localhost:${webServerPort(webServer).toString()}/api/transport-metrics?templog=10`
		);

		expect(response.status).toBe(401);
		expect(getMetrics).not.toHaveBeenCalled();
	});

	it('sets a persistent cookie after form login and accepts it on later requests', async () => {
		const webServer = protectedWebServer();
		webServers.push(webServer);
		webServer.setupApiRoutes();
		await webServer.setupStaticFiles(false);
		await webServer.start(0);
		const baseUrl = `http://localhost:${webServerPort(webServer).toString()}`;

		const rootResponse = await fetch(baseUrl, { redirect: 'manual' });
		expect(rootResponse.status).toBe(302);
		expect(rootResponse.headers.get('location')).toBe('/mcp');

		const dashboardResponse = await fetch(`${baseUrl}/metrics`, { redirect: 'manual' });
		expect(dashboardResponse.status).toBe(302);
		expect(dashboardResponse.headers.get('location')).toBe('/metrics/login');

		const loginPageResponse = await fetch(`${baseUrl}/metrics/login`);
		const loginPage = await loginPageResponse.text();
		expect(loginPageResponse.status).toBe(200);
		expect(loginPageResponse.headers.get('cache-control')).toBe('no-store');
		expect(loginPage).toContain('action="/metrics/login"');
		expect(loginPage).toContain('type="password"');
		expect(loginPage).not.toContain(METRICS_PASSWORD);

		const invalidPassword = 'wrong-password-must-not-be-reflected';
		const invalidResponse = await fetch(`${baseUrl}/metrics/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ password: invalidPassword }),
			redirect: 'manual',
		});
		const invalidPage = await invalidResponse.text();
		expect(invalidResponse.status).toBe(401);
		expect(invalidResponse.headers.get('set-cookie')).toBeNull();
		expect(invalidPage).not.toContain(invalidPassword);

		const loginResponse = await fetch(`${baseUrl}/metrics/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Origin: 'null',
			},
			body: new URLSearchParams({ password: METRICS_PASSWORD }),
			redirect: 'manual',
		});
		const setCookie = loginResponse.headers.get('set-cookie');
		if (!setCookie) {
			throw new Error('Expected login to set an authentication cookie');
		}
		const cookie = setCookie.split(';', 1)[0];

		expect(loginResponse.status).toBe(303);
		expect(loginResponse.headers.get('location')).toBe('/metrics');
		expect(setCookie).toContain(`${METRICS_PAGE_AUTH_COOKIE_NAME}=`);
		expect(setCookie).toContain('Max-Age=2592000');
		expect(setCookie).toContain('Path=/');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('SameSite=Lax');
		expect(setCookie).not.toContain('Secure');
		expect(setCookie).not.toContain(METRICS_PASSWORD);

		const authenticatedResponse = await fetch(`${baseUrl}/api/transport`, {
			headers: { Cookie: cookie },
		});
		expect(authenticatedResponse.status).toBe(200);

		const authenticatedDashboard = await fetch(`${baseUrl}/metrics`, {
			headers: { Cookie: cookie },
		});
		expect(authenticatedDashboard.status).toBe(200);
		expect(await authenticatedDashboard.text()).toContain('<div id="root"></div>');

		const authenticatedLoginPage = await fetch(`${baseUrl}/metrics/login`, {
			headers: { Cookie: cookie },
			redirect: 'manual',
		});
		expect(authenticatedLoginPage.status).toBe(302);
		expect(authenticatedLoginPage.headers.get('location')).toBe('/metrics');
	});

	it('marks the login cookie secure when HTTPS is forwarded by the trusted proxy', async () => {
		const webServer = protectedWebServer();
		webServers.push(webServer);
		await webServer.start(0);

		const response = await fetch(`http://localhost:${webServerPort(webServer).toString()}/metrics/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'X-Forwarded-Proto': 'https',
			},
			body: new URLSearchParams({ password: METRICS_PASSWORD }),
			redirect: 'manual',
		});

		expect(response.status).toBe(303);
		expect(response.headers.get('set-cookie')).toContain('Secure');
	});

	it('leaves MCP paths outside the metrics page gate', async () => {
		const webServer = protectedWebServer();
		webServers.push(webServer);
		webServer.setTransportInfo({
			transport: 'stdio',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		await webServer.setupStaticFiles(false);
		await webServer.start(0);
		const baseUrl = `http://localhost:${webServerPort(webServer).toString()}`;

		const mcpResponse = await fetch(`${baseUrl}/mcp`, { redirect: 'manual' });
		expect(mcpResponse.status).not.toBe(302);
		expect(mcpResponse.headers.get('location')).not.toBe('/metrics/login');

		const cardResponse = await fetch(`${baseUrl}${SERVER_CARD_PATH}`, { redirect: 'manual' });
		expect(cardResponse.status).toBe(404);
		expect(cardResponse.headers.get('location')).not.toBe('/metrics/login');
	});
});

function protectedWebServer(getMetrics = () => new MetricsCounter().getMetrics()): WebServer {
	const webServer = new WebServer({ metricsPageAuth: createMetricsPageAuth(METRICS_PASSWORD) });
	webServer.setTransport({
		getMetrics,
		getSessions: () => [testSession()],
	} as unknown as BaseTransport);
	webServer.setTransportInfo({
		transport: 'streamableHttpJson',
		defaultHfTokenSet: false,
		externalApiMode: false,
		stdioClient: null,
	});
	return webServer;
}

function testSession(): SessionMetadata {
	return {
		id: 'session-1',
		connectedAt: new Date('2026-07-28T00:00:00.000Z'),
		lastActivity: new Date(),
		requestCount: 3,
		isAuthenticated: false,
		capabilities: {},
	};
}
