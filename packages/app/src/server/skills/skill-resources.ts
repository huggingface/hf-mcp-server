import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import type { ReadableSkillFile, SkillCatalog } from './skill-types.js';
import { listSkillResources, readSkillDirectory, readSkillFile, SKILL_INDEX_URI } from './skill-resource-data.js';
import { ResourcesDirectoryReadRequestSchema } from './skill-directory-schema.js';

function registerReadable(server: McpServer, name: string, file: ReadableSkillFile, description?: string): void {
	server.registerResource(
		name,
		file.url,
		description ? { description, mimeType: file.mimeType } : { mimeType: file.mimeType },
		async () => {
			const content = await readSkillFile(file);
			return { contents: [content] };
		},
	);
}

export function registerSkillResources(server: McpServer, catalog: SkillCatalog): void {
	for (const entry of catalog.entries) {
		for (const file of entry.files) {
			registerReadable(server, file.name, file, file.description);
		}
		for (const archive of entry.archives) {
			registerReadable(server, archive.name, archive);
		}
	}

	server.registerResource(
		'Skills Index',
		SKILL_INDEX_URI,
		{
			description: 'Catalog of skills exposed by this server (SEP-2640 index).',
			mimeType: 'application/json',
		},
		async () => ({
			contents: [{ uri: SKILL_INDEX_URI, mimeType: 'application/json', text: catalog.indexText }],
		}),
	);

	// SEP-2640 `resources/directory/read`: list the direct children of a directory resource.
	server.server.setRequestHandler(ResourcesDirectoryReadRequestSchema, (request): ServerResult => {
		const { uri, cursor } = request.params;
		const listing = readSkillDirectory(catalog, uri, cursor);
		if (!listing) {
			throw new McpError(ErrorCode.InvalidParams, `Not a directory resource: ${uri}`);
		}
		return listing as ServerResult;
	});

	const resources = listSkillResources(catalog).length;
	logger.info({ skills: catalog.entries.length, resources }, 'registered skill resources');
}
