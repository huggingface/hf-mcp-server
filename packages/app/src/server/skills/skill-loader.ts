import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { DIRECTORY_MIME, mimeFor } from './skill-uri.js';
import type {
	ReadableSkillFile,
	SkillCatalog,
	SkillDirChild,
	SkillEntry,
	SkillFrontmatter,
	SkillManifestResource,
} from './skill-types.js';

const MANIFEST_FILE = 'skills.json';
const SKILL_MD = 'SKILL.md';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FRONTMATTER_RE = /^---[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[^\S\r\n]*(?:\r?\n|$)/u;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_SKILLS = 1_000;
const MAX_RESOURCES = 10_000;
const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

interface RawManifest {
	skills?: unknown;
}

interface RawEntry {
	uri?: unknown;
	frontmatter?: unknown;
	resources?: unknown;
}

interface RawResource {
	uri?: unknown;
	digest?: unknown;
}

interface ResolvedSkillUri {
	uri: string;
	encodedParts: string[];
	decodedParts: string[];
	absPath: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function parseSkillUri(rootDir: string, uri: string): ResolvedSkillUri {
	if (!uri.startsWith('skill://') || uri.includes('?') || uri.includes('#')) {
		throw new Error(`invalid skill resource URI: ${uri}`);
	}

	const encodedParts = uri.slice('skill://'.length).split('/');
	if (encodedParts.length < 2 || encodedParts.some((part) => part.length === 0)) {
		throw new Error(`invalid skill resource URI: ${uri}`);
	}

	let decodedParts: string[];
	try {
		decodedParts = encodedParts.map((part) => decodeURIComponent(part));
	} catch {
		throw new Error(`invalid percent encoding in skill resource URI: ${uri}`);
	}

	if (
		decodedParts.some(
			(part) =>
				part.length === 0 ||
				part === '.' ||
				part === '..' ||
				part.includes('/') ||
				part.includes('\\') ||
				part.includes('\0') ||
				path.isAbsolute(part)
		)
	) {
		throw new Error(`unsafe skill resource URI: ${uri}`);
	}

	const absRoot = path.resolve(rootDir);
	const absPath = path.resolve(absRoot, ...decodedParts);
	const relative = path.relative(absRoot, absPath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`skill resource escapes distribution root: ${uri}`);
	}

	return { uri, encodedParts, decodedParts, absPath };
}

async function readRegularFile(
	rootDir: string,
	absPath: string,
	uri: string,
	retainedBytes: { value: number }
): Promise<Buffer> {
	const stat = await fs.lstat(absPath).catch(() => null);
	if (!stat?.isFile() || stat.isSymbolicLink()) {
		throw new Error(`skill resource is missing or is not a regular file: ${uri}`);
	}
	if (stat.size > MAX_RESOURCE_BYTES) {
		throw new Error(`skill resource exceeds the maximum file size: ${uri}`);
	}
	if (retainedBytes.value + stat.size > MAX_SNAPSHOT_BYTES) {
		throw new Error('skills snapshot exceeds the maximum retained size');
	}
	const [realRoot, realFile] = await Promise.all([fs.realpath(rootDir), fs.realpath(absPath)]);
	const relative = path.relative(realRoot, realFile);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`skill resource resolves outside distribution root: ${uri}`);
	}
	const bytes = await fs.readFile(absPath);
	retainedBytes.value += bytes.length;
	return bytes;
}

async function discoverPublishedFiles(absDir: string): Promise<Set<string>> {
	const discovered = new Set<string>();
	const visit = async (directory: string): Promise<void> => {
		const dirents = await fs.readdir(directory, { withFileTypes: true });
		for (const dirent of dirents) {
			const child = path.join(directory, dirent.name);
			if (dirent.isSymbolicLink()) throw new Error(`published skill contains a symlink: ${child}`);
			if (dirent.isDirectory()) {
				await visit(child);
			} else if (dirent.isFile()) {
				discovered.add(path.resolve(child));
			} else {
				throw new Error(`published skill contains a non-regular path: ${child}`);
			}
		}
	};
	await visit(absDir);
	return discovered;
}

