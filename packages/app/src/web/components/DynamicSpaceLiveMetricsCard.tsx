import {
	DYNAMIC_SPACE_FAILURE_STAGES,
	DYNAMIC_SPACE_OPERATIONS,
	type DynamicSpaceLiveMetricsResponse,
} from '../../shared/dynamic-space-metrics.js';
import { formatCompactNumber } from '../lib/dashboard-utils';
import { SectionHeader } from './DashboardPrimitives';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

interface DynamicSpaceLiveMetricsCardProps {
	metrics: DynamicSpaceLiveMetricsResponse;
}

export function DynamicSpaceLiveMetricsCard({ metrics }: DynamicSpaceLiveMetricsCardProps) {
	const failureStages = DYNAMIC_SPACE_FAILURE_STAGES.filter((stage) => metrics.failuresByStage[stage] > 0);

	return (
		<Card>
			<CardContent className="space-y-4">
				<SectionHeader
					title="Dynamic Spaces live"
					description="Completed dynamic_space handler outcomes since this server process started, not task success."
				/>
				<div className="grid grid-cols-2 gap-3">
					{[
						{ label: 'Calls', counts: metrics.calls },
						{ label: 'Invocations', counts: metrics.operations.invoke },
					].map(({ label, counts }) => (
						<div key={label} className="rounded-xl border bg-muted/25 p-3">
							<p className="text-xs font-medium text-muted-foreground">{label}</p>
							<p className="mt-1 font-mono text-xl font-semibold">{formatCompactNumber(counts.total)}</p>
							<p className="mt-1 text-xs text-muted-foreground">
								{formatCompactNumber(counts.succeeded)} succeeded · {formatCompactNumber(counts.failed)} failed
							</p>
						</div>
					))}
				</div>
				{metrics.calls.total === 0 ? (
					<p className="text-sm text-muted-foreground">No completed dynamic_space calls yet.</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<caption className="sr-only">Dynamic Space usage by operation</caption>
							<thead className="text-xs text-muted-foreground">
								<tr>
									<th scope="col" className="py-2 text-left font-medium">
										Operation
									</th>
									{['Calls', 'Succeeded', 'Failed'].map((label) => (
										<th key={label} scope="col" className="py-2 text-right font-medium">
											{label}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{DYNAMIC_SPACE_OPERATIONS.map((operation) => (
									<tr key={operation} className="border-t">
										<th scope="row" className="py-2 text-left font-mono font-normal">
											{operation}
										</th>
										{(['total', 'succeeded', 'failed'] as const).map((outcome) => (
											<td key={outcome} className="py-2 text-right font-mono">
												{formatCompactNumber(metrics.operations[operation][outcome])}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{failureStages.length > 0 ? (
					<div className="flex flex-wrap items-center gap-2 text-xs">
						<span className="text-muted-foreground">Failures by stage</span>
						{failureStages.map((stage) => (
							<Badge key={stage} variant="secondary">
								{stage} · {formatCompactNumber(metrics.failuresByStage[stage])}
							</Badge>
						))}
					</div>
				) : null}
				<p className="text-xs text-muted-foreground">
					Excludes pre-handler SDK validation and direct Gradio tools (gr_*), including direct image generation; only
					dynamic_space calls are counted here.
				</p>
			</CardContent>
		</Card>
	);
}
