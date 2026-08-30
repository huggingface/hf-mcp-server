import { describe, expect, it, vi } from 'vitest';
import { Application } from '../../src/server/application.js';
import type { WebServer } from '../../src/server/web-server.js';

/**
 * On STDIO the web server is the dashboard, not the transport, and
 * `Application.start()` starts it before the transport is initialized. A listen
 * failure there used to propagate out of `start()`, which `stdio.ts` turns into
 * `process.exit(1)` -- so an occupied port meant the MCP server never read
 * stdin and the client saw a server that never answered `initialize`.
 */
function webServerDouble(startImpl: () => Promise<void>) {
	return {
		getApp: () => ({}) as never,
		setTransportInfo: vi.fn(),
		setupApiRoutes: vi.fn(),
		setupStaticFiles: vi.fn(async () => undefined),
		setTransport: vi.fn(),
		start: vi.fn(startImpl),
		stop: vi.fn(async () => undefined),
	} as unknown as WebServer;
}

const listenFailure = () => {
	const error = new Error('listen EADDRINUSE: address already in use :::3000') as NodeJS.ErrnoException;
	error.code = 'EADDRINUSE';
	return Promise.reject(error);
};

describe('web dashboard failure on STDIO', () => {
	it('keeps serving MCP when the dashboard port is taken', async () => {
		const webServer = webServerDouble(listenFailure);
		const app = new Application({
			transportType: 'stdio',
			webAppPort: 3000,
			webServerInstance: webServer,
		});

		await expect(app.start()).resolves.toBeUndefined();
		// The transport is initialized after the web server, so reaching it at all
		// is what proves the failure no longer aborts startup.
		expect(webServer.setTransport).toHaveBeenCalled();
	});

	it('still fails for HTTP transports, where the port is the transport', async () => {
		const app = new Application({
			transportType: 'streamableHttpJson',
			webAppPort: 3000,
			webServerInstance: webServerDouble(listenFailure),
		});

		await expect(app.start()).rejects.toThrow(/EADDRINUSE/);
	});
});
