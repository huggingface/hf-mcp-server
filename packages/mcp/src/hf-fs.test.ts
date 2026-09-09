import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	downloadFile,
	datasetInfo,
	HubApiError,
	listDatasets,
	listFiles,
	listModels,
	listSpaces,
	modelInfo,
	pathsInfo,
	spaceInfo,
} from '@huggingface/hub';
import {
	HF_FS_ATTACH_MAX_BYTES,
	HF_FS_BATCH_CONCURRENCY,
	HF_FS_MAX_OUTPUT_CHARS,
	HF_FS_TOOL_CONFIG,
	HfFsTool,
	formatHfFsBatchMarkdown,
	formatHfFsMarkdown,
	isHfFsAttachExecutionResult,
	parseHfFsUri,
	toHfFsBatchResult,
} from './hf-fs.js';
import { classifyHfFsError } from './hf-fs-errors.js';

vi.mock('@huggingface/hub', () => ({
	HubApiError: class HubApiError extends Error {
		constructor(
			public readonly url: string,
			public readonly statusCode: number,
			public readonly requestId?: string
		) {
			super();
		}
	},
	HUB_URL: 'https://huggingface.co',
	listFiles: vi.fn(),
	listModels: vi.fn(),
	listDatasets: vi.fn(),
	listSpaces: vi.fn(),
	modelInfo: vi.fn(),
	datasetInfo: vi.fn(),
	spaceInfo: vi.fn(),
	pathsInfo: vi.fn(),
	downloadFile: vi.fn(),
}));

async function* entries<T>(items: T[]): AsyncGenerator<T> {
	await Promise.resolve();
	for (const item of items) {
		yield item;
	}
}

function createStreamingBlob(
	size: number,
	chunks: Uint8Array[],
	cancel?: (reason?: unknown) => void,
	close = true
): Blob {
	return {
		size,
		stream: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(chunk);
					}
					if (close) {
						controller.close();
					}
				},
				cancel,
			}),
		arrayBuffer: () => {
			throw new Error('arrayBuffer must not be used for attachments');
		},
	} as unknown as Blob;
}

function expectBatchOutputSchemaAccepts(result: unknown): void {
	const output = {
		results: [{ index: 0, status: 'success' as const, result }],
	};
	expect(HF_FS_TOOL_CONFIG.outputSchema.parse(output)).toEqual(output);
}

describe('HfFsTool config', () => {
	it('exposes the strict batch schema and concise command grammar', () => {
		expect(Object.keys(HF_FS_TOOL_CONFIG.schema.shape)).toEqual(['operations']);
		expect(HF_FS_TOOL_CONFIG.schema.safeParse({ operations: [] }).success).toBe(false);
		expect(
			HF_FS_TOOL_CONFIG.schema.safeParse({
				operations: Array.from({ length: 30 }, () => ({ cmd: 'stat' as const, args: ['hf://models'] })),
			}).success
		).toBe(true);
		expect(
			HF_FS_TOOL_CONFIG.schema.safeParse({
				operations: Array.from({ length: 31 }, () => ({ cmd: 'stat' as const, args: ['hf://models'] })),
			}).success
		).toBe(false);
		expect(
			HF_FS_TOOL_CONFIG.schema.safeParse({
				operations: [{ cmd: 'stat', args: ['hf://models'], extra: true }],
			}).success
		).toBe(false);
		expect(HF_FS_TOOL_CONFIG.description).toContain('multiple operations may be submitted together');
		expect(HF_FS_TOOL_CONFIG.description).toContain('{"operations":[{"cmd":"ls","args":["hf://models/org/repo"]}]}');
		expect(HF_FS_TOOL_CONFIG.description).not.toContain('only tool');
		expect(HF_FS_TOOL_CONFIG.schema.shape.operations.element.shape.args.description).toBe(
			'Command arguments. First item must be an hf:// URI, not a local path or bare filename. One argument per array item. search discovers resources, not repository contents; use root/owner discovery scopes, find for file discovery, or cat for a known text file. --tag and --kind require exactly hf://spaces; the only valid --kind value is mcp.'
		);
		expect(HF_FS_TOOL_CONFIG.description).toContain('Grammar; each string below is one args array item');
		expect(HF_FS_TOOL_CONFIG.description).toContain('ls hf://models/trending');
		expect(HF_FS_TOOL_CONFIG.description).toContain('hf://papers/trending');
		expect(HF_FS_TOOL_CONFIG.description).toContain('hf://papers/daily/latest');
		expect(HF_FS_TOOL_CONFIG.description).toContain("today's trending models");
		expect(HF_FS_TOOL_CONFIG.description).toContain('daily papers');
		expect(HF_FS_TOOL_CONFIG.description.slice(0, 1024)).toContain('hf://models/trending');
		expect(HF_FS_TOOL_CONFIG.description.slice(0, 1024)).toContain('hf://papers/daily/latest');
		expect(HF_FS_TOOL_CONFIG.description).toContain('hf://README.md');
		expect(HF_FS_TOOL_CONFIG.description).toContain('attach URI [--max-bytes N]');
	});

	it('validates attachment metadata without accepting a binary payload field', () => {
		const metadata = {
			op: 'attach' as const,
			uri: 'hf://models/org/repo/image.png',
			path: 'image.png',
			mime_type: 'image/png' as const,
			bytes: 3,
		};
		expectBatchOutputSchemaAccepts(metadata);
		expect(() =>
			HF_FS_TOOL_CONFIG.outputSchema.parse({
				results: [{ index: 0, status: 'success', result: { ...metadata, data: Uint8Array.from([1, 2, 3]) } }],
			})
		).toThrow();
		expect(() =>
			HF_FS_TOOL_CONFIG.outputSchema.parse({
				results: [{ index: 0, status: 'success', result: { ...metadata, base64: 'AQID' } }],
			})
		).toThrow();
		expect(() =>
			HF_FS_TOOL_CONFIG.outputSchema.parse({
				results: [{ index: 0, status: 'success', result: { ...metadata, bytes: Uint8Array.from([1, 2, 3]) } }],
			})
		).toThrow();
		for (const field of ['path', 'mime_type', 'bytes'] as const) {
			const missing: Partial<typeof metadata> = { ...metadata };
			delete missing[field];
			expect(() =>
				HF_FS_TOOL_CONFIG.outputSchema.parse({
					results: [{ index: 0, status: 'success', result: missing }],
				})
			).toThrow();
		}
		expect(() =>
			HF_FS_TOOL_CONFIG.outputSchema.parse({
				results: [{ index: 0, status: 'success', result: { ...metadata, bytes: HF_FS_ATTACH_MAX_BYTES + 1 } }],
			})
		).toThrow();

		const jsonSchema = z.toJSONSchema(HF_FS_TOOL_CONFIG.outputSchema);
		expect(jsonSchema.additionalProperties).toBe(false);
		expect(jsonSchema.properties).toHaveProperty('results');
		expect(JSON.stringify(jsonSchema)).toContain('"const":"attach"');
		expect(JSON.stringify(jsonSchema)).toContain(`"maximum":${HF_FS_ATTACH_MAX_BYTES.toString()}`);
	});
});

