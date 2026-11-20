import type { McpServer, ServerCapabilities } from '@modelcontextprotocol/server';

interface RegisterCapabilitiesOptions {
	/**
	 * Whether resources have been registered on the server
	 * If true, the resources capability will be included
	 */
	hasResources?: boolean;
	/**
	 * Whether the experimental Skills extension (SEP-2640) is active.
	 * When true, the `resources` capability is forced on and the
	 * `extensions["io.modelcontextprotocol/skills"]` flag is advertised.
	 */
	hasSkills?: boolean;
	/**
	 * Whether the experimental Events extension (SEP-3415) is active.
	 */
	hasEvents?: boolean;
}

/**
 * Registers MCP capabilities on a server instance
 *
 * This utility function handles:
 * - Configuring tools and resources capabilities
 * @param server - The McpServer instance to register capabilities on
 * @param options - Configuration options for capabilities
 */
export function registerCapabilities(server: McpServer, options: RegisterCapabilitiesOptions = {}): void {
	const { hasResources = false, hasSkills = false, hasEvents = false } = options;
	const advertiseResources = hasResources || hasSkills;

	const capabilities: ServerCapabilities = {
		tools: {
			listChanged: false,
		},
		...(advertiseResources
			? {
					resources: {
						// We do not support resource subscriptions (skills are static —
						// nothing to notify `resources/updated` about). Advertise explicitly
						// rather than relying on omission.
						subscribe: false,
						listChanged: false,
					},
				}
			: {}),
		...(hasSkills || hasEvents
			? {
					extensions: {
						// SEP-2640 capability declaration. We implement the optional
						// `resources/directory/read` method, so advertise `directoryRead: true`.
						// The non-empty object also sidesteps the empty-object → `[]` JSON
						// serialization gotcha reported in experimental-ext-skills PR #95.
						...(hasSkills ? { 'io.modelcontextprotocol/skills': { directoryRead: true } } : {}),
						// SEP-3415 capability declaration. Event types are fixed per request.
						...(hasEvents ? { 'io.modelcontextprotocol/events': { listChanged: false } } : {}),
					},
				}
			: {}),
	};

	server.server.registerCapabilities(capabilities);
}
