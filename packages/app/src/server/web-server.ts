import type { SkillsMetricsResponse } from '../shared/skills-metrics.js';
import { getSkillCatalogStatus } from './skills/skill-catalog-cache.js';
import { skillsLiveMetrics, parseSkillsMetricsFilters } from './utils/skills-live-metrics.js';
import express, { type Express } from 'express';
import cors from 'cors';
import type { CorsOptions, CorsRequest, CorsOptionsDelegate } from 'cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { TransportInfo } from '../shared/transport-info.js';
import { logger } from './utils/logger.js';
import {
	DEFINITION_VERSION_MISMATCH,
	definitionVersioningStats,
	definitionVersionsTestEnabled,
	resetDefinitionVersioningStats,
	setDefinitionVersionsTestSalt,
} from './definition-versioning/index.js';
import { definitionVersioningStatus } from './definition-versioning/policy.js';
import type { BaseTransport } from './transport/base-transport.js';
import { formatMetricsForAPI } from '../shared/transport-metrics.js';
import { getHfFsLiveMetrics } from './utils/hf-fs-live-metrics.js';
import { CORS_ALLOWED_ORIGINS, CORS_EXPOSED_HEADERS } from '../shared/constants.js';
import { apiMetrics } from './utils/api-metrics.js';
import { gradioMetrics } from './utils/gradio-metrics.js';
import { formatCacheMetricsForAPI } from './utils/gradio-cache.js';
import { inboundRequestSecurityMiddleware } from './utils/inbound-request-security.js';
import { matchesCorsOrigin, normalizeCorsOrigin } from './utils/cors-origin.js';
import { isServerCardRequestUrl, SERVER_CARD_PATH } from './server-card.js';
import {
	createMetricsPageAuth,
	METRICS_PAGE_AUTH_COOKIE_NAME,
	METRICS_PAGE_AUTH_TTL_MS,
	type MetricsPageAuth,
} from './utils/metrics-page-auth.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebServerOptions {
	metricsPageAuth?: MetricsPageAuth;
}

export class WebServer {
	private app: Express;
	private server: Server | null = null;
	private readonly metricsPageAuth: MetricsPageAuth;
	private transportInfo: TransportInfo = {
		transport: 'unknown',
		defaultHfTokenSet: false,
		externalApiMode: false,
		stdioClient: null,
	};
	private transport?: BaseTransport;

	constructor(options: WebServerOptions = {}) {
		this.metricsPageAuth = options.metricsPageAuth ?? createMetricsPageAuth(process.env.METRICS_PAGE_PASSWORD);
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

		this.app.use(['/mcp', '/api'], (req, res, next) => {
			inboundRequestSecurityMiddleware(req, res, next, {
				allowAnyOrigin: this.isPublicServerCardRequest(req.originalUrl),
			});
		});

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

		const defaultCors = cors(corsOptions);
		const serverCardCors = cors({
			origin: '*',
			methods: ['GET'],
			allowedHeaders: ['Content-Type', 'If-None-Match'],
			exposedHeaders: ['ETag'],
			maxAge: 86400,
		});
		const applyCors = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
			const middleware = this.isPublicServerCardRequest(req.originalUrl) ? serverCardCors : defaultCors;
			middleware(req, res, next);
		};

		this.app.use(applyCors);
		// Ensure preflight requests succeed for any path
		this.app.options('{*splat}', applyCors);

		this.app.get('/', (_req, res) => {
			res.redirect(302, '/mcp');
		});