describe('parseHfFsUri', () => {
	it('parses typed repo URIs with revision and path', () => {
		expect(parseHfFsUri('hf://datasets/org/repo@refs/pr/3/data/train.jsonl')).toEqual({
			kind: 'repo',
			repo: { type: 'dataset', name: 'org/repo' },
			repoType: 'dataset',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/pr/3',
			path: 'data/train.jsonl',
		});
	});

	it('parses Hub special refs and encoded slash-containing revisions', () => {
		expect(parseHfFsUri('hf://datasets/org/repo@refs/convert/parquet-v2/data/train.parquet')).toEqual({
			kind: 'repo',
			repo: { type: 'dataset', name: 'org/repo' },
			repoType: 'dataset',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/convert/parquet-v2',
			path: 'data/train.parquet',
		});
		expect(parseHfFsUri('hf://models/org/repo@refs%2Fheads%2Ffeature/README.md')).toEqual({
			kind: 'repo',
			repo: { type: 'model', name: 'org/repo' },
			repoType: 'model',
			repoId: 'org/repo',
			namespace: 'org',
			revision: 'refs/heads/feature',
			path: 'README.md',
		});
	});

	it('rejects unescaped slash-containing revision forms that would otherwise parse ambiguously', () => {
		expect(() => parseHfFsUri('hf://models/org/repo@refs/heads/feature/README.md')).toThrow(
			"Revision names containing '/' must be percent-encoded"
		);
		expect(() => parseHfFsUri('hf://models/org/repo@refs/tags/v1/README.md')).toThrow(
			"Revision names containing '/' must be percent-encoded"
		);
	});

	it('parses bucket URIs without revisions', () => {
		expect(parseHfFsUri('hf://buckets/org/bucket/images/cat%201.png')).toEqual({
			kind: 'repo',
			repo: { type: 'bucket', name: 'org/bucket' },
			repoType: 'bucket',
			repoId: 'org/bucket',
			namespace: 'org',
			path: 'images/cat 1.png',
		});
	});

	it('parses namespace listing URIs', () => {
		expect(parseHfFsUri('hf://models/openai')).toEqual({
			kind: 'namespace',
			repoType: 'model',
			namespace: 'openai',
			path: '',
		});
		expect(parseHfFsUri('hf://buckets')).toEqual({
			kind: 'namespace',
			repoType: 'bucket',
			path: '',
		});
	});

	it('rejects singular type prefixes', () => {
		expect(() => parseHfFsUri('hf://model/org/repo')).toThrow("Invalid URI type 'model'");
	});
});

