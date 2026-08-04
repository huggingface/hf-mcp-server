export const DISABLE_TOOLS_ENV = 'DISABLE_TOOLS';

export function parseDisabledTools(value: string | undefined = process.env[DISABLE_TOOLS_ENV]): ReadonlySet<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean)
	);
}

export function disabledToolCallName(request: unknown, disabledTools = parseDisabledTools()): string | undefined {
	const body = request as { method?: unknown; params?: { name?: unknown } } | null;
	const name = body?.method === 'tools/call' ? body.params?.name : undefined;
	return typeof name === 'string' && disabledTools.has(name) ? name : undefined;
}

export function disabledToolMessage(name: string): string {
	return `Tool ${name} is disabled by server configuration`;
}
