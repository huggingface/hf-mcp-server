import useSWR from 'swr';
import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Card, CardContent } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { DataTable } from './data-table';
import { createSortableHeader } from './data-table-utils';
import type { TransportMetricsResponse } from '../../shared/transport-metrics.js';
import { Box, Clock3, MessageSquareText, Wrench } from 'lucide-react';
import { MetricTile, SectionHeader } from './DashboardPrimitives';
import { formatCompactNumber } from '../lib/dashboard-utils';

// SWR fetcher function
const fetcher = (url: string) =>
	fetch(url).then((res) => {
		if (!res.ok) {
			throw new Error(`Failed to fetch: ${res.status}`);
		}
		return res.json();
	});

type MethodData = {
	method: string;
	count: number;
	errors: number;
	errorRate: number;
	averageResponseTime?: number;
	lastCalled: string;
	// Gradio-specific metrics if available
	gradioSuccess?: number;
	gradioFailure?: number;
};

export function McpMethodsCard() {
	// State for filtering only resource, tool, and prompt calls
	const [showOnlyPrimaryMcpCalls, setShowOnlyPrimaryMcpCalls] = useState(false);

	// Use SWR for transport metrics with auto-refresh
	const { data: metrics, error } = useSWR<TransportMetricsResponse>('/api/transport-metrics', fetcher, {
		refreshInterval: 3000, // Refresh every 3 seconds
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});

	const isLoading = !metrics && !error;
	const isStdioMode = metrics?.transport === 'stdio';

	// Process methods and enrich with Gradio metrics
	const processedMethods: MethodData[] = (metrics?.methods || []).map((method) => {
		let gradioSuccess: number | undefined;
		let gradioFailure: number | undefined;

		// Check if this is a tool call and we have Gradio metrics
		if (method.method.startsWith('tools/call:') && metrics?.gradioMetrics) {
			// Extract tool name from method (tools/call:toolName -> toolName)
			const toolName = method.method.replace('tools/call:', '');
			const gradioByTool = metrics.gradioMetrics.byTool;

			// Look for exact match in Gradio metrics
			if (gradioByTool[toolName]) {
				gradioSuccess = gradioByTool[toolName].success;
				gradioFailure = gradioByTool[toolName].failure;
			}
		}

		const methodData: MethodData = {
			method: method.method,
			count: method.count,
			// Gradio failures are another view of these same failed method calls,
			// not additional calls. Adding them here would double-count failures.
			errors: method.errors,
			errorRate: method.errorRate,
			averageResponseTime: method.averageResponseTime,
			lastCalled: method.lastCalled,
			gradioSuccess,
			gradioFailure,
		};

		return methodData;
	});

	// Filter methods if checkbox is checked
	const filteredMethods = showOnlyPrimaryMcpCalls
		? processedMethods.filter(
				(m) =>
					m.method.startsWith('tools/call') || m.method.startsWith('prompts/') || m.method.startsWith('resources/read')
			)
		: processedMethods;

	// Calculate total calls, tool calls, prompt calls, and resource reads
	const totalMcpCalls = processedMethods.reduce((sum, method) => sum + method.count, 0);
	const toolCalls = processedMethods
		.filter((m) => m.method.startsWith('tools/call'))
		.reduce((sum, method) => sum + method.count, 0);
	const promptCalls = processedMethods
		.filter((m) => m.method.startsWith('prompts/'))
		.reduce((sum, method) => sum + method.count, 0);
	const resourceReads = processedMethods
		.filter((m) => m.method.startsWith('resources/read'))
		.reduce((sum, method) => sum + method.count, 0);
	const totalErrors = processedMethods.reduce((sum, method) => sum + method.errors, 0);
	const timedMethods = processedMethods.filter((method) => method.averageResponseTime !== undefined);
	const averageResponseTime =
		timedMethods.length === 0
			? 0
			: timedMethods.reduce((sum, method) => sum + (method.averageResponseTime ?? 0), 0) / timedMethods.length;

	// Define columns for the data table
	const columns: ColumnDef<MethodData>[] = [
		{
			accessorKey: 'method',
			header: createSortableHeader('Method'),
			cell: ({ row }) => {
				const method = row.getValue('method') as string;
				return (
					<div className="font-mono text-sm">
						{method === 'tools/call' ? (
							<span className="text-blue-600 dark:text-blue-400">tools/call</span>
						) : method.startsWith('tools/call:') ? (
							<>
								<span className="text-blue-600 dark:text-blue-400">tools/call:</span>
								<span className="text-green-600 dark:text-green-400">{method.replace('tools/call:', '')}</span>
							</>
						) : method === 'prompts/get' ? (
							<span className="text-purple-600 dark:text-purple-400">prompts/get</span>
						) : method === 'prompts/list' ? (
							<span className="text-purple-600 dark:text-purple-400">prompts/list</span>
						) : method.startsWith('prompts/get:') ? (
							<>
								<span className="text-purple-600 dark:text-purple-400">prompts/get:</span>
								<span className="text-orange-600 dark:text-orange-400">{method.replace('prompts/get:', '')}</span>
							</>
						) : method === 'resources/read' ? (
							<span className="text-cyan-600 dark:text-cyan-400">resources/read</span>
						) : method.startsWith('resources/read:') ? (
							<>
								<span className="text-cyan-600 dark:text-cyan-400">resources/read:</span>
								<span className="text-teal-600 dark:text-teal-400 break-all">
									{method.replace('resources/read:', '')}
								</span>
							</>
						) : (
							method
						)}
					</div>
				);
			},
		},
		{
			accessorKey: 'count',
			header: createSortableHeader('Calls', 'right'),
			cell: ({ row }) => <div className="text-right font-mono">{row.getValue<number>('count').toLocaleString()}</div>,
		},
		{
			accessorKey: 'errors',
			header: createSortableHeader('Errors', 'right'),
			cell: ({ row }) => {
				const errors = row.getValue<number>('errors');
				return (
					<div className="text-right font-mono">
						{errors > 0 ? <span className="text-red-600 dark:text-red-400">{errors}</span> : '0'}
					</div>
				);
			},
		},
		{
			accessorKey: 'gradioMetrics',
			header: createSortableHeader('Gradio Success/Failure', 'right'),
			cell: ({ row }) => {
				const data = row.original;
				if (data.gradioSuccess !== undefined && data.gradioFailure !== undefined) {
					return (
						<div className="text-right font-mono text-sm">
							<span className="text-green-600 dark:text-green-400">{data.gradioSuccess}</span>
							<span className="text-muted-foreground">/</span>
							<span className="text-red-600 dark:text-red-400">{data.gradioFailure}</span>
						</div>
					);
				}
				return <div className="text-right text-muted-foreground">—</div>;
			},
		},
		{
			accessorKey: 'errorRate',
			header: createSortableHeader('Error Rate', 'right'),
			cell: ({ row }) => {
				const errorRate = row.getValue<number>('errorRate');
				return (
					<div className="text-right font-mono">
						{errorRate > 0 ? <span className="text-red-600 dark:text-red-400">{errorRate.toFixed(1)}%</span> : '0%'}
					</div>
				);
			},
		},
		{
			accessorKey: 'averageResponseTime',
			header: createSortableHeader('Avg Response', 'right'),
			cell: ({ row }) => {
				const avgTime = row.getValue<number | undefined>('averageResponseTime');
				return <div className="text-right font-mono">{avgTime ? `${avgTime.toFixed(0)}ms` : '—'}</div>;
			},
		},
		{
			accessorKey: 'lastCalled',
			header: createSortableHeader('Last Called', 'right'),
			cell: ({ row }) => (
				<div className="text-right text-sm text-muted-foreground">
					{new Date(row.getValue<string>('lastCalled')).toLocaleTimeString()}
				</div>
			),
		},
	];

	return (
		<div className="space-y-5">
			<SectionHeader
				title="MCP methods"
				description={`Call volume, reliability, and response times by operation${isStdioMode ? ' (HTTP transports only)' : ''}.`}
			/>
			{metrics && !isStdioMode && (
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<MetricTile
						label="All method calls"
						value={formatCompactNumber(totalMcpCalls)}
						detail={`${processedMethods.length} methods observed`}
						icon={<Box className="size-5" />}
						tone="blue"
					/>
					<MetricTile
						label="Tool calls"
						value={formatCompactNumber(toolCalls)}
						detail={`${totalErrors} total errors`}
						icon={<Wrench className="size-5" />}
						tone="amber"
					/>
					<MetricTile
						label="Prompt attempts"
						value={formatCompactNumber(promptCalls)}
						detail={`${formatCompactNumber(resourceReads)} resource reads`}
						icon={<MessageSquareText className="size-5" />}
						tone="violet"
					/>
					<MetricTile
						label="Mean response"
						value={averageResponseTime > 0 ? `${averageResponseTime.toFixed(0)}ms` : '—'}
						detail="Across methods with timings"
						icon={<Clock3 className="size-5" />}
						tone="green"
					/>
				</div>
			)}
			<Card>
				<CardContent>
					{isLoading && (
						<div className="flex items-center justify-center py-8">
							<div className="text-sm text-muted-foreground">Loading metrics...</div>
						</div>
					)}

					{error && (
						<div className="flex items-center justify-center py-8">
							<div className="text-sm text-destructive">Error loading metrics: {error.message}</div>
						</div>
					)}

					{isStdioMode && (
						<div className="flex items-center justify-center py-8">
							<div className="text-sm text-muted-foreground">
								Method tracking is not available in STDIO mode. This data is only collected for HTTP-based transports.
							</div>
						</div>
					)}

					{metrics && !isStdioMode && (
						<div className="space-y-4">
							{processedMethods.length > 0 && (
								<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									<div className="text-xs text-muted-foreground">
										Showing {filteredMethods.length} method{filteredMethods.length !== 1 ? 's' : ''} tracked since{' '}
										{new Date(metrics.startupTime).toLocaleString()}
									</div>
									<div className="flex items-center space-x-2 rounded-lg border bg-muted/30 px-3 py-2">
										<Checkbox
											id="tool-prompt-calls-filter"
											checked={showOnlyPrimaryMcpCalls}
											onCheckedChange={(checked) => setShowOnlyPrimaryMcpCalls(!!checked)}
										/>
										<label
											htmlFor="tool-prompt-calls-filter"
											className="cursor-pointer text-xs font-medium leading-none"
										>
											Primary MCP calls only
										</label>
									</div>
								</div>
							)}

							{filteredMethods.length === 0 ? (
								<div className="flex items-center justify-center py-8">
									<div className="text-sm text-muted-foreground">
										{showOnlyPrimaryMcpCalls
											? 'No tool, prompt, or resource calls recorded yet.'
											: 'No method calls recorded yet.'}
									</div>
								</div>
							) : (
								<DataTable
									columns={columns}
									data={filteredMethods}
									searchColumn="method"
									searchPlaceholder="Filter methods..."
									pageSize={50}
									defaultColumnVisibility={{
										method: true,
										count: true,
										errors: false,
										gradioMetrics: false,
										errorRate: true,
										averageResponseTime: metrics.transport === 'streamableHttpJson',
										lastCalled: true,
									}}
									defaultSorting={[{ id: 'count', desc: true }]}
								/>
							)}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
