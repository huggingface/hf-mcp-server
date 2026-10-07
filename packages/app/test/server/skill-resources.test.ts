import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { loadSkills } from '../../src/server/skills/skill-loader.js';
import { registerSkillResources } from '../../src/server/skills/skill-resources.js';
import { skillsListTag } from '../../src/server/skills/skill-resource-data.js';
import { RESOURCES_DIRECTORY_READ_METHOD } from '../../src/server/skills/skill-directory-schema.js';
import { SKILLS_GET_METHOD, SKILLS_LIST_METHOD } from '../../src/server/skills/skill-method-schema.js';

type ResourceContent = { uri: string; mimeType: string; text?: string; blob?: string };
type ResourceHandler = () => Promise<{ contents: ResourceContent[] }>;
type RequestHandler = (params: Record<string, unknown>) => unknown;

interface Registration {
	name: string;
	uri: string;
	metadata: { description?: string; mimeType?: string; cacheHint?: { ttlMs?: number; cacheScope?: string } };
	handler: ResourceHandler;
}

function makeMockServer(): {
	server: McpServer;
	calls: Registration[];
	requestHandlers: Map<string, RequestHandler>;
} {
	const calls: Registration[] = [];
	const requestHandlers = new Map<string, RequestHandler>();
	const inner = {
		setRequestHandler(method: string, _schemas: { params: unknown; result?: unknown }, handler: RequestHandler) {
			requestHandlers.set(method, handler);
		},
	};
	const server = {
		registerResource(name: string, uri: string, metadata: Registration['metadata'], handler: ResourceHandler): void {
			calls.push({ name, uri, metadata, handler });
		},
		server: inner,
	} as unknown as McpServer;
	return { server, calls, requestHandlers };
}

