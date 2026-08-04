import { ProtocolError, ProtocolErrorCode, type McpServer, type ServerResult } from '@modelcontextprotocol/server';
import { logger } from '../utils/logger.js';
import type { ReadableSkillFile, SkillCatalog } from './skill-types.js';
import { getSkill, listSkillResources, listSkills, readSkillDirectory, readSkillFile } from './skill-resource-data.js';
import { RESOURCES_DIRECTORY_READ_METHOD, ResourcesDirectoryReadParamsSchema } from './skill-directory-schema.js';
import {
	SKILLS_GET_METHOD,
	SKILLS_LIST_METHOD,
	SkillsGetParamsSchema,
	SkillsListParamsSchema,
} from './skill-method-schema.js';

interface RegisterSkillResourcesOptions {
	protocolVersion?: string;
	ttlMs: number;
}

function isCacheAwareProtocol(protocolVersion: string | undefined): boolean {
	return protocolVersion !== undefined && protocolVersion >= '2026-07-28';
}

function registerReadable(server: McpServer, file: ReadableSkillFile, ttlMs: number): void {
	server.registerResource(
		file.name,
		file.uri,
		{
			...(file.description ? { description: file.description } : {}),
			mimeType: file.mimeType,
			cacheHint: { ttlMs, cacheScope: 'public' },
		},
		async () => ({ contents: [readSkillFile(file)] })
	);
}

export function registerSkillResources(
	server: McpServer,
	catalog: SkillCatalog,
	options: RegisterSkillResourcesOptions
): void {
	for (const file of catalog.resourcesByUri.values()) {
		registerReadable(server, file, options.ttlMs);
	}

	server.server.setRequestHandler(
		SKILLS_LIST_METHOD,
		{ params: SkillsListParamsSchema },
		({ cursor }): ServerResult => {
			const result = listSkills(catalog, cursor);
			if (!result) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid skills/list cursor: ${cursor ?? ''}`);
			}
			return {
				...result,
				...(isCacheAwareProtocol(options.protocolVersion)
					? { ttlMs: options.ttlMs, cacheScope: 'public' as const }
					: {}),
			} as ServerResult;
		}
	);

	server.server.setRequestHandler(SKILLS_GET_METHOD, { params: SkillsGetParamsSchema }, ({ uri }): ServerResult => {
		const skill = getSkill(catalog, uri);
		if (!skill) {
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${uri}`);
		}
		return { skill } as ServerResult;
	});

	server.server.setRequestHandler(
		RESOURCES_DIRECTORY_READ_METHOD,
		{ params: ResourcesDirectoryReadParamsSchema },
		({ uri, cursor }): ServerResult => {
			const listing = readSkillDirectory(catalog, uri, cursor);
			if (!listing) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Not a directory resource: ${uri}`);
			}
			return listing as ServerResult;
		}
	);

	logger.info(
		{ skills: catalog.entries.length, resources: listSkillResources(catalog).length },
		'registered skill resources'
	);
}
