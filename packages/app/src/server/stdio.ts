#!/usr/bin/env node

// Set environment variables BEFORE importing logger
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TRANSPORT = process.env.TRANSPORT || 'STDIO';

import { DEFAULT_WEB_APP_PORT } from '../shared/constants.js';
import { parseArgs } from 'node:util';
import { logger, forceLoggerToStderr } from './utils/logger.js';
import { runApplication } from './run-application.js';

// Force logger to use STDERR. The environment variable may not have been set in dev, so just force it.
forceLoggerToStderr();

// Parse command line arguments
const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p' },
	},
	args: process.argv.slice(2),
});

logger.info('Starting (STDIO) server...');

const port = parseInt((values.port as string) || process.env.WEB_APP_PORT || DEFAULT_WEB_APP_PORT.toString());

async function main() {
	await runApplication({
		transportType: 'stdio',
		port,
	});
}

main().catch((error: unknown) => {
	logger.error({ error }, 'Server error');
	process.exit(1);
});
