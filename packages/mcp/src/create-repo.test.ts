import { createRepo } from '@huggingface/hub';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProfile } from './network/fetch-profile.js';
import { CREATE_REPO_TOOL_CONFIG, CreateRepoTool, formatCreateRepoResult } from './create-repo.js';

vi.mock('@huggingface/hub', () => ({
	createRepo: vi.fn(),
}));

vi.mock('./network/fetch-profile.js', () => ({
	fetchWithProfile: vi.fn(),
	NETWORK_FETCH_PROFILES: {
		externalHttps: vi.fn(() => ({
			urlPolicy: { validate: vi.fn() },
			timeoutMs: 12_500,
			maxRedirects: 3,
			externalOnly: true,
		})),
	},
}));

describe('CreateRepoTool', () => {
	beforeEach(() => {
		vi.mocked(createRepo).mockReset();
		vi.mocked(createRepo).mockResolvedValue({
			repoUrl: 'https://huggingface.co/alice/example-model',
			id: '0123456789abcdef01234567',
		});
		vi.mocked(fetchWithProfile).mockReset();
	});

	it('describes the hf:// repo URI contract', () => {
		const config = CreateRepoTool.createToolConfig();

		expect(config.description).toContain('hf:// destination URI');
		expect(config.schema.shape.uri.description).toContain('hf://models|datasets|spaces|buckets/OWNER/NAME');
		expect(config.schema.shape.source_uri.description).toContain('hf://models|datasets|spaces/OWNER/NAME');
	});

	it('creates a model repository from a destination URI', async () => {
		const result = await new CreateRepoTool('token').create({
			uri: 'hf://models/alice/example-model',
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/example-model', type: 'model' },
			private: undefined,
		});
		expect(result).toEqual({
			action: 'created',
			uri: 'hf://models/alice/example-model',
			url: 'https://huggingface.co/alice/example-model',
			repo: 'alice/example-model',
			repo_type: 'model',
			id: '0123456789abcdef01234567',
		});
		expect(CREATE_REPO_TOOL_CONFIG.outputSchema.parse(result)).toEqual(result);
	});

	it('creates a dataset repository', async () => {
		await new CreateRepoTool('token').create({
			uri: 'hf://datasets/alice/example-dataset',
			private: true,
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/example-dataset', type: 'dataset' },
			private: true,
		});
	});

	it('creates a bucket repository', async () => {
		vi.mocked(createRepo).mockResolvedValue({
			repoUrl: 'https://huggingface.co/buckets/alice/example-bucket',
			id: 'bucket-id',
		});

		const result = await new CreateRepoTool('token').create({
			uri: 'hf://buckets/alice/example-bucket',
			private: true,
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/example-bucket', type: 'bucket' },
			private: true,
		});
		expect(result).toMatchObject({
			action: 'created',
			uri: 'hf://buckets/alice/example-bucket',
			repo: 'alice/example-bucket',
			repo_type: 'bucket',
			id: 'bucket-id',
		});
	});

	it('creates a Space repository with sdk', async () => {
		vi.mocked(createRepo).mockResolvedValue({
			repoUrl: 'https://huggingface.co/spaces/alice/demo',
			id: 'abcdefabcdefabcdefabcdef',
		});

		await new CreateRepoTool('token').create({
			uri: 'hf://spaces/alice/demo',
			sdk: 'gradio',
		});

		expect(createRepo).toHaveBeenCalledWith({
			accessToken: 'token',
			repo: { name: 'alice/demo', type: 'space' },
			private: undefined,
			sdk: 'gradio',
		});
	});

	it('duplicates a model repository server-side using hf:// source and destination URIs', async () => {
		vi.mocked(fetchWithProfile).mockResolvedValue({
			response: jsonResponse({ url: 'https://huggingface.co/alice/gemma-copy', id: 'copy-id' }),
			finalUrl: new URL('https://huggingface.co/api/models/google/gemma-7b/duplicate'),
			redirectsFollowed: 0,
		});

		const result = await new CreateRepoTool('token').create({
			uri: 'hf://models/alice/gemma-copy',
			source_uri: 'hf://models/google/gemma-7b',
			private: false,
		});

		const call = vi.mocked(fetchWithProfile).mock.calls[0];
		expect(call?.[0]).toBe('https://huggingface.co/api/models/google/gemma-7b/duplicate');
		expect(call?.[2]?.requestInit).toMatchObject({
			method: 'POST',
			headers: {
				Accept: 'application/json',
				Authorization: 'Bearer token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ repository: 'alice/gemma-copy', visibility: 'public' }),
		});
		expect(createRepo).not.toHaveBeenCalled();
		expect(result).toEqual({
			action: 'duplicated',
			uri: 'hf://models/alice/gemma-copy',
			url: 'https://huggingface.co/alice/gemma-copy',
			repo: 'alice/gemma-copy',
			repo_type: 'model',
			id: 'copy-id',
			source_uri: 'hf://models/google/gemma-7b',
			source_repo: 'google/gemma-7b',
		});
		expect(CREATE_REPO_TOOL_CONFIG.outputSchema.parse(result)).toEqual(result);
	});

	it('duplicates datasets and preserves source visibility when private is omitted', async () => {
		vi.mocked(fetchWithProfile).mockResolvedValue({
			response: jsonResponse({ url: 'https://huggingface.co/datasets/alice/gdpval-copy' }),
			finalUrl: new URL('https://huggingface.co/api/datasets/openai/gdpval/duplicate'),
			redirectsFollowed: 0,
		});

		await new CreateRepoTool('token').create({
			uri: 'hf://datasets/alice/gdpval-copy',
			source_uri: 'hf://datasets/openai/gdpval',
		});

		expect(vi.mocked(fetchWithProfile).mock.calls[0]?.[2]?.requestInit?.body).toBe(
			JSON.stringify({ repository: 'alice/gdpval-copy' })
		);
	});

	it('rejects invalid URI targets before calling the Hub', async () => {
		const tool = new CreateRepoTool('token');

		await expect(tool.create({ uri: 'alice/example-model' })).rejects.toThrow('URI must start with hf://');
		await expect(tool.create({ uri: 'hf://models/alice' })).rejects.toThrow(
			'uri must point to a repository, not a namespace'
		);
		await expect(tool.create({ uri: 'hf://models/alice/example-model/README.md' })).rejects.toThrow(
			'uri must point to a repository, not a file path'
		);
		await expect(tool.create({ uri: 'hf://models/alice/example-model@main' })).rejects.toThrow(
			'uri must point to a repository and must not include a revision'
		);
		await expect(tool.create({ uri: 'hf://datasets/alice/data', sdk: 'gradio' })).rejects.toThrow(
			'sdk is only valid when creating a Space repository'
		);
		expect(createRepo).not.toHaveBeenCalled();
		expect(fetchWithProfile).not.toHaveBeenCalled();
	});

	it('rejects invalid duplication requests before calling the Hub', async () => {
		const tool = new CreateRepoTool('token');

		await expect(
			tool.create({
				uri: 'hf://datasets/alice/gemma-copy',
				source_uri: 'hf://models/google/gemma-7b',
			})
		).rejects.toThrow('source_uri type (model) must match uri type (dataset)');
		await expect(
			tool.create({
				uri: 'hf://buckets/alice/bucket-copy',
				source_uri: 'hf://buckets/google/source-bucket',
			})
		).rejects.toThrow('Duplicating bucket repositories is not supported');
		await expect(
			tool.create({
				uri: 'hf://spaces/alice/demo-copy',
				source_uri: 'hf://spaces/source/demo',
				sdk: 'gradio',
			})
		).rejects.toThrow('sdk is only valid when creating a new empty Space, not when duplicating');
		expect(createRepo).not.toHaveBeenCalled();
		expect(fetchWithProfile).not.toHaveBeenCalled();
	});

	it('requires an auth token', async () => {
		await expect(
			new CreateRepoTool(undefined).create({
				uri: 'hf://models/alice/example-model',
			})
		).rejects.toThrow('Requires Authentication');
		expect(createRepo).not.toHaveBeenCalled();
		expect(fetchWithProfile).not.toHaveBeenCalled();
	});

	it('formats created and duplicated repository results', () => {
		expect(
			formatCreateRepoResult({
				action: 'created',
				uri: 'hf://models/alice/example-model',
				url: 'https://huggingface.co/alice/example-model',
				repo: 'alice/example-model',
				repo_type: 'model',
				id: '0123456789abcdef01234567',
			})
		).toBe(
			[
				'# create_repo created',
				'',
				'URI: `hf://models/alice/example-model`',
				'Repo: `alice/example-model`',
				'Type: `model`',
				'URL: https://huggingface.co/alice/example-model',
				'ID: `0123456789abcdef01234567`',
			].join('\n')
		);

		expect(
			formatCreateRepoResult({
				action: 'duplicated',
				uri: 'hf://models/alice/gemma-copy',
				url: 'https://huggingface.co/alice/gemma-copy',
				repo: 'alice/gemma-copy',
				repo_type: 'model',
				source_uri: 'hf://models/google/gemma-7b',
				source_repo: 'google/gemma-7b',
			})
		).toContain('Source: `hf://models/google/gemma-7b`');
	});
});

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		statusText: 'OK',
		headers: { 'content-type': 'application/json' },
	});
}
