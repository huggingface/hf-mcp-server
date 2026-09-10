import { describe, expect, it } from 'vitest';

import {
	HF_FS_ATTACH_MAX_BYTES,
	HF_FS_BATCH_MAX_OPERATIONS,
	HF_FS_DESCRIPTION,
	HF_FS_OPERATION_SCHEMA,
	HF_FS_SCHEMA,
	parseHfFsRequest,
} from './hf-fs-contract.js';

describe('parseHfFsRequest', () => {
	it('requires a strict operations array with at most 30 items', () => {
		expect(
			HF_FS_SCHEMA.parse({
				operations: [{ cmd: 'stat', args: ['hf://models/org/repo'] }],
			})
		).toEqual({
			operations: [{ cmd: 'stat', args: ['hf://models/org/repo'] }],
		});
		expect(() => HF_FS_SCHEMA.parse({ operations: [] })).toThrow();
		expect(() =>
			HF_FS_SCHEMA.parse({
				operations: Array.from({ length: HF_FS_BATCH_MAX_OPERATIONS + 1 }, () => ({
					cmd: 'stat',
					args: ['hf://models/org/repo'],
				})),
			})
		).toThrow();
		expect(() =>
			HF_FS_SCHEMA.parse({
				operations: [{ cmd: 'stat', args: ['hf://models/org/repo'], extra: true }],
			})
		).toThrow();
		expect(() =>
			HF_FS_SCHEMA.parse({
				operations: [{ cmd: 'stat', args: ['hf://models/org/repo'] }],
				cmd: 'stat',
			})
		).toThrow();
	});

	it('parses command arguments into canonical parameters', () => {
		expect(
			parseHfFsRequest({
				cmd: 'find',
				args: ['hf://models/openai', '-type', 'model', '-name', '*.json', '--limit', '25'],
			})
		).toEqual({
			params: {
				op: 'find',
				uri: 'hf://models/openai',
				entry_type: 'repo',
				name: '*.json',
				limit: 25,
			},
			warnings: [],
		});
	});

	it('accepts recursive and type aliases', () => {
		expect(
			parseHfFsRequest({
				cmd: 'ls',
				args: ['ls', 'hf://datasets/org/repo', '-R', '--entry-type', 'f'],
			}).params
		).toEqual({
			op: 'ls',
			uri: 'hf://datasets/org/repo',
			recursive: true,
			entry_type: 'file',
		});
	});

	it('accepts harmless CLI compatibility aliases', () => {
		expect(
			parseHfFsRequest({
				cmd: 'ls',
				args: ['hf://models/org/repo', '-la', '--long', '-limit', '5'],
			}).params
		).toEqual({
			op: 'ls',
			uri: 'hf://models/org/repo',
			limit: 5,
		});
		for (const recursive of ['-R', '-r', '--recursive']) {
			expect(
				parseHfFsRequest({
					cmd: 'find',
					args: ['hf://models/org/repo', recursive, '--glob', '*.json', '-limit', '5'],
				}).params
			).toEqual({
				op: 'find',
				uri: 'hf://models/org/repo',
				name: '*.json',
				limit: 5,
			});
		}
		expect(
			parseHfFsRequest({
				cmd: 'cat',
				args: ['hf://models/org/repo/README.md', '-offset', '10', '-max-bytes', '20'],
			}).params
		).toEqual({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			offset: 10,
			max_bytes: 20,
		});
	});

	it('accepts combined long-list recursion flags', () => {
		for (const flag of ['-lR', '-laR']) {
			expect(
				parseHfFsRequest({
					cmd: 'ls',
					args: [flag, 'hf://models/org/repo'],
				}).params
			).toEqual({
				op: 'ls',
				uri: 'hf://models/org/repo',
				recursive: true,
			});
		}
	});

	it('joins relative cat and stat paths and multi-token search queries', () => {
		expect(
			parseHfFsRequest({
				cmd: 'cat',
				args: ['hf://models/org/repo', '/README.md', '--max-bytes', '100'],
			}).params
		).toEqual({
			op: 'cat',
			uri: 'hf://models/org/repo/README.md',
			max_bytes: 100,
		});
		expect(
			parseHfFsRequest({
				cmd: 'stat',
				args: ['hf://models/org/repo', 'model.safetensors.index.json'],
			}).params
		).toEqual({
			op: 'stat',
			uri: 'hf://models/org/repo/model.safetensors.index.json',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://models', 'vision', 'language', 'model', '--limit', '5'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://models',
			query: 'vision language model',
			limit: 5,
		});
	});

	it('parses attach with exactly one complete URI and an optional lowering limit', () => {
		expect(
			parseHfFsRequest({
				cmd: 'attach',
				args: ['hf://datasets/org/repo/images/example.PNG', '--max-bytes', '1024'],
			}).params
		).toEqual({
			op: 'attach',
			uri: 'hf://datasets/org/repo/images/example.PNG',
			max_bytes: 1024,
		});

		expect(() =>
			parseHfFsRequest({
				cmd: 'attach',
				args: ['hf://datasets/org/repo', 'images/example.png'],
			})
		).toThrow('unexpected argument for attach');
		expect(() =>
			parseHfFsRequest({
				cmd: 'attach',
				args: ['hf://datasets/org/repo/images/example.png', '--offset', '1'],
			})
		).toThrow('unexpected argument for attach');
		expect(() =>
			parseHfFsRequest({
				cmd: 'attach',
				args: ['hf://datasets/org/repo/images/example.png', '-max-bytes', '1'],
			})
		).toThrow('unexpected argument for attach');

		expect(
			parseHfFsRequest({
				cmd: 'attach',
				args: ['hf://datasets/org/repo/images/example.png', '--max-bytes', HF_FS_ATTACH_MAX_BYTES.toString()],
			}).params.max_bytes
		).toBe(HF_FS_ATTACH_MAX_BYTES);
	});

	it('allows queryless repository discovery but still requires docs and paper queries', () => {
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://spaces', '--kind', 'mcp', '-limit', '20'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://spaces',
			space_kind: 'mcp',
			limit: 20,
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://models/unsloth', '--sort', 'createdAt', '--limit', '20'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://models/unsloth',
			sort: 'createdAt',
			limit: 20,
		});
		expect(() => parseHfFsRequest({ cmd: 'search', args: ['hf://docs'] })).toThrow(
			'search requires a positional query or --query'
		);
		expect(() => parseHfFsRequest({ cmd: 'search', args: ['hf://papers'] })).toThrow(
			'search requires a positional query or --query'
		);
	});

	it('accepts positional and flagged search queries', () => {
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://models', 'vision language', '--sort', 'downloads'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://models',
			query: 'vision language',
			sort: 'downloads',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://datasets/org', '--query', 'speech'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://datasets/org',
			query: 'speech',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://docs/transformers', 'pipeline loading'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://docs/transformers',
			query: 'pipeline loading',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://docs/transformers/v5.13.1/internal/generation_utils.md', 'TextIteratorStreamer'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://docs/transformers/v5.13.1/internal/generation_utils.md',
			query: 'TextIteratorStreamer',
		});
		expect(
			parseHfFsRequest({
				cmd: 'search',
				args: ['hf://spaces', 'python execution', '--kind', 'mcp', '--tag', 'gradio', '--tag', 'region:us'],
			}).params
		).toEqual({
			op: 'search',
			uri: 'hf://spaces',
			query: 'python execution',
			space_kind: 'mcp',
			tags: ['gradio', 'region:us'],
		});
	});

	it('rejects Space semantic filters on unsupported scopes', () => {
		expect(() => parseHfFsRequest({ cmd: 'search', args: ['hf://spaces/alice', 'demo', '--kind', 'mcp'] })).toThrow(
			'--tag and --kind are supported only with search hf://spaces'
		);
		expect(() => parseHfFsRequest({ cmd: 'search', args: ['hf://spaces', 'demo', '--kind', 'agent'] })).toThrow(
			'Supported kinds: mcp'
		);
	});

	it('softens redundant trending arguments with warnings', () => {
		expect(
			parseHfFsRequest({
				cmd: 'ls',
				args: ['hf://spaces/trending', '--sort', 'trendingScore', '--type', 'space'],
			})
		).toEqual({
			params: {
				op: 'ls',
				uri: 'hf://spaces/trending',
			},
			warnings: [
				'Ignored --sort trendingScore because hf://spaces/trending already implies trending order.',
				'Ignored --type repo because hf://spaces/trending contains only repositories.',
			],
		});
	});

	it('normalizes typed shorthand and Hugging Face web URLs', () => {
		for (const [input, uri] of [
			['models/openai/gpt2', 'hf://models/openai/gpt2'],
			['datasets/openai/example/README.md', 'hf://datasets/openai/example/README.md'],
			['https://huggingface.co/openai/gpt2', 'hf://models/openai/gpt2'],
			['https://huggingface.co/openai/gpt2/blob/main/README.md', 'hf://models/openai/gpt2/README.md'],
			['https://huggingface.co/openai/gpt2/blob/dev/README.md', 'hf://models/openai/gpt2@dev/README.md'],
			[
				'https://huggingface.co/openai/gpt2/resolve/refs%2Fpr%2F3/README.md',
				'hf://models/openai/gpt2@refs%2Fpr%2F3/README.md',
			],
			['https://huggingface.co/datasets/openai/example/tree/main/data', 'hf://datasets/openai/example/data'],
			['https://www.huggingface.co/spaces/openai/demo', 'hf://spaces/openai/demo'],
			[
				'https://huggingface.co/buckets/openai/assets/resolve/images/logo.png',
				'hf://buckets/openai/assets/images/logo.png',
			],
			['https://huggingface.co/docs/transformers/main/en/index', 'hf://docs/transformers/main/en/index'],
			['docs/transformers/main/en/index', 'hf://docs/transformers/main/en/index'],
			['https://huggingface.co/papers/2501.00001', 'hf://papers/2501.00001'],
		] as const) {
			expect(parseHfFsRequest({ cmd: 'ls', args: [input] }).params.uri).toBe(uri);
		}
	});

	it('keeps non-Hugging Face and insecure web URLs outside the hf:// namespace', () => {
		for (const uri of [
			'https://example.com/models/org/repo',
			'http://huggingface.co/models/org/repo',
			'https://huggingface.co/settings/tokens',
			'https://huggingface.co/openai/gpt2/discussions',
			'https://huggingface.co/openai/gpt2?download=true',
			'https://user@huggingface.co/openai/gpt2',
		]) {
			expect(() => parseHfFsRequest({ cmd: 'ls', args: [uri] })).toThrow('URI must start with hf://');
		}
	});

	it('treats --sort trending on listing roots as the trending virtual directory', () => {
		for (const root of ['models', 'datasets', 'spaces', 'papers']) {
			expect(
				parseHfFsRequest({
					cmd: 'ls',
					args: [`hf://${root}`, '--sort', 'trending'],
				})
			).toEqual({
				params: {
					op: 'ls',
					uri: `hf://${root}/trending`,
				},
				warnings: [`Treated --sort trending on hf://${root} as hf://${root}/trending.`],
			});
		}
		expect(parseHfFsRequest({ cmd: 'ls', args: ['models/', '--sort', 'trending'] }).params.uri).toBe(
			'hf://models/trending'
		);
		expect(() => parseHfFsRequest({ cmd: 'ls', args: ['hf://models', '--sort', 'trending', '--recursive'] })).toThrow(
			'--sort trending does not support recursive or glob'
		);
	});

	it.each([
		[{ cmd: 'ls', args: [] }, 'ls requires an hf:// URI'],
		[{ cmd: 'stat', args: ['owner/repo'] }, 'URI must start with hf://'],
		[{ cmd: 'stat', args: ['hf://models/org/repo', '--limit', '1'] }, 'unexpected argument for stat'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit'] }, '--limit requires a value'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit', 'many'] }, '--limit requires an integer'],
		[{ cmd: 'ls', args: ['hf://models/org', '--limit', '1', '--limit', '2'] }, 'duplicate option for limit'],
		[{ cmd: 'search', args: ['hf://models', 'vision', '--query', 'speech'] }, 'duplicate option for query: --query'],
		[{ cmd: 'search', args: ['hf://models/org/repo', 'query'] }, 'search requires hf://models'],
		[{ cmd: 'search', args: ['hf://models', 'query', '--limit', '1001'] }, 'limit must be between 1 and 1000'],
		[{ cmd: 'ls', args: ['hf://models/trending', '--limit', '21'] }, 'limit must be between 1 and 20'],
		[{ cmd: 'cat', args: ['hf://models/org/repo/README.md', '--max-bytes', '80001'] }, 'max_bytes'],
		[{ cmd: 'attach', args: ['hf://models/org/repo/image.png', '--max-bytes', '0'] }, 'attach max_bytes'],
		[
			{
				cmd: 'attach',
				args: ['hf://models/org/repo/image.png', '--max-bytes', (HF_FS_ATTACH_MAX_BYTES + 1).toString()],
			},
			'attach max_bytes',
		],
	] as const)('rejects invalid argv: %o', (request, message) => {
		expect(() => parseHfFsRequest({ cmd: request.cmd, args: [...request.args] })).toThrow(message);
	});
});

