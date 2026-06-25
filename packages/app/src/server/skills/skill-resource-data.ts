import fs from 'node:fs/promises';
import type { ReadableSkillFile, SkillCatalog } from './skill-types.js';

export const SKILL_INDEX_URI = 'skill://index.json';

// Default page size for `resources/directory/read`. Skill directories are small, so this
// is effectively a single page in practice; pagination is implemented for spec conformance.
const DIR_PAGE_SIZE = 500;

export interface ListedSkillResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

interface BaseSkillResourceContent {
	uri: string;
	mimeType: string;
}

export type SkillResourceContent =
	| (BaseSkillResourceContent & { text: string })
	| (BaseSkillResourceContent & { blob: string });

export interface SkillDirectoryListing {
	resources: { uri: string; name: string; mimeType: string }[];
	nextCursor?: string;
}

/** All readable file resources (skill files + archives) plus the index. Directories are
 * intentionally omitted — they are addressable via `resources/directory/read` but need not
 * appear in `resources/list`. */
export function listSkillResources(catalog: SkillCatalog): ListedSkillResource[] {
	const resources: ListedSkillResource[] = [];
	for (const entry of catalog.entries) {
		for (const file of entry.files) {
			resources.push({ uri: file.url, name: file.name, description: file.description, mimeType: file.mimeType });
		}
		for (const archive of entry.archives) {
			resources.push({ uri: archive.url, name: archive.name, mimeType: archive.mimeType });
		}
	}
	resources.push({
		uri: SKILL_INDEX_URI,
		name: 'Skills Index',
		description: 'Catalog of skills exposed by this server (SEP-2640 index).',
		mimeType: 'application/json',
	});
	return resources;
}

export async function readSkillResource(catalog: SkillCatalog, uri: string): Promise<SkillResourceContent | null> {
	if (uri === SKILL_INDEX_URI) {
		return { uri, mimeType: 'application/json', text: catalog.indexText };
	}

	const file = catalog.resourcesByUri.get(uri);
	if (!file) return null;

	return readSkillFile(file);
}

export async function readSkillFile(file: ReadableSkillFile): Promise<SkillResourceContent> {
	const buf = await fs.readFile(file.absPath);
	return file.isText
		? { uri: file.url, mimeType: file.mimeType, text: buf.toString('utf8') }
		: { uri: file.url, mimeType: file.mimeType, blob: buf.toString('base64') };
}

function decodeCursor(cursor: string | undefined): number | null {
	if (cursor === undefined) return 0;
	const offset = Number.parseInt(cursor, 10);
	if (!Number.isInteger(offset) || offset < 0) return null;
	return offset;
}

/**
 * List the direct children of a directory resource (`resources/directory/read`). Returns
 * `null` when the URI is not a known directory (caller maps that to JSON-RPC -32602).
 * `cursor` is an opaque offset following the `resources/list` pagination contract.
 */
export function readSkillDirectory(
	catalog: SkillCatalog,
	uri: string,
	cursor?: string,
	pageSize: number = DIR_PAGE_SIZE,
): SkillDirectoryListing | null {
	// Normalise away a trailing slash; directory URIs are stored without one.
	const normalised = uri.endsWith('/') ? uri.slice(0, -1) : uri;
	const children = catalog.directories.get(normalised);
	if (!children) return null;

	const offset = decodeCursor(cursor);
	if (offset === null) return null;

	const page = children.slice(offset, offset + pageSize);
	const nextOffset = offset + page.length;
	const listing: SkillDirectoryListing = {
		resources: page.map((child) => ({ uri: child.uri, name: child.name, mimeType: child.mimeType })),
	};
	if (nextOffset < children.length) {
		listing.nextCursor = String(nextOffset);
	}
	return listing;
}
