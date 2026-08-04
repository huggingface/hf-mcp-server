//import "./App.css";

import useSWR from 'swr';
import { TransportMetricsCard } from './components/TransportMetricsCard';
import { ProtocolMetricsCard } from './components/ProtocolMetricsCard';
import { McpMethodsCard } from './components/McpMethodsCard';
import { ConnectionFooter } from './components/ConnectionFooter';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';
import { Separator } from './components/ui/separator';
import { Activity, BarChart3, Copy, Home, Network, Settings, Wrench } from 'lucide-react';
import type { TransportInfo } from '../shared/transport-info.js';
import hfLogo from './hf-logo.svg';

// SWR fetcher function
const fetcher = (url: string) =>
	fetch(url).then((res) => {
		if (!res.ok) {
			throw new Error(`Failed to fetch: ${res.status}`);
		}
		return res.json();
	});

function App() {
	// Use SWR for transport info with auto-refresh
	const { data: transportInfo, error: transportError } = useSWR<TransportInfo>('/api/transport', fetcher, {
		refreshInterval: 3000, // Refresh every 3 seconds
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});

	// Only STDIO needs the session endpoint to populate stdioClient. HTTP
	// dashboards use aggregate counters from transport metrics.
	useSWR(transportInfo?.transport === 'stdio' ? '/api/sessions' : null, fetcher, {
		refreshInterval: 3000, // Refresh every 3 seconds
		revalidateOnFocus: true,
	});

	const isLoading = !transportInfo && !transportError;
	const error = transportError ? transportError.message : null;

	// Handler for copying MCP URL
	const handleCopyMcpUrl = async () => {
		const mcpUrl = `https://huggingface.co/mcp`;

		try {
			await navigator.clipboard.writeText(mcpUrl);
		} catch (err) {
			console.error('Failed to copy URL:', err);
		}
	};

	// Handler for going to settings (switch to search tab)
	const handleGoToSettings = () => {
		window.open('https://huggingface.co/settings/mcp', '_blank');
	};

	return (
		<div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.08),_transparent_32rem)]">
			<header className="border-b bg-background/90 backdrop-blur">
				<div className="mx-auto flex max-w-[1440px] items-center justify-between gap-6 px-4 py-4 sm:px-6 lg:px-8">
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-white shadow-xs">
							<img src={hfLogo} alt="" className="size-7" />
						</div>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<h1 className="truncate text-lg font-semibold tracking-tight text-foreground">MCP Operations</h1>
								<span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
									<Activity className="size-3" />
									Live
								</span>
							</div>
							<p className="truncate text-xs text-muted-foreground">Hugging Face MCP server telemetry</p>
						</div>
					</div>
					<div className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
						<span className="rounded-lg border bg-card px-3 py-1.5 font-mono">
							{transportInfo?.transport === 'stdio' ? 'stdin/stdout' : '/mcp'}
						</span>
						<span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
					</div>
				</div>
			</header>

			<main className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
				<Tabs defaultValue="metrics" className="w-full">
					<TabsList className="mb-5 h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border bg-card p-1 shadow-xs">
						<TabsTrigger value="metrics" className="min-w-32 gap-2 whitespace-nowrap py-2">
							<BarChart3 className="size-4" />
							Overview
						</TabsTrigger>
						<TabsTrigger value="protocols" className="min-w-32 gap-2 whitespace-nowrap py-2">
							<Network className="size-4" />
							Protocols
						</TabsTrigger>
						<TabsTrigger value="mcp" className="min-w-32 gap-2 whitespace-nowrap py-2">
							<Wrench className="size-4" />
							MCP methods
						</TabsTrigger>
						<TabsTrigger value="home" className="min-w-32 gap-2 whitespace-nowrap py-2">
							<Home className="size-4" />
							About
						</TabsTrigger>
					</TabsList>
					<TabsContent value="metrics" className="mt-0">
						<TransportMetricsCard />
					</TabsContent>
					<TabsContent value="protocols" className="mt-0">
						<ProtocolMetricsCard />
					</TabsContent>
					<TabsContent value="mcp" className="mt-0">
						<McpMethodsCard />
					</TabsContent>
					<TabsContent value="home" className="mt-0">
						{/* HF MCP Server Card */}
						<Card className="mx-auto max-w-3xl">
							<CardHeader>
								<CardTitle>🤗 HF MCP Server</CardTitle>
								<CardDescription>Connect with AI assistants through the Model Context Protocol</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								{/* What's MCP Section */}
								<div>
									<h3 className="text-sm font-semibold text-foreground mb-3">What's MCP?</h3>
									<p className="text-sm text-muted-foreground leading-relaxed">
										The Model Context Protocol (MCP) is an open standard that enables AI assistants to securely connect
										to external data sources and tools. This HF MCP Server provides access to Hugging Face's ecosystem
										of models, datasets, and Spaces, allowing AI assistants to search, analyze, and interact with ML
										resources directly.
									</p>
								</div>

								<Separator />

								{/* Action Buttons */}
								<div className="flex flex-col gap-4">
									<Button
										size="xl"
										onClick={handleCopyMcpUrl}
										className="w-full transition-all duration-200 active:bg-green-500 active:border-green-500 touch-manipulation"
									>
										<Copy className="mr-2 h-5 w-5" />
										Copy MCP URL
									</Button>
									<Button
										size="xl"
										variant="outline"
										onClick={handleGoToSettings}
										className="w-full touch-manipulation"
									>
										<Settings className="mr-2 h-5 w-5" />
										Go to Settings
									</Button>
								</div>
							</CardContent>
						</Card>
					</TabsContent>
				</Tabs>
			</main>

			<ConnectionFooter isLoading={isLoading} error={error} transportInfo={transportInfo || { transport: 'unknown' }} />
		</div>
	);
}

export default App;
