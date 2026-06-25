import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSkills } from '../../src/server/skills/skill-loader.js';
import { registerSkillResources } from '../../src/server/skills/skill-resources.js';
import { RESOURCES_DIRECTORY_READ_METHOD } from '../../src/server/skills/skill-directory-schema.js';

type ResourceContent = { uri: string; mimeType: string; text?: string; blob?: string };
type ResourceHandler = () => Promise<{ contents: ResourceContent[] }>;
type RequestHandler = (request: { method: string; params: Record<string, unknown> }) => unknown;

interface Registration {
	name: string;
	uri: string;
	metadata: { description?: string; mimeType?: string };
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
		setRequestHandler(schema: { shape: { method: { value: string } } }, handler: RequestHandler) {
			requestHandlers.set(schema.shape.method.value, handler);
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

async function buildAlphaSkill(root: string): Promise<void> {
	await mkdir(path.join(root, 'alpha', 'references'), { recursive: true });
	await writeFile(path.join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8');
	await writeFile(path.join(root, 'alpha', 'references', 'guide.md'), '# guide\n', 'utf8');
	await writeFile(path.join(root, 'beta.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08]));
	await writeFile(
		path.join(root, 'index.json'),
		JSON.stringify({
			skills: [
				{
					url: 'skill://alpha/SKILL.md',
					digest: 'sha256:alpha',
					frontmatter: { name: 'alpha', description: 'first skill' },
				},
				{
					frontmatter: { name: 'beta', description: 'archive skill' },
					archives: [{ url: 'skill://beta.tar.gz', mimeType: 'application/gzip', digest: 'sha256:beta' }],
				},
			],
		}),
		'utf8',
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
	it('registers every skill file, the archive, and the index', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		expect(calls.map((c) => c.uri).sort()).toEqual([
			'skill://alpha/SKILL.md',
			'skill://alpha/references/guide.md',
			'skill://beta.tar.gz',
			'skill://index.json',
		]);

		const skillMdReg = calls.find((c) => c.uri === 'skill://alpha/SKILL.md')!;
		expect(skillMdReg.name).toBe('alpha');
		expect(skillMdReg.metadata.description).toBe('first skill');
		expect(skillMdReg.metadata.mimeType).toBe('text/markdown');

		const supportReg = calls.find((c) => c.uri === 'skill://alpha/references/guide.md')!;
		expect(supportReg.name).toBe('guide.md');
		expect(supportReg.metadata.mimeType).toBe('text/markdown');

		const archiveReg = calls.find((c) => c.uri === 'skill://beta.tar.gz')!;
		expect(archiveReg.name).toBe('beta.tar.gz');
		expect(archiveReg.metadata.mimeType).toBe('application/gzip');
	});

	it('serves text for files and base64 blobs for archives', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const skillMdBody = (await calls.find((c) => c.uri === 'skill://alpha/SKILL.md')!.handler()).contents[0];
		expect(skillMdBody.mimeType).toBe('text/markdown');
		expect(skillMdBody.text).toBe('# alpha\n');
		expect(skillMdBody.blob).toBeUndefined();

		const archiveBody = (await calls.find((c) => c.uri === 'skill://beta.tar.gz')!.handler()).contents[0];
		expect(archiveBody.mimeType).toBe('application/gzip');
		expect(archiveBody.text).toBeUndefined();
		expect(archiveBody.blob).toBe(Buffer.from([0x1f, 0x8b, 0x08]).toString('base64'));
	});

	it('serves index.json exactly as provided by the distribution', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, calls } = makeMockServer();
		registerSkillResources(server, catalog);

		const index = calls.find((c) => c.uri === 'skill://index.json')!;
		const body = (await index.handler()).contents[0];
		expect(body.mimeType).toBe('application/json');
		expect(body.text).toBe(catalog.indexText);
	});

	it('installs a resources/directory/read handler that lists children and errors on non-directories', async () => {
		await buildAlphaSkill(root);
		const catalog = await loadSkills(root);
		const { server, requestHandlers } = makeMockServer();
		registerSkillResources(server, catalog);

		const handler = requestHandlers.get(RESOURCES_DIRECTORY_READ_METHOD)!;
		expect(handler).toBeDefined();

		const rootListing = handler({
			method: RESOURCES_DIRECTORY_READ_METHOD,
			params: { uri: 'skill://alpha' },
		}) as { resources: { uri: string; mimeType: string }[] };
		expect(rootListing.resources).toContainEqual({
			uri: 'skill://alpha/references',
			name: 'references',
			mimeType: 'inode/directory',
		});

		// Non-directory URI → JSON-RPC InvalidParams (-32602).
		expect(() =>
			handler({ method: RESOURCES_DIRECTORY_READ_METHOD, params: { uri: 'skill://alpha/SKILL.md' } }),
		).toThrowError(/Not a directory/);
	});
});