		this.setupMetricsPageAuth();
	}

	private setupMetricsPageAuth(): void {
		if (!this.metricsPageAuth.enabled) {
			return;
		}

		this.app.get('/metrics/login', (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			if (this.metricsPageAuth.isSessionCookieValid(req.get('cookie'))) {
				res.redirect(302, '/metrics');
				return;
			}

			res.type('html').send(renderMetricsLoginPage(false));
		});

		this.app.post('/metrics/login', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			const body = req.body as { password?: unknown };
			if (!this.metricsPageAuth.isPasswordValid(body.password)) {
				res.status(401).type('html').send(renderMetricsLoginPage(true));
				return;
			}

			const token = this.metricsPageAuth.createSessionToken();
			if (!token) {
				res.sendStatus(500);
				return;
			}

			res.cookie(METRICS_PAGE_AUTH_COOKIE_NAME, token, {
				httpOnly: true,
				maxAge: METRICS_PAGE_AUTH_TTL_MS,
				path: '/',
				sameSite: 'lax',
				secure: req.secure,
			});
			res.redirect(303, '/metrics');
		});

		this.app.use('/api', (req, res, next) => {
			res.setHeader('Cache-Control', 'no-store, private');
			const isAuthenticated = this.metricsPageAuth.isRequestAuthenticated({
				cookieHeader: req.get('cookie'),
				headerPassword: req.get('X-Metrics-Password'),
				queryPassword: req.query.metrics_password,
			});
			if (isAuthenticated) {
				next();
				return;
			}

			res.status(401).json({ error: 'Metrics page authentication required' });
		});

		this.app.use((req, res, next) => {
			if (isMetricsPageAuthExemptPath(req.path) || this.metricsPageAuth.isSessionCookieValid(req.get('cookie'))) {
				next();
				return;
			}

			res.setHeader('Cache-Control', 'no-store');
			res.redirect(302, '/metrics/login');
		});
	}

	public getApp(): Express {
		return this.app;
	}

	private isPublicServerCardRequest(originalUrl: string): boolean {
		return this.transportInfo.transport === 'streamableHttpJson' && isServerCardRequestUrl(originalUrl);
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
				if (req.path === SERVER_CARD_PATH) {
					res.sendStatus(404);
					return;
				}
				if (!req.path.startsWith('/api/')) {
					res.sendFile(path.join(staticPath, 'index.html'));
				}
			});
		}
	}

	/**
	 * Test-only definition-versions controls (DEFINITION_VERSIONS_TEST=true), used by
	 * the dashboard Caching tab. Changing the runtime salt changes every advertised
	 * version without changing definitions, so connected clients see a mismatch on
	 * their next checked call. Lives under /api, so metrics-page authentication applies
	 * when configured. Salt and counters are per process.
	 */
	private setupDefinitionVersionsTestRoutes(): void {
		const base = '/api/definition-versions';
		const respond = (res: express.Response) =>
			res.json(definitionVersioningStatus(DEFINITION_VERSION_MISMATCH, definitionVersioningStats()));
		const guard = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
			if (definitionVersionsTestEnabled()) next();
			else res.status(404).json({ error: 'Definition versions test mode is not enabled' });
		};

		this.app.get(base, guard, (_req, res) => respond(res));
		this.app.post(`${base}/salt`, guard, (req, res) => {
			const value = typeof req.query.value === 'string' ? req.query.value : randomUUID().slice(0, 8);
			try {
				setDefinitionVersionsTestSalt(value);
			} catch (error) {
				res.status(400).json({ error: (error as Error).message });
				return;
			}
			logger.info({ salt: value }, 'Definition versions test salt updated');
			respond(res);
		});
		this.app.delete(`${base}/salt`, guard, (_req, res) => {
			setDefinitionVersionsTestSalt('');
			logger.info('Definition versions test salt cleared');
			respond(res);
		});
		this.app.delete(`${base}/stats`, guard, (_req, res) => {
			resetDefinitionVersioningStats();
			respond(res);
		});
	}

	public setupApiRoutes(): void {
		this.setupDefinitionVersionsTestRoutes();

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

		this.app.get('/api/skills-metrics', (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			const filters = parseSkillsMetricsFilters(
				Object.fromEntries(Object.entries(req.query).filter(([key]) => key !== 'metrics_password'))
			);
			if (!filters) {
				res.status(400).json({ error: 'Invalid Skills metrics filters' });
				return;
			}
			const supported = this.transportInfo.transport === 'streamableHttpJson';
			const response: SkillsMetricsResponse = {
				transport: this.transportInfo.transport,
				supported,
				unsupportedReason: supported
					? null
					: 'Live Skills metrics are supported only on stateless HTTP, not stdio or other transports.',
				snapshot: getSkillCatalogStatus(),
				live: supported ? skillsLiveMetrics.snapshot(filters) : null,
			};
			res.json(response);
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
				formattedMetrics.hfFsMetrics = getHfFsLiveMetrics();

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

function isMetricsPageAuthExemptPath(requestPath: string): boolean {
	return (
		requestPath === '/metrics/login' ||
		requestPath === '/api' ||
		requestPath.startsWith('/api/') ||
		requestPath === '/mcp' ||
		requestPath.startsWith('/mcp/')
	);
}

function renderMetricsLoginPage(showError: boolean): string {
	const error = showError ? '<p class="error" role="alert">The password was not accepted. Please try again.</p>' : '';

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>MCP Operations</title>
		<style>
			:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
			body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f7f7f8; color: #171717; }
			main { width: min(24rem, calc(100% - 2rem)); box-sizing: border-box; padding: 2rem; border: 1px solid #dedede; border-radius: 1rem; background: white; box-shadow: 0 1rem 3rem rgb(0 0 0 / 8%); }
			h1 { margin: 0 0 .5rem; font-size: 1.4rem; }
			p { margin: 0 0 1.25rem; color: #666; line-height: 1.5; }
			label { display: block; margin-bottom: .45rem; font-size: .9rem; font-weight: 600; }
			input, button { width: 100%; box-sizing: border-box; border-radius: .6rem; font: inherit; }
			input { padding: .75rem; border: 1px solid #bdbdbd; background: white; color: #171717; }
			button { margin-top: 1rem; padding: .75rem; border: 0; background: #ffb000; color: #171717; font-weight: 700; cursor: pointer; }
			.error { padding: .75rem; border-radius: .6rem; background: #fee2e2; color: #991b1b; font-size: .9rem; }
			@media (prefers-color-scheme: dark) {
				body { background: #111; color: #f5f5f5; }
				main { border-color: #333; background: #1b1b1b; }
				p { color: #aaa; }
				input { border-color: #555; background: #111; color: #f5f5f5; }
			}
		</style>
	</head>
	<body>
		<main>
			<h1>MCP Operations</h1>
			<p>Enter the shared password to view the transport metrics dashboard.</p>
			${error}
			<form method="post" action="/metrics/login">
				<label for="password">Password</label>
				<input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
				<button type="submit">View metrics</button>
			</form>
		</main>
	</body>
</html>`;
}
