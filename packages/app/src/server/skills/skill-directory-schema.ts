import { z } from 'zod';

// `resources/directory/read` (SEP-2640, WG decision 2026-06-09). The MCP SDK at ^1.29.0
// has no built-in schema for this extension method, so we define the request shape locally
// and register it via `server.server.setRequestHandler`. The result reuses the
// `resources/list` shape (an array of Resource + optional `nextCursor`).
export const RESOURCES_DIRECTORY_READ_METHOD = 'resources/directory/read';

export const ResourcesDirectoryReadRequestSchema = z
	.object({
		method: z.literal(RESOURCES_DIRECTORY_READ_METHOD),
		params: z
			.object({
				uri: z.string(),
				cursor: z.string().optional(),
			})
			.passthrough(),
	})
	.passthrough();
