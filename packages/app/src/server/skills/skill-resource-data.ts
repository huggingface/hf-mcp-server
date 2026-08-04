import type { ReadableSkillFile, SkillCatalog, SkillEntry, SkillProtocolEntry } from './skill-types.js';

const DIR_PAGE_SIZE = 500;
const SKILLS_PAGE_SIZE = 100;

interface ListedSkillResource {
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
	(BaseSkillResourceContent & { text: string }) | (BaseSkillResourceContent & { blob: string });

interface SkillDirectoryListing {
	resources: { uri: string; name: string; mimeType: string }[];
	nextCursor?: string;
}

export interface SkillListResult {
	skills: SkillProtocolEntry[];
	nextCursor?: string;
}

export function toProtocolEntry(entry: SkillEntry): SkillProtocolEntry {
	return {
		uri: entry.uri,
		frontmatter: entry.frontmatter,
		resources: entry.resources,
	};
}

/** Generic MCP resource enumeration. Skill discovery itself uses `skills/list`. */
export function listSkillResources(catalog: SkillCatalog): ListedSkillResource[] {
	return [...catalog.resourcesByUri.values()].map((file) => ({
		uri: file.uri,
		name: file.name,
		description: file.description,
		mimeType: file.mimeType,
	}));
}

export function readSkillResource(catalog: SkillCatalog, uri: string): SkillResourceContent | null {
	const file = catalog.resourcesByUri.get(uri);
	return file ? readSkillFile(file) : null;
}

export function readSkillFile(file: ReadableSkillFile): SkillResourceContent {
	return file.isText
		? { uri: file.uri, mimeType: file.mimeType, text: file.bytes.toString('utf8') }
		: { uri: file.uri, mimeType: file.mimeType, blob: file.bytes.toString('base64') };
}

function decodeCursor(cursor: string | undefined): number | null {
	if (cursor === undefined) return 0;
	if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) return null;
	const offset = Number(cursor);
	return Number.isSafeInteger(offset) ? offset : null;
}

export function listSkills(
	catalog: SkillCatalog,
	cursor?: string,
	pageSize: number = SKILLS_PAGE_SIZE
): SkillListResult | null {
	const offset = decodeCursor(cursor);
	if (offset === null || offset > catalog.entries.length) return null;

	const page = catalog.entries.slice(offset, offset + pageSize);
	const nextOffset = offset + page.length;
	return {
		skills: page.map(toProtocolEntry),
		...(nextOffset < catalog.entries.length ? { nextCursor: String(nextOffset) } : {}),
	};
}

export function getSkill(catalog: SkillCatalog, uri: string): SkillProtocolEntry | null {
	const entry = catalog.entriesByUri.get(uri);
	return entry ? toProtocolEntry(entry) : null;
}

export function readSkillDirectory(
	catalog: SkillCatalog,
	uri: string,
	cursor?: string,
	pageSize: number = DIR_PAGE_SIZE
): SkillDirectoryListing | null {
	const normalised = uri.endsWith('/') ? uri.slice(0, -1) : uri;
	const children = catalog.directories.get(normalised);
	if (!children) return null;

	const offset = decodeCursor(cursor);
	if (offset === null || offset > children.length) return null;

	const page = children.slice(offset, offset + pageSize);
	const nextOffset = offset + page.length;
	return {
		resources: page.map((child) => ({ uri: child.uri, name: child.name, mimeType: child.mimeType })),
		...(nextOffset < children.length ? { nextCursor: String(nextOffset) } : {}),
	};
}
