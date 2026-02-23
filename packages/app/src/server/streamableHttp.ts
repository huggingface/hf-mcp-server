#!/usr/bin/env node

import { DEFAULT_WEB_APP_PORT } from '../shared/constants.js';
import { parseArgs } from 'node:util';
import { logger } from './utils/logger.js';
import { runApplication } from './run-application.js';

// Parse command line arguments
const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
		json: { type: 'boolean', short: 'j' },
	},
	args: process.argv.slice(2),
});

logger.info('Starting Streamable HTTP server...');
if (values.json) {
	logger.info('JSON response mode enabled');
}

// Set development mode environment variable
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Configuration with single port for both the web app and MCP API
const port = parseInt((values.port as string) || process.env.WEB_APP_PORT || DEFAULT_WEB_APP_PORT.toString());

async function start() {
	const useJsonMode = values.json || false;

	// Choose the appropriate transport type based on JSON mode
	const transportType = useJsonMode ? 'streamableHttpJson' : 'streamableHttp';

	await runApplication({
		transportType,
		port,
	});
}

// Run the async start function
start().catch((error: unknown) => {
	logger.error({ error }, 'Server startup error');
	process.exit(1);
});
