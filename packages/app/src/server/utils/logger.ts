import pino, { type Logger, type LoggerOptions, type Level } from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerTransportLogger } from './transport-loggers.js';
import { forward, isClusterWorker } from '../cluster/ipc.js';

const isDev = process.env.NODE_ENV === 'development';
const activeTransport = process.env.TRANSPORT || '';

const destination = activeTransport.toUpperCase() === 'STDIO' ? 2 : 1; // 2 = stderr, 1 = stdout

const logLevel = (process.env.LOG_LEVEL?.toLowerCase() || 'info') as Level;
const hfLoggingEnabled = !!process.env.LOGGING_DATASET_ID;

// Get the current file's directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const forwardMainLog = forward('log.main', (line: string): void => {
	writeRelayedMainLogLine(line);
});

function createLogger(): Logger {
	const baseOptions: LoggerOptions = {
		level: logLevel,
		timestamp: pino.stdTimeFunctions.isoTime, // Always use ISO time for better readability
	};

	if (isClusterWorker) {
		return pino(baseOptions, {
			write(chunk: string) {
				forwardMainLog(chunk);
			},
		});
	}

	// Setup HF logging if enabled
	if (hfLoggingEnabled) {
		const datasetId = process.env.LOGGING_DATASET_ID;
		const hfToken = process.env.LOGGING_HF_TOKEN || process.env.DEFAULT_HF_TOKEN;

		if (!hfToken) {
			console.warn(
				'[Logger] HF Dataset logging disabled: No HF token found (set LOGGING_HF_TOKEN or DEFAULT_HF_TOKEN)'
			);
		} else {
			console.log(`[Logger] HF Dataset logging enabled for dataset: ${datasetId}`);

			try {
				const transportPath = join(__dirname, 'hf-dataset-transport.js');

				const targets = [
					// Console output
					{
						target: 'pino-pretty',
						level: logLevel,
						options: {
							colorize: isDev,
							destination,
						},
					},
					// HF dataset output
					{
						target: transportPath,
						level: logLevel,
						options: { sync: false },
					},
				];

				return registerTransportLogger(pino({ ...baseOptions, transport: { targets } }), { datasetTargets: 1 });
			} catch (error) {
				console.error('[Logger] Failed to setup HF transport, falling back to console only:', error);
			}
		}
	}

	// Console-only logging (default or fallback)
	return registerTransportLogger(
		pino(
			{
				...baseOptions,
				...(isDev
					? {
							transport: {
								target: 'pino-pretty',
								options: { colorize: true, destination },
							},
						}
					: {}),
			},
			!isDev ? pino.destination(destination) : undefined
		)
	);
}

const logger: Logger = createLogger();

// Function to reconfigure logger for STDIO transport
export function forceLoggerToStderr(): void {
	const stderrOptions: LoggerOptions = {
		level: logLevel,
		timestamp: pino.stdTimeFunctions.isoTime, // Always use ISO time for better readability
	};

	if (isDev) {
		// Development: use pretty printing to stderr
		Object.assign(
			logger,
			pino({
				...stderrOptions,
				transport: {
					target: 'pino-pretty',
					options: {
						colorize: true,
						destination: 2, // stderr
					},
				},
			})
		);
	} else {
		// Production: plain output to stderr
		Object.assign(logger, pino(stderrOptions, pino.destination(2)));
	}
}

export function writeRelayedMainLogLine(line: string): void {
	const normalized = line.endsWith('\n') ? line : `${line}\n`;
	const stream = (logger as unknown as Record<symbol, { write?: (chunk: string) => void }>)[pino.symbols.streamSym];
	if (stream && typeof stream.write === 'function') {
		stream.write(normalized);
		return;
	}
	process.stdout.write(normalized);
}

export { logger };
