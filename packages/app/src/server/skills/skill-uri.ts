import path from 'node:path';

const TEXT_MIME_BY_EXT: Record<string, string> = {
	'.md': 'text/markdown',
	'.markdown': 'text/markdown',
	'.txt': 'text/plain',
	'.json': 'application/json',
	'.yaml': 'application/yaml',
	'.yml': 'application/yaml',
	'.py': 'text/x-python',
	'.sh': 'application/x-sh',
	'.js': 'text/javascript',
	'.ts': 'text/x-typescript',
	'.tsx': 'text/x-typescript',
	'.jsx': 'text/javascript',
	'.html': 'text/html',
	'.css': 'text/css',
	'.csv': 'text/csv',
	'.toml': 'application/toml',
	'.xml': 'application/xml',
};

const BINARY_MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.tar': 'application/x-tar',
	'.gz': 'application/gzip',
	'.tgz': 'application/gzip',
};

export function mimeFor(relPath: string): { mimeType: string; isText: boolean } {
	const ext = path.extname(relPath).toLowerCase();
	const baseLower = path.basename(relPath).toLowerCase();
	if (baseLower === 'license' || baseLower === 'license.txt') {
		return { mimeType: 'text/plain', isText: true };
	}
	if (TEXT_MIME_BY_EXT[ext]) {
		return { mimeType: TEXT_MIME_BY_EXT[ext], isText: true };
	}
	if (BINARY_MIME_BY_EXT[ext]) {
		return { mimeType: BINARY_MIME_BY_EXT[ext], isText: false };
	}
	return { mimeType: 'application/octet-stream', isText: false };
}

/** mimeType marking a directory resource (per SEP-2640 `resources/directory/read`). */
export const DIRECTORY_MIME = 'inode/directory';

function encodeSegments(value: string): string {
	return value
		.replaceAll('\\', '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.map(encodeURIComponent)
		.join('/');
}

/**
 * Build a `skill://` resource URI. `skillPath` may be a single segment (`git-workflow`)
 * or nested (`acme/billing/refunds`); `relPath` is the file path relative to the skill
 * directory root. Each segment is URL-encoded individually.
 */
export function buildSkillUri(skillPath: string, relPath: string): string {
	const encodedSkill = encodeSegments(skillPath);
	const encodedPath = encodeSegments(relPath);
	return `skill://${encodedSkill}/${encodedPath}`;
}

/**
 * Build a directory resource URI (no trailing slash). `relDir` is the directory path
 * relative to the skill root; an empty `relDir` yields the skill root directory URI.
 */
export function buildSkillDirUri(skillPath: string, relDir: string): string {
	const encodedSkill = encodeSegments(skillPath);
	const encodedDir = encodeSegments(relDir);
	return encodedDir ? `skill://${encodedSkill}/${encodedDir}` : `skill://${encodedSkill}`;
}