describe('HfFsTool', () => {
	beforeEach(() => {
		vi.mocked(listFiles).mockReset();
		vi.mocked(listModels).mockReset();
		vi.mocked(listDatasets).mockReset();
		vi.mocked(listSpaces).mockReset();
		vi.mocked(modelInfo).mockReset();
		vi.mocked(datasetInfo).mockReset();
		vi.mocked(spaceInfo).mockReset();
		vi.mocked(pathsInfo).mockReset();
		vi.mocked(downloadFile).mockReset();
		vi.stubGlobal('fetch', vi.fn());
	});

	it('runs operations in ordered parallel chunks', async () => {
		let active = 0;
		let maximumActive = 0;
		const started: string[] = [];
		let releaseFirstChunk: (() => void) | undefined;
		const firstChunkGate = new Promise<void>((resolve) => {
			releaseFirstChunk = resolve;
		});
		vi.mocked(pathsInfo).mockImplementation(({ paths }) =>
			Promise.resolve([{ path: paths[0] ?? '', type: 'file', size: 32 }])
		);
		vi.mocked(downloadFile).mockImplementation(async ({ path }) => {
			started.push(path);
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			if (started.length <= HF_FS_BATCH_CONCURRENCY) {
				await firstChunkGate;
			}
			active -= 1;
			return new Blob([path]);
		});

		const operations = Array.from({ length: HF_FS_BATCH_CONCURRENCY + 1 }, (_, index) => ({
			cmd: 'cat' as const,
			args: [`hf://models/org/repo/file-${index.toString()}.txt`],
		}));
		const run = new HfFsTool().runBatch({ operations });
		await vi.waitFor(() => {
			expect(started).toHaveLength(HF_FS_BATCH_CONCURRENCY);
		});
		expect(maximumActive).toBe(HF_FS_BATCH_CONCURRENCY);
		expect(started).not.toContain(`file-${HF_FS_BATCH_CONCURRENCY.toString()}.txt`);
		releaseFirstChunk?.();

		const results = await run;
		expect(started).toHaveLength(HF_FS_BATCH_CONCURRENCY + 1);
		expect(results.map((result) => result.index)).toEqual(
			Array.from({ length: HF_FS_BATCH_CONCURRENCY + 1 }, (_, index) => index)
		);
		expect(
			results.map((result) =>
				result.status === 'success' && !isHfFsAttachExecutionResult(result.executionResult)
					? result.executionResult.uri
					: undefined
			)
		).toEqual(operations.map((operation) => operation.args[0]));
	});

	it('isolates deterministic operation errors while preserving successful results', async () => {
		const results = await new HfFsTool().runBatch({
			operations: [
				{ cmd: 'cat', args: ['hf://models/org/repo'] },
				{ cmd: 'stat', args: ['hf://models'] },
			],
		});

		expect(results).toMatchObject([
			{
				index: 0,
				status: 'error',
				error: {
					code: 'HF_FS_NOT_A_FILE',
					retryable: false,
					suggestedOperation: 'stat',
				},
			},
			{
				index: 1,
				status: 'success',
				executionResult: {
					op: 'stat',
					uri: 'hf://models',
					exists: true,
				},
			},
		]);
	});

	it('isolates gated repository access errors while preserving successful results', async () => {
		vi.mocked(pathsInfo).mockRejectedValueOnce(
			Object.assign(new Error('Access to this gated repository is restricted.'), { statusCode: 401 })
		);

		const results = await new HfFsTool().runBatch({
			operations: [
				{ cmd: 'stat', args: ['hf://models/org/gated/config.json'] },
				{ cmd: 'stat', args: ['hf://models'] },
			],
		});

		expect(results).toMatchObject([
			{
				index: 0,
				status: 'error',
				error: {
					code: 'HF_FS_ACCESS_DENIED',
					retryable: false,
				},
			},
			{
				index: 1,
				status: 'success',
				executionResult: {
					op: 'stat',
					uri: 'hf://models',
					exists: true,
				},
			},
		]);
	});

	it('isolates Hub SDK not-found errors while preserving successful results', async () => {
		vi.mocked(listFiles).mockImplementation(() => {
			throw new HubApiError('https://huggingface.co/api/models/org/missing/tree/main', 404);
		});

		const results = await new HfFsTool().runBatch({
			operations: [
				{ cmd: 'ls', args: ['hf://models/org/missing'] },
				{ cmd: 'stat', args: ['hf://models'] },
			],
		});

		expect(results).toMatchObject([
			{
				index: 0,
				status: 'error',
				error: {
					code: 'HF_FS_NOT_FOUND',
					retryable: false,
					suggestedOperation: 'stat',
				},
			},
			{
				index: 1,
				status: 'success',
				executionResult: {
					op: 'stat',
					uri: 'hf://models',
					exists: true,
				},
			},
		]);
	});

	it('isolates malformed URI parser errors while preserving successful results', async () => {
		const results = await new HfFsTool().runBatch({
			operations: [
				{ cmd: 'stat', args: ['hf://bogus'] },
				{ cmd: 'stat', args: ['hf://models'] },
			],
		});

		expect(results).toMatchObject([
			{
				index: 0,
				status: 'error',
				error: {
					code: 'HF_FS_INVALID_ARGUMENT',
					message:
						"EINVAL: Invalid URI type 'bogus'. Must be one of models, datasets, spaces, buckets, collections, papers.",
					retryable: false,
				},
			},
			{
				index: 1,
				status: 'success',
				executionResult: {
					op: 'stat',
					uri: 'hf://models',
					exists: true,
				},
			},
		]);
	});

	it('caps cumulative batch text and structured content', () => {
		const items = [0, 1].map((index) => ({
			index,
			status: 'success' as const,
			executionResult: {
				op: 'cat' as const,
				uri: `hf://models/org/repo/file-${index.toString()}.txt`,
				path: `file-${index.toString()}.txt`,
				content: 'x'.repeat(60_000),
				bytes: 60_000,
				truncated: false,
			},
		}));

		const markdown = formatHfFsBatchMarkdown(items);
		expect(markdown.length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(markdown).toContain('Batch output truncated');

		const structured = toHfFsBatchResult(items);
		expect(JSON.stringify(structured).length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(structured).toMatchObject({
			truncated: true,
			truncation_reason: 'output_budget',
			results: [
				{ index: 0, status: 'success' },
				{ index: 1, status: 'success', output_truncated: true },
			],
		});
		expect(structured.results[1]).not.toHaveProperty('result.content');
		expect(HF_FS_TOOL_CONFIG.outputSchema.parse(structured)).toEqual(structured);
	});

	it('caps structured error batches containing oversized user-derived messages', () => {
		const oversized = 'x'.repeat(HF_FS_MAX_OUTPUT_CHARS);
		const items = Array.from({ length: 30 }, (_, index) => ({
			index,
			status: 'error' as const,
			error: {
				code: 'HF_FS_INVALID_ARGUMENT' as const,
				message: `EINVAL: ${oversized}`,
				recovery: oversized,
				retryable: false as const,
			},
		}));

		const structured = toHfFsBatchResult(items);
		expect(JSON.stringify(structured).length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(structured).toMatchObject({
			truncated: true,
			truncation_reason: 'output_budget',
		});
		expect(structured.results[0]).toMatchObject({
			index: 0,
			status: 'error',
			error: {
				code: 'HF_FS_INVALID_ARGUMENT',
				retryable: false,
			},
		});
		expect(structured.results[0]?.status === 'error' && structured.results[0].error.message.length).toBeLessThanOrEqual(
			512
		);
		expect(HF_FS_TOOL_CONFIG.outputSchema.parse(structured)).toEqual(structured);
	});

	it('reserves the cumulative attachment budget before downloading later images', async () => {
		const firstPath = 'first.png';
		const secondPath = 'second.png';
		let releaseSecondStat: (() => void) | undefined;
		const secondStatGate = new Promise<void>((resolve) => {
			releaseSecondStat = resolve;
		});
		vi.mocked(pathsInfo).mockImplementation(async ({ paths }) => {
			const path = paths[0] ?? '';
			if (path === secondPath) {
				await secondStatGate;
			}
			return [{ path, type: 'file', size: path === firstPath ? HF_FS_ATTACH_MAX_BYTES : 1 }];
		});
		vi.mocked(downloadFile).mockImplementation(({ path }) => {
			releaseSecondStat?.();
			return Promise.resolve(new Blob([new Uint8Array(path === firstPath ? HF_FS_ATTACH_MAX_BYTES : 1)]));
		});

		const results = await new HfFsTool().runBatch({
			operations: [
				{ cmd: 'attach', args: [`hf://models/org/repo/${firstPath}`] },
				{ cmd: 'attach', args: [`hf://models/org/repo/${secondPath}`] },
			],
		});

		expect(results[0]).toMatchObject({ index: 0, status: 'success' });
		expect(results[1]).toMatchObject({
			index: 1,
			status: 'error',
			error: {
				code: 'HF_FS_ATTACHMENT_BUDGET_EXCEEDED',
				suggestedOperation: 'attach',
			},
		});
		expect(results[1]?.status === 'error' ? results[1].error.message : '').toContain('Attachment omitted');
		expect(results[1]?.status === 'error' ? results[1].error.recovery : '').toContain('separate hf_fs call');
		expect(downloadFile).toHaveBeenCalledOnce();
	});

	it('lists entries recursively with glob, type filter, offset, and limit', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries([
				{ type: 'directory', path: 'weights', size: 0 },
				{ type: 'file', path: 'weights/a.gguf', size: 10, lfs: { oid: '1', size: 10, pointerSize: 120 } },
				{ type: 'file', path: 'weights/b.safetensors', size: 20 },
				{ type: 'file', path: 'weights/c.gguf', size: 30 },
			])
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://models/org/repo/weights',
			recursive: true,
			glob: '*.gguf',
			entry_type: 'file',
			offset: 1,
			limit: 1,
		});

		expect(listFiles).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			path: 'weights',
			recursive: true,
			expand: false,
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/org/repo/weights',
			op: 'ls',
			entries: [{ type: 'file', path: 'weights/c.gguf', size: 30 }],
		});
		expectBatchOutputSchemaAccepts(result);
	});

	it('marks ls results truncated when another matching entry exists', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries([
				{ type: 'file', path: 'a.txt', size: 1 },
				{ type: 'file', path: 'b.txt', size: 2 },
			])
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			limit: 1,
		});

		expect(result).toEqual({
			uri: 'hf://datasets/org/repo',
			op: 'ls',
			entries: [{ type: 'file', path: 'a.txt', size: 1 }],
			truncated: true,
			truncation_reason: 'entry_limit',
			truncation_message: 'Result truncated after reaching the entry limit. Rerun with a larger --limit, up to 10000.',
		});
	});

	it('rejects zero list limits', async () => {
		vi.mocked(listFiles).mockReturnValue(entries([{ type: 'file', path: 'a.txt', size: 1 }]));

		await expect(
			new HfFsTool().run({
				op: 'ls',
				uri: 'hf://datasets/org/repo',
				limit: 0,
			})
		).rejects.toThrow('EINVAL: limit must be an integer between 1 and 10000');
		expect(listFiles).not.toHaveBeenCalled();
	});

	it('finds matching files in repository trees without routing through collection navigation', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries([
				{ type: 'directory', path: 'weights', size: 0 },
				{ type: 'file', path: 'weights/model.safetensors', size: 10 },
				{ type: 'file', path: 'weights/model.gguf', size: 20 },
				{ type: 'file', path: 'README.md', size: 30 },
			])
		);

		const result = await new HfFsTool('token').run({
			op: 'find',
			uri: 'hf://models/org/repo',
			entry_type: 'file',
			name: '*.gguf',
			path: 'weights/*',
			limit: 1,
		});

		expect(listFiles).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			recursive: true,
			expand: false,
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/org/repo',
			op: 'find',
			entries: [{ type: 'file', path: 'weights/model.gguf', size: 20 }],
		});
		expectBatchOutputSchemaAccepts(result);
	});

	it('finds file URIs by statting the file instead of listing it as a tree', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'weights/model.gguf', type: 'file', size: 20 }]);

		const result = await new HfFsTool('token').run({
			op: 'find',
			uri: 'hf://models/org/repo/weights/model.gguf',
			entry_type: 'file',
			name: '*.gguf',
			path: 'model.gguf',
		});

		expect(pathsInfo).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			paths: ['weights/model.gguf'],
			expand: true,
			accessToken: 'token',
		});
		expect(listFiles).not.toHaveBeenCalled();
		expect(result).toEqual({
			uri: 'hf://models/org/repo/weights/model.gguf',
			op: 'find',
			entries: [{ type: 'file', path: 'weights/model.gguf', size: 20 }],
		});
	});

	it('keeps complete structured ls results while truncating the markdown view', async () => {
		vi.mocked(listFiles).mockReturnValue(
			entries(
				Array.from({ length: 100 }, (_, index) => ({
					type: 'file',
					path: `${index.toString().padStart(3, '0')}-${'nested/'.repeat(240)}file.txt`,
					size: index,
				}))
			)
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			limit: 100,
		});

		if (result.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(result.entries).toHaveLength(100);
		expect(result.truncated).toBeUndefined();
		const markdown = formatHfFsMarkdown(result);
		expect(markdown.length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(markdown).toContain('Markdown view truncated');
	});

	it('renders available structured entry metadata in markdown details', () => {
		const markdown = formatHfFsMarkdown({
			uri: 'hf://models',
			op: 'search',
			entries: [
				{
					type: 'repo',
					path: 'owner/model',
					uri: 'hf://models/owner/model',
					likes: 123,
					downloads: 456,
					trending_score: 12.5,
					category: 'Code Generation',
					semantic_relevance: 0.875,
					published_at: '2026-07-02T00:00:00.000Z',
					daily_papers_uri: 'hf://papers/daily/2026/07/02',
					content_type: 'application/json',
				},
			],
		});

		expect(markdown).toContain('likes=123');
		expect(markdown).toContain('downloads=456');
		expect(markdown).toContain('trending score=12.5');
		expect(markdown).toContain('category=Code Generation');
		expect(markdown).toContain('semantic relevance=87.5%');
		expect(markdown).toContain('published=2026-07-02T00:00:00.000Z');
		expect(markdown).toContain('daily papers uri=hf://papers/daily/2026/07/02');
		expect(markdown).toContain('content type=application/json');
	});

	it('lists model repositories for a namespace', async () => {
		vi.mocked(listModels).mockReturnValue(
			entries([
				{
					id: '1',
					name: 'openai/gpt-oss-120b',
					private: false,
					gated: false,
					task: 'text-generation',
					likes: 4937,
					downloads: 4_073_251,
					updatedAt: new Date('2025-08-26T17:25:03.000Z'),
				},
				{
					id: '2',
					name: 'openai/whisper-large-v3',
					private: false,
					gated: false,
					task: 'automatic-speech-recognition',
					likes: 5898,
					downloads: 5_778_052,
					updatedAt: new Date('2024-08-12T10:20:10.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://models/openai',
			glob: 'gpt-*',
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'openai' },
			sort: 'lastModified',
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/openai',
			op: 'ls',
			entries: [
				{
					type: 'repo',
					path: 'openai/gpt-oss-120b',
					uri: 'hf://models/openai/gpt-oss-120b',
					repo_type: 'model',
					private: false,
					gated: false,
					likes: 4937,
					downloads: 4_073_251,
					task: 'text-generation',
					updated_at: '2025-08-26T17:25:03.000Z',
				},
			],
		});
	});

	it('honors requested sort order for namespace listings', async () => {
		vi.mocked(listModels).mockReturnValue(entries([]) as ReturnType<typeof listModels>);

		await new HfFsTool().run({
			cmd: 'ls',
			args: ['hf://models/openai', '--sort', 'downloads'],
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'openai' },
			sort: 'downloads',
			limit: 1001,
		});
	});

	it('keeps scanning namespace repositories before applying glob filters locally', async () => {
		vi.mocked(listModels).mockReturnValue(
			entries([
				{
					id: '1',
					name: 'org/recent-diffusion',
					private: false,
					gated: false,
					task: 'text-to-image',
					likes: 10,
					downloads: 20,
					updatedAt: new Date('2025-08-26T17:25:03.000Z'),
				},
				{
					id: '2',
					name: 'org/older-bert',
					private: false,
					gated: false,
					task: 'fill-mask',
					likes: 30,
					downloads: 40,
					updatedAt: new Date('2024-08-12T10:20:10.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		const result = await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://models/org',
			glob: '*bert*',
			limit: 1,
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'org' },
			sort: 'lastModified',
		});
		expect(result).toMatchObject({
			entries: [{ path: 'org/older-bert' }],
		});
	});

	it('limits namespace repository scans when no glob filter is applied', async () => {
		vi.mocked(listModels).mockReturnValue(entries([]) as ReturnType<typeof listModels>);

		await new HfFsTool().run({
			op: 'ls',
			uri: 'hf://models/org',
			offset: 3,
			limit: 5,
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { owner: 'org' },
			sort: 'lastModified',
			limit: 9,
		});
	});

	it('lists buckets for a namespace', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{
						_id: 'bucket-id',
						id: 'evalstate/skills',
						author: 'evalstate',
						private: false,
						createdAt: '2026-05-31T09:53:36.000Z',
						updatedAt: '2026-05-31T09:53:58.030Z',
						size: 4_527_050,
						totalFiles: 133,
						repoType: 'bucket',
						cdnRegions: [],
					},
				])
			)
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://buckets/evalstate',
		});

		expect(fetch).toHaveBeenCalledWith(
			'https://huggingface.co/api/buckets/evalstate',
			expect.objectContaining({ redirect: 'manual' })
		);
		const bucketFetchInit = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
		const bucketFetchHeaders = new Headers(bucketFetchInit.headers);
		expect(bucketFetchHeaders.get('accept')).toBe('application/json');
		expect(bucketFetchHeaders.get('authorization')).toBe('Bearer token');
		expect(result).toEqual({
			uri: 'hf://buckets/evalstate',
			op: 'ls',
			entries: [
				{
					type: 'bucket',
					path: 'evalstate/skills',
					uri: 'hf://buckets/evalstate/skills',
					repo_type: 'bucket',
					private: false,
					size: 4_527_050,
					total_files: 133,
					created_at: '2026-05-31T09:53:36.000Z',
					updated_at: '2026-05-31T09:53:58.030Z',
				},
			],
		});
	});

	it('lists the top-level hf namespace', async () => {
		await expect(new HfFsTool().run({ op: 'ls', uri: 'hf://' })).resolves.toEqual({
			uri: 'hf://',
			op: 'ls',
			entries: [
				{
					type: 'file',
					path: 'README.md',
					name: 'README.md',
					uri: 'hf://README.md',
					content_type: 'text/markdown',
				},
				{ type: 'dir', path: 'models', name: 'models', uri: 'hf://models' },
				{ type: 'dir', path: 'datasets', name: 'datasets', uri: 'hf://datasets' },
				{ type: 'dir', path: 'spaces', name: 'spaces', uri: 'hf://spaces' },
				{ type: 'dir', path: 'buckets', name: 'buckets', uri: 'hf://buckets' },
				{ type: 'dir', path: 'collections', name: 'collections', uri: 'hf://collections' },
				{ type: 'dir', path: 'papers', name: 'papers', uri: 'hf://papers' },
				{ type: 'dir', path: 'docs', name: 'docs', uri: 'hf://docs' },
			],
		});
	});

	it('exposes repository trending virtual directories', async () => {
		await expect(
			new HfFsTool().run({
				cmd: 'ls',
				args: ['hf://models'],
			})
		).resolves.toEqual({
			uri: 'hf://models',
			op: 'ls',
			entries: [
				{
					type: 'dir',
					path: 'trending',
					name: 'trending',
					uri: 'hf://models/trending',
					description: 'Browse the 20 currently trending models.',
				},
			],
		});
		await expect(
			new HfFsTool().run({
				cmd: 'stat',
				args: ['hf://spaces/trending'],
			})
		).resolves.toEqual({
			uri: 'hf://spaces/trending',
			op: 'stat',
			exists: true,
			type: 'dir',
			path: 'trending',
		});
	});

	it('lists the dedicated repository trending feed and reports softened arguments', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					recentlyTrending: [
						{
							repoType: 'model',
							repoData: {
								id: 'org/trending-model',
								repoType: 'model',
								private: false,
								gated: false,
								likes: 42,
								downloads: 1000,
								pipeline_tag: 'text-generation',
								lastModified: '2026-07-13T10:00:00.000Z',
							},
						},
					],
				})
			)
		);

		const result = await new HfFsTool('token').run({
			cmd: 'ls',
			args: ['hf://models/trending', '--sort', 'trending', '--type', 'model'],
		});

		expect(fetch).toHaveBeenCalledWith(
			'https://huggingface.co/api/trending?type=model&limit=20',
			expect.objectContaining({ redirect: 'manual' })
		);
		expect(result).toEqual({
			uri: 'hf://models/trending',
			op: 'ls',
			entries: [
				{
					type: 'repo',
					path: 'org/trending-model',
					uri: 'hf://models/org/trending-model',
					repo_type: 'model',
					private: false,
					gated: false,
					likes: 42,
					downloads: 1000,
					task: 'text-generation',
					updated_at: '2026-07-13T10:00:00.000Z',
				},
			],
			warnings: [
				'Ignored --sort trending because hf://models/trending already implies trending order.',
				'Ignored --type repo because hf://models/trending contains only repositories.',
			],
		});
		expect(formatHfFsMarkdown(result)).toContain('## Warnings');
	});

	it('lists collections through hf_fs', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{
						name: 'huggingface/agents-course-0123456789abcdef01234567',
						title: 'Agents Course',
						private: false,
						upvotes: 123,
					},
				]),
				{ headers: { 'content-type': 'application/json' } }
			)
		);

		const result = await new HfFsTool('token').run({
			op: 'ls',
			uri: 'hf://collections/huggingface',
			entry_type: 'collection',
			limit: 20,
		});

		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('/api/collections?'),
			expect.objectContaining({ redirect: 'manual' })
		);
		if (result.op !== 'ls') {
			throw new Error('Expected ls result');
		}
		expect(result.entries).toEqual([
			{
				type: 'collection',
				name: 'agents-course-0123456789abcdef01234567',
				path: 'agents-course-0123456789abcdef01234567',
				uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567',
				title: 'Agents Course',
				private: false,
				upvotes: 123,
			},
		]);
		expectBatchOutputSchemaAccepts(result);
		expect(formatHfFsMarkdown(result)).toContain('# hf_fs ls');
	});

	it('does not route collection-like URI types through collection navigation', async () => {
		await expect(new HfFsTool().run({ op: 'ls', uri: 'hf://collections:local/workspace' })).rejects.toThrow(
			"Invalid URI type 'collections:local'"
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('returns no collection listing entries for the paper entry type', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{
						name: 'huggingface/agents-course-0123456789abcdef01234567',
						title: 'Agents Course',
					},
				])
			)
		);

		await expect(
			new HfFsTool().run({
				op: 'ls',
				uri: 'hf://collections/huggingface',
				entry_type: 'paper',
			})
		).resolves.toEqual({
			uri: 'hf://collections/huggingface',
			op: 'ls',
			entries: [],
		});
	});

	it('returns no collection find entries for the paper entry type', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					slug: 'agents-course-0123456789abcdef01234567',
					owner: { name: 'huggingface' },
					items: [{ type: 'paper', id: '1706.03762', position: 0 }],
				})
			)
		);

		await expect(
			new HfFsTool().run({
				op: 'find',
				uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567',
				entry_type: 'paper',
			})
		).resolves.toEqual({
			uri: 'hf://collections/huggingface/agents-course-0123456789abcdef01234567',
			op: 'find',
			entries: [],
		});
	});

	it('rejects zero collection limits before requesting the provider', async () => {
		await expect(
			new HfFsTool('token').run({
				op: 'ls',
				uri: 'hf://collections/huggingface',
				limit: 0,
			})
		).rejects.toThrow('EINVAL: limit must be an integer between 1 and 10000');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('searches global model discovery roots', async () => {
		vi.mocked(listModels).mockReturnValue(
			entries([
				{
					id: '1',
					name: 'google/gemma-2-2b',
					private: false,
					gated: false,
					task: 'text-generation',
					likes: 100,
					downloads: 200,
					updatedAt: new Date('2025-01-02T03:04:05.000Z'),
				},
				{
					id: '2',
					name: 'google/gemma-2-9b',
					private: false,
					gated: false,
					task: 'text-generation',
					likes: 90,
					downloads: 180,
					updatedAt: new Date('2025-01-03T03:04:05.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		const result = await new HfFsTool('token').run({
			op: 'search',
			uri: 'hf://models',
			query: 'gemma',
			sort: 'downloads',
			limit: 1,
		});

		expect(listModels).toHaveBeenCalledWith({
			search: { query: 'gemma' },
			sort: 'downloads',
			limit: 2,
			accessToken: 'token',
		});
		expect(result).toMatchObject({
			uri: 'hf://models',
			op: 'search',
			entries: [{ type: 'repo', path: 'google/gemma-2-2b', uri: 'hf://models/google/gemma-2-2b' }],
			truncated: true,
			truncation_reason: 'limit',
		});
	});

	it('semantically searches Spaces with tag and MCP filters', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json([
				{
					id: 'org/python-mcp',
					private: false,
					likes: 42,
					sdk: 'gradio',
					title: 'Python MCP',
					ai_short_description: 'Run Python code and get results',
					ai_category: 'Code Generation',
					trendingScore: 3,
					semanticRelevancyScore: 0.91,
					tags: ['gradio', 'mcp-server'],
					lastModified: '2026-07-14T00:00:00.000Z',
				},
				{
					id: 'org/other-mcp',
					semanticRelevancyScore: 0.8,
					tags: ['gradio', 'mcp-server'],
				},
			])
		);

		const result = await new HfFsTool('token').run({
			op: 'search',
			uri: 'hf://spaces',
			query: 'python execution',
			tags: ['gradio'],
			space_kind: 'mcp',
			limit: 1,
		});

		const fetchInput = vi.mocked(fetch).mock.calls[0]?.[0];
		expect(typeof fetchInput).toBe('string');
		if (typeof fetchInput !== 'string') throw new Error('Expected fetch to receive a URL string');
		const requestUrl = new URL(fetchInput);
		expect(requestUrl.pathname).toBe('/api/spaces/semantic-search');
		expect(requestUrl.searchParams.get('q')).toBe('python execution');
		expect(requestUrl.searchParams.getAll('filter')).toEqual(['gradio', 'mcp-server']);
		expect(result).toMatchObject({
			uri: 'hf://spaces',
			op: 'search',
			entries: [
				{
					type: 'repo',
					path: 'org/python-mcp',
					uri: 'hf://spaces/org/python-mcp',
					title: 'Python MCP',
					description: 'Run Python code and get results',
					category: 'Code Generation',
					semantic_relevance: 0.91,
					tags: ['gradio', 'mcp-server'],
				},
			],
			truncated: true,
			truncation_reason: 'limit',
		});
		expect(listSpaces).not.toHaveBeenCalled();
	});

	it('supports queryless repository discovery and filtered Space search', async () => {
		vi.mocked(listModels).mockReturnValueOnce(
			entries([
				{
					id: '1',
					name: 'google/gemma-2-2b',
					private: false,
					gated: false,
					task: 'text-generation',
					likes: 100,
					downloads: 200,
					updatedAt: new Date('2025-01-02T03:04:05.000Z'),
				},
			]) as ReturnType<typeof listModels>
		);

		await new HfFsTool('token').run({
			cmd: 'search',
			args: ['hf://models', '--sort', 'downloads', '--limit', '1'],
		});

		expect(listModels).toHaveBeenCalledWith({
			search: {},
			sort: 'downloads',
			limit: 2,
			accessToken: 'token',
		});

		vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));
		await new HfFsTool('token').run({
			cmd: 'search',
			args: ['hf://spaces', '--kind', 'mcp', '--limit', '5'],
		});
		const fetchInput = vi.mocked(fetch).mock.calls.at(-1)?.[0];
		expect(typeof fetchInput).toBe('string');
		if (typeof fetchInput !== 'string') throw new Error('Expected fetch to receive a URL string');
		const requestUrl = new URL(fetchInput);
		expect(requestUrl.pathname).toBe('/api/spaces/semantic-search');
		expect(requestUrl.searchParams.get('q')).toBe('');
		expect(requestUrl.searchParams.getAll('filter')).toEqual(['mcp-server']);
	});

	it('requires an explicit owner for namespace listings regardless of authentication', async () => {
		await expect(new HfFsTool('token').run({ op: 'ls', uri: 'hf://buckets' })).rejects.toThrow(
			'Listing buckets requires an explicit owner. Use hf://buckets/<owner>.'
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('stats repo roots, files, directories, and missing paths', async () => {
		const tool = new HfFsTool();
		vi.mocked(spaceInfo).mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof spaceInfo>>);

		await expect(tool.run({ op: 'stat', uri: 'hf://spaces/org/repo' })).resolves.toEqual({
			uri: 'hf://spaces/org/repo',
			op: 'stat',
			exists: true,
			type: 'repo',
			path: '',
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 42 }]);
		await expect(tool.run({ op: 'stat', uri: 'hf://spaces/org/repo/README.md' })).resolves.toEqual({
			uri: 'hf://spaces/org/repo/README.md',
			op: 'stat',
			exists: true,
			type: 'file',
			path: 'README.md',
			size: 42,
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'data', type: 'directory', size: 0 }]);
		await expect(tool.run({ op: 'stat', uri: 'hf://datasets/org/repo/data' })).resolves.toMatchObject({
			exists: true,
			type: 'dir',
			path: 'data',
		});

		vi.mocked(pathsInfo).mockResolvedValueOnce([]);
		await expect(tool.run({ op: 'stat', uri: 'hf://datasets/org/repo/missing.txt' })).resolves.toEqual({
			uri: 'hf://datasets/org/repo/missing.txt',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: 'missing.txt',
		});
	});

	it.each(['hf://models', 'hf://datasets', 'hf://spaces'])(
		'stats the virtual discovery root %s without probing the Hub',
		async (uri) => {
			await expect(new HfFsTool('token').run({ op: 'stat', uri })).resolves.toEqual({
				uri,
				op: 'stat',
				exists: true,
				type: 'dir',
				path: '',
			});
			expect(modelInfo).not.toHaveBeenCalled();
			expect(datasetInfo).not.toHaveBeenCalled();
			expect(spaceInfo).not.toHaveBeenCalled();
			expect(pathsInfo).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		}
	);

	it('probes repo roots before reporting them as existing', async () => {
		vi.mocked(modelInfo).mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof modelInfo>>);

		await expect(new HfFsTool('token').run({ op: 'stat', uri: 'hf://models/org/repo' })).resolves.toEqual({
			uri: 'hf://models/org/repo',
			op: 'stat',
			exists: true,
			type: 'repo',
			path: '',
		});
		const modelInfoParams = vi.mocked(modelInfo).mock.calls[0]?.[0];
		expect(modelInfoParams).toMatchObject({
			name: 'org/repo',
			accessToken: 'token',
		});
		expect(typeof modelInfoParams?.fetch).toBe('function');
	});

	it('reports missing repo roots as missing', async () => {
		vi.mocked(modelInfo).mockRejectedValueOnce(new HubApiError('https://huggingface.co/api/models/org/missing', 404));

		await expect(new HfFsTool().run({ op: 'stat', uri: 'hf://models/org/missing' })).resolves.toEqual({
			uri: 'hf://models/org/missing',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: '',
		});
	});

	it('reports repo roots with missing revisions as missing', async () => {
		vi.mocked(modelInfo).mockRejectedValueOnce(new HubApiError('https://huggingface.co/api/models/org/repo', 404));

		await expect(new HfFsTool().run({ op: 'stat', uri: 'hf://models/org/repo@missing-revision' })).resolves.toEqual({
			uri: 'hf://models/org/repo@missing-revision',
			op: 'stat',
			exists: false,
			type: 'missing',
			path: '',
		});
		const modelInfoParams = vi.mocked(modelInfo).mock.calls[0]?.[0];
		expect(modelInfoParams).toMatchObject({
			name: 'org/repo',
			revision: 'missing-revision',
		});
		expect(typeof modelInfoParams?.fetch).toBe('function');
	});

	it('reads exact file byte ranges for cat', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 11 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello world']));

		const result = await new HfFsTool('token').run({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			offset: 6,
			max_bytes: 3,
		});

		expect(downloadFile).toHaveBeenCalledWith({
			repo: { type: 'model', name: 'org/repo' },
			path: 'README.md',
			accessToken: 'token',
		});
		expect(result).toEqual({
			uri: 'hf://models/org/repo/README.md',
			op: 'cat',
			path: 'README.md',
			content: 'wor',
			bytes: 3,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 9,
		});
	});

	it('treats max_bytes 0 as the maximum allowed byte count', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'README.md', type: 'file', size: 11 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello world']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			max_bytes: 0,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/README.md',
			op: 'cat',
			path: 'README.md',
			content: 'hello world',
			bytes: 11,
			truncated: false,
		});
	});

	it('extends cat ranges to avoid splitting trailing UTF-8 characters', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'unicode.txt', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['a€b']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/unicode.txt',
			max_bytes: 2,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/unicode.txt',
			op: 'cat',
			path: 'unicode.txt',
			content: 'a€',
			bytes: 4,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 4,
		});
	});

	it('extends cat ranges to avoid splitting leading UTF-8 characters', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'unicode.txt', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['a€b']));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/unicode.txt',
			offset: 2,
			max_bytes: 1,
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/unicode.txt',
			op: 'cat',
			path: 'unicode.txt',
			content: '€',
			bytes: 3,
			truncated: true,
			truncation_reason: 'max_bytes',
			next_offset: 4,
		});
	});

	it('refuses to cat known binary file extensions before downloading', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'model.safetensors', type: 'file', size: 100 }]);

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/model.safetensors',
			})
		).rejects.toThrow('Refusing to cat non-text file: model.safetensors');

		expect(downloadFile).not.toHaveBeenCalled();
	});

	it('refuses to cat unknown files containing NUL bytes', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'artifact.unknown', type: 'file', size: 5 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([new Uint8Array([65, 0, 66, 67, 68])]));

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/artifact.unknown',
			})
		).rejects.toThrow('contains NUL bytes');
	});

	it('refuses to cat unknown files that are not valid UTF-8 text', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'artifact.unknown', type: 'file', size: 3 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([new Uint8Array([0xff, 0xfe, 0xfd])]));

		await expect(
			new HfFsTool('token').run({
				op: 'cat',
				uri: 'hf://models/org/repo/artifact.unknown',
			})
		).rejects.toThrow('not valid UTF-8 text');
	});

	it('cats unknown extensions when byte sniffing confirms UTF-8 text', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'modelcard.unknown', type: 'file', size: 12 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['hello\nworld\n']));

		const result = await new HfFsTool('token').run({
			op: 'cat',
			uri: 'hf://models/org/repo/modelcard.unknown',
		});

		expect(result).toEqual({
			uri: 'hf://models/org/repo/modelcard.unknown',
			op: 'cat',
			path: 'modelcard.unknown',
			content: 'hello\nworld\n',
			bytes: 12,
			truncated: false,
		});
	});

	it('keeps complete structured cat content while truncating the markdown view', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'large.txt', type: 'file', size: 120_000 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['x'.repeat(120_000)]));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/large.txt',
			max_bytes: 80_000,
		});

		if (result.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(result.truncated).toBe(true);
		expect(result.truncation_reason).toBe('max_bytes');
		expect(result.bytes).toBe(80_000);
		expect(result.content).toHaveLength(80_000);
		expect(result.next_offset).toBe(80_000);
		const markdown = formatHfFsMarkdown(result);
		expect(markdown.length).toBeLessThanOrEqual(HF_FS_MAX_OUTPUT_CHARS);
		expect(markdown).toContain('Markdown view truncated');
	});

	it('reports cat max-byte continuation offsets from the requested offset', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'large.txt', type: 'file', size: 120_050 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob(['x'.repeat(120_050)]));

		const result = await new HfFsTool().run({
			op: 'cat',
			uri: 'hf://models/org/repo/large.txt',
			offset: 50,
			max_bytes: 80_000,
		});

		if (result.op !== 'cat') {
			throw new Error('Expected cat result');
		}
		expect(result.truncated).toBe(true);
		expect(result.truncation_reason).toBe('max_bytes');
		expect(result.bytes).toBe(80_000);
		expect(result.next_offset).toBe(80_050);
	});

	it.each([
		['photo.jpg', 'image/jpeg'],
		['photo.JPEG', 'image/jpeg'],
		['photo.PNG', 'image/png'],
		['photo.WeBp', 'image/webp'],
	] as const)('classifies attach extension %s as %s without inspecting bytes', async (filePath, mimeType) => {
		const opaqueBytes = Uint8Array.from([0, 255, 1, 2, 3]);
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: filePath, type: 'file', size: opaqueBytes.byteLength }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([opaqueBytes]));

		const result = await new HfFsTool('token').run({
			op: 'attach',
			uri: `hf://models/org/repo/${filePath}`,
		});

		expect(isHfFsAttachExecutionResult(result)).toBe(true);
		if (!isHfFsAttachExecutionResult(result)) {
			throw new Error('Expected attach execution result');
		}
		expect(result.metadata).toEqual({
			op: 'attach',
			uri: `hf://models/org/repo/${filePath}`,
			path: filePath,
			mime_type: mimeType,
			bytes: opaqueBytes.byteLength,
		});
		expect(result.data).toEqual(opaqueBytes);
		expect(result.data).toBeInstanceOf(Uint8Array);
		expect(Object.keys(result)).toEqual(['metadata', 'data']);
	});

	it.each([
		[
			'hf://models/org/repo@refs/pr/3/images/cat.png',
			{ type: 'model', name: 'org/repo' },
			'images/cat.png',
			'refs/pr/3',
		],
		[
			'hf://buckets/org/bucket/images/cat%201.png',
			{ type: 'bucket', name: 'org/bucket' },
			'images/cat 1.png',
			undefined,
		],
	] as const)('propagates the attach designation, path, and revision for %s', async (uri, repo, filePath, revision) => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: filePath, type: 'file', size: 1 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([Uint8Array.of(1)]));

		await new HfFsTool('token').run({ op: 'attach', uri });

		expect(pathsInfo).toHaveBeenCalledWith({
			repo,
			paths: [filePath],
			expand: true,
			accessToken: 'token',
			...(revision ? { revision } : {}),
		});
		expect(downloadFile).toHaveBeenCalledWith({
			repo,
			path: filePath,
			accessToken: 'token',
			...(revision ? { revision } : {}),
		});
	});

	it('passes one abort-aware fetch to attach stat and download and combines SDK request signals', async () => {
		const abortController = new AbortController();
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 1 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([Uint8Array.of(1)]));

		await new HfFsTool('token', undefined, abortController.signal).run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
		});

		const pathsFetch = vi.mocked(pathsInfo).mock.calls[0]?.[0].fetch;
		const downloadFetch = vi.mocked(downloadFile).mock.calls[0]?.[0].fetch;
		expect(pathsFetch).toBeTypeOf('function');
		expect(downloadFetch).toBe(pathsFetch);
		if (!pathsFetch) {
			throw new Error('Expected attach calls to receive a custom fetch');
		}

		const sdkAbortController = new AbortController();
		await pathsFetch('https://huggingface.co/test', { signal: sdkAbortController.signal });
		const combinedSdkSignal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
		expect(combinedSdkSignal).not.toBe(sdkAbortController.signal);
		expect(combinedSdkSignal).not.toBe(abortController.signal);
		sdkAbortController.abort();
		expect(combinedSdkSignal?.aborted).toBe(true);

		const secondSdkAbortController = new AbortController();
		await pathsFetch('https://huggingface.co/test', { signal: secondSdkAbortController.signal });
		const combinedMcpSignal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
		abortController.abort();
		expect(combinedMcpSignal?.aborted).toBe(true);
	});

	it.each([
		['README.md', 'HF_FS_IMAGE_ONLY'],
		['animation.gif', 'HF_FS_UNSUPPORTED_MEDIA'],
		['weights.safetensors', 'HF_FS_UNSUPPORTED_MEDIA'],
		['artifact.unknown', 'HF_FS_UNSUPPORTED_MEDIA'],
	] as const)('rejects unsupported attach path %s with %s before stat or download', async (filePath, expectedCode) => {
		try {
			await new HfFsTool().run({
				op: 'attach',
				uri: `hf://models/org/repo/${filePath}`,
			});
			throw new Error('Expected attach to reject');
		} catch (error) {
			expect(classifyHfFsError(error)?.code).toBe(expectedCode);
		}
		expect(pathsInfo).not.toHaveBeenCalled();
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it('rejects known stat oversize before download and accepts the exact hard boundary', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([
			{ path: 'too-large.png', type: 'file', size: HF_FS_ATTACH_MAX_BYTES + 1 },
		]);
		const tooLarge = new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/too-large.png',
		});
		await expect(tooLarge).rejects.toThrow('Image is too large to attach');
		await expect(tooLarge).rejects.toMatchObject({ code: 'HF_FS_IMAGE_TOO_LARGE' });
		expect(downloadFile).not.toHaveBeenCalled();

		const boundaryBytes = new Uint8Array(HF_FS_ATTACH_MAX_BYTES);
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'boundary.png', type: 'file', size: HF_FS_ATTACH_MAX_BYTES }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([boundaryBytes]));
		const boundary = await new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/boundary.png',
		});
		expect(boundary.metadata.bytes).toBe(HF_FS_ATTACH_MAX_BYTES);
		expect(boundary.data.byteLength).toBe(HF_FS_ATTACH_MAX_BYTES);
	});

	it('classifies invalid stat and Blob sizes as attachment integrity failures', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'invalid.png', type: 'file', size: -1 }]);
		const invalidStat = new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/invalid.png',
		});
		await expect(invalidStat).rejects.toMatchObject({ code: 'HF_FS_ATTACHMENT_INTEGRITY' });
		expect(classifyHfFsError(await invalidStat.catch((error: unknown) => error))).toMatchObject({
			code: 'HF_FS_ATTACHMENT_INTEGRITY',
			suggestedOperation: 'stat',
		});
		expect(downloadFile).not.toHaveBeenCalled();

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'invalid.png', type: 'file', size: 1 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce({
			size: Number.NaN,
			stream: vi.fn(),
		} as unknown as Blob);
		await expect(
			new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/invalid.png',
			})
		).rejects.toMatchObject({ code: 'HF_FS_ATTACHMENT_INTEGRITY' });
	});

	it('checks lazy Blob.size before consuming the payload', async () => {
		const stream = vi.fn(() => new ReadableStream<Uint8Array>());
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.webp', type: 'file', size: 1 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce({
			size: HF_FS_ATTACH_MAX_BYTES + 1,
			stream,
		} as unknown as Blob);

		await expect(
			new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/image.webp',
			})
		).rejects.toThrow('Image is too large to attach');
		expect(stream).not.toHaveBeenCalled();
	});

	it('enforces a lower complete-file max without truncating', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 4 }]);
		await expect(
			new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/image.png',
				max_bytes: 3,
			})
		).rejects.toThrow('complete-file limit is 3 bytes');
		expect(downloadFile).not.toHaveBeenCalled();

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 3 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(new Blob([Uint8Array.from([1, 2, 3])]));
		const exact = await new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
			max_bytes: 3,
		});
		expect(exact.data).toEqual(Uint8Array.from([1, 2, 3]));
	});

	it('cancels and rejects a stream that overruns its declared Blob.size', async () => {
		const cancel = vi.fn();
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 2 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(createStreamingBlob(2, [Uint8Array.from([1, 2, 3])], cancel, false));

		const run = new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
		});
		await expect(run).rejects.toThrow('exceeded its declared Blob size');
		await expect(run).rejects.toMatchObject({ code: 'HF_FS_ATTACHMENT_INTEGRITY' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('keeps stream overruns above the configured limit classified as too large', async () => {
		const cancel = vi.fn();
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 2 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(createStreamingBlob(2, [Uint8Array.from([1, 2, 3])], cancel, false));

		const run = new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
			max_bytes: 2,
		});
		await expect(run).rejects.toMatchObject({ code: 'HF_FS_IMAGE_TOO_LARGE' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('rejects a stream that ends before its declared Blob.size', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 3 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(createStreamingBlob(3, [Uint8Array.from([1, 2])]));

		const run = new HfFsTool().run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
		});
		await expect(run).rejects.toThrow('ended after 2 bytes; expected 3 bytes');
		await expect(run).rejects.toMatchObject({ code: 'HF_FS_ATTACHMENT_INTEGRITY' });
	});

	it('promptly rejects and cancels a pending attachment stream when aborted', async () => {
		const abortController = new AbortController();
		const cancel = vi.fn();
		const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');
		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'image.png', type: 'file', size: 1 }]);
		vi.mocked(downloadFile).mockResolvedValueOnce(createStreamingBlob(1, [], cancel, false));

		const run = new HfFsTool(undefined, undefined, abortController.signal).run({
			op: 'attach',
			uri: 'hf://models/org/repo/image.png',
		});
		await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
		const abortReason = new DOMException('MCP request cancelled', 'AbortError');
		abortController.abort(abortReason);

		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await expect(
				Promise.race([
					run,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error('Attachment abort did not reject promptly')), 100);
					}),
				])
			).rejects.toBe(abortReason);
		} finally {
			clearTimeout(timeout);
		}
		expect(cancel).toHaveBeenCalledWith(abortReason);
		expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('applies canonical attach argument and direct-file validation', async () => {
		await expect(
			new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/image.png',
				offset: 1,
			})
		).rejects.toThrow('offset is not valid for attach');
		await expect(new HfFsTool().run({ op: 'attach', uri: 'hf://docs/transformers/image.png' })).rejects.toThrow(
			'attach requires a direct repository or bucket file URI'
		);
		await expect(new HfFsTool().run({ op: 'attach', uri: 'hf://models/org/repo' })).rejects.toThrow(
			'attach requires a direct repository or bucket file URI'
		);
		expect(pathsInfo).not.toHaveBeenCalled();
		expect(downloadFile).not.toHaveBeenCalled();
	});

	it('uses existing not-found and not-a-file attachment errors', async () => {
		vi.mocked(pathsInfo).mockResolvedValueOnce([]);
		try {
			await new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/missing.png',
			});
			throw new Error('Expected attach to reject');
		} catch (error) {
			expect(classifyHfFsError(error)?.code).toBe('HF_FS_NOT_FOUND');
		}

		vi.mocked(pathsInfo).mockResolvedValueOnce([{ path: 'directory.png', type: 'directory', size: 0 }]);
		try {
			await new HfFsTool().run({
				op: 'attach',
				uri: 'hf://models/org/repo/directory.png',
			});
			throw new Error('Expected attach to reject');
		} catch (error) {
			expect(classifyHfFsError(error)?.code).toBe('HF_FS_NOT_A_FILE');
		}
		expect(downloadFile).not.toHaveBeenCalled();
	});
});

describe('repository search recovery', () => {
	it.each(['models', 'datasets', 'spaces'])(
		'rejects %s repository scopes with file-discovery guidance',
		async (root) => {
			for (const suffix of ['example-owner/example-repo', 'example-owner/example-repo/README.md']) {
				await expect(
					new HfFsTool().run({ op: 'search', uri: `hf://${root}/${suffix}`, query: 'demo' })
				).rejects.toThrow(
					'Search a resource root or owner scope to discover resources; use find for file discovery by name/path (not file contents) or cat for a known text file'
				);
			}
		}
	);
});
