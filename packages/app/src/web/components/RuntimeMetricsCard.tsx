import type { RuntimeMetricsResponse, RuntimeWindow } from '../../shared/runtime-metrics.js';
import { formatCompactNumber } from '../lib/dashboard-utils';
import { SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

interface RuntimeMetricsCardProps {
	metrics: RuntimeMetricsResponse;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	return `${Math.round(bytes / 1024 ** 2).toString()} MB`;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${String(seconds)}s`;
	if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${String(hours)}h ${String(mins)}m`;
}

function windowLine(window: RuntimeWindow | null, format: (w: RuntimeWindow) => string): string {
	return window ? format(window) : '—';
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
	return (
		<div className="rounded-xl border bg-muted/25 p-3">
			<p className="text-xs font-medium text-muted-foreground">{label}</p>
			<p className="mt-1 font-mono text-xl font-semibold">{value}</p>
			{detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
		</div>
	);
}

/** Main-thread load and connection reuse for this server process or worker cluster. */
export function RuntimeMetricsCard({ metrics }: RuntimeMetricsCardProps) {
	const { current, windows, memory, http, forwardedForHops, cluster } = metrics;
	const fifteen = windows['15m'];
	const hour = windows['1h'];
	const requestsPerSocket =
		http.closedSockets > 0 ? (http.closedSocketRequests / http.closedSockets).toFixed(1) : undefined;
	const busy = (hour?.eventLoopUtilization.max ?? 0) >= 0.8;

	const clusterEnabled = Boolean(cluster?.enabled);
	const hasClusterAlert =
		clusterEnabled &&
		((cluster?.totalRestarts ?? 0) > 0 || (cluster?.ipcDropped ?? 0) > 0 || (cluster?.sessionRpcFailures ?? 0) > 0);
	const totalWorkerRequests = cluster ? cluster.workers.reduce((sum, w) => sum + w.totalRequests, 0) : 0;

	const description =
		clusterEnabled && cluster
			? `Cluster: ${String(cluster.activeWorkers)}/${String(cluster.desiredWorkers)} workers + supervisor pid ${String(cluster.supervisor.pid)} · Node ${metrics.nodeVersion} · ${String(metrics.availableParallelism)} CPUs`
			: `pid ${String(metrics.pid)} · Node ${metrics.nodeVersion} · ${String(metrics.availableParallelism)} CPUs available · sampled every ${String(metrics.sampleIntervalMs / 1000)}s`;

	return (
		<Card>
			<CardContent className="space-y-4">
				<SectionHeader
					title="Process runtime"
					description={description}
					aside={
						<div className="flex flex-wrap items-center gap-2">
							{hasClusterAlert && cluster ? (
								<Badge variant="destructive">
									{[
										cluster.totalRestarts > 0 ? `${String(cluster.totalRestarts)} restarts` : null,
										cluster.ipcDropped > 0 ? `${String(cluster.ipcDropped)} IPC dropped` : null,
										cluster.sessionRpcFailures > 0 ? `${String(cluster.sessionRpcFailures)} session RPC err` : null,
									]
										.filter(Boolean)
										.join(' · ')}
								</Badge>
							) : null}
							<Badge variant={busy ? 'destructive' : 'outline'}>
								{current ? `Event loop ${percent(current.eventLoopUtilization)} busy` : 'Waiting for first sample'}
							</Badge>
						</div>
					}
				/>
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<Tile
						label="Event loop utilisation"
						value={current ? percent(current.eventLoopUtilization) : '—'}
						detail={`15m avg ${windowLine(fifteen, (w) => percent(w.eventLoopUtilization.avg))} · 1h max ${windowLine(hour, (w) => percent(w.eventLoopUtilization.max))}`}
					/>
					<Tile
						label="Process CPU (% of one core)"
						value={current ? `${current.cpuPercent.toFixed(0)}%` : '—'}
						detail={`15m avg ${windowLine(fifteen, (w) => `${w.cpuPercent.avg.toFixed(0)}%`)} · 1h max ${windowLine(hour, (w) => `${w.cpuPercent.max.toFixed(0)}%`)}`}
					/>
					<Tile
						label="Event loop delay p99"
						value={current ? `${current.eventLoopDelayP99Ms.toFixed(1)} ms` : '—'}
						detail={`max ${current ? current.eventLoopDelayMaxMs.toFixed(0) : '—'} ms · 1h worst p99 ${windowLine(hour, (w) => `${w.eventLoopDelayP99Ms.max.toFixed(0)} ms`)}`}
					/>
					<Tile
						label="Memory (RSS)"
						value={formatBytes(memory.rssBytes)}
						detail={`heap ${formatBytes(memory.heapUsedBytes)} of ${formatBytes(memory.heapLimitBytes)} limit`}
					/>
					<Tile
						label="HTTP requests/s"
						value={current ? current.httpRequestsPerSecond.toFixed(1) : '—'}
						detail={`1h max ${windowLine(hour, (w) => w.httpRequestsPerSecond.max.toFixed(1))} · ${formatCompactNumber(http.totalRequests)} total`}
					/>
					<Tile
						label="Open sockets"
						value={formatCompactNumber(http.openSockets)}
						detail={`${current ? current.newConnectionsPerSecond.toFixed(1) : '—'} new/s · ${formatCompactNumber(http.totalConnections)} total`}
					/>
					<Tile
						label="Requests per socket"
						value={requestsPerSocket ?? '—'}
						detail={`average over ${formatCompactNumber(http.closedSockets)} closed sockets`}
					/>
					<Tile
						label="Legacy sessions held"
						value={metrics.legacySessions === null ? '—' : formatCompactNumber(metrics.legacySessions)}
						detail="in-memory analytics sessions"
					/>
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					<span className="text-muted-foreground">Requests per socket:</span>
					{Object.entries(http.requestsPerSocket).map(([bucket, count]) => (
						<Badge key={bucket} variant="secondary">
							{bucket} · {formatCompactNumber(count)}
						</Badge>
					))}
				</div>
				<div className="flex flex-wrap gap-2 text-xs">
					<span className="text-muted-foreground">X-Forwarded-For entries on /mcp:</span>
					{Object.entries(forwardedForHops).map(([hops, count]) => (
						<Badge key={hops} variant="outline">
							{hops} · {formatCompactNumber(count)}
						</Badge>
					))}
				</div>
				{clusterEnabled && cluster ? (
					<div className="space-y-2 pt-2">
						<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Supervisor &amp; Workers
						</p>
						<div className="overflow-x-auto rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="border-b bg-muted/40 text-muted-foreground">
									<tr>
										<th className="px-3 py-2 font-medium">Role</th>
										<th className="px-3 py-2 font-medium">PID</th>
										<th className="px-3 py-2 font-medium">Uptime</th>
										<th className="px-3 py-2 font-medium">Req/s &amp; share</th>
										<th className="px-3 py-2 font-medium">Sockets</th>
										<th className="px-3 py-2 font-medium">ELU</th>
										<th className="px-3 py-2 font-medium">CPU</th>
										<th className="px-3 py-2 font-medium">p99</th>
										<th className="px-3 py-2 font-medium">RSS / Heap</th>
										<th className="px-3 py-2 font-medium">Gradio cache</th>
									</tr>
								</thead>
								<tbody className="divide-y font-mono">
									<tr className="bg-muted/15">
										<td className="px-3 py-2 font-sans font-medium">supervisor</td>
										<td className="px-3 py-2">{cluster.supervisor.pid}</td>
										<td className="px-3 py-2">{formatUptime(cluster.supervisor.uptimeSeconds)}</td>
										<td className="px-3 py-2 text-muted-foreground">—</td>
										<td className="px-3 py-2 text-muted-foreground">—</td>
										<td className="px-3 py-2">
											{cluster.supervisor.eventLoopUtilization !== null
												? percent(cluster.supervisor.eventLoopUtilization)
												: '—'}
										</td>
										<td className="px-3 py-2">
											{cluster.supervisor.cpuPercent !== null ? `${cluster.supervisor.cpuPercent.toFixed(0)}%` : '—'}
										</td>
										<td className="px-3 py-2">
											{cluster.supervisor.eventLoopDelayP99Ms !== null
												? `${cluster.supervisor.eventLoopDelayP99Ms.toFixed(1)} ms`
												: '—'}
										</td>
										<td className="px-3 py-2">
											{formatBytes(cluster.supervisor.rssBytes)} / {formatBytes(cluster.supervisor.heapUsedBytes)}
										</td>
										<td className="px-3 py-2 text-muted-foreground">—</td>
									</tr>
									{cluster.workers.map((worker) => {
										const sharePct =
											totalWorkerRequests > 0 ? Math.round((worker.totalRequests / totalWorkerRequests) * 100) : 0;
										return (
											<tr key={worker.workerId}>
												<td className="px-3 py-2 font-sans font-medium">w{worker.workerId}</td>
												<td className="px-3 py-2">{worker.pid}</td>
												<td className="px-3 py-2">{formatUptime(worker.uptimeSeconds)}</td>
												<td className="px-3 py-2">
													<div className="flex items-center gap-2">
														<span>
															{worker.httpRequestsPerSecond !== null ? worker.httpRequestsPerSecond.toFixed(1) : '—'}
														</span>
														<div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
															<div className="h-full bg-primary" style={{ width: `${String(sharePct)}%` }} />
														</div>
														<span className="text-muted-foreground">{String(sharePct)}%</span>
													</div>
												</td>
												<td className="px-3 py-2">{formatCompactNumber(worker.openSockets)}</td>
												<td className="px-3 py-2">
													{worker.eventLoopUtilization !== null ? percent(worker.eventLoopUtilization) : '—'}
												</td>
												<td className="px-3 py-2">
													{worker.cpuPercent !== null ? `${worker.cpuPercent.toFixed(0)}%` : '—'}
												</td>
												<td className="px-3 py-2">
													{worker.eventLoopDelayP99Ms !== null ? `${worker.eventLoopDelayP99Ms.toFixed(1)} ms` : '—'}
												</td>
												<td className="px-3 py-2">
													{formatBytes(worker.rssBytes)} / {formatBytes(worker.heapUsedBytes)}
												</td>
												<td className="px-3 py-2">{formatCompactNumber(worker.gradioCacheSize)}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
