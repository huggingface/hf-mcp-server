import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * Shared HTTP smoke flow for the v1/legacy and v2/2026 wrappers.
 *
 * MCP_URL defaults to http://127.0.0.1:3000/mcp.
 * MCP_TOOL defaults to hf_whoami and MCP_ARGS defaults to {}.
 * Set MCP_REQUIRE_PROGRESS=true when MCP_TOOL is expected to emit progress.
 */
export type ExpectedProtocolEra = 'legacy' | 'modern';

interface ProtocolSmokeOptions {
	expectedEra: ExpectedProtocolEra;
}

function parseArguments(value: string | undefined): Record<string, unknown> {
	if (!value) return {};

	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('MCP_ARGS must be a JSON object');
	}
	return parsed as Record<string, unknown>;
}

function isEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

export async function runProtocolSmoke({ expectedEra }: ProtocolSmokeOptions): Promise<void> {
	const serverUrl = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp');
	const toolName = process.env.MCP_TOOL ?? 'hf_whoami';
	const toolArguments = parseArguments(process.env.MCP_ARGS);
	const requireProgress = isEnabled(process.env.MCP_REQUIRE_PROGRESS);
	const progressMessages: Array<{ progress: number; total?: number; message?: string }> = [];

	const versionNegotiation =
		expectedEra === 'modern' ? ({ mode: { pin: '2026-07-28' } } as const) : ({ mode: 'legacy' } as const);
	const client = new Client({ name: `hf-mcp-${expectedEra}-http-smoke`, version: '1.0.0' }, { versionNegotiation });
	const transport = new StreamableHTTPClientTransport(serverUrl);

	try {
		await client.connect(transport);

		const actualEra = client.getProtocolEra();
		if (actualEra !== expectedEra) {
			throw new Error(`Expected protocol era ${expectedEra}, connected using ${actualEra ?? 'unknown'}`);
		}

		const { tools } = await client.listTools();
		const selectedTool = tools.find((tool) => tool.name === toolName);
		if (!selectedTool) {
			throw new Error(
				`Tool ${toolName} is not advertised. Available tools: ${tools.map((tool) => tool.name).join(', ')}`
			);
		}

		const result = await client.callTool(
			{ name: toolName, arguments: toolArguments },
			{
				onprogress: (progress) => {
					progressMessages.push(progress);
					console.log(
						`[${expectedEra}] progress=${progress.progress}` +
							`${progress.total === undefined ? '' : `/${progress.total}`}` +
							`${progress.message ? ` ${progress.message}` : ''}`
					);
				},
				resetTimeoutOnProgress: true,
			}
		);

		if (result.isError === true) {
			throw new Error(`Tool ${toolName} returned an MCP error result: ${JSON.stringify(result.content)}`);
		}
		if (requireProgress && progressMessages.length === 0) {
			throw new Error(`Tool ${toolName} completed without a progress notification`);
		}
		for (let index = 1; index < progressMessages.length; index++) {
			const previous = progressMessages[index - 1];
			const current = progressMessages[index];
			if (previous && current && current.progress < previous.progress) {
				throw new Error(`Progress decreased from ${previous.progress} to ${current.progress}`);
			}
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					url: serverUrl.toString(),
					era: actualEra,
					tools: tools.length,
					tool: toolName,
					progressNotifications: progressMessages.length,
					resultContentTypes: result.content.map((content) => content.type),
				},
				null,
				2
			)
		);
	} finally {
		await client.close().catch(() => {
			// Preserve the original smoke-test failure.
		});
	}
}
