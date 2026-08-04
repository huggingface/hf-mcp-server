import express, { type Express } from 'express';
import cors from 'cors';
import type { CorsOptions, CorsRequest, CorsOptionsDelegate } from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { TransportInfo } from '../shared/transport-info.js';
import { logger } from './utils/logger.js';
import type { BaseTransport } from './transport/base-transport.js';
import { formatMetricsForAPI } from '../shared/transport-metrics.js';
import { CORS_ALLOWED_ORIGINS, CORS_EXPOSED_HEADERS } from '../shared/constants.js';
import { apiMetrics } from './utils/api-metrics.js';
import { gradioMetrics } from './utils/gradio-metrics.js';
import { formatCacheMetricsForAPI } from './utils/gradio-cache.js';
import { inboundRequestSecurityMiddleware } from './utils/inbound-request-security.js';
import { matchesCorsOrigin, normalizeCorsOrigin } from './utils/cors-origin.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
	private app: Express;
	private server: Server | null = null;
	private transportInfo: TransportInfo = {
		transport: 'unknown',
		defaultHfTokenSet: false,
		externalApiMode: false,
		stdioClient: null,
	};
	private transport?: BaseTransport;

	constructor() {
		this.app = express() as Express;
		this.setupMiddleware();
	}

	private setupMiddleware(): void {
		this.app.disable('x-powered-by');
		this.app.set('trust proxy', true);
		// Inbound body size limit to prevent abuse
		this.app.use(express.json({ limit: '1mb' }));

		// Basic security headers (complementary to CORS)
		this.app.use((_, res, next) => {
			res.setHeader('X-Content-Type-Options', 'nosniff');
			res.setHeader('Referrer-Policy', 'no-referrer');
			if (process.env.HSTS === 'true') {
				res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
			}
			next();
		});

		this.app.use(['/mcp', '/api'], inboundRequestSecurityMiddleware);

		// Global CORS for all routes (API + MCP endpoints)
		// Simple exact-match allowlist with optional env override
		const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const envOriginsNorm = envOrigins.map(normalizeCorsOrigin);
		const allowedOrigins = (envOriginsNorm.length > 0 ? envOriginsNorm : CORS_ALLOWED_ORIGINS).map(normalizeCorsOrigin);

		// Support wildcard "*" to allow all origins explicitly
		let originSetting: CorsOptions['origin'];
		if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') {
			originSetting = '*';
		} else if (allowedOrigins.some((o) => o.includes('*'))) {
			// Support basic subdomain wildcards like "https://*.use-mcp.dev" or "*.use-mcp.dev"
			const exact = new Set(allowedOrigins.filter((o) => !o.includes('*')));
			const patterns = allowedOrigins.filter((o) => o.includes('*'));

			originSetting = (requestOrigin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
				if (!requestOrigin) return cb(null, true);
				const reqOrigin = normalizeCorsOrigin(requestOrigin);
				if (exact.has(reqOrigin)) return cb(null, true);
				return cb(
					null,
					patterns.some((pattern) => matchesCorsOrigin(requestOrigin, pattern))
				);
			};
		} else {
			originSetting = allowedOrigins;
		}

		const corsOptions: CorsOptions | CorsOptionsDelegate<CorsRequest> = {
			origin: originSetting,
			exposedHeaders: CORS_EXPOSED_HEADERS,
		};

		this.app.use(cors(corsOptions));
		// Ensure preflight requests succeed for any path
		this.app.options('{*splat}', cors(corsOptions));
	}

	public getApp(): Express {
		return this.app;
	}

	public setTransportInfo(info: TransportInfo): void {
		this.transportInfo = info;
	}

	public setTransport(transport: BaseTransport): void {
		this.transport = transport;
	}

	public getTransportInfo(): TransportInfo {
		return this.transportInfo;
	}

	public async start(port: number): Promise<void> {
		if (this.server) {
			throw new Error('Server is already running');
		}

		return new Promise((resolve, reject) => {
			const handleStartupError = (error: Error): void => {
				this.server = null;
				reject(error);
			};
			const server = this.app.listen(port, (error?: Error) => {
				server.off('error', handleStartupError);
				if (error) {
					handleStartupError(error);
					return;
				}

				this.transportInfo.port = port;
				resolve();
			});

			this.server = server;
			server.once('error', handleStartupError);
		});
	}

	public async stop(): Promise<void> {
		if (!this.server) {
			return;
		}

		return new Promise((resolve, reject) => {
			this.server?.close((err) => {
				if (err) {
					reject(err);
				} else {
					this.server = null;
					resolve();
				}
			});
		});
	}

	public async setupStaticFiles(isDevelopment: boolean): Promise<void> {
		if (isDevelopment) {
			// In development mode, use Vite's dev server middleware
			try {
				const { createServer: createViteServer } = await import('vite');
				const rootDir = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'web');

				// Create Vite server with proper HMR configuration
				const vite = await createViteServer({
					configFile: path.resolve(__dirname, '..', '..', '..', 'app', 'vite.config.ts'),
					server: {
						middlewareMode: true,
						hmr: true, // Explicitly enable HMR
					},
					appType: 'spa',
					root: rootDir,
				});

				// Use Vite's middleware for dev server with HMR
				this.app.use(vite.middlewares);

				logger.info('Using Vite middleware in development mode with HMR enabled');
				logger.info({ rootDir }, 'Vite root directory');
			} catch (err) {
				logger.error({ err }, 'Error setting up Vite middleware');
				throw err;
			}
		} else {
			// In production, serve static files
			const staticPath = path.join(__dirname, '..', 'web');
			this.app.use(express.static(staticPath));

			// Fallback to index.html for SPA routing
			this.app.get('{*splat}', (req, res) => {
				if (!req.path.startsWith('/api/')) {
					res.sendFile(path.join(staticPath, 'index.html'));
				}
			});
		}
	}

	public setupApiRoutes(): void {
		// Transport info endpoint
		this.app.get('/api/transport', (_req, res) => {
			res.json(this.transportInfo);
		});

		// Sessions endpoint
		this.app.get('/api/sessions', (_req, res) => {
			if (!this.transport) {
				res.json([]);
				return;
			}

			const sessions = this.transport.getSessions();

			// For STDIO transport, also update the stdioClient info if we have a session
			if (this.transportInfo.transport === 'stdio' && sessions.length > 0) {
				const stdioSession = sessions[0];
				if (stdioSession?.clientInfo && !this.transportInfo.stdioClient) {
					this.transportInfo.stdioClient = {
						name: stdioSession.clientInfo.name,
						version: stdioSession.clientInfo.version,
					};
				}
			}

			res.json(sessions);
		});

		// Transport metrics endpoint
		this.app.get('/api/transport-metrics', (req, res) => {
			if (!this.transport) {
				res.status(503).json({ error: 'Transport not initialized' });
				return;
			}

			try {
				// Check for templog query parameter
				const tempLogParam = req.query.templog;
				let tempLogStatus: { activated: boolean; remaining: number; maxAllowed: number } | undefined = undefined;

				if (tempLogParam && this.transportInfo.transport === 'streamableHttpJson') {
					// Only activate for stateless transport with analytics mode
					// We need to import StatelessHttpTransport type or use method check
					const statelessTransport = this.transport as {
						activateTempLogging?: (count: number) => number;
						getTempLogStatus?: () => { enabled: boolean; remaining: number; maxAllowed: number };
					};
					if (statelessTransport.activateTempLogging && statelessTransport.getTempLogStatus) {
						const requestedCount = parseInt(tempLogParam as string, 10);
						if (!isNaN(requestedCount) && requestedCount > 0) {
							const activated = statelessTransport.activateTempLogging(requestedCount);
							tempLogStatus = {
								activated: true,
								remaining: activated,
								maxAllowed: statelessTransport.getTempLogStatus().maxAllowed,
							};
						}
					}
				}

				// Get raw metrics from transport
				const metrics = this.transport.getMetrics();

				// Determine if transport is stateless
				const isStateless = this.transportInfo.transport === 'streamableHttpJson';

				// Stateless dashboards use aggregate lifecycle counters. Do not copy and
				// serialize the unbounded analytics-session map on every metrics poll.
				const sessions = isStateless
					? []
					: this.transport.getSessions().map((session) => {
							const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
							const hasRecentActivity = session.lastActivity > fiveMinutesAgo;

							return {
								id: session.id,
								connectedAt: session.connectedAt.toISOString(),
								lastActivity: session.lastActivity.toISOString(),
								requestCount: session.requestCount,
								clientInfo: session.clientInfo,
								isConnected: hasRecentActivity,
								connectionStatus: hasRecentActivity ? ('Connected' as const) : ('Disconnected' as const),
								ipAddress: session.ipAddress,
								protocolEra: session.protocolEra,
								protocolVersion: session.protocolVersion,
							};
						});

				// Format for API response
				const formattedMetrics = formatMetricsForAPI(metrics, this.transportInfo.transport, isStateless, sessions);

				// Add API metrics if in external API mode
				if (this.transportInfo.externalApiMode) {
					formattedMetrics.apiMetrics = apiMetrics.getMetrics();
				}

				// Add Gradio metrics
				formattedMetrics.gradioMetrics = gradioMetrics.getMetrics();

				// Add Gradio cache metrics
				formattedMetrics.gradioCacheMetrics = formatCacheMetricsForAPI();

				// Add temp log status if it was activated or if we need to check current status
				const extendedMetrics = formattedMetrics as typeof formattedMetrics & { tempLogStatus?: unknown };
				if (tempLogStatus) {
					extendedMetrics.tempLogStatus = tempLogStatus;
				} else if (this.transportInfo.transport === 'streamableHttpJson') {
					// Include current status even if not activating
					const statelessTransport = this.transport as {
						getTempLogStatus?: () => { enabled: boolean; remaining: number; maxAllowed: number };
					};
					if (statelessTransport.getTempLogStatus) {
						const status = statelessTransport.getTempLogStatus();
						if (status.enabled) {
							extendedMetrics.tempLogStatus = status;
						}
					}
				}

				res.json(formattedMetrics);
			} catch (error) {
				logger.error({ error }, 'Error retrieving transport metrics');
				res.status(500).json({ error: 'Failed to retrieve transport metrics' });
			}
		});
	}
}
