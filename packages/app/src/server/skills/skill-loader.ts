import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { buildSkillDirUri, buildSkillUri, DIRECTORY_MIME, mimeFor } from './skill-uri.js';
import type {
	ReadableSkillFile,
	SkillArchive,
	SkillCatalog,
	SkillDirChild,
	SkillEntry,
	SkillFrontmatter,
	SkillResource,
} from './skill-types.js';

const INDEX_FILE = 'index.json';
const SKILL_MD = 'SKILL.md';

// New-format index entry (SEP-2640, WG decision 2026-06-05): verbatim `frontmatter`,
// optional `url` + `digest`, and a per-skill `archives[]` array.
interface IndexEntry {
	frontmatter?: unknown;
	url?: unknown;
	digest?: unknown;
	archives?: unknown;
}

interface ArchiveEntry {
	url?: unknown;
	mimeType?: unknown;
	digest?: unknown;
}

interface IndexJson {
	skills?: unknown;
}

function emptyCatalog(indexPath: string, indexText = ''): SkillCatalog {
	return { indexPath, indexText, entries: [], resourcesByUri: new Map(), directories: new Map() };
}

function parseFrontmatter(value: unknown): SkillFrontmatter | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const fm = value as Record<string, unknown>;
	if (typeof fm.name !== 'string' || typeof fm.description !== 'string') return null;
	return fm as SkillFrontmatter;
}

/** Resolve a `skill://` URL to an on-disk path, rejecting traversal outside `rootDir`. */
function resolveSkillUrl(rootDir: string, url: string): { absPath: string; relPath: string } | null {
	const prefix = 'skill://';
	if (!url.startsWith(prefix) || url.includes('?') || url.includes('#')) {
		return null;
	}

	const encodedPath = url.slice(prefix.length);
	if (!encodedPath) return null;

	let parts: string[];
	try {
		parts = encodedPath.split('/').map((part) => decodeURIComponent(part));
	} catch {
		return null;
	}

	if (parts.some((part) => !part || part === '.' || part === '..' || path.isAbsolute(part))) {
		return null;
	}

	const absRoot = path.resolve(rootDir);
	const absPath = path.resolve(absRoot, ...parts);
	const relative = path.relative(absRoot, absPath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return null;
	}

	return { absPath, relPath: parts.join('/') };
}

