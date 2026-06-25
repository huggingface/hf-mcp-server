import { describe, expect, it } from 'vitest';
import { buildSkillDirUri, buildSkillUri, DIRECTORY_MIME, mimeFor } from '../../src/server/skills/skill-uri.js';

describe('buildSkillUri', () => {
	it('produces a skill uri for a single file', () => {
		expect(buildSkillUri('my-skill', 'SKILL.md')).toBe('skill://my-skill/SKILL.md');
	});

	it('normalises backslashes to forward slashes', () => {
		expect(buildSkillUri('my-skill', 'assets\\diagram.png')).toBe('skill://my-skill/assets/diagram.png');
	});

	it('encodes skill names and path segments', () => {
		expect(buildSkillUri('my skill', 'assets/foo bar(1).png')).toBe('skill://my%20skill/assets/foo%20bar(1).png');
	});

	it('encodes each segment of a nested skill path', () => {
		expect(buildSkillUri('acme/billing/refunds', 'SKILL.md')).toBe('skill://acme/billing/refunds/SKILL.md');
	});
});

describe('buildSkillDirUri', () => {
	it('returns the skill root directory uri with no trailing slash', () => {
		expect(buildSkillDirUri('my-skill', '')).toBe('skill://my-skill');
		expect(buildSkillDirUri('acme/billing/refunds', '')).toBe('skill://acme/billing/refunds');
	});

	it('appends a relative directory path', () => {
		expect(buildSkillDirUri('my-skill', 'references')).toBe('skill://my-skill/references');
		expect(buildSkillDirUri('my-skill', 'templates/regional')).toBe('skill://my-skill/templates/regional');
	});

	it('exposes the directory mime constant', () => {
		expect(DIRECTORY_MIME).toBe('inode/directory');
	});
});

describe('mimeFor', () => {
	it('maps markdown as text', () => {
		expect(mimeFor('SKILL.md')).toEqual({ mimeType: 'text/markdown', isText: true });
	});

	it('maps python as text', () => {
		expect(mimeFor('scripts/run.py')).toEqual({ mimeType: 'text/x-python', isText: true });
	});

	it('maps png as binary', () => {
		expect(mimeFor('assets/diagram.png')).toEqual({ mimeType: 'image/png', isText: false });
	});

	it('special-cases LICENSE files', () => {
		expect(mimeFor('LICENSE')).toEqual({ mimeType: 'text/plain', isText: true });
		expect(mimeFor('license.txt')).toEqual({ mimeType: 'text/plain', isText: true });
	});

	it('falls back to octet-stream for unknown extensions', () => {
		expect(mimeFor('mystery.xyz')).toEqual({ mimeType: 'application/octet-stream', isText: false });
	});

	it('handles uppercase extensions', () => {
		expect(mimeFor('NOTES.MD')).toEqual({ mimeType: 'text/markdown', isText: true });
	});
});