function digest(content: Buffer | string): string {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function buildAlphaSkill(root: string): Promise<void> {
	const skillMd = '---\nname: alpha\ndescription: first skill\n---\n\n# alpha\n';
	const guide = '# guide\n';
	const binary = Buffer.from([0x00, 0xff, 0x08]);
	await mkdir(path.join(root, 'alpha', 'references'), { recursive: true });
	await mkdir(path.join(root, 'alpha', 'assets'), { recursive: true });
	await writeFile(path.join(root, 'alpha', 'SKILL.md'), skillMd);
	await writeFile(path.join(root, 'alpha', 'references', 'guide.md'), guide);
	await writeFile(path.join(root, 'alpha', 'assets', 'raw.bin'), binary);
	await writeFile(
		path.join(root, 'skills.json'),
		JSON.stringify({
			skills: [
				{
					uri: 'skill://alpha/SKILL.md',
					frontmatter: { name: 'alpha', description: 'first skill' },
					resources: [
						{ uri: 'skill://alpha/SKILL.md', digest: digest(skillMd) },
						{ uri: 'skill://alpha/references/guide.md', digest: digest(guide) },
						{ uri: 'skill://alpha/assets/raw.bin', digest: digest(binary) },
					],
				},
			],
		})
	);
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-resources-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('registerSkillResources', () => {
	it('registers every verified file from the in-memory snapshot, but no legacy index or archive', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog, { protocolVersion: '2026-07-28', ttlMs: 123_000 });

		expect(calls.map((call) => call.uri).sort()).toEqual([
			'skill://alpha/SKILL.md',
			'skill://alpha/assets/raw.bin',
			'skill://alpha/references/guide.md',
		]);
		expect(calls.find((call) => call.uri.endsWith('/SKILL.md'))).toMatchObject({
			name: 'alpha',
			metadata: {
				description: 'first skill',
				mimeType: 'text/markdown',
				cacheHint: { ttlMs: 123_000, cacheScope: 'public' },
			},
		});
	});

	it('serves text and binary content from retained bytes', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog, { ttlMs: 1 });

		const skillMd = (await calls.find((call) => call.uri.endsWith('/SKILL.md'))!.handler()).contents[0];
		expect(skillMd.text).toContain('# alpha');
		const binary = (await calls.find((call) => call.uri.endsWith('/raw.bin'))!.handler()).contents[0];
		expect(binary.text).toBeUndefined();
		expect(binary.blob).toBe(Buffer.from([0x00, 0xff, 0x08]).toString('base64'));
	});

	it.each([456_000, 0])('implements skills/list and skills/get with matching cache fields (TTL %i)', async (ttlMs) => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog, { protocolVersion: '2026-07-28', ttlMs });

		const list = requestHandlers.get(SKILLS_LIST_METHOD)!({}) as {
			skills: Record<string, unknown>[];
			ttlMs: number;
			cacheScope: string;
		};
		expect(list).toMatchObject({ ttlMs, cacheScope: 'public' });
		expect(list.skills).toHaveLength(1);
		expect(Object.keys(list.skills[0]!).sort()).toEqual(['frontmatter', 'resources', 'uri']);

		const get = requestHandlers.get(SKILLS_GET_METHOD)!({ uri: 'skill://alpha/SKILL.md' }) as {
			skill: Record<string, unknown>;
		};
		expect(get.skill).toEqual(list.skills[0]);
		expect(get).toMatchObject({ ttlMs, cacheScope: 'public' });
		expect(() => requestHandlers.get(SKILLS_GET_METHOD)!({ uri: 'skill://alpha/references/guide.md' })).toThrow();
	});

	it.each([789_000, 0])(
		'preserves custom method cache fields through the SDK protocol layer (TTL %i)',
		async (ttlMs) => {
			await buildAlphaSkill(root);
			const catalog = await loadSkills(root);
			const server = new McpServer({
				name: 'skills-test',
				version: '1.0.0',
			});
			registerSkillResources(server, catalog, { protocolVersion: '2026-07-28', ttlMs, tagSalt: '' });
			const client = new Client({ name: 'skills-client', version: '1.0.0' });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
			try {
				const list = await client.request(
					{ method: SKILLS_LIST_METHOD, params: {} },
					z.looseObject({ skills: z.array(z.looseObject({ uri: z.string() })) })
				);
				expect(list).toMatchObject({
					skills: [{ uri: 'skill://alpha/SKILL.md' }],
					ttlMs,
					cacheScope: 'public',
					tag: skillsListTag(catalog),
				});
				const get = await client.request(
					{
						method: SKILLS_GET_METHOD,
						params: { uri: 'skill://alpha/SKILL.md' },
					},
					z.looseObject({ skill: z.looseObject({ uri: z.string() }) })
				);
				expect(get).toMatchObject({ skill: list.skills[0], ttlMs, cacheScope: 'public' });
			} finally {
				await client.close();
				await server.close();
			}
		}
	);

	it('adds a collection-wide definition tag to every skills/list page, but not to skills/get', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog, { protocolVersion: '2026-07-28', ttlMs: 1, tagSalt: '' });
		const tag = skillsListTag(catalog);
		expect(tag).toMatch(/^sha256:[0-9a-f]{64}$/);
		// The first page and a later (here empty) page carry the same collection tag.
		expect(requestHandlers.get(SKILLS_LIST_METHOD)!({})).toMatchObject({ tag });
		expect(requestHandlers.get(SKILLS_LIST_METHOD)!({ cursor: '1' })).toMatchObject({ skills: [], tag });
		expect(requestHandlers.get(SKILLS_GET_METHOD)!({ uri: 'skill://alpha/SKILL.md' })).not.toHaveProperty('tag');
		expect(skillsListTag(catalog, 's1')).not.toBe(tag);
		expect(skillsListTag(catalog, 's1')).toBe(skillsListTag(catalog, 's1'));
	});

	it('changes the skills/list tag when catalog entries change', async () => {
		await buildAlphaSkill(root);
		const before = skillsListTag(await loadSkills(root));
		expect(skillsListTag(await loadSkills(root))).toBe(before);
		await writeFile(path.join(root, 'alpha', 'references', 'guide.md'), '# guide v2\n');
		const manifest = JSON.parse(await readFile(path.join(root, 'skills.json'), 'utf8')) as {
			skills: { resources: { uri: string; digest: string }[] }[];
		};
		manifest.skills[0]!.resources[1]!.digest = digest('# guide v2\n');
		await writeFile(path.join(root, 'skills.json'), JSON.stringify(manifest));
		expect(skillsListTag(await loadSkills(root))).not.toBe(before);
	});

	it.each([
		['2026-07-28', undefined],
		['2025-11-25', ''],
		[undefined, ''],
	])('omits the skills/list tag for protocol %s with tag salt %j', async (protocolVersion, tagSalt) => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog, { protocolVersion, ttlMs: 1, tagSalt });
		expect(requestHandlers.get(SKILLS_LIST_METHOD)!({})).not.toHaveProperty('tag');
	});

	it.each(['2025-11-25', undefined])('omits list/get cache attributes for protocol %s', async (protocolVersion) => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog, { protocolVersion, ttlMs: 456_000 });
		const list = requestHandlers.get(SKILLS_LIST_METHOD)!({});
		const get = requestHandlers.get(SKILLS_GET_METHOD)!({ uri: 'skill://alpha/SKILL.md' });
		for (const result of [list, get]) {
			expect(result).not.toHaveProperty('ttlMs');
			expect(result).not.toHaveProperty('cacheScope');
		}
	});

	it('lists direct directory children and rejects non-directories', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog, { ttlMs: 1 });

		const handler = requestHandlers.get(RESOURCES_DIRECTORY_READ_METHOD)!;
		const rootListing = handler({ uri: 'skill://alpha' }) as {
			resources: { uri: string; mimeType: string }[];
		};
		expect(rootListing.resources).toContainEqual({
			uri: 'skill://alpha/references',
			name: 'references',
			mimeType: 'inode/directory',
		});
		try {
			handler({ uri: 'skill://alpha/SKILL.md' });
			throw new Error('expected directory read to fail');
		} catch (error) {
			expect(error).toMatchObject({ code: ProtocolErrorCode.InvalidParams });
		}
	});
});
