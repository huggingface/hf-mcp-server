import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Activity, ArrowUpRight, Clock, Gauge, Network, ShieldCheck, Timer, Users, Wrench } from 'lucide-react';
import { DataTable } from './data-table';
import { createSortableHeader } from './data-table-utils';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { formatCompactNumber } from '../lib/dashboard-utils';
import type { TransportMetricsResponse } from '../../shared/transport-metrics.js';

type ClientMetric = TransportMetricsResponse['clients'][number];
type ClientProtocolMetric = ClientMetric['protocols'][number];
type ClientProtocolData = Omit<
	ClientMetric,
	'protocols' | 'requestCount' | 'toolCallCount' | 'firstSeen' | 'lastSeen'
> & {
	protocol: ClientProtocolMetric;
	requestCount: number;
	toolCallCount: number;
	firstSeen: string;
	lastSeen: string;
};

/**
 * Format relative time (e.g., "5m ago", "2h ago", "just now")
 */
function formatRelativeTime(timestamp: string): string {
	const now = new Date();
	const time = new Date(timestamp);
	const diffMs = now.getTime() - time.getTime();
	const diffSeconds = Math.floor(diffMs / 1000);

	if (diffSeconds < 60) return 'just now';

	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;

	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;

	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

/**
 * Format uptime in a human-readable way
 */
function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);

	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/**
 * Check if a client was recently active (within last 5 minutes)
 */
function isRecentlyActive(lastSeen: string): boolean {
	const now = new Date();
	const lastSeenTime = new Date(lastSeen);
	const diffMs = now.getTime() - lastSeenTime.getTime();
	const diffMinutes = Math.floor(diffMs / 60000);
	return diffMinutes < 5;
}

/**
 * Truncate client name to show first 35 and last 5 characters
 */
function truncateClientName(name: string): string {
	if (name.length <= 42) return name;
	return `${name.slice(0, 35)}.....${name.slice(-5)}`;
}

interface StatelessTransportMetricsProps {
	metrics: TransportMetricsResponse;
}

