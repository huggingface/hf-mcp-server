import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkillDirectory } from '../../src/server/skills/skill-resource-data.js';
import { SkillCatalogCache, SKILL_SNAPSHOT_MAX_AGE_MS } from '../../src/server/skills/skill-catalog-cache.js';
import { loadSkills } from '../../src/server/skills/skill-loader.js';

let root: string;

function digest(bytes: Buffer | string): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface FixtureFile {
	relativePath: string;
	content: Buffer | string;
}

async function writeSkill(
	name = 'alpha',
	files: FixtureFile[] = [{ relativePath: 'references/guide.md', content: '# guide\n' }],
	frontmatter: Record<string, unknown> = { name, description: 'first skill' }
): Promise<void> {
	const skillDir = path.join(root, name);
	await mkdir(skillDir, { recursive: true });
	const skillMd = `---\nname: ${String(frontmatter.name)}\ndescription: ${String(frontmatter.description)}\n---\n\n# ${name}\n`;
	const allFiles = [{ relativePath: 'SKILL.md', content: skillMd }, ...files];
	for (const file of allFiles) {
		const target = path.join(skillDir, file.relativePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.content);
	}
	await writeFile(
		path.join(root, 'skills.json'),
		JSON.stringify({
			skills: [
				{
					uri: `skill://${name}/SKILL.md`,
					frontmatter,
					resources: allFiles.map((file) => ({
						uri: `skill://${name}/${file.relativePath.split('/').map(encodeURIComponent).join('/')}`,
						digest: digest(file.content),
					})),
				},
			],
		})
	);
}