describe('search discovery guidance', () => {
	it('documents discovery, supported scopes, and exact Space filter semantics', () => {
		expect(HF_FS_DESCRIPTION).toContain('resource discovery, not repository-content search');
		for (const root of ['models', 'datasets', 'spaces', 'collections']) {
			expect(HF_FS_DESCRIPTION).toContain(`hf://${root}[/OWNER]`);
		}
		expect(HF_FS_DESCRIPTION).toContain('hf://papers, and hf://docs[/...]');
		expect(HF_FS_DESCRIPTION).toContain(
			'--tag (repeatable) and --kind are supported only on exactly hf://spaces, not owner scopes or other roots'
		);
		expect(HF_FS_DESCRIPTION).toContain('The only valid --kind value is mcp');
		expect(HF_FS_OPERATION_SCHEMA.shape.args.description).toContain(
			'search discovers resources, not repository contents'
		);
		expect(HF_FS_OPERATION_SCHEMA.shape.args.description).toContain(
			'--tag and --kind require exactly hf://spaces; the only valid --kind value is mcp'
		);
	});

	it.each(['models', 'datasets', 'spaces', 'collections'])(
		'preserves %s root/owner acceptance and repository rejection',
		(root) => {
			for (const uri of [`hf://${root}`, `hf://${root}/example-owner`]) {
				expect(parseHfFsRequest({ cmd: 'search', args: [uri, 'demo'] }).params).toEqual({
					op: 'search',
					uri,
					query: 'demo',
				});
			}
			for (const suffix of ['example-owner/example-repo', 'example-owner/example-repo/README.md']) {
				expect(() => parseHfFsRequest({ cmd: 'search', args: [`hf://${root}/${suffix}`, 'demo'] })).toThrow(
					'search a resource root or owner scope to discover resources; use find for file discovery by name/path (not file contents) or cat for a known text file'
				);
			}
		}
	);

	it.each(['--tag', '--kind'])('restricts %s to the exact Spaces root', (flag) => {
		expect(parseHfFsRequest({ cmd: 'search', args: ['hf://spaces', flag, 'mcp'] }).params).toMatchObject({
			op: 'search',
			uri: 'hf://spaces',
		});
		for (const uri of [
			'hf://spaces/example-owner',
			'hf://models',
			'hf://datasets',
			'hf://collections',
			'hf://papers',
			'hf://docs',
		]) {
			expect(() => parseHfFsRequest({ cmd: 'search', args: [uri, 'demo', flag, 'mcp'] })).toThrow(
				'exact root, not owner scopes or other roots'
			);
		}
	});
});

describe('paper read guidance', () => {
	it('distinguishes paper directories from full file URIs and demonstrates direct cat', () => {
		expect(HF_FS_DESCRIPTION).toContain('hf://papers/ID is a paper directory, not paper text.');
		expect(HF_FS_DESCRIPTION).toContain(
			'Use cat hf://papers/ID/paper.md for paper text and cat hf://papers/ID/metadata.json for metadata.'
		);
		expect(HF_FS_DESCRIPTION).toContain('No preliminary listing is needed for these known paths.');
		expect(HF_FS_DESCRIPTION).toContain('Use ls hf://papers/ID to discover other resources.');

		const example = '{"operations":[{"cmd":"cat","args":["hf://papers/2501.00001/paper.md"]}]}';
		expect(HF_FS_DESCRIPTION).toContain(example);
		const request = HF_FS_SCHEMA.parse(JSON.parse(example));
		expect(request.operations).toHaveLength(1);
		const operation = request.operations[0];
		if (!operation) throw new Error('Expected a paper read operation');
		expect(parseHfFsRequest(operation)).toEqual({
			params: { op: 'cat', uri: 'hf://papers/2501.00001/paper.md' },
			warnings: [],
		});
	});
});
