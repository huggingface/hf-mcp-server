#!/usr/bin/env node

import cluster from 'node:cluster';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEFAULT_WEB_APP_PORT } from '../shared/constants.js';
import { installEarlyWorkerShutdownCapture } from './cluster/ipc.js';
import { parseMcpWorkers } from './cluster/workers-config.js';

// Install early shutdown listener and notify primary before any dynamic imports run.
installEarlyWorkerShutdownCapture();

// Parse command line arguments
const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
	},
	args: process.argv.slice(2),
});

// Set development mode environment variable
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Share one server session ID across supervisor and all forked workers BEFORE
// any logger module is imported.
process.env.MCP_SERVER_SESSION_ID ||= randomUUID();

// Configuration with single port for both the web app and MCP API
const port = parseInt((values.port as string) || process.env.WEB_APP_PORT || DEFAULT_WEB_APP_PORT.toString(), 10);

let workerCount = parseMcpWorkers(process.env.MCP_WORKERS);
if (process.env.NODE_ENV === 'development' && workerCount > 0) {
	console.warn('[cluster] MCP_WORKERS > 0 is disabled in development mode (Vite HMR requires single-process mode)');
	workerCount = 0;
}

async function start(): Promise<void> {
	if (workerCount >= 1 && cluster.isPrimary) {
		const { startClusterPrimary } = await import('./cluster/primary.js');
		await startClusterPrimary({ port, workerCount });
		return;
	}

	const { logger } = await import('./utils/logger.js');
	const { runApplication } = await import('./run-application.js');
	logger.info('Starting Streamable HTTP server...');
	logger.info('Stateless JSON response mode enabled');
	await runApplication({
		transportType: 'streamableHttpJson',
		port,
	});
}

// Run the async start function
start().catch((error: unknown) => {
	console.error('Server startup error:', error);
	process.exit(1);
});
