import useSWR from 'swr';
import { Card, CardContent } from './ui/card';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { AlertTriangle } from 'lucide-react';
import { StdioTransportMetrics } from './StdioTransportMetrics';
import { StatelessTransportMetrics } from './StatelessTransportMetrics';
import type { TransportMetricsResponse } from '../../shared/transport-metrics.js';
import { SectionHeader } from './DashboardPrimitives';

// SWR fetcher function
const fetcher = (url: string) =>
	fetch(url).then((res) => {
		if (!res.ok) {
			throw new Error(`Failed to fetch: ${res.status}`);
		}
		return res.json();
	});

export function TransportMetricsCard() {
	// Use SWR for metrics with auto-refresh every 3 seconds
	const { data: metrics, error } = useSWR<TransportMetricsResponse>('/api/transport-metrics', fetcher, {
		refreshInterval: 3000,
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});

	if (error) {
		return (
			<div className="space-y-5">
				<SectionHeader title="Live overview" description="Request traffic, client activity, and service health." />
				<Card>
					<CardContent>
						<Alert variant="destructive">
							<AlertTriangle className="h-4 w-4" />
							<AlertTitle>Error Loading Metrics</AlertTitle>
							<AlertDescription>Failed to load transport metrics: {error.message}</AlertDescription>
						</Alert>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (!metrics) {
		return (
			<div className="animate-pulse space-y-5" aria-label="Loading transport metrics">
				<div className="space-y-2">
					<div className="h-4 w-32 rounded bg-muted" />
					<div className="h-3 w-80 max-w-full rounded bg-muted" />
				</div>
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					{Array.from({ length: 8 }, (_, index) => (
						<Card key={index}>
							<CardContent className="h-27 space-y-3">
								<div className="h-3 w-24 rounded bg-muted" />
								<div className="h-7 w-16 rounded bg-muted" />
								<div className="h-3 w-32 max-w-full rounded bg-muted" />
							</CardContent>
						</Card>
					))}
				</div>
				<Card>
					<CardContent>
						<div className="h-4 w-40 rounded bg-muted" />
						<div className="mt-5 h-28 rounded-xl bg-muted" />
					</CardContent>
				</Card>
			</div>
		);
	}

	// Route to appropriate component based on transport type
	if (metrics.transport === 'stdio') {
		return <StdioTransportMetrics metrics={metrics} />;
	}

	return <StatelessTransportMetrics metrics={metrics} />;
}