async function isRegularFile(absPath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(absPath);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Recursively walk a skill directory, collecting individually-addressable file resources
 * and recording each directory's direct children for `resources/directory/read`.
 * Symlinks are skipped (matching the resolve-time guard) so a skill cannot point outside
 * its own directory.
 */
async function walkSkillDir(
	skillPath: string,
	absDir: string,
	relDir: string,
	frontmatter: SkillFrontmatter,
	files: SkillResource[],
	directories: Map<string, SkillDirChild[]>,
): Promise<void> {
	const dirUri = buildSkillDirUri(skillPath, relDir);
	const children: SkillDirChild[] = [];

	let dirents: Dirent[];
	try {
		dirents = await fs.readdir(absDir, { withFileTypes: true });
	} catch (err) {
		logger.warn({ absDir, err }, 'failed to read skill directory, skipping contents');
		directories.set(dirUri, children);
		return;
	}

	dirents.sort((a, b) => a.name.localeCompare(b.name));

	for (const dirent of dirents) {
		if (dirent.isSymbolicLink()) {
			logger.warn({ dir: absDir, name: dirent.name }, 'skipping symlink in skill directory');
			continue;
		}
		const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
		if (dirent.isDirectory()) {
			children.push({ uri: buildSkillDirUri(skillPath, childRel), name: dirent.name, mimeType: DIRECTORY_MIME });
			await walkSkillDir(skillPath, path.join(absDir, dirent.name), childRel, frontmatter, files, directories);
		} else if (dirent.isFile()) {
			const url = buildSkillUri(skillPath, childRel);
			const { mimeType, isText } = mimeFor(childRel);
			const isSkillMd = childRel === SKILL_MD;
			files.push({
				url,
				absPath: path.join(absDir, dirent.name),
				mimeType,
				isText,
				name: isSkillMd ? frontmatter.name : dirent.name,
				description: isSkillMd ? frontmatter.description : undefined,
			});
			children.push({ uri: url, name: dirent.name, mimeType });
		}
	}

	directories.set(dirUri, children);
}

async function loadArchives(rootDir: string, raw: unknown): Promise<SkillArchive[]> {
	if (!Array.isArray(raw)) return [];
	const archives: SkillArchive[] = [];
	for (const item of raw as ArchiveEntry[]) {
		if (typeof item?.url !== 'string' || typeof item?.mimeType !== 'string') {
			logger.warn({ archive: item }, 'invalid archive entry, skipping');
			continue;
		}
		const resolved = resolveSkillUrl(rootDir, item.url);
		if (!resolved || !(await isRegularFile(resolved.absPath))) {
			logger.warn({ url: item.url }, 'archive resource missing or invalid, skipping');
			continue;
		}
		archives.push({
			url: item.url,
			absPath: resolved.absPath,
			mimeType: item.mimeType,
			isText: false,
			name: path.basename(resolved.relPath),
			digest: typeof item.digest === 'string' ? item.digest : undefined,
		});
	}
	return archives;
}

async function loadIndexEntry(
	rootDir: string,
	entry: IndexEntry,
	directories: Map<string, SkillDirChild[]>,
): Promise<SkillEntry | null> {
	const frontmatter = parseFrontmatter(entry.frontmatter);
	if (!frontmatter) {
		logger.warn({ entry }, 'skill index entry missing valid frontmatter (name/description), skipping');
		return null;
	}

	const hasUrl = typeof entry.url === 'string';
	const archives = await loadArchives(rootDir, entry.archives);

	if (!hasUrl && archives.length === 0) {
		logger.warn({ name: frontmatter.name }, 'skill index entry has neither a readable url nor archives, skipping');
		return null;
	}

	let skillMd: SkillEntry['skillMd'];
	let skillPath = frontmatter.name;
	const files: SkillResource[] = [];

	if (hasUrl) {
		const url = entry.url as string;
		const resolved = resolveSkillUrl(rootDir, url);
		if (!resolved) {
			logger.warn({ url }, 'invalid skill resource URL, skipping entry');
			return null;
		}
		const parts = resolved.relPath.split('/');
		if (parts.length < 2 || parts[parts.length - 1] !== SKILL_MD) {
			logger.warn({ url }, 'skill url must point to a SKILL.md, skipping entry');
			return null;
		}
		skillPath = parts.slice(0, -1).join('/');
		const finalSegment = parts[parts.length - 2];
		if (finalSegment !== frontmatter.name) {
			logger.warn(
				{ url, finalSegment, name: frontmatter.name },
				'final skill-path segment must equal frontmatter.name, skipping entry',
			);
			return null;
		}
		if (!(await isRegularFile(resolved.absPath))) {
			logger.warn({ path: resolved.absPath }, 'SKILL.md missing or not a regular file, skipping entry');
			return null;
		}
		if (typeof entry.digest !== 'string') {
			logger.warn({ url }, 'skill entry with url is missing a digest (recommended by SEP-2640)');
		}

		const absDir = path.dirname(resolved.absPath);
		await walkSkillDir(skillPath, absDir, '', frontmatter, files, directories);

		skillMd = { url, digest: typeof entry.digest === 'string' ? entry.digest : undefined };
	}

	return { skillPath, frontmatter, skillMd, files, archives };
}

export async function loadSkills(rootDir: string): Promise<SkillCatalog> {
	const indexPath = path.join(rootDir, INDEX_FILE);
	let indexText: string;
	try {
		indexText = await fs.readFile(indexPath, 'utf8');
	} catch (err) {
		logger.warn({ indexPath, err }, 'skills index not found, skills disabled');
		return emptyCatalog(indexPath);
	}

	let parsed: IndexJson;
	try {
		parsed = JSON.parse(indexText) as IndexJson;
	} catch (err) {
		logger.warn({ indexPath, err }, 'skills index is invalid JSON, skills disabled');
		return emptyCatalog(indexPath, indexText);
	}

	if (!Array.isArray(parsed.skills)) {
		logger.warn({ indexPath }, 'skills index missing skills array, skills disabled');
		return emptyCatalog(indexPath, indexText);
	}

	const entries: SkillEntry[] = [];
	const resourcesByUri = new Map<string, ReadableSkillFile>();
	const directories = new Map<string, SkillDirChild[]>();

	for (const raw of parsed.skills as IndexEntry[]) {
		const entry = await loadIndexEntry(rootDir, raw, directories);
		if (!entry) continue;

		const readables: ReadableSkillFile[] = [...entry.files, ...entry.archives];
		let conflict = false;
		for (const file of readables) {
			if (resourcesByUri.has(file.url)) {
				logger.warn({ url: file.url }, 'duplicate skill resource URL, skipping entry');
				conflict = true;
				break;
			}
		}
		if (conflict) continue;

		for (const file of readables) {
			resourcesByUri.set(file.url, file);
		}
		entries.push(entry);
	}

	logger.info({ rootDir, skills: entries.length, resources: resourcesByUri.size }, 'loaded skills');
	return { indexPath, indexText, entries, resourcesByUri, directories };
}
