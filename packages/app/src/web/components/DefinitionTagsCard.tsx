import { useState } from 'react';
import useSWR from 'swr';
import { CircleCheck, DatabaseZap, Eraser, KeyRound, RefreshCw, Shuffle, Timer, TriangleAlert } from 'lucide-react';
import type { DefinitionTagsStatus } from '../../shared/definition-tags-status.js';
import { formatCompactNumber } from '../lib/dashboard-utils';
import { DEFINITION_TAGS_STATUS_URL, definitionTagsFetcher } from '../lib/definition-tags';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';

function formatTtl(ms: number): string {
	if (ms === 0) return '0 (no caching)';
	if (ms % 60_000 === 0) return `${(ms / 60_000).toString()} min`;
	return `${(ms / 1000).toString()} s`;
}

function formatWhen(timestamp: string | undefined): string {
	if (!timestamp) return 'never';
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
	if (seconds < 60) return `${seconds.toString()}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes.toString()}m ago`;
	return `${Math.floor(minutes / 60).toString()}h ago`;
}

/** Caching tab: definition tags status, test salt controls and check counters (test mode only). */
export function DefinitionTagsCard() {
	const {
		data: status,
		error,
		mutate,
	} = useSWR<DefinitionTagsStatus>(DEFINITION_TAGS_STATUS_URL, definitionTagsFetcher, {
		refreshInterval: 3000,
		revalidateOnFocus: true,
	});
	const [saltInput, setSaltInput] = useState('');
	const [actionError, setActionError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const act = async (method: 'POST' | 'DELETE', path: string) => {
		setPending(true);
		setActionError(null);
		try {
			const res = await fetch(`${DEFINITION_TAGS_STATUS_URL}${path}`, { method });
			const body = (await res.json()) as DefinitionTagsStatus | { error: string };
			if (!res.ok || 'error' in body) {
				setActionError('error' in body ? body.error : `Request failed: ${res.status}`);
				return;
			}
			await mutate(body, { revalidate: false });
		} catch (err) {
			setActionError((err as Error).message);
		} finally {
			setPending(false);
		}
	};

	if (error) {
		return (
			<Card>
				<CardContent className="text-sm text-muted-foreground">
					Definition tags test mode is not available ({error.message}).
				</CardContent>
			</Card>
		);
	}
	if (!status) {
		return (
			<Card>
				<CardContent className="text-sm text-muted-foreground">Loading definition tags status…</CardContent>
			</Card>
		);
	}

	const { stats } = status;
	const effectiveSalt = [status.deploySalt, status.testSalt].filter(Boolean).join('/');

	return (
		<div className="space-y-5">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<MetricTile
					label="Definition tags"
					value={status.enabled ? 'Active' : 'Off'}
					detail={status.enabled ? 'Anonymous and named-bouquet requests' : 'DEFINITION_TAGS=off'}
					icon={<DatabaseZap className="size-5" />}
					tone={status.enabled ? 'green' : 'red'}
				/>
				<MetricTile
					label="List TTL"
					value={formatTtl(status.ttlMs)}
					detail="tools/list and server/discover"
					icon={<Timer className="size-5" />}
					tone="blue"
				/>
				<MetricTile
					label="Checked calls"
					value={formatCompactNumber(stats.checkedCalls)}
					detail={`${formatCompactNumber(stats.matched)} matched · last ${formatWhen(stats.lastCheckedAt)}`}
					icon={<CircleCheck className="size-5" />}
					tone="violet"
				/>
				<MetricTile
					label="Mismatches"
					value={formatCompactNumber(stats.mismatched)}
					detail={`error ${status.errorCode.toString()} · last ${formatWhen(stats.lastMismatchAt)}`}
					icon={<TriangleAlert className="size-5" />}
					tone={stats.mismatched > 0 ? 'amber' : 'neutral'}
				/>
			</div>

			<Card>
				<CardContent className="space-y-4">
					<SectionHeader
						title="Tag salt"
						description="Changing the salt changes every advertised tag without changing definitions. Connected clients get a mismatch on their next checked call and must refresh."
						aside={
							<Badge variant="outline" className="font-mono">
								{effectiveSalt ? `effective: ${effectiveSalt}` : 'unsalted'}
							</Badge>
						}
					/>
					<div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
						<div className="rounded-xl border bg-muted/25 p-3">
							<p className="text-xs font-medium text-muted-foreground">Test salt (runtime)</p>
							<p className="mt-1 font-mono text-lg font-semibold">{status.testSalt || '—'}</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Updated {formatWhen(status.testSaltUpdatedAt)} · this process only
							</p>
						</div>
						<div className="rounded-xl border bg-muted/25 p-3">
							<p className="text-xs font-medium text-muted-foreground">Deploy salt (DEFINITION_TAGS_SALT)</p>
							<p className="mt-1 font-mono text-lg font-semibold">{status.deploySalt || '—'}</p>
							<p className="mt-1 text-xs text-muted-foreground">Set by environment; restart to change</p>
						</div>
					</div>
					<form
						className="flex flex-col gap-2 sm:flex-row"
						onSubmit={(event) => {
							event.preventDefault();
							if (saltInput) void act('POST', `/salt?value=${encodeURIComponent(saltInput)}`);
						}}
					>
						<Input
							value={saltInput}
							onChange={(event) => setSaltInput(event.target.value)}
							placeholder="New test salt (printable ASCII, no spaces)"
							maxLength={128}
							aria-label="New test salt"
							className="font-mono sm:max-w-sm"
						/>
						<Button type="submit" disabled={pending || !saltInput}>
							<KeyRound />
							Set salt
						</Button>
						<Button type="button" variant="outline" disabled={pending} onClick={() => void act('POST', '/salt')}>
							<Shuffle />
							Random
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={pending || !status.testSalt}
							onClick={() => void act('DELETE', '/salt')}
						>
							<Eraser />
							Clear
						</Button>
					</form>
					{actionError && <p className="text-sm text-destructive">{actionError}</p>}
				</CardContent>
			</Card>

			<Card>
				<CardContent className="space-y-4">
					<SectionHeader
						title="Activity"
						description={`Process-local counters since ${new Date(stats.since).toLocaleString()}.`}
						aside={
							<Button variant="outline" size="sm" disabled={pending} onClick={() => void act('DELETE', '/stats')}>
								<RefreshCw />
								Reset counters
							</Button>
						}
					/>
					<div className="flex flex-wrap gap-2 text-xs">
						<Badge variant="secondary">Tagged lists · {formatCompactNumber(stats.taggedLists)}</Badge>
						<Badge variant="secondary">Tagged discoveries · {formatCompactNumber(stats.taggedDiscoveries)}</Badge>
						<Badge variant="secondary">Memo checks · {formatCompactNumber(stats.memoChecks)}</Badge>
						<Badge variant="outline">Stale tools · {formatCompactNumber(stats.staleTools)}</Badge>
						<Badge variant="outline">Stale discovery · {formatCompactNumber(stats.staleDiscovery)}</Badge>
					</div>
					<div className="rounded-xl border bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
						<p className="font-medium text-foreground">Quick test</p>
						<ol className="mt-1 list-decimal space-y-0.5 pl-4">
							<li>
								Connect a client to <code className="font-mono">/mcp?anon</code> or{' '}
								<code className="font-mono">/mcp?bouquet=search</code> and list tools.
							</li>
							<li>Call a tool with the known tags: “Checked calls” increases.</li>
							<li>Set or randomize the salt, then call again: the call is rejected and “Mismatches” increases.</li>
							<li>The client re-lists (bypassing its cache) and later calls match again.</li>
						</ol>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
