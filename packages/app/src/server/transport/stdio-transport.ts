import { BaseTransport, type SessionMetadata } from './base-transport.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { logger } from '../utils/logger.js';

interface StdioSession {
	transport: StdioServerTransport;
	server: McpServer;
	metadata: SessionMetadata;
}

/**
 * Implementation of STDIO transport
 */
export class StdioTransport extends BaseTransport {
	private readonly SESSION_ID = 'STDIO';
	private session?: StdioSession;

	override async initialize(): Promise<void> {
		const transport = new StdioServerTransport();

		// Create server instance using factory (null headers for STDIO)
		const result = await this.serverFactory(null);
		const server = result.server;

		// Create session with metadata tracking
		const session: StdioSession = {
			transport,
			server,
			metadata: {
				id: this.SESSION_ID,
				connectedAt: new Date(),
				lastActivity: new Date(),
				requestCount: 0,
				isAuthenticated: false, // STDIO doesn't have authentication headers
				capabilities: {},
				protocolEra: 'legacy',
			},
		};

		this.session = session;

		this.trackNewConnection();
		this.metrics.updateActiveConnections(1);
		this.metrics.trackSessionCreated();
		session.metadata.clientInfo = { name: 'unknown', version: 'unknown' };
		this.metrics.associateSessionWithClient(session.metadata.clientInfo);

		try {
			// Set up request/response interceptors for metrics
			const originalSendMessage = transport.send.bind(transport);
			transport.send = (message) => {
				this.trackRequest();
				session.metadata.lastActivity = new Date();
				this.metrics.updateClientActivity(session.metadata.clientInfo);

				// Increment request count
				session.metadata.requestCount++;

				return originalSendMessage(message);
			};

			server.server.oninitialized = () => {
				const clientInfo = server.server.getClientVersion();
				const clientCapabilities = server.server.getClientCapabilities();
				session.metadata.protocolVersion = server.server.getNegotiatedProtocolVersion();
				if (session.metadata.protocolVersion) {
					this.trackProtocolRequest('legacy', session.metadata.protocolVersion);
				}
				if (clientInfo) {
					if (session.metadata.clientInfo) {
						this.metrics.disconnectClient(session.metadata.clientInfo);
					}
					session.metadata.clientInfo = clientInfo;
					this.metrics.associateSessionWithClient(clientInfo);
					if (session.metadata.protocolVersion) {
						this.trackClientProtocol(clientInfo, 'legacy', session.metadata.protocolVersion);
					}
				}
				if (clientCapabilities) {
					session.metadata.clientCapabilities = clientCapabilities as Record<string, unknown>;
					session.metadata.capabilities = {
						sampling: !!clientCapabilities.sampling,
						roots: !!clientCapabilities.roots,
					};
				}
			};

			// Set up error tracking
			server.server.onerror = (error) => {
				this.trackError(undefined, error);
				logger.error({ error }, 'STDIO server error');
			};

			await server.connect(transport);

			logger.info('STDIO transport initialized');
		} catch (error) {
			logger.error({ error }, 'Error connecting STDIO transport');
			// Clean up on error
			this.session = undefined;
			this.trackSessionClosed(session);
			throw error;
		}
	}

	override async cleanup(): Promise<void> {
		const session = this.session;
		if (session) {
			try {
				await session.transport.close();
			} catch (error) {
				logger.error({ error }, 'Error closing STDIO transport');
			}
			try {
				await session.server.close();
			} catch (error) {
				logger.error({ error }, 'Error closing STDIO server');
			}
			this.trackSessionClosed(session);
		}
		this.session = undefined;
		logger.info('STDIO transport cleaned up');
		return Promise.resolve();
	}

	override getSessions(): SessionMetadata[] {
		return this.session ? [this.session.metadata] : [];
	}

	/**
	 * Get the STDIO session if it exists
	 */
	getSession(): StdioSession | undefined {
		return this.session;
	}

	private trackSessionClosed(session: StdioSession): void {
		this.metrics.trackSessionCleaned();
		this.metrics.trackSessionDeleted();
		this.metrics.updateActiveConnections(0);
		if (session.metadata.clientInfo) {
			this.metrics.disconnectClient(session.metadata.clientInfo);
		}
	}
}
