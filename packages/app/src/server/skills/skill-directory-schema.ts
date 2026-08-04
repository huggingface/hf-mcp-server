import { z } from 'zod';

// `resources/directory/read` from draft SEP-2640. The MCP SDK has no built-in
// schema for this extension method, so we define the request shape locally
// and register it via `server.server.setRequestHandler`. The result reuses the
// `resources/list` shape (an array of Resource + optional `nextCursor`).
export const RESOURCES_DIRECTORY_READ_METHOD = 'resources/directory/read';

export const ResourcesDirectoryReadParamsSchema = z.looseObject({
	uri: z.string(),
	cursor: z.string().optional(),
});
