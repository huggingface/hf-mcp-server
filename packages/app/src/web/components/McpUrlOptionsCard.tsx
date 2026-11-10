import { SlidersHorizontal } from 'lucide-react';
import { MCP_URL_BASE, MCP_URL_OPTIONS, MCP_URL_PRESETS } from '../lib/mcp-url-options';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { CopyButton } from './ui/copy-button';

export function McpUrlOptionsCard() {
	return (
		<Card className="mt-8 scroll-mt-6" id="url-options" aria-labelledby="url-options-title">
			<CardHeader>
				<div className="flex items-center gap-3">
					<div className="rounded-lg bg-primary/10 p-2 text-primary">
						<SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
					</div>
					<div className="space-y-1.5">
						<CardTitle className="text-xl font-semibold" id="url-options-title">
							Tool Presets and URL Options
						</CardTitle>
						<CardDescription>Optional tweaks. No changes to your saved MCP settings.</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-2 text-sm text-muted-foreground">
					<p>
						Copy an example URL into your client’s MCP server settings, then reconnect. Each example keeps{' '}
						<code className="font-mono text-foreground">?login</code> to request Hugging Face sign-in.
					</p>
					<p>
						To edit a URL yourself, start with{' '}
						<code className="break-all font-mono text-xs text-foreground">{MCP_URL_BASE}</code> and append options with{' '}
						<code className="font-mono text-foreground">&amp;</code>. Never put your access token in the URL.
					</p>
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					{MCP_URL_OPTIONS.map((option) => (
						<div key={option.query} className="flex min-w-0 flex-col rounded-xl border border-border bg-muted/20 p-4">
							<h3 className="text-sm font-semibold text-foreground">{option.title}</h3>
							<p className="mt-2 text-sm text-muted-foreground">{option.description}</p>
							<div className="my-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2">
								<code className="min-w-0 break-all font-mono text-xs text-foreground">{option.query}</code>
								<CopyButton
									content={`${MCP_URL_BASE}&${option.query}`}
									label={`Copy URL with ${option.query}`}
									iconOnly
									variant="ghost"
									className="h-7 w-7 shrink-0"
								/>
							</div>
							<p className="text-xs leading-relaxed text-muted-foreground">{option.note}</p>
						</div>
					))}
				</div>

				<div className="space-y-3">
					<div>
						<h3 className="text-sm font-semibold text-foreground">Useful presets</h3>
						<p className="mt-1 text-sm text-muted-foreground">
							Use one with <code className="font-mono text-xs">bouquet=</code>, or add several with{' '}
							<code className="font-mono text-xs">mix=</code>.
						</p>
					</div>
					<dl className="space-y-3">
						{MCP_URL_PRESETS.map((preset) => (
							<div key={preset.key} className="flex items-start gap-3">
								<dt className="w-20 shrink-0 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs text-foreground">
									{preset.key}
								</dt>
								<dd className="text-sm text-muted-foreground">{preset.description}</dd>
							</div>
						))}
					</dl>
				</div>

				<p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
					All presets include the core filesystem and account tools. Hub writes, repository creation, Jobs and sandboxes
					require authentication and appropriate permissions; a preset does not grant extra access.
				</p>
			</CardContent>
		</Card>
	);
}
