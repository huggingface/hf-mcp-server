import { type Express } from 'express';
import { type TransportType } from '../shared/constants.js';
import type { TransportInfo } from '../shared/transport-info.js';
import { createTransport } from './transport/transport-factory.js';
import type { BaseTransport, ServerFactory } from './transport/base-transport.js';
import type { WebServer } from './web-server.js';
import { logger } from './utils/logger.js';
import { createServerFactory } from './mcp-server.js';
import { createProxyServerFactory } from './mcp-proxy.js';
import { McpApiClient, type ApiClientConfig } from './utils/mcp-api-client.js';
import { loadProxyToolsConfig } from './utils/proxy-tools-config.js';
import { runtimeMetrics } from './utils/runtime-metrics.js';
import { startRuntimeSampleLogging, stopRuntimeSampleLogging } from './utils/runtime-sample-logger.js';
import { MetricsCounter } from '../shared/transport-metrics.js';
import { createForwardingMetrics, isClusterWorker } from './cluster/ipc.js';
import { ClusterSessionStore } from './sessions/session-registry.js';

interface ApplicationOptions {
	transportType: TransportType;
	webAppPort: number;
	webServerInstance: WebServer;
}

/**
 * Main application class that coordinates web server, MCP server factory, and transport lifecycle
 */
export class Application {
	private serverFactory: ServerFactory;
	private webServerInstance: WebServer;
	private appInstance: Express;
	private transport?: BaseTransport;
	private apiClient: McpApiClient;
	private transportType: TransportType;
	private webAppPort: number;
	private isDev: boolean;
	private serving = false;

	constructor(options: ApplicationOptions) {
		this.transportType = options.transportType;
		this.webAppPort = options.webAppPort;
		this.webServerInstance = options.webServerInstance;
		this.isDev = process.env.NODE_ENV === 'development';

		// Create transport info first
		const defaultHfToken = process.env.DEFAULT_HF_TOKEN;
		const transportInfo: TransportInfo = {
			transport: this.transportType,
			port: this.webAppPort,
			defaultHfTokenSet: !!defaultHfToken,
			hfTokenMasked: defaultHfToken ? maskToken(defaultHfToken) : undefined,
			externalApiMode: !!process.env.USER_CONFIG_API,
			stdioClient: this.transportType === 'stdio' ? null : undefined,
		};

		let apiClientConfig: ApiClientConfig;

		// Check for USER_CONFIG_API environment variable
		const userConfigApi = process.env.USER_CONFIG_API;
		if (userConfigApi) {
			// Use external mode with the user config API
			apiClientConfig = {
				type: 'external',
				externalUrl: userConfigApi,
				hfToken: process.env.DEFAULT_HF_TOKEN,
			};
			logger.info(`Using external API client with user config API: ${userConfigApi}`);
		} else {
			// Use immutable built-in settings when no per-user API is configured.
			apiClientConfig = {
				type: 'static',
			};
			logger.info('Using immutable built-in tool settings');
		}
		this.apiClient = new McpApiClient(apiClientConfig, transportInfo);

		// This creates our MCP Server with the standard tools.
		const originalServerFactory = createServerFactory(this.apiClient);

		// This adds the Gradio endpoints to the original MCP Server.
		this.serverFactory = createProxyServerFactory(this.apiClient, originalServerFactory);

		// Get Express app instance
		this.appInstance = this.webServerInstance.getApp();
	}

	public isServing(): boolean {
		return this.serving;
	}

	async start(options: { shouldAbort?: () => boolean } = {}): Promise<void> {
		await loadProxyToolsConfig();
		if (options.shouldAbort?.()) return;

		// Set transport info (already created in constructor)
		const transportInfo = this.apiClient.getTransportInfo();
		if (transportInfo) {
			this.webServerInstance.setTransportInfo(transportInfo);
		}

		// Configure API endpoints
		this.webServerInstance.setupApiRoutes();

		// Initialize transport (before static files and before listening so routes are mounted first)
		await this.initializeTransport();
		if (options.shouldAbort?.()) return;

		// Setup static files (must be AFTER transport routes to avoid catch-all conflicts)
		await this.webServerInstance.setupStaticFiles(this.isDev);
		if (options.shouldAbort?.()) return;

		// Start web server once all routes are mounted
		await this.startWebServer();
		if (options.shouldAbort?.()) {
			await this.stop({ drainMs: 0 });
			return;
		}

		runtimeMetrics.start({ sessionCount: () => this.transport?.getSessionCount() ?? 0 });
		if (!isClusterWorker) {
			startRuntimeSampleLogging();
		}
	}

	private async initializeTransport(): Promise<void> {
		if (this.transportType === 'unknown') return;

		try {
			const transportOptions =
				isClusterWorker && this.transportType === 'streamableHttpJson'
					? {
							metrics: createForwardingMetrics(new MetricsCounter()),
							sessionStore: new ClusterSessionStore(),
						}
					: undefined;
			this.transport = createTransport(this.transportType, this.serverFactory, this.appInstance, transportOptions);

			// Pass transport to web server for session management
			this.webServerInstance.setTransport(this.transport);

			await this.transport.initialize();
		} catch (error) {
			logger.error({ error }, `Error initializing ${this.transportType} transport`);
			throw error;
		}
	}

	private async startWebServer(): Promise<void> {
		// WebServer manages its own lifecycle
		try {
			await this.webServerInstance.start(this.webAppPort);
			this.serving = true;
		} catch (error) {
			// On STDIO the web server is the dashboard, not the transport, and it
			// starts before the transport is initialized. Letting a listen failure
			// propagate takes the MCP server down with it: the process exits before
			// stdin is ever read, so the client sees a server that never answers
			// `initialize`. The default port is one of the most commonly occupied
			// on a developer machine, and nothing about serving MCP over stdio
			// needs it.
			if (this.transportType === 'stdio') {
				logger.warn(
					{ error, port: this.webAppPort },
					'Web dashboard could not start; continuing with STDIO transport only'
				);
				return;
			}
			throw error;
		}
		logger.info(`Server running at http://localhost:${String(this.webAppPort)}`);
		logger.info(
			{ transportType: this.transportType, mode: this.isDev ? 'development with HMR' : 'production' },
			'Server configuration'
		);
		if (this.isDev) {
			logger.info('HMR is active - frontend changes will be automatically reflected in the browser');
			logger.info("For server changes, use 'npm run dev:watch' to automatically rebuild and apply changes");
		}
	}

	async stop(options: { drainMs?: number } = {}): Promise<void> {
		this.serving = false;
		stopRuntimeSampleLogging();
		runtimeMetrics.stop();
		logger.info('Shutting down web server...');
		await this.webServerInstance.stop(options.drainMs);

		// Clean up transport if initialized
		if (this.transport) {
			await this.transport.cleanup();
		}
	}
}

function maskToken(token: string): string {
	if (!token || token.length <= 9) return token;
	return `${token.substring(0, 4)}...${token.substring(token.length - 5)}`;
}
