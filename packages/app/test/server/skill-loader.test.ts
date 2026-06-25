import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkills } from '../../src/server/skills/skill-loader.js';

let root: string;

async function writeIndex(skills: unknown[]): Promise<void> {
	await writeFile(path.join(root, 'index.json'), JSON.stringify({ skills }, null, 2), 'utf8');
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-loader-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('loadSkills', () => {
	it('loads a skill, walks its directory, and exposes supporting files as resources', async () => {
		await mkdir(path.join(root, 'alpha', 'references'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		await writeFile(path.join(root, 'alpha', 'references', 'guide.md'), '# guide\n', 'utf8');
		await writeFile(path.join(root, 'alpha.tar.gz'), Buffer.from([0x1f, 0x8b]));
		await writeIndex([
			{
				url: 'skill://alpha/SKILL.md',
				digest: 'sha256:abc',
				frontmatter: { name: 'alpha', description: 'first skill' },
				archives: [{ url: 'skill://alpha.tar.gz', mimeType: 'application/gzip', digest: 'sha256:arch' }],
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.indexPath).toBe(path.join(root, 'index.json'));
		expect(catalog.entries).toHaveLength(1);
		const entry = catalog.entries[0];
		expect(entry.skillPath).toBe('alpha');
		expect(entry.frontmatter).toEqual({ name: 'alpha', description: 'first skill' });
		expect(entry.skillMd).toEqual({ url: 'skill://alpha/SKILL.md', digest: 'sha256:abc' });

		// SKILL.md + the supporting file are both individually addressable.
		expect([...catalog.resourcesByUri.keys()].sort()).toEqual([
			'skill://alpha.tar.gz',
			'skill://alpha/SKILL.md',
			'skill://alpha/references/guide.md',
		]);

		const skillMd = catalog.resourcesByUri.get('skill://alpha/SKILL.md');
		expect(skillMd).toMatchObject({ mimeType: 'text/markdown', isText: true });

		const archive = catalog.resourcesByUri.get('skill://alpha.tar.gz');
		expect(archive).toMatchObject({ mimeType: 'application/gzip', isText: false });
	});

	it('records directory children for resources/directory/read', async () => {
		await mkdir(path.join(root, 'alpha', 'scripts'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		await writeFile(path.join(root, 'alpha', 'scripts', 'run.py'), 'print(1)\n', 'utf8');
		await writeIndex([
			{
				url: 'skill://alpha/SKILL.md',
				digest: 'sha256:abc',
				frontmatter: { name: 'alpha', description: 'first skill' },
			},
		]);

		const catalog = await loadSkills(root);

		const rootDir = catalog.directories.get('skill://alpha');
		expect(rootDir).toBeDefined();
		expect(rootDir).toContainEqual({ uri: 'skill://alpha/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown' });
		expect(rootDir).toContainEqual({ uri: 'skill://alpha/scripts', name: 'scripts', mimeType: 'inode/directory' });

		const scriptsDir = catalog.directories.get('skill://alpha/scripts');
		expect(scriptsDir).toEqual([{ uri: 'skill://alpha/scripts/run.py', name: 'run.py', mimeType: 'text/x-python' }]);
	});

	it('supports nested skill paths whose final segment equals frontmatter.name', async () => {
		await mkdir(path.join(root, 'acme', 'billing', 'refunds'), { recursive: true });
		await writeFile(path.join(root, 'acme', 'billing', 'refunds', 'SKILL.md'), '# refunds\n', 'utf8');
		await writeIndex([
			{
				url: 'skill://acme/billing/refunds/SKILL.md',
				digest: 'sha256:abc',
				frontmatter: { name: 'refunds', description: 'process refunds' },
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.entries[0].skillPath).toBe('acme/billing/refunds');
		expect(catalog.resourcesByUri.has('skill://acme/billing/refunds/SKILL.md')).toBe(true);
		expect(catalog.directories.has('skill://acme/billing/refunds')).toBe(true);
	});

	it('loads an archive-only skill (no url)', async () => {
		await writeFile(path.join(root, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b]));
		await writeIndex([
			{
				frontmatter: { name: 'beta', description: 'archive only' },
				archives: [{ url: 'skill://beta.tar.gz', mimeType: 'application/gzip', digest: 'sha256:beta' }],
			},
		]);

		const catalog = await loadSkills(root);

		expect(catalog.entries).toHaveLength(1);
		expect(catalog.entries[0].skillMd).toBeUndefined();
		expect(catalog.entries[0].files).toEqual([]);
		expect([...catalog.resourcesByUri.keys()]).toEqual(['skill://beta.tar.gz']);
	});

	it('returns an empty catalog when the index does not exist', async () => {
		const catalog = await loadSkills(path.join(root, 'does-not-exist'));
		expect(catalog.entries).toEqual([]);
		expect(catalog.resourcesByUri.size).toBe(0);
	});

	it('returns an empty catalog when the index is invalid JSON', async () => {
		await writeFile(path.join(root, 'index.json'), '{nope', 'utf8');
		const catalog = await loadSkills(root);
		expect(catalog.entries).toEqual([]);
	});

	it('skips entries missing frontmatter, missing files, or with no url/archives', async () => {
		await mkdir(path.join(root, 'valid'), { recursive: true });
		await writeFile(path.join(root, 'valid', 'SKILL.md'), '# valid\n', 'utf8');
		await writeIndex([
			{ url: 'skill://valid/SKILL.md', digest: 'sha256:ok', frontmatter: { name: 'valid', description: 'ok' } },
			// missing SKILL.md on disk
			{ url: 'skill://missing/SKILL.md', digest: 'sha256:x', frontmatter: { name: 'missing', description: 'gone' } },
			// no frontmatter
			{ url: 'skill://nofm/SKILL.md', digest: 'sha256:x' },
			// neither url nor archives
			{ frontmatter: { name: 'empty', description: 'nothing' } },
		]);

		const catalog = await loadSkills(root);

		expect(catalog.entries.map((e) => e.frontmatter.name)).toEqual(['valid']);
	});

	it('skips entries whose final skill-path segment does not match frontmatter.name', async () => {
		await mkdir(path.join(root, 'mismatch'), { recursive: true });
		await writeFile(path.join(root, 'mismatch', 'SKILL.md'), '# x\n', 'utf8');
		await writeIndex([
			{ url: 'skill://mismatch/SKILL.md', digest: 'sha256:x', frontmatter: { name: 'different', description: 'd' } },
		]);

		const catalog = await loadSkills(root);

		expect(catalog.entries).toEqual([]);
	});

	it('rejects skill URLs that escape the distribution root', async () => {
		await writeFile(path.join(root, 'outside.md'), '# outside\n', 'utf8');
		await writeIndex([
			{ url: 'skill://../outside.md', digest: 'sha256:x', frontmatter: { name: 'escape', description: 'bad' } },
		]);

		const catalog = await loadSkills(root);

		expect(catalog.entries).toEqual([]);
	});

	it('skips symlinked files while walking a skill directory', async () => {
		await mkdir(path.join(root, 'alpha'), { recursive: true });
		await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
		const target = path.join(root, 'alpha', 'real.md');
		const link = path.join(root, 'alpha', 'linked.md');
		await writeFile(target, '# real\n', 'utf8');
		try {
			await symlink(target, link);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
			throw err;
		}
		await writeIndex([
			{ url: 'skill://alpha/SKILL.md', digest: 'sha256:x', frontmatter: { name: 'alpha', description: 'a' } },
		]);

		const catalog = await loadSkills(root);

		expect(catalog.resourcesByUri.has('skill://alpha/real.md')).toBe(true);
		expect(catalog.resourcesByUri.has('skill://alpha/linked.md')).toBe(false);
	});
});