export function StatelessTransportMetrics({ metrics }: StatelessTransportMetricsProps) {
	const clientData: ClientProtocolData[] = metrics.clients.flatMap((client) => {
		const { protocols, ...clientTotals } = client;
		return protocols.map((protocol) => ({
			...clientTotals,
			protocol,
			requestCount: protocol.requestCount,
			toolCallCount: protocol.toolCallCount,
			firstSeen: protocol.firstSeen,
			lastSeen: protocol.lastSeen,
		}));
	});
	const protocolRequestTotal = metrics.protocolEras.legacy + metrics.protocolEras.modern;
	const modernShare =
		protocolRequestTotal === 0 ? 0 : Math.round((metrics.protocolEras.modern / protocolRequestTotal) * 100);
	const totalErrors = metrics.errors.expected + metrics.errors.unexpected;
	const toolCalls = metrics.methods
		.filter((method) => method.method === 'tools/call' || method.method.startsWith('tools/call:'))
		.reduce((sum, method) => sum + method.count, 0);
	const recentClients = metrics.clients.filter((client) => isRecentlyActive(client.lastSeen)).length;
	const protocolFilterOptions = Array.from(
		new Map(
			clientData.map((client) => {
				const value = `${client.protocol.era}:${client.protocol.version}`;
				return [value, { value, label: `${client.protocol.era} · ${client.protocol.version}` }] as const;
			})
		).values()
	).sort((a, b) => b.value.localeCompare(a.value));

	// Define columns for exact client/protocol combinations.
	const createClientColumns = (): ColumnDef<ClientProtocolData>[] => [
		{
			accessorKey: 'name',
			header: createSortableHeader('Client'),
			cell: ({ row }) => {
				const client = row.original;
				const clientDisplay = `${truncateClientName(client.name)}@${client.version}`;
				return (
					<div>
						<p className="font-medium font-mono text-sm" title={`${client.name}@${client.version}`}>
							{clientDisplay}
						</p>
						<p className="text-xs text-muted-foreground">First seen {formatRelativeTime(client.firstSeen)}</p>
					</div>
				);
			},
		},
		{
			id: 'protocol',
			header: 'Protocol',
			filterFn: (row, _columnId, filterValue: string) =>
				`${row.original.protocol.era}:${row.original.protocol.version}` === filterValue,
			cell: ({ row }) => {
				const protocol = row.original.protocol;
				return (
					<Badge variant={protocol.era === 'modern' ? 'success' : 'secondary'}>
						{protocol.era} · {protocol.version}
					</Badge>
				);
			},
		},
		{
			accessorKey: 'requestCount',
			header: createSortableHeader('Requests', 'right'),
			cell: ({ row }) => <div className="text-right font-mono text-sm">{row.getValue<number>('requestCount')}</div>,
		},
		{
			accessorKey: 'toolCallCount',
			header: createSortableHeader('Tool Calls', 'right'),
			cell: ({ row }) => <div className="text-right font-mono text-sm">{row.getValue<number>('toolCallCount')}</div>,
		},
		{
			accessorKey: 'newIpCount',
			header: createSortableHeader('Client New IPs', 'right'),
			cell: ({ row }) => (
				<div className="text-right font-mono text-sm" title="Client-wide total across all protocol versions">
					{row.getValue<number>('newIpCount')}
				</div>
			),
		},
		{
			accessorKey: 'anonCount',
			header: createSortableHeader('Client Anon/Tokens/Users', 'right'),
			cell: ({ row }) => {
				const client = row.original;
				return (
					<div className="text-right font-mono text-sm" title="Client-wide totals across all protocol versions">
						{client.anonCount}/{client.uniqueAuthCount}/{client.uniqueUserCount}
					</div>
				);
			},
		},
		{
			accessorKey: 'isConnected',
			header: createSortableHeader('Status'),
			cell: ({ row }) => {
				const client = row.original;
				return (
					<div>
						{isRecentlyActive(client.lastSeen) ? (
							<Badge variant="success" className="gap-1">
								<Activity className="h-3 w-3" />
								Recent
							</Badge>
						) : (
							<Badge variant="secondary" className="gap-1">
								<Clock className="h-3 w-3" />
								Idle
							</Badge>
						)}
					</div>
				);
			},
		},
		{
			accessorKey: 'lastSeen',
			header: createSortableHeader('Last Seen', 'right'),
			cell: ({ row }) => (
				<div className="text-right text-sm">{formatRelativeTime(row.getValue<string>('lastSeen'))}</div>
			),
		},
	];

	return (
		<div className="space-y-5">
			<SectionHeader
				title="Live overview"
				description="Request traffic, client activity, and service health since this process started."
				aside={
					<div className="flex items-center gap-2">
						<Badge variant="secondary">Streamable HTTP</Badge>
						<Badge variant="outline">{metrics.sessionLifecycle ? 'analytics on' : 'stateless'}</Badge>
					</div>
				}
			/>

			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<MetricTile
					label="MCP requests"
					value={formatCompactNumber(metrics.requests.total)}
					detail={`${metrics.requests.lastMinute}/min right now`}
					icon={<Gauge className="size-5" />}
					tone="blue"
				/>
				<MetricTile
					label="Recent clients"
					value={recentClients}
					detail={`${metrics.clients.length} implementations seen`}
					icon={<Users className="size-5" />}
					tone="violet"
				/>
				<MetricTile
					label="Tool calls"
					value={formatCompactNumber(toolCalls)}
					detail={`${metrics.gradioMetrics?.success ?? 0} Gradio successes`}
					icon={<Wrench className="size-5" />}
					tone="amber"
				/>
				<MetricTile
					label="Modern adoption"
					value={`${modernShare}%`}
					detail={`${metrics.protocolEras.modern} modern · ${metrics.protocolEras.legacy} legacy`}
					icon={<Network className="size-5" />}
					tone="green"
				/>
				<MetricTile
					label="Unique users"
					value={metrics.connections.uniqueUsers ?? 0}
					detail={`${metrics.connections.uniqueIps ?? 0} unique IPs`}
					icon={<ShieldCheck className="size-5" />}
					tone="green"
				/>
				<MetricTile
					label="Errors"
					value={totalErrors}
					detail={`${metrics.errors.expected} expected · ${metrics.errors.unexpected} unexpected`}
					icon={<ArrowUpRight className="size-5" />}
					tone={totalErrors > 0 ? 'red' : 'neutral'}
				/>
				<MetricTile
					label="Throughput · 1h"
					value={`${metrics.requests.lastHour}/min`}
					detail={`3h ${metrics.requests.last3Hours}/min · lifetime ${metrics.requests.averagePerMinute}/min`}
					icon={<Activity className="size-5" />}
					tone="blue"
				/>
				<MetricTile
					label="Uptime"
					value={formatUptime(metrics.uptimeSeconds)}
					detail={`Started ${new Date(metrics.startupTime).toLocaleTimeString()}`}
					icon={<Timer className="size-5" />}
					tone="neutral"
				/>
			</div>

			<Card>
				<CardContent>
					<div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
						<div>
							<p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Authentication</p>
							<p className="mt-1 font-mono">
								{metrics.connections.anonymous} anon · {metrics.connections.authenticated} auth ·{' '}
								{metrics.connections.unauthorized ?? 0} denied
							</p>
						</div>
						<div>
							<p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Gradio</p>
							<p className="mt-1 font-mono">
								{metrics.gradioMetrics?.success ?? 0} success · {metrics.gradioMetrics?.failure ?? 0} failed
							</p>
						</div>
						<div>
							<p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Legacy sessions</p>
							<p className="mt-1 font-mono">
								{metrics.sessionLifecycle?.created ?? 0} new · {metrics.sessionLifecycle?.deleted ?? 0} closed
							</p>
						</div>
						<div>
							<p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Welcome route</p>
							<p className="mt-1 font-mono">
								{metrics.staticPageHits200 ?? 0} served · {metrics.staticPageHits405 ?? 0} rejected
							</p>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<SectionHeader
						title="Client implementations"
						description="One row per implementation and exact protocol version, with protocol-attributed requests and tool calls."
					/>
					<DataTable
						columns={createClientColumns()}
						data={clientData}
						searchColumn="name"
						searchPlaceholder="Filter clients..."
						facetFilter={{
							column: 'protocol',
							label: 'All protocol versions',
							options: protocolFilterOptions,
						}}
						pageSize={50}
						defaultSorting={[{ id: 'lastSeen', desc: true }]}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
