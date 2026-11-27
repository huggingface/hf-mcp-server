import { useState } from 'react';
import useSWR from 'swr';
import {
	EVENT_METRIC_METHODS,
	type EventMetricOutcome,
	type EventsMetricsCounts,
	type EventsMetricsFilters,
	type EventsMetricsResponse,
} from '../../shared/events-metrics.js';
import { DEFAULT_EVENTS_FILTERS, eventsMetricsFetcher, eventsMetricsUrl } from '../lib/events-metrics';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';

function when(value: number | null): string {
	return value === null ? 'Never / unavailable' : new Date(value).toISOString();
}

const OUTCOME_LABELS: Record<EventMetricOutcome, string> = {
	ok: 'List OK',
	delivered: 'Delivered transition',
	empty: 'Empty poll',
	truncated: 'Truncated poll',
	auth_rejected: 'Auth rejected',
	header_mismatch: 'Header mismatch (-32020)',
	not_found: 'Unknown event (-32023)',
	forbidden: 'Forbidden (-32024)',
	invalid_params: 'Invalid params (-32602)',
	method_not_found: 'Method not found (-32601)',
	error: 'Server / internal error',
};

interface CountsRow extends EventsMetricsCounts {
	key: string;
	label: string;
	advertisedCount?: number;
}

