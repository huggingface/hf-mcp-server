// Clients on this denylist are not offered MCP resources (the Skills surface):
// the server advertises no `resources` capability / skills extension to them and
// routes resource methods to the stub responder. This mitigates clients that
// flood the server against the resource surface — notably `cursor-vscode`, which
// retry-loops `resources/subscribe` regardless of advertised capabilities.

export const DEFAULT_DENIED_CLIENTS = ['cursor-vscode'] as const;

// Comma-separated. When set (even empty) it REPLACES the default list, so ops can
// disable the denylist entirely (`MCP_RESOURCES_CLIENT_DENYLIST=`) or customise it
// (`MCP_RESOURCES_CLIENT_DENYLIST=cursor-vscode,foo`). Unset uses the default.
export const RESOURCES_CLIENT_DENYLIST_ENV = 'MCP_RESOURCES_CLIENT_DENYLIST' as const;

export function getDeniedClients(): string[] {
	const raw = process.env[RESOURCES_CLIENT_DENYLIST_ENV];
	const source = raw === undefined ? DEFAULT_DENIED_CLIENTS.join(',') : raw;
	return source
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

/**
 * Whether a client should be denied the resources surface. Matches the denylist
 * entries as case-insensitive substrings against both the MCP `clientInfo.name`
 * and the HTTP `user-agent` (catches e.g. `cursor-vscode (via mcp-remote 0.1.37)`).
 */
export function isClientDenied(clientName?: string, userAgent?: string): boolean {
	const needles = getDeniedClients();
	if (needles.length === 0) return false;
	const haystack = `${clientName ?? ''}\n${userAgent ?? ''}`.toLowerCase();
	return needles.some((needle) => haystack.includes(needle));
}
