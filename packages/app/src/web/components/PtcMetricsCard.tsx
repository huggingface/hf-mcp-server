import useSWR from 'swr';
import { Boxes, Code2, TriangleAlert, Users } from 'lucide-react';
import type { PtcMetricsResponse } from '../../shared/ptc-metrics.js';
import { formatCompactNumber } from '../lib/dashboard-utils';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

const fetcher = async (url: string): Promise<PtcMetricsResponse> => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch: ${res.status.toString()}`);
	return (await res.json()) as PtcMetricsResponse;
};

function ago(timestamp: string | null): string {
	if (!timestamp) return '—';
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60).toString()}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600).toString()}h ago`;
	return `${Math.floor(seconds / 86400).toString()}d ago`;
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
	return (
		<div className="max-h-[28rem] overflow-auto">
			<table className="w-full text-left text-sm tabular-nums">
				<thead>
					<tr className="border-b">
						{headers.map((h) => (
							<th key={h} scope="col" className="whitespace-nowrap p-2 text-xs font-semibold text-muted-foreground">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<tr key={i} className="border-b last:border-0">
							{row.map((cell, j) => (
								<td key={j} className={j === 0 ? 'p-2 font-mono text-xs' : 'p-2'}>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** PTC bouquet (?bouquet=ptc) usage since this server process started. */
export function PtcMetricsCard() {
	const { data, error } = useSWR<PtcMetricsResponse>('/api/ptc-metrics', fetcher, { refreshInterval: 5000 });
	if (error) return <p className="text-sm text-destructive">Failed to load PTC metrics: {String(error)}</p>;
	if (!data) return <p className="text-sm text-muted-foreground">Loading PTC metrics…</p>;

	const errorRate = data.toolCalls ? (data.toolErrors / data.toolCalls) * 100 : undefined;
	const usedTools = data.tools.filter((t) => t.calls > 0).sort((a, b) => b.calls - a.calls);
	const unusedCount = data.tools.length - usedTools.length;

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<MetricTile
					label="PTC requests"
					value={formatCompactNumber(data.requests)}
					detail={`${data.access.anonymous.toString()} anon · ${data.access.authenticated.toString()} read · ${data.access.write.toString()} write`}
					icon={<Boxes className="size-4" />}
					tone="violet"
				/>
				<MetricTile
					label="Tool calls"
					value={formatCompactNumber(data.toolCalls)}
					detail={`${usedTools.length.toString()} of ${data.tools.length.toString()} tools used`}
					icon={<Code2 className="size-4" />}
					tone="blue"
				/>
				<MetricTile
					label="Tool errors"
					value={formatCompactNumber(data.toolErrors)}
					detail={errorRate === undefined ? 'No calls yet' : `${errorRate.toFixed(1)}% of calls`}
					icon={<TriangleAlert className="size-4" />}
					tone={data.toolErrors ? 'red' : 'neutral'}
				/>
				<MetricTile
					label="Clients"
					value={formatCompactNumber(data.clients.length)}
					detail={`Since ${new Date(data.startedAt).toLocaleString()}`}
					icon={<Users className="size-4" />}
					tone="green"
				/>
			</div>

			<Card>
				<CardContent className="space-y-3">
					<SectionHeader
						title="Clients using the PTC bouquet"
						description="MCP clients (name@version from initialize) that sent requests with ?bouquet=ptc."
					/>
					{data.clients.length ? (
						<Table
							headers={[
								'Client',
								'Version',
								'Requests',
								'Tool calls',
								'Errors',
								'Anonymous',
								'First seen',
								'Last seen',
							]}
							rows={data.clients.map((c) => [
								c.name,
								c.version || '—',
								c.requests,
								c.toolCalls,
								c.toolErrors,
								c.anonymousRequests,
								ago(c.firstSeen),
								ago(c.lastSeen),
							])}
						/>
					) : (
						<p className="text-sm text-muted-foreground">No PTC clients yet.</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardContent className="space-y-3">
					<SectionHeader
						title="Tool usage"
						description="Calls per PTC tool. Errors are sanitized PtcError codes."
						aside={unusedCount ? <Badge variant="outline">{unusedCount} tools not called yet</Badge> : undefined}
					/>
					{usedTools.length ? (
						<Table
							headers={['Tool', 'Family', 'Calls', 'Errors', 'Avg ms', 'Last called']}
							rows={usedTools.map((t) => [t.name, t.family, t.calls, t.errors, t.avgDurationMs, ago(t.lastCalled)])}
						/>
					) : (
						<p className="text-sm text-muted-foreground">No tool calls yet.</p>
					)}
					{Object.keys(data.errorCodes).length > 0 && (
						<div className="flex flex-wrap gap-2 text-xs">
							{Object.entries(data.errorCodes).map(([code, count]) => (
								<Badge key={code} variant="secondary">
									{code} · {count}
								</Badge>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