async function mutateManifest(mutator: (manifest: Record<string, unknown>) => void): Promise<void> {
	const manifestPath = path.join(root, 'skills.json');
	const manifest = JSON.parse(
		await import('node:fs/promises').then((fs) => fs.readFile(manifestPath, 'utf8'))
	) as Record<string, unknown>;
	mutator(manifest);
	await writeFile(manifestPath, JSON.stringify(manifest));
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-loader-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('loadSkills', () => {
	it('loads and verifies a complete multi-file snapshot into memory', async () => {
		const binary = Buffer.from([0x00, 0xff, 0x10]);
		await writeSkill('alpha', [
			{ relativePath: 'references/guide.md', content: '# guide\r\n' },
			{ relativePath: 'assets/raw.bin', content: binary },
		]);

		const catalog = await loadSkills(root, 1234);
		expect(catalog.loadedAt).toBe(1234);
		expect(catalog.entries).toHaveLength(1);
		expect(catalog.entries[0]).toMatchObject({
			uri: 'skill://alpha/SKILL.md',
			skillPath: 'alpha',
			frontmatter: { name: 'alpha', description: 'first skill' },
		});
		expect(catalog.resourcesByUri.size).toBe(3);
		expect(catalog.resourcesByUri.get('skill://alpha/assets/raw.bin')?.bytes).toEqual(binary);
		expect(catalog.directories.get('skill://alpha')).toContainEqual({
			uri: 'skill://alpha/references',
			name: 'references',
			mimeType: 'inode/directory',
		});
	});

	it('exposes empty directory trees with encoded names and readable empty leaves', async () => {
		await writeSkill();
		await mkdir(path.join(root, 'alpha/empty parent/雪 #?%/leaf'), { recursive: true });
		await mkdir(path.join(root, 'alpha/references/empty'), { recursive: true });
		const catalog = await loadSkills(root);
		const parent = 'skill://alpha/empty%20parent';
		const nested = `${parent}/${encodeURIComponent('雪 #?%')}`;
		expect(readSkillDirectory(catalog, 'skill://alpha')?.resources).toContainEqual({
			uri: parent,
			name: 'empty parent',
			mimeType: 'inode/directory',
		});
		expect(readSkillDirectory(catalog, parent)?.resources).toEqual([
			{ uri: nested, name: '雪 #?%', mimeType: 'inode/directory' },
		]);
		expect(readSkillDirectory(catalog, nested)?.resources).toEqual([
			{ uri: `${nested}/leaf`, name: 'leaf', mimeType: 'inode/directory' },
		]);
		expect(readSkillDirectory(catalog, `${nested}/leaf`)).toEqual({ resources: [] });
		expect(readSkillDirectory(catalog, `${nested}/leaf/`)).toEqual({ resources: [] });
		expect(readSkillDirectory(catalog, 'skill://alpha/references/empty')).toEqual({ resources: [] });
		expect(catalog.resourcesByUri.size).toBe(2);
	});

	it('preserves manifest directory encoding for empty descendants', async () => {
		await writeSkill();
		await mkdir(path.join(root, 'alpha/references/empty'), { recursive: true });
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources[1]!.uri = 'skill://alpha/%72eferences/guide.md';
		});
		const catalog = await loadSkills(root);
		expect(readSkillDirectory(catalog, 'skill://alpha/%72eferences/empty')).toEqual({ resources: [] });
		expect(catalog.directories.has('skill://alpha/references')).toBe(false);
	});

	it.each(['internal', 'external', 'dangling'])('rejects %s directory symlinks in empty trees', async (target) => {
		await writeSkill();
		await mkdir(path.join(root, 'alpha/empty'), { recursive: true });
		await mkdir(path.join(root, 'outside'), { recursive: true });
		const destination = target === 'internal' ? 'alpha/references' : target === 'external' ? 'outside' : 'missing';
		await symlink(path.join(root, destination), path.join(root, 'alpha/empty/link'));
		await expect(loadSkills(root)).rejects.toThrow(/symlink/u);
	});

	it('allows exactly 512 resources including SKILL.md and rejects 513', async () => {
		const files = Array.from({ length: 511 }, (_, index) => ({
			relativePath: `nested/${index}.txt`,
			content: '',
		}));
		await writeSkill('alpha', files);
		expect((await loadSkills(root)).resourcesByUri.size).toBe(512);
		await writeSkill('alpha', [...files, { relativePath: 'nested/extra.txt', content: '' }]);
		await expect(loadSkills(root)).rejects.toThrow(/skill exceeds the maximum resource count/u);
	});

	it('counts shared resources toward each skill resource count', async () => {
		const files = [
			{ relativePath: 'child/SKILL.md', content: '---\nname: child\ndescription: child\n---\n' },
			...Array.from({ length: 510 }, (_, index) => ({ relativePath: `child/${index}.txt`, content: '' })),
		];
		const publish = async (extra: boolean): Promise<void> => {
			await writeSkill('alpha', extra ? [...files, { relativePath: 'extra.txt', content: '' }] : files);
			await mutateManifest((manifest) => {
				const skills = manifest.skills as {
					uri: string;
					frontmatter: Record<string, unknown>;
					resources: { uri: string; digest: string }[];
				}[];
				skills.unshift({
					uri: 'skill://alpha/child/SKILL.md',
					frontmatter: { name: 'child', description: 'child' },
					resources: skills[0]!.resources.filter((resource) => resource.uri.startsWith('skill://alpha/child/')),
				});
			});
		};
		await publish(false);
		const catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.resources.length)).toEqual([511, 512]);
		expect(catalog.resourcesByUri.size).toBe(512);
		await publish(true);
		await expect(loadSkills(root)).rejects.toThrow(/skill exceeds the maximum resource count/u);
	});

	it('allows exactly 16 MiB raw bytes including SKILL.md and rejects one extra byte atomically', async () => {
		await writeSkill('alpha', []);
		const skillMd = await readFile(path.join(root, 'alpha/SKILL.md'));
		const content = Buffer.alloc(16 * 1024 * 1024 - skillMd.length, 0xff);
		await writeSkill('alpha', [{ relativePath: 'nested/data.bin', content }]);
		let now = 0;
		let failed = false;
		const cache = new SkillCatalogCache(
			root,
			async (directory, loadedAt) => {
				try {
					return await loadSkills(directory, loadedAt);
				} catch (error) {
					failed = true;
					throw error;
				}
			},
			() => now
		);
		const original = await cache.get();
		expect(original).not.toBeNull();
		expect([...original!.resourcesByUri.values()].reduce((sum, file) => sum + file.bytes.length, 0)).toBe(
			16 * 1024 * 1024
		);
		await writeSkill('alpha', [
			{ relativePath: 'nested/data.bin', content: Buffer.concat([content, Buffer.from([0])]) },
		]);
		await mkdir(path.join(root, 'alpha/new-empty'));
		await expect(loadSkills(root)).rejects.toThrow(/maximum raw byte size/u);
		now = SKILL_SNAPSHOT_MAX_AGE_MS;
		expect(await cache.get()).toBe(original);
		await vi.waitFor(() => expect(failed).toBe(true));
		expect(await cache.get()).toBe(original);
		expect(original!.directories.has('skill://alpha/new-empty')).toBe(false);
		expect(original!.resourcesByUri.get('skill://alpha/nested/data.bin')?.bytes.equals(content)).toBe(true);
	});

	it('counts shared nested resources per skill despite global deduplication', async () => {
		const childMd = '---\nname: child\ndescription: child\n---\n';
		const shared = Buffer.alloc(8 * 1024 * 1024);
		await writeSkill('alpha', [
			{ relativePath: 'child/SKILL.md', content: childMd },
			{ relativePath: 'child/shared.bin', content: shared },
		]);
		const parentMd = await readFile(path.join(root, 'alpha/SKILL.md'));
		const own = Buffer.alloc(16 * 1024 * 1024 - shared.length - childMd.length - parentMd.length);
		const publish = async (extra: number): Promise<void> => {
			await writeSkill('alpha', [
				{ relativePath: 'child/SKILL.md', content: childMd },
				{ relativePath: 'child/shared.bin', content: shared },
				{ relativePath: 'own.bin', content: Buffer.concat([own, Buffer.alloc(extra)]) },
			]);
			await mutateManifest((manifest) => {
				const skills = manifest.skills as {
					uri: string;
					frontmatter: Record<string, unknown>;
					resources: { uri: string; digest: string }[];
				}[];
				skills.unshift({
					uri: 'skill://alpha/child/SKILL.md',
					frontmatter: { name: 'child', description: 'child' },
					resources: skills[0]!.resources.filter((resource) => resource.uri.startsWith('skill://alpha/child/')),
				});
			});
		};
		await publish(0);
		const catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.resources.length)).toEqual([2, 4]);
		expect(catalog.resourcesByUri.size).toBe(4);
		await publish(1);
		await expect(loadSkills(root)).rejects.toThrow(/maximum raw byte size/u);
	});

	it('retains verified bytes after the backing file changes', async () => {
		await writeSkill();
		const catalog = await loadSkills(root);
		const uri = 'skill://alpha/references/guide.md';
		const before = catalog.resourcesByUri.get(uri)?.bytes.toString('utf8');
		await writeFile(path.join(root, 'alpha/references/guide.md'), '# changed\n');
		expect(catalog.resourcesByUri.get(uri)?.bytes.toString('utf8')).toBe(before);
	});

	it('supports organizational prefixes and encoded filenames', async () => {
		await mkdir(path.join(root, 'acme', 'refunds'), { recursive: true });
		const skillMd = '---\nname: refunds\ndescription: Process refunds\n---\n';
		await writeFile(path.join(root, 'acme/refunds/SKILL.md'), skillMd);
		await writeFile(path.join(root, 'acme/refunds/a b.txt'), 'space');
		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({
				skills: [
					{
						uri: 'skill://acme/refunds/SKILL.md',
						frontmatter: { name: 'refunds', description: 'Process refunds' },
						resources: [
							{ uri: 'skill://acme/refunds/SKILL.md', digest: digest(skillMd) },
							{ uri: 'skill://acme/refunds/a%20b.txt', digest: digest('space') },
						],
					},
				],
			})
		);
		const catalog = await loadSkills(root);
		expect(catalog.entries[0]?.skillPath).toBe('acme/refunds');
		expect(catalog.resourcesByUri.has('skill://acme/refunds/a%20b.txt')).toBe(true);
	});

	it('rejects a digest mismatch', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { digest: string }[] }[];
			skills[0]!.resources[0]!.digest = `sha256:${'0'.repeat(64)}`;
		});
		await expect(loadSkills(root)).rejects.toThrow(/digest mismatch/u);
	});

	it('rejects a manifest that omits a published supporting file', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources = skills[0]!.resources.filter((resource) => !resource.uri.endsWith('/guide.md'));
		});
		await expect(loadSkills(root)).rejects.toThrow(/manifest is incomplete/u);
	});

	it('rejects invalid digest syntax, duplicate resources, and a missing SKILL.md resource', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources[0]!.digest = 'sha256:nope';
		});
		await expect(loadSkills(root)).rejects.toThrow(/valid uri and SHA-256/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.push({ ...skills[0]!.resources[0]! });
		});
		await expect(loadSkills(root)).rejects.toThrow(/duplicate skill resource/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources = skills[0]!.resources.filter((resource) => !resource.uri.endsWith('/SKILL.md'));
		});
		await expect(loadSkills(root)).rejects.toThrow(/does not include its SKILL.md/u);
	});

	it('rejects traversal, resources outside the skill root, and symlinks', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources[0]!.uri = 'skill://alpha/%2e%2e/outside';
		});
		await expect(loadSkills(root)).rejects.toThrow(/unsafe skill resource URI/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources[0]!.uri = 'skill://beta/SKILL.md';
		});
		await expect(loadSkills(root)).rejects.toThrow(/outside skill/u);

		await writeSkill();
		await rm(path.join(root, 'alpha/references/guide.md'));
		try {
			await symlink(path.join(root, 'alpha/SKILL.md'), path.join(root, 'alpha/references/guide.md'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		await expect(loadSkills(root)).rejects.toThrow(/not a regular file/u);
	});

	it('rejects malformed, mismatched, or invalid Agent Skills frontmatter', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { frontmatter: { description: string } }[];
			skills[0]!.frontmatter.description = 'different';
		});
		await expect(loadSkills(root)).rejects.toThrow(/frontmatter mismatch/u);

		await writeSkill('BadName', [], { name: 'BadName', description: 'bad' });
		await expect(loadSkills(root)).rejects.toThrow(/invalid or mismatched/u);

		await writeSkill('alpha', [], {
			name: 'alpha',
			description: 'first skill',
			metadata: { tags: ['bad'] },
		});
		await expect(loadSkills(root)).rejects.toThrow(/metadata must map/u);
	});

	it('rejects ambiguous YAML and invalid UTF-8 in the actual SKILL.md', async () => {
		await writeSkill();
		const duplicateYaml = '---\nname: alpha\nname: alpha\ndescription: first skill\n---\n';
		await writeFile(path.join(root, 'alpha/SKILL.md'), duplicateYaml);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.find((resource) => resource.uri.endsWith('/SKILL.md'))!.digest = digest(duplicateYaml);
		});
		await expect(loadSkills(root)).rejects.toThrow(/invalid YAML frontmatter/u);

		await writeSkill();
		const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
		await writeFile(path.join(root, 'alpha/SKILL.md'), invalidUtf8);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.find((resource) => resource.uri.endsWith('/SKILL.md'))!.digest = digest(invalidUtf8);
		});
		await expect(loadSkills(root)).rejects.toThrow(/not valid UTF-8/u);
	});

	it('rejects missing or invalid manifest JSON', async () => {
		await expect(loadSkills(root)).rejects.toThrow(/skills\.json/u);
		await writeFile(path.join(root, 'skills.json'), '{nope');
		await expect(loadSkills(root)).rejects.toThrow();
		await writeFile(path.join(root, 'skills.json'), '{}');
		await expect(loadSkills(root)).rejects.toThrow(/skills array/u);
	});

	it('rejects symlinked and oversized manifests', async () => {
		const outside = path.join(root, 'outside.json');
		await writeFile(outside, JSON.stringify({ skills: [] }));
		try {
			await symlink(outside, path.join(root, 'skills.json'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		await expect(loadSkills(root)).rejects.toThrow(/regular manifest/u);

		await rm(path.join(root, 'skills.json'));
		await writeFile(path.join(root, 'skills.json'), 'x'.repeat(5 * 1024 * 1024 + 1));
		await expect(loadSkills(root)).rejects.toThrow(/maximum size/u);
	});

	it('rejects excessive skill and resource counts before loading files', async () => {
		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({ skills: Array.from({ length: 1_001 }, () => ({})) })
		);
		await expect(loadSkills(root)).rejects.toThrow(/maximum skill count/u);

		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({
				skills: [
					{
						uri: 'skill://alpha/SKILL.md',
						frontmatter: { name: 'alpha', description: 'alpha' },
						resources: Array.from({ length: 10_001 }, () => ({
							uri: 'skill://alpha/SKILL.md',
							digest: `sha256:${'0'.repeat(64)}`,
						})),
					},
				],
			})
		);
		await expect(loadSkills(root)).rejects.toThrow(/maximum resource count/u);
	});
});
