import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Activity, CircleOff, Timer, Wifi, WifiOff } from 'lucide-react';
import { DataTable } from './data-table';
import { createSortableHeader } from './data-table-utils';
import { useSessionCache } from '../hooks/useSessionCache';
import type { TransportMetricsResponse } from '../../shared/transport-metrics.js';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { formatCompactNumber } from '../lib/dashboard-utils';

type SessionData = {
	id: string;
	connectedAt: string;
	lastActivity: string;
	requestCount: number;
	clientInfo?: {
		name: string;
		version: string;
	};
	isConnected: boolean;
	protocolEra?: 'legacy' | 'modern';
	protocolVersion?: string;
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
 * Truncate session ID to show first 5 and last 5 characters
 */
function truncateSessionId(id: string): string {
	if (id.length <= 12) return id;
	return `${id.slice(0, 5)}...${id.slice(-5)}`;
}

/**
 * Truncate client name to show first 35 and last 5 characters
 */
function truncateClientName(name: string): string {
	if (name.length <= 42) return name;
	return `${name.slice(0, 35)}.....${name.slice(-5)}`;
}

interface StdioTransportMetricsProps {
	metrics: TransportMetricsResponse;
}

export function StdioTransportMetrics({ metrics }: StdioTransportMetricsProps) {
	const apiSessions = metrics.sessions || [];
	const sessionData = useSessionCache(apiSessions);
	const connectedSessions = sessionData.filter((session) => session.isConnected).length;
	const disconnectedSessions = sessionData.length - connectedSessions;
	const totalRequests = sessionData.reduce((sum, session) => sum + session.requestCount, 0);

	// Define columns for the sessions table
	const createSessionColumns = (): ColumnDef<SessionData>[] => [
		{
			accessorKey: 'clientInfo',
			header: createSortableHeader('Client'),
			cell: ({ row }) => {
				const session = row.original;
				const clientDisplay = session.clientInfo
					? `${truncateClientName(session.clientInfo.name)}@${session.clientInfo.version}`
					: 'unknown';
				return (
					<div
						className="font-mono text-sm"
						title={session.clientInfo ? `${session.clientInfo.name}@${session.clientInfo.version}` : 'unknown'}
					>
						{clientDisplay}
					</div>
				);
			},
		},
		{
			id: 'protocol',
			header: 'Protocol',
			cell: ({ row }) => {
				const session = row.original;
				return session.protocolVersion ? (
					<Badge variant={session.protocolEra === 'modern' ? 'success' : 'secondary'}>
						{session.protocolEra ?? 'legacy'} · {session.protocolVersion}
					</Badge>
				) : (
					<span className="text-muted-foreground">unknown</span>
				);
			},
		},
		{
			accessorKey: 'id',
			header: createSortableHeader('Session ID'),
			cell: ({ row }) => (
				<div className="font-mono text-sm" title={row.getValue<string>('id')}>
					{truncateSessionId(row.getValue<string>('id'))}
				</div>
			),
		},
		{
			accessorKey: 'isConnected',
			header: createSortableHeader('Status'),
			cell: ({ row }) => {
				const session = row.original;
				return (
					<Badge variant={session.isConnected ? 'success' : 'secondary'} className="gap-1">
						{session.isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
						{session.isConnected ? 'Connected' : 'Disconnected'}
					</Badge>
				);
			},
		},
		{
			accessorKey: 'connectedAt',
			header: createSortableHeader('Connected'),
			cell: ({ row }) => <div className="text-sm">{formatRelativeTime(row.getValue<string>('connectedAt'))}</div>,
		},
		{
			accessorKey: 'requestCount',
			header: createSortableHeader('Requests', 'right'),
			cell: ({ row }) => <div className="text-right font-mono text-sm">{row.getValue<number>('requestCount')}</div>,
		},
		{
			accessorKey: 'lastActivity',
			header: createSortableHeader('Last Activity'),
			cell: ({ row }) => <div className="text-sm">{formatRelativeTime(row.getValue<string>('lastActivity'))}</div>,
		},
	];

	return (
		<div className="space-y-5">
			<SectionHeader
				title="STDIO overview"
				description="Connection activity and negotiated protocols for local sessions."
			/>
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<MetricTile
					label="Connected"
					value={connectedSessions}
					detail="Active sessions"
					icon={<Wifi className="size-5" />}
					tone="green"
				/>
				<MetricTile
					label="Disconnected"
					value={disconnectedSessions}
					detail="Cached session history"
					icon={<CircleOff className="size-5" />}
					tone="neutral"
				/>
				<MetricTile
					label="Requests"
					value={formatCompactNumber(totalRequests)}
					detail="Across all sessions"
					icon={<Activity className="size-5" />}
					tone="blue"
				/>
				<MetricTile
					label="Uptime"
					value={formatUptime(metrics.uptimeSeconds)}
					detail="Current process"
					icon={<Timer className="size-5" />}
					tone="amber"
				/>
			</div>
			<Card>
				<CardContent>
					<SectionHeader
						title="Sessions"
						description={`${connectedSessions} active · ${disconnectedSessions} disconnected`}
					/>
					<DataTable
						columns={createSessionColumns()}
						data={sessionData}
						searchColumn="id"
						searchPlaceholder="Filter sessions..."
						pageSize={10}
						defaultSorting={[{ id: 'lastActivity', desc: true }]}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
