import type { TransportInfo } from '../../shared/transport-info.js';
import { getTokenDisplayText } from '../../shared/transport-info.js';

interface ConnectionFooterProps {
	isLoading: boolean;
	error: string | null;
	transportInfo: TransportInfo;
}

export function ConnectionFooter({ isLoading, error, transportInfo }: ConnectionFooterProps) {
	// Format the transport name for display
	const getTransportDisplayName = () => {
		switch (transportInfo.transport) {
			case 'stdio':
				return 'STDIO';
			case 'streamableHttpJson':
				return 'Streamable HTTP';
			default:
				return 'Unknown';
		}
	};

	// Get the endpoint path for the transport
	const getEndpointPath = () => {
		switch (transportInfo.transport) {
			case 'streamableHttpJson':
				return '/mcp';
			case 'stdio':
				return 'stdin/stdout';
			default:
				return 'unknown';
		}
	};

	// Check if using JSON mode
	// Get mode badge based on transport type
	const getModeBadge = () => {
		if (transportInfo.transport === 'streamableHttpJson') {
			// For JSON mode - green badge with "JSON (stateless)"
			return (
				<span className="ml-1.5 px-1.5 py-0.5 bg-green-100 text-green-800 text-[10px] rounded-sm whitespace-nowrap">
					JSON (stateless)
				</span>
			);
		}

		return null;
	};

	if (isLoading) {
		return <div className="text-center text-xs text-muted-foreground py-2">Loading connection information...</div>;
	}

	if (error) {
		return <div className="text-center text-xs text-destructive py-2">Error: {error}</div>;
	}

	// All transports now include port info (web app always runs on a port)
	const port = transportInfo.port || 3000;
	const shouldShowPort = transportInfo.transport !== 'stdio';

	return (
		<footer className="mt-8 border-t bg-card/70 px-4 py-3">
			<div className="mx-auto flex max-w-[1440px] flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-wrap items-center gap-1">
					<span className="text-muted-foreground">Using</span>
					<span className="font-medium text-primary">{getTransportDisplayName()}</span>

					{transportInfo.transport === 'stdio' && (
						<span className="text-muted-foreground flex items-center">
							Client Info :
							{transportInfo.stdioClient ? (
								<span className="ml-2 flex items-center">
									<span className="ml-1 font-medium text-green-700">
										{transportInfo.stdioClient.name} {transportInfo.stdioClient.version}
									</span>
								</span>
							) : (
								<span className="ml-2 text-muted-foreground"> (disconnected) </span>
							)}
						</span>
					)}

					{shouldShowPort && (
						<span className="text-muted-foreground flex items-center">
							on port <span className="font-mono mx-1">{port}</span>
							at <span className="font-mono mx-1">{getEndpointPath()}</span>
							{getModeBadge()}
						</span>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-1">
					<span className="text-muted-foreground"> Default HF Token:</span>
					<span className={`font-mono ${getTokenDisplayText(transportInfo).isWarning ? 'text-red-500' : ''}`}>
						{getTokenDisplayText(transportInfo).text}
					</span>
				</div>
			</div>
		</footer>
	);
}