function parseActualFrontmatter(bytes: Buffer, uri: string): SkillFrontmatter {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${uri} is not valid UTF-8`);
	}

	const match = FRONTMATTER_RE.exec(text);
	if (!match?.[1]) {
		throw new Error(`${uri} must begin with YAML frontmatter`);
	}

	const document = parseDocument(match[1], { uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new Error(`${uri} has invalid YAML frontmatter: ${document.errors[0]?.message ?? 'unknown error'}`);
	}

	const value = document.toJSON();
	if (!isPlainObject(value)) {
		throw new Error(`${uri} frontmatter must be a mapping`);
	}

	// Ensure the parsed YAML can be represented by the JSON form used in skills.json.
	try {
		JSON.stringify(value);
	} catch {
		throw new Error(`${uri} frontmatter is not JSON-compatible`);
	}
	return value as SkillFrontmatter;
}

function validateFrontmatter(value: unknown, skillName: string, uri: string): SkillFrontmatter {
	if (!isPlainObject(value)) throw new Error(`${uri} frontmatter must be an object`);

	const { name, description, license, compatibility, metadata } = value;
	if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME_RE.test(name) || name !== skillName) {
		throw new Error(`${uri} has an invalid or mismatched frontmatter name`);
	}
	if (typeof description !== 'string' || description.length === 0 || description.length > 1024) {
		throw new Error(`${uri} has an invalid frontmatter description`);
	}
	if (license !== undefined && typeof license !== 'string') {
		throw new Error(`${uri} has a non-string frontmatter license`);
	}
	if (
		compatibility !== undefined &&
		(typeof compatibility !== 'string' || compatibility.length === 0 || compatibility.length > 500)
	) {
		throw new Error(`${uri} has invalid frontmatter compatibility`);
	}
	if (
		metadata !== undefined &&
		(!isPlainObject(metadata) || Object.values(metadata).some((item) => typeof item !== 'string'))
	) {
		throw new Error(`${uri} frontmatter metadata must map string keys to string values`);
	}
	if (value['allowed-tools'] !== undefined && typeof value['allowed-tools'] !== 'string') {
		throw new Error(`${uri} has invalid frontmatter allowed-tools`);
	}
	return value as SkillFrontmatter;
}

function parseManifestResource(
	raw: unknown,
	rootDir: string
): { manifest: SkillManifestResource; resolved: ResolvedSkillUri } {
	if (!isPlainObject(raw)) throw new Error('skill resource manifest entry must be an object');
	const resource = raw as RawResource;
	if (typeof resource.uri !== 'string' || typeof resource.digest !== 'string' || !DIGEST_RE.test(resource.digest)) {
		throw new Error('skill resource manifest entry must contain a valid uri and SHA-256 digest');
	}
	return {
		manifest: { uri: resource.uri, digest: resource.digest },
		resolved: parseSkillUri(rootDir, resource.uri),
	};
}

function addDirectoryChildren(
	directories: Map<string, Map<string, SkillDirChild>>,
	entryUri: string,
	resource: ReadableSkillFile
): void {
	const rootUri = entryUri.slice(0, -`/${SKILL_MD}`.length);
	if (!resource.uri.startsWith(`${rootUri}/`)) {
		throw new Error(`resource ${resource.uri} is outside skill root ${rootUri}`);
	}

	const relativeEncodedParts = resource.uri.slice(rootUri.length + 1).split('/');
	let parentUri = rootUri;
	for (let index = 0; index < relativeEncodedParts.length; index += 1) {
		const encodedPart = relativeEncodedParts[index];
		if (encodedPart === undefined) continue;
		const childUri = `${parentUri}/${encodedPart}`;
		const isFile = index === relativeEncodedParts.length - 1;
		const child: SkillDirChild = {
			uri: childUri,
			name: decodeURIComponent(encodedPart),
			mimeType: isFile ? resource.mimeType : DIRECTORY_MIME,
		};
		const children = directories.get(parentUri) ?? new Map<string, SkillDirChild>();
		children.set(childUri, child);
		directories.set(parentUri, children);
		if (!isFile) {
			if (!directories.has(childUri)) directories.set(childUri, new Map());
			parentUri = childUri;
		}
	}
}

async function loadEntry(
	rootDir: string,
	raw: unknown,
	resourcesByUri: Map<string, ReadableSkillFile>,
	directoryChildren: Map<string, Map<string, SkillDirChild>>,
	retainedBytes: { value: number },
	resourceCount: { value: number }
): Promise<SkillEntry> {
	if (!isPlainObject(raw)) throw new Error('skill entry must be an object');
	const rawEntry = raw as RawEntry;
	if (typeof rawEntry.uri !== 'string' || !Array.isArray(rawEntry.resources)) {
		throw new Error('skill entry must contain uri, frontmatter, and resources');
	}
	resourceCount.value += rawEntry.resources.length;
	if (resourceCount.value > MAX_RESOURCES) {
		throw new Error('skills manifest exceeds the maximum resource count');
	}

	const resolvedEntry = parseSkillUri(rootDir, rawEntry.uri);
	if (resolvedEntry.decodedParts.at(-1) !== SKILL_MD || resolvedEntry.decodedParts.length < 2) {
		throw new Error(`skill entry URI must identify SKILL.md: ${rawEntry.uri}`);
	}
	const skillName = resolvedEntry.decodedParts.at(-2);
	if (!skillName) throw new Error(`skill entry URI has no skill name: ${rawEntry.uri}`);
	const frontmatter = validateFrontmatter(rawEntry.frontmatter, skillName, rawEntry.uri);
	const skillRootParts = resolvedEntry.decodedParts.slice(0, -1);
	const skillPath = skillRootParts.join('/');

	const manifests: SkillManifestResource[] = [];
	const seen = new Set<string>();
	const manifestPaths = new Set<string>();
	const loadedForEntry: ReadableSkillFile[] = [];
	for (const rawResource of rawEntry.resources) {
		const { manifest, resolved } = parseManifestResource(rawResource, rootDir);
		if (seen.has(manifest.uri)) throw new Error(`duplicate skill resource URI: ${manifest.uri}`);
		seen.add(manifest.uri);

		if (
			resolved.decodedParts.length <= skillRootParts.length ||
			skillRootParts.some((part, index) => resolved.decodedParts[index] !== part)
		) {
			throw new Error(`resource ${manifest.uri} is outside skill ${rawEntry.uri}`);
		}

		const resolvedPath = path.resolve(resolved.absPath);
		if (manifestPaths.has(resolvedPath)) {
			throw new Error(`multiple resource URIs resolve to the same file: ${manifest.uri}`);
		}
		manifestPaths.add(resolvedPath);

		const existing = resourcesByUri.get(manifest.uri);
		const bytes = existing?.bytes ?? (await readRegularFile(rootDir, resolved.absPath, manifest.uri, retainedBytes));
		const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
		if (actualDigest !== manifest.digest) {
			throw new Error(`digest mismatch for skill resource ${manifest.uri}`);
		}

		const relativePath = resolved.decodedParts.slice(skillRootParts.length).join('/');
		const { mimeType, isText: expectedText } = mimeFor(relativePath);
		let isText = expectedText;
		if (isText) {
			try {
				new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			} catch {
				isText = false;
			}
		}
		const isSkillMd = manifest.uri === rawEntry.uri;
		const file: ReadableSkillFile = {
			uri: manifest.uri,
			bytes,
			mimeType,
			isText,
			name: isSkillMd ? frontmatter.name : (resolved.decodedParts.at(-1) ?? manifest.uri),
			description: isSkillMd ? frontmatter.description : undefined,
			digest: manifest.digest,
		};

		if (existing && (existing.digest !== file.digest || !existing.bytes.equals(file.bytes))) {
			throw new Error(`conflicting duplicate skill resource URI: ${file.uri}`);
		}
		resourcesByUri.set(file.uri, existing ?? file);
		loadedForEntry.push(existing ?? file);
		manifests.push(manifest);
	}

	if (!seen.has(rawEntry.uri)) {
		throw new Error(`skill manifest does not include its SKILL.md: ${rawEntry.uri}`);
	}
	const publishedFiles = await discoverPublishedFiles(path.dirname(resolvedEntry.absPath));
	if (
		publishedFiles.size !== manifestPaths.size ||
		[...publishedFiles].some((publishedPath) => !manifestPaths.has(publishedPath))
	) {
		throw new Error(`resource manifest is incomplete for ${rawEntry.uri}`);
	}
	const skillMd = resourcesByUri.get(rawEntry.uri);
	if (!skillMd) throw new Error(`missing loaded SKILL.md: ${rawEntry.uri}`);
	const actualFrontmatter = parseActualFrontmatter(skillMd.bytes, rawEntry.uri);
	if (!isDeepStrictEqual(actualFrontmatter, frontmatter)) {
		throw new Error(`frontmatter mismatch for ${rawEntry.uri}`);
	}

	for (const file of loadedForEntry) addDirectoryChildren(directoryChildren, rawEntry.uri, file);
	return { uri: rawEntry.uri, frontmatter, resources: manifests, skillPath };
}

export async function loadSkills(rootDir: string, loadedAt = Date.now()): Promise<SkillCatalog> {
	const manifestPath = path.join(rootDir, MANIFEST_FILE);
	const manifestStat = await fs.lstat(manifestPath);
	if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
		throw new Error(`${manifestPath} is not a regular manifest or exceeds the maximum size`);
	}
	const manifestText = await fs.readFile(manifestPath, 'utf8');
	const parsed = JSON.parse(manifestText) as RawManifest;
	if (!isPlainObject(parsed) || !Array.isArray(parsed.skills)) {
		throw new Error(`${manifestPath} must contain a skills array`);
	}
	if (parsed.skills.length > MAX_SKILLS) {
		throw new Error(`${manifestPath} exceeds the maximum skill count`);
	}

	const resourcesByUri = new Map<string, ReadableSkillFile>();
	const directoryChildren = new Map<string, Map<string, SkillDirChild>>();
	const entries: SkillEntry[] = [];
	const entriesByUri = new Map<string, SkillEntry>();
	const retainedBytes = { value: 0 };
	const resourceCount = { value: 0 };

	for (const raw of parsed.skills) {
		const entry = await loadEntry(rootDir, raw, resourcesByUri, directoryChildren, retainedBytes, resourceCount);
		if (entriesByUri.has(entry.uri)) throw new Error(`duplicate skill entry URI: ${entry.uri}`);
		entries.push(entry);
		entriesByUri.set(entry.uri, entry);
	}

	const directories = new Map<string, SkillDirChild[]>();
	for (const [uri, children] of directoryChildren) {
		directories.set(
			uri,
			[...children.values()].sort(
				(left, right) => left.name.localeCompare(right.name) || left.uri.localeCompare(right.uri)
			)
		);
	}

	return { manifestPath, loadedAt, entries, entriesByUri, resourcesByUri, directories };
}
