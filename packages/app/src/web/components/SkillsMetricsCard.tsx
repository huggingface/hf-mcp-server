import { useState } from 'react';
import useSWR from 'swr';
import {
	SKILL_METRIC_METHODS,
	type SkillsMetricsCounts,
	type SkillsMetricsFilters,
	type SkillsMetricsResponse,
} from '../../shared/skills-metrics.js';
import { DEFAULT_SKILLS_FILTERS, skillsMetricsFetcher, skillsMetricsUrl } from '../lib/skills-metrics';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';

function when(value: number | null): string {
	return value === null ? 'Never / unavailable' : new Date(value).toISOString();
}

interface CountsRow extends SkillsMetricsCounts {
	key: string;
	label: string;
}

function CountsTable({ title, description, rows }: { title: string; description: string; rows: CountsRow[] }) {
	return (
		<Card>
			<CardContent className="space-y-3">
				<SectionHeader title={title} description={description} />
				<div className="max-h-80 overflow-auto">
					<table className="w-full text-left text-sm tabular-nums">
						<caption className="sr-only">{title}</caption>
						<thead>
							<tr className="border-b">
								{[
									title,
									'Requests',
									'Successes',
									'Failures',
									'Skill doc reads',
									'Supporting file reads',
									'Last seen (UTC)',
								].map((label) => (
									<th key={label} scope="col" className="whitespace-nowrap p-2">
										{label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key} className="border-b">
									<th scope="row" className="max-w-80 break-words p-2 font-medium">
										{row.label}
									</th>
									{[
										row.requests,
										row.successes,
										row.failures,
										row.skillDocumentReads,
										row.supportingFileReads,
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
									<td colSpan={7} className="p-2 text-muted-foreground">
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

export function SkillsMetricsSnapshot({ metrics }: { metrics: SkillsMetricsResponse }) {
	const { snapshot, live } = metrics;
	return (
		<>
			<Card>
				<CardContent className="space-y-3">
					<SectionHeader
						title="Catalog health"
						description="Process-local catalog snapshot; bucket files alone do not establish that Skills are enabled."
					/>
					<dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
						{[
							['State', snapshot.state],
							['Snapshot skills', snapshot.skillCount],
							['Snapshot resources', snapshot.resourceCount],
							['Last loaded (UTC)', when(snapshot.loadedAt)],
							['Last attempt (UTC)', when(snapshot.lastAttemptAt)],
							['Last failure (UTC)', when(snapshot.lastFailureAt)],
							['Next refresh / retry eligible (UTC)', when(snapshot.nextRefreshAt)],
							['Remaining freshness', `${Math.ceil(snapshot.remainingTtlMs / 1000)} s`],
							['Refreshing', snapshot.refreshing ? 'Yes' : 'No'],
							['Serving previous snapshot', snapshot.servingPreviousSnapshot ? 'Yes' : 'No'],
							['Consecutive refresh failures', snapshot.refreshFailures],
						].map(([label, value]) => (
							<div key={label}>
								<dt className="text-muted-foreground">{label}</dt>
								<dd className="break-words font-medium">{value}</dd>
							</div>
						))}
					</dl>
					<p className="text-xs text-muted-foreground">
						Refreshes and retries are demand-driven, not scheduled background tasks. Catalog health is not affected by
						the activity filters.
					</p>
					{snapshot.warning ? (
						<p role="note" className="rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
							{snapshot.warning}
						</p>
					) : null}
				</CardContent>
			</Card>
			{!metrics.supported ? (
				<Card>
					<CardContent>
						<p role="status">
							Live Skills metrics are unsupported on {metrics.transport}. {metrics.unsupportedReason} Unavailable
							metrics do not mean zero activity.
						</p>
					</CardContent>
				</Card>
			) : !live ? (
				<p role="status">Live Skills metrics are unavailable.</p>
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
							label="Requests"
							value={live.totals.requests}
							detail={`Last seen: ${when(live.totals.lastSeen)}`}
						/>
						<MetricTile
							label="Window requests / min"
							value={live.totals.requestsPerMinute.toFixed(2)}
							detail={`Average over full ${live.filters.window} window, not instantaneous`}
						/>
						<MetricTile label="Successes" value={live.totals.successes} />
						<MetricTile label="Failures" value={live.totals.failures} />
						<MetricTile
							label="Metadata probes"
							value={live.totals.listRequests + live.totals.getRequests + live.totals.directoryRequests}
							detail={`List: ${live.totals.listRequests} · Get: ${live.totals.getRequests} · Directory: ${live.totals.directoryRequests} (all outcomes)`}
						/>
						<MetricTile
							label="Get requests"
							value={live.totals.getRequests}
							detail="Metadata only, not file content; all outcomes"
						/>
						<MetricTile
							label="Skill document reads"
							value={live.totals.skillDocumentReads}
							detail="Successful resources/read of SKILL.md"
						/>
						<MetricTile
							label="Supporting file reads"
							value={live.totals.supportingFileReads}
							detail="Successful resources/read of supporting files"
						/>
					</div>
					{live.totals.requests === 0 && (
						<p role="status">No events match these filters in the available live window.</p>
					)}
					<CountsTable
						title="Clients"
						description="Top 50 by request count. Names and versions are self-reported, not verified identities."
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

/** Mounted only in the active Skills tab; no background polling from other tabs. */
export function SkillsMetricsCard() {
	const [filters, setFilters] = useState<SkillsMetricsFilters>(DEFAULT_SKILLS_FILTERS);
	const { data, error, mutate } = useSWR<SkillsMetricsResponse>(skillsMetricsUrl(filters), skillsMetricsFetcher, {
		refreshInterval: 5000,
		keepPreviousData: false,
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});
	const selectClass = 'mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm';
	return (
		<div className="space-y-5">
			<SectionHeader
				title="Skills"
				description="Bounded, process-local live activity since restart—not historical analytics. Polls every 5 seconds while this tab is mounted."
			/>
			<p className="text-sm text-muted-foreground">
				Client name and version are self-reported, not identities. File retrieval does not prove a skill was used,
				executed, or fully installed.
			</p>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<label className="text-sm">
					Window
					<select
						className={selectClass}
						value={filters.window}
						onChange={(event) =>
							setFilters({ ...filters, window: event.target.value as SkillsMetricsFilters['window'] })
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
							setFilters({ ...filters, method: event.target.value as SkillsMetricsFilters['method'] })
						}
					>
						<option value="all">All methods</option>
						{SKILL_METRIC_METHODS.map((method) => (
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
							setFilters({ ...filters, outcome: event.target.value as SkillsMetricsFilters['outcome'] })
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
					Failed to load Skills metrics.{' '}
					{data ? 'Showing the last successful response; it may be stale.' : 'No metrics available.'}
					<Button variant="outline" size="sm" className="ml-3" onClick={() => void mutate()}>
						Retry
					</Button>
				</div>
			)}
			{!data && !error && <p role="status">Loading Skills metrics…</p>}
			{data && <SkillsMetricsSnapshot metrics={data} />}
		</div>
	);
}
