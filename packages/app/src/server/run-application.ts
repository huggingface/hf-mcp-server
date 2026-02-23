import { type TransportType } from '../shared/constants.js';
import { Application } from './application.js';
import { logger } from './utils/logger.js';
import { WebServer } from './web-server.js';

export interface RunApplicationOptions {
	transportType: Exclude<TransportType, 'unknown'>;
	port: number;
}

function attachShutdownHandlers(app: Application): void {
	let shutdownInProgress = false;

	const shutdown = async () => {
		logger.info('Shutting down server...');
		shutdownInProgress = true;
		try {
			await app.stop();
			logger.info('Server shutdown complete');
		} catch (error) {
			logger.error({ error }, 'Error during shutdown');
			process.exit(1);
		}
	};

	process.once('SIGINT', () => {
		void shutdown();

		// Set up second SIGINT handler for force exit
		process.once('SIGINT', () => {
			if (shutdownInProgress) {
				logger.warn('Force exit requested, terminating immediately...');
				process.exit(1);
			}
		});
	});

	process.once('SIGTERM', () => {
		void shutdown();
	});
}

export async function runApplication(options: RunApplicationOptions): Promise<void> {
	const webServer = new WebServer();
	const app = new Application({
		transportType: options.transportType,
		webAppPort: options.port,
		webServerInstance: webServer,
	});

	await app.start();
	attachShutdownHandlers(app);
}
