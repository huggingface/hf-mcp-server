import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../../src/server/web-server.js';
import type { BaseTransport, SessionMetadata } from '../../src/server/transport/base-transport.js';
import { MetricsCounter } from '../../src/shared/transport-metrics.js';

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
		const webServer = new WebServer();
		webServers.push(webServer);
		const getSessions = vi.fn(() => [testSession()]);
		webServer.setTransport(
			{
				getMetrics: () => new MetricsCounter().getMetrics(),
				getSessions,
			} as unknown as BaseTransport
		);
		webServer.setTransportInfo({
			transport: 'streamableHttpJson',
			defaultHfTokenSet: false,
			externalApiMode: false,
			stdioClient: null,
		});
		webServer.setupApiRoutes();
		await webServer.start(0);

		const response = await fetch(`http://localhost:${webServerPort(webServer).toString()}/api/transport-metrics`);
		const body = (await response.json()) as { sessions?: unknown[] };

		expect(response.status).toBe(200);
		expect(body.sessions).toEqual([]);
		expect(getSessions).not.toHaveBeenCalled();
	});

	it('retains session details in STDIO transport metrics', async () => {
		const webServer = new WebServer();
		webServers.push(webServer);
		const getSessions = vi.fn(() => [testSession()]);
		webServer.setTransport(
			{
				getMetrics: () => new MetricsCounter().getMetrics(),
				getSessions,
			} as unknown as BaseTransport
		);
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
});

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
