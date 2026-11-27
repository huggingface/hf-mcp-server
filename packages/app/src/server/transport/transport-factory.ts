import { type Express } from 'express';
import { type TransportType } from '../../shared/constants.js';
import type { MetricsCounter } from '../../shared/transport-metrics.js';
import type { SessionStore } from '../sessions/session-registry.js';
import type { BaseTransport, ServerFactory } from './base-transport.js';
import { StdioTransport } from './stdio-transport.js';
import { StatelessHttpTransport } from './stateless-http-transport.js';

interface CreateTransportOptions {
	metrics?: MetricsCounter;
	sessionStore?: SessionStore;
}

/**
 * Utility for creating transport instances
 */
export const createTransport = (
	type: TransportType,
	serverFactory: ServerFactory,
	app: Express,
	options?: CreateTransportOptions
): BaseTransport => {
	switch (type) {
		case 'stdio':
			return new StdioTransport(serverFactory, app);
		case 'streamableHttpJson':
			return new StatelessHttpTransport(serverFactory, app, undefined, options);
		default:
			throw new Error(`Unsupported transport type: ${type}`);
	}
};