function CountsTable({
	title,
	description,
	rows,
	showAdvertised = false,
}: {
	title: string;
	description: string;
	rows: CountsRow[];
	showAdvertised?: boolean;
}) {
	const headers = [
		title,
		...(showAdvertised ? ['Advertised'] : []),
		'Requests',
		'Successes',
		'Failures',
		'Delivered',
		'Empty',
		'Truncated',
		'Last seen (UTC)',
	];
	return (
		<Card>
			<CardContent className="space-y-3">
				<SectionHeader title={title} description={description} />
				<div className="max-h-80 overflow-auto">
					<table className="w-full text-left text-sm tabular-nums">
						<caption className="sr-only">{title}</caption>
						<thead>
							<tr className="border-b">
								{headers.map((label) => (
									<th key={label} scope="col" className="whitespace-nowrap p-2 font-medium">
										{label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key} className="border-b last:border-0">
									<th scope="row" className="max-w-80 break-words p-2 font-medium">
										{row.label}
									</th>
									{showAdvertised && <td className="whitespace-nowrap p-2">{row.advertisedCount ?? 0}</td>}
									{[
										row.requests,
										row.successes,
										row.failures,
										row.deliveredPolls,
										row.emptyPolls,
										row.truncatedPolls,
										when(row.lastSeen),
									].map((value, index) => (
										<td key={index} className="whitespace-nowrap p-2">
											{value}
										</td>
									))}
								</tr>
							))}
							{rows.length === 0 && (
								<tr>
									<td colSpan={headers.length} className="p-2 text-muted-foreground">
										No matching events.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</CardContent>
		</Card>
	);
}

export function EventsMetricsSnapshot({ metrics }: { metrics: EventsMetricsResponse }) {
	const { live } = metrics;
	return (
		<>
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">MCP Events Extension (SEP-3415)</h3>
							<Badge variant={metrics.enabled ? 'default' : 'secondary'}>
								{metrics.enabled ? 'Enabled' : 'Disabled'}
							</Badge>
						</div>
						<p className="text-xs text-muted-foreground">
							{metrics.enabled
								? 'Poll delivery active for authenticated modern Streamable HTTP callers (protocol ≥ 2026-07-28): job.status_changed.'
								: 'Set MCP_EVENTS_ENABLED=true to advertise io.modelcontextprotocol/events and serve events/list and events/poll.'}
						</p>
					</div>
				</CardContent>
			</Card>
			{!metrics.supported ? (
				<Card>
					<CardContent>
						<p role="status">
							Live Events metrics are unsupported on {metrics.transport}. {metrics.unsupportedReason} Unavailable
							metrics do not mean zero activity.
						</p>
					</CardContent>
				</Card>
			) : !live ? (
				<p role="status">Live Events metrics are unavailable.</p>
			) : (
				<>
					{live.retention.truncated && (
						<p role="status" className="rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
							Truncated coverage: the requested window extends before complete coverage, available since{' '}
							{when(live.retention.availableSince)}. Counts may be incomplete due to process startup or bounded
							retention.
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						Window (UTC): {when(live.windowStart)} – {when(live.windowEnd)} · Updated {when(live.generatedAt)}. Retained
						events (before filters): {live.retention.retainedEvents} / {live.retention.maxEvents}; maximum age{' '}
						{live.retention.maxAgeMs / 3_600_000}h. Process-lifetime capacity evictions:{' '}
						{live.retention.capacityEvictions}; expired events: {live.retention.expiredEvents}.
					</p>
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<MetricTile
							label="Capability advertised"
							value={live.discovery.advertisedResponses}
							detail={`${live.discovery.uniqueClients} distinct clients · Last: ${when(live.discovery.lastAdvertised)}`}
						/>
						<MetricTile
							label="Event requests"
							value={live.totals.requests}
							detail={`List: ${live.totals.listRequests} · Poll: ${live.totals.pollRequests}`}
						/>
						<MetricTile
							label="Window requests / min"
							value={live.totals.requestsPerMinute.toFixed(2)}
							detail={`Average over full ${live.filters.window} window, not instantaneous`}
						/>
						<MetricTile
							label="Transitions delivered"
							value={live.totals.deliveredPolls}
							detail={`${live.totals.deliveredEvents} events emitted across polls`}
						/>
						<MetricTile
							label="Empty polls"
							value={live.totals.emptyPolls}
							detail="Successful polls with no stage change"
						/>
						<MetricTile
							label="Truncated polls"
							value={live.totals.truncatedPolls}
							detail="Unknown cursor reset or maxAgeMs exceeded"
						/>
						<MetricTile label="Successes" value={live.totals.successes} />
						<MetricTile label="Failures" value={live.totals.failures} />
					</div>
					{live.totals.requests === 0 && (
						<p role="status">No event protocol requests match these filters in the available live window.</p>
					)}
					<CountsTable
						title="Clients"
						description="Clients that called events/list or events/poll in the selected window, top 50 by request count. Advertised counts reflect server/discover responses offering io.modelcontextprotocol/events to that client in the same window. Names and versions are self-reported, not verified identities."
						showAdvertised
						rows={[...live.byClient]
							.sort((a, b) => b.requests - a.requests)
							.slice(0, 50)
							.map((row) => ({
								...row,
								key: JSON.stringify([row.name, row.version]),
								label: `${row.name || 'Unknown client'} · ${row.version || 'Unknown version'}`,
							}))}
					/>
					<CountsTable
						title="Methods"
						description="Counts for the selected filters."
						rows={live.byMethod.map((row) => ({ ...row, key: row.method, label: row.method }))}
					/>
					<CountsTable
						title="Event types"
						description="Normalized events/poll targets (unknown event names are grouped under [unknown])."
						rows={live.byEventName.map((row) => ({ ...row, key: row.eventName, label: row.eventName }))}
					/>
					<Card>
						<CardContent className="space-y-3">
							<SectionHeader
								title="Outcomes"
								description="Poll delivery and JSON-RPC error breakdown for matching requests."
							/>
							<div className="max-h-80 overflow-auto">
								<table className="w-full text-left text-sm tabular-nums">
									<caption className="sr-only">Outcomes</caption>
									<thead>
										<tr className="border-b">
											<th scope="col" className="whitespace-nowrap p-2 font-medium">
												Outcome
											</th>
											<th scope="col" className="whitespace-nowrap p-2 font-medium">
												Count
											</th>
											<th scope="col" className="whitespace-nowrap p-2 font-medium">
												Last seen (UTC)
											</th>
										</tr>
									</thead>
									<tbody>
										{live.byOutcome.map((row) => (
											<tr key={row.outcome} className="border-b last:border-0">
												<th scope="row" className="p-2 font-medium">
													{OUTCOME_LABELS[row.outcome]}
												</th>
												<td className="whitespace-nowrap p-2">{row.count}</td>
												<td className="whitespace-nowrap p-2">{when(row.lastSeen)}</td>
											</tr>
										))}
										{live.byOutcome.length === 0 && (
											<tr>
												<td colSpan={3} className="p-2 text-muted-foreground">
													No matching events.
												</td>
											</tr>
										)}
									</tbody>
								</table>
							</div>
						</CardContent>
					</Card>
					<CountsTable
						title="Timeline (UTC)"
						description="Latest 60 active minute buckets, newest first. Absent minutes have zero events; edge buckets may be partial."
						rows={[...live.timeline]
							.sort((a, b) => b.minute - a.minute)
							.slice(0, 60)
							.map((row) => ({ ...row, key: String(row.minute), label: when(row.minute) }))}
					/>
				</>
			)}
		</>
	);
}

/** Mounted only in the active Events tab; no background polling from other tabs. */
export function EventsMetricsCard() {
	const [filters, setFilters] = useState<EventsMetricsFilters>(DEFAULT_EVENTS_FILTERS);
	const { data, error, mutate } = useSWR<EventsMetricsResponse>(eventsMetricsUrl(filters), eventsMetricsFetcher, {
		refreshInterval: 5000,
		keepPreviousData: false,
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});
	const selectClass = 'mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm';
	return (
		<div className="space-y-5">
			<SectionHeader
				title="Events"
				description="Bounded, process-local live MCP Events (SEP-3415) uptake since restart—not historical analytics. Polls every 5 seconds while this tab is mounted."
			/>
			<p className="text-sm text-muted-foreground">
				Tracks capability advertisement on server/discover alongside events/list and events/poll outcomes. Client name
				and version are self-reported, not verified identities; job IDs, cursors, and payloads are never stored.
			</p>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<label className="text-sm">
					Window
					<select
						className={selectClass}
						value={filters.window}
						onChange={(event) =>
							setFilters({ ...filters, window: event.target.value as EventsMetricsFilters['window'] })
						}
					>
						<option value="15m">15 minutes</option>
						<option value="1h">1 hour</option>
						<option value="24h">24 hours</option>
					</select>
				</label>
				<label className="text-sm">
					Client name or version
					<Input
						className="mt-1"
						maxLength={128}
						placeholder="Case-insensitive substring"
						value={filters.client}
						onChange={(event) => setFilters({ ...filters, client: event.target.value })}
					/>
				</label>
				<label className="text-sm">
					Method
					<select
						className={selectClass}
						value={filters.method}
						onChange={(event) =>
							setFilters({ ...filters, method: event.target.value as EventsMetricsFilters['method'] })
						}
					>
						<option value="all">All methods</option>
						{EVENT_METRIC_METHODS.map((method) => (
							<option key={method} value={method}>
								{method}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					Outcome
					<select
						className={selectClass}
						value={filters.outcome}
						onChange={(event) =>
							setFilters({ ...filters, outcome: event.target.value as EventsMetricsFilters['outcome'] })
						}
					>
						<option value="all">All outcomes</option>
						<option value="success">Success</option>
						<option value="failure">Failure</option>
					</select>
				</label>
			</div>
			{error && (
				<div role="alert" className="rounded-lg border border-destructive p-3 text-sm">
					Failed to load Events metrics.{' '}
					{data ? 'Showing the last successful response; it may be stale.' : 'No metrics available.'}
					<Button variant="outline" size="sm" className="ml-3" onClick={() => void mutate()}>
						Retry
					</Button>
				</div>
			)}
			{!data && !error && <p role="status">Loading Events metrics…</p>}
			{data && <EventsMetricsSnapshot metrics={data} />}
		</div>
	);
}
