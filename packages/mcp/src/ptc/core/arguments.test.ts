import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getPtcTool } from '../index.js';
import { advertisedInputSchema, normalizePtcArguments } from './arguments.js';
import { callPtcTool } from './tool.js';

function tool(name: string) {
	const found = getPtcTool(name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

function validate(name: string, args: unknown): { value?: unknown; issues?: { message: string }[] } {
	return advertisedInputSchema(tool(name).input)['~standard'].validate(args) as {
		value?: unknown;
		issues?: { message: string }[];
	};
}

describe('PTC argument aliases', () => {
	it('maps habitual repository names, qualifying bare IDs with repo_type', () => {
		expect(
			normalizePtcArguments(tool('hf_repo_list_files').input, { repo_id: 'org/ds', repo_type: 'dataset' })
		).toEqual({
			ref: 'hf://datasets/org/ds',
		});
		expect(normalizePtcArguments(tool('hf_repo_list_files').input, { ref: 'org/ds', repo_type: 'dataset' })).toEqual({
			ref: 'hf://datasets/org/ds',
		});
		expect(normalizePtcArguments(tool('hf_repo_info').input, { repo_id: 'org/m', repo_type: 'model' })).toEqual({
			repos: ['org/m'],
			kind: 'model',
		});
		expect(normalizePtcArguments(tool('hf_dataset_structure').input, { dataset_id: 'org/ds' })).toEqual({
			dataset: 'hf://datasets/org/ds',
		});
		expect(normalizePtcArguments(tool('hf_docs_read').input, { url: 'https://huggingface.co/docs/hub' })).toEqual({
			uri: 'https://huggingface.co/docs/hub',
		});
	});

	it('builds a file uri from a repository and a path for single-uri readers', () => {
		expect(
			normalizePtcArguments(tool('hf_repo_read_text').input, { repo_id: 'org/m', filename: 'config.json' })
		).toEqual({ uri: 'hf://models/org/m/config.json' });
		expect(
			normalizePtcArguments(tool('hf_repo_read_text').input, {
				repo_id: 'org/ds',
				repo_type: 'dataset',
				path: '/README.md',
			})
		).toEqual({ uri: 'hf://datasets/org/ds/README.md' });
	});

	it('accepts the record field a value came from (uri, url, id, ref) as the argument name', () => {
		const n = (name: string, args: Record<string, unknown>) => normalizePtcArguments(tool(name).input, args);
		expect(n('hf_repo_list_files', { uri: 'hf://datasets/o/d' })).toEqual({ ref: 'hf://datasets/o/d' });
		expect(n('hf_repo_info', { id: 'o/m' })).toEqual({ repos: ['o/m'] });
		expect(n('hf_repo_info', { uris: ['hf://models/o/m'] })).toEqual({ repos: ['hf://models/o/m'] });
		expect(n('hf_dataset_rows', { uri: 'hf://datasets/o/d', config: 'c', split: 's' })).toMatchObject({
			dataset: 'hf://datasets/o/d',
		});
		expect(n('hf_space_tools', { uri: 'hf://spaces/o/s' })).toEqual({ space: 'hf://spaces/o/s' });
		expect(n('hf_collection_get', { uri: 'hf://collections/o/c-1' })).toEqual({ collection: 'hf://collections/o/c-1' });
		expect(n('hf_paper_read', { uri: 'hf://papers/2405.02730' })).toEqual({ paper_id: 'hf://papers/2405.02730' });
		expect(n('hf_paper_read', { paper_ids: ['2405.02730'] })).toEqual({ paper_id: '2405.02730' });
		expect(n('hf_paper_get', { uri: 'hf://papers/2405.02730' })).toEqual({ paper_ids: ['hf://papers/2405.02730'] });
		expect(n('hf_job_get', { id: 'abc' })).toEqual({ job_id: 'abc' });
		expect(n('hf_sandbox_status', { id: 'abc' })).toEqual({ sandbox: 'abc' });
		expect(n('hf_discussion_get', { uri: 'https://huggingface.co/o/m/discussions/3' })).toEqual({
			ref: 'https://huggingface.co/o/m/discussions/3',
		});
	});

	it('maps ref to uri only when it is a full uri', () => {
		const input = tool('hf_repo_read_text').input;
		expect(normalizePtcArguments(input, { ref: 'https://huggingface.co/o/m/blob/main/a.json' })).toEqual({
			uri: 'https://huggingface.co/o/m/blob/main/a.json',
		});
		expect(normalizePtcArguments(input, { path: 'hf://models/o/m/a.json' })).toEqual({
			uri: 'hf://models/o/m/a.json',
		});
		const bare = { ref: 'o/m' };
		expect(normalizePtcArguments(input, bare)).toBe(bare);
	});

	it('aliases person arguments to each other on tools with exactly one person argument', () => {
		expect(normalizePtcArguments(tool('hf_user_likes').input, { handle: 'julien-c' })).toEqual({ user: 'julien-c' });
		expect(normalizePtcArguments(tool('hf_org_members').input, { uri: 'https://huggingface.co/hf' })).toEqual({
			org: 'https://huggingface.co/hf',
		});
		expect(normalizePtcArguments(tool('hf_activity').input, { user: 'x' })).toEqual({ entity: 'x' });
		expect(normalizePtcArguments(tool('hf_profile_get').input, { id: 'x' })).toEqual({ handles: ['x'] });
		// hf_discussions_list has owner and author: no person aliasing.
		const args = { user: 'x' };
		expect(normalizePtcArguments(tool('hf_discussions_list').input, args)).toBe(args);
	});

	it('returns the normalized input from validate, so the handler can parse it again', async () => {
		// Non-idempotent transforms (a repo uri that parses to {id, kind}) must not be parsed twice.
		const result = validate('hf_repo_fulltext_search', { query: 'x', repo_ids: ['hf://datasets/o/d'] });
		expect(result.issues).toBeUndefined();
		expect(result.value).toEqual({ query: 'x', repo_ids: ['hf://datasets/o/d'] });
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(Response.json({ hits: [], estimatedTotalHits: 0 }))
		);
		await expect(callPtcTool(tool('hf_repo_fulltext_search'), result.value, { fetch })).resolves.toBeDefined();
	});

	it('accepts profile uris in every person argument', () => {
		const profile = 'https://huggingface.co/julien-c';
		for (const [name, args] of [
			['hf_models_search', { authors_any: [profile] }],
			['hf_repo_fulltext_search', { query: 'x', owners: [profile] }],
			['hf_collections_search', { owners: [profile] }],
			['hf_buckets_list', { owner: profile }],
			['hf_daily_papers', { submitter: profile }],
			['hf_jobs_list', { namespace: profile }],
			['hf_sandbox_create', { namespace: profile }],
			['hf_user_likes', { user: profile }],
		] as const) {
			const result = validate(name, args);
			expect(result.issues, name).toBeUndefined();
			const parsed: unknown = tool(name).input.parse(result.value);
			expect(JSON.stringify(parsed), name).toContain('"julien-c"');
			expect(JSON.stringify(parsed), name).not.toContain(profile);
		}
		const bad = validate('hf_buckets_list', { owner: 'https://example.com/x/y' });
		expect(bad.issues?.[0]?.message).toContain('expected a user or organization name or profile uri');
	});

	it('never overrides a canonical argument or an argument the tool itself defines', () => {
		const args = { ref: 'org/a', repo_id: 'org/b' };
		expect(normalizePtcArguments(tool('hf_repo_list_files').input, args)).toBe(args);
		const input = z.object({ query: z.string().optional(), q: z.string().optional() }).strict();
		const own = { q: 'x' };
		expect(normalizePtcArguments(input, own)).toBe(own);
	});

	it('accepts aliases through the SDK-facing schema and returns parsed data', () => {
		const result = validate('hf_models_search', { q: 'llama', max_results: 5 });
		expect(result.issues).toBeUndefined();
		expect(result.value).toMatchObject({ query: 'llama', limit: 5 });
	});
});

describe('PTC repository kinds and enum values', () => {
	const n = (name: string, args: Record<string, unknown>) => normalizePtcArguments(tool(name).input, args);

	it.each(['dataset', 'datasets', 'DATASET', 'Datasets'])('accepts repo_type %s as dataset', (repoType) => {
		expect(n('hf_repo_list_files', { repo_id: 'org/ds', repo_type: repoType })).toEqual({
			ref: 'hf://datasets/org/ds',
		});
		expect(n('hf_repo_info', { repo_id: 'org/ds', repo_type: repoType })).toEqual({
			repos: ['org/ds'],
			kind: 'dataset',
		});
		// Write tools: a dataset delete must never hit the same-named model.
		expect(n('hf_repo_write_files', { repo_id: 'org/ds', repo_type: repoType })).toMatchObject({
			ref: 'hf://datasets/org/ds',
		});
		expect(n('hf_repo_read_text', { repo_id: 'org/ds', repo_type: repoType, path: 'a.md' })).toEqual({
			uri: 'hf://datasets/org/ds/a.md',
		});
	});

	it('rejects an unknown repo_type instead of defaulting to a model', async () => {
		for (const repoType of ['dataset-ish', 'repo', 7]) {
			expect(() => n('hf_repo_list_files', { repo_id: 'org/ds', repo_type: repoType })).toThrow(
				/repo_type must be one of model, dataset, space or bucket/
			);
			const result = validate('hf_repo_list_files', { repo_id: 'org/ds', repo_type: repoType });
			expect(result.issues?.[0]?.message).toMatch(/repo_type must be one of model, dataset, space or bucket/);
			await expect(callPtcTool(tool('hf_repo_list_files'), { repo_id: 'org/ds', repo_type: repoType })).rejects.toThrow(
				/^invalid input\. repo_type must be one of/
			);
			await expect(
				callPtcTool(tool('hf_repo_list_files'), { repo_id: 'org/ds', repo_type: repoType })
			).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		}
		expect(() => n('hf_repo_info', { repos: ['o/x'], kind: 'model', repo_type: 'datasets' })).toThrow(/disagree/);
	});

	it('keeps the kind carried by model_id/dataset_id/space_id', () => {
		expect(n('hf_repo_info', { dataset_id: 'org/ds' })).toEqual({ repos: ['hf://datasets/org/ds'] });
		expect(n('hf_repo_info', { space_id: 'org/sp' })).toEqual({ repos: ['hf://spaces/org/sp'] });
		expect(n('hf_repo_info', { dataset_ids: ['org/a', 'squad'] })).toEqual({
			repos: ['hf://datasets/org/a', 'hf://datasets/squad'],
		});
		expect(n('hf_repo_list_files', { model_id: 'org/m' })).toEqual({ ref: 'hf://models/org/m' });
		expect(n('hf_repo_read_text', { dataset_id: 'org/ds', filename: 'README.md' })).toEqual({
			uri: 'hf://datasets/org/ds/README.md',
		});
		// Legacy single-segment ids get an explicit revision so the file uri parses back unambiguously.
		expect(n('hf_repo_read_text', { repo_id: 'gpt2', filename: 'config.json' })).toEqual({
			uri: 'hf://models/gpt2@main/config.json',
		});
	});

	it('matches enum values case-insensitively through both entry points', async () => {
		expect(n('hf_models_search', { sort: 'Downloads' })).toEqual({ sort: 'downloads' });
		expect(n('hf_repo_fulltext_search', { query: 'x', kinds: ['Models', 'DATASET'] })).toEqual({
			query: 'x',
			kinds: ['model', 'dataset'],
		});
		expect(n('hf_repo_info', { repos: ['o/m'], kind: 'Spaces', fields: ['Likes'] })).toEqual({
			repos: ['o/m'],
			kind: 'space',
			fields: ['likes'],
		});
		const result = validate('hf_models_search', { sort: 'DOWNLOADS' });
		expect(result.issues).toBeUndefined();
		expect(result.value).toMatchObject({ sort: 'downloads' });
		expect(validate('hf_models_search', { sort: 'popularity' }).issues?.length).toBeGreaterThan(0);
		await expect(callPtcTool(tool('hf_jobs_list'), { kind: 'Nope' })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		const exact = { sort: 'downloads' };
		expect(n('hf_models_search', exact)).toBe(exact);
	});
});

describe('PTC naming aliases (NAMING-SPEC R16)', () => {
	const n = (name: string, args: Record<string, unknown>) => normalizePtcArguments(tool(name).input, args);

	it('maps names that differ only in separators or case', () => {
		const read = getPtcTool('hf_repo_read_text');
		const maxBytes = read && Object.keys(read.input.shape).find((key) => /max_?bytes/i.test(key));
		expect(maxBytes).toBeDefined();
		const other = maxBytes === 'max_bytes' ? 'maxBytes' : 'max_bytes';
		expect(n('hf_repo_read_text', { uri: 'hf://models/o/m/a.md', [other]: 10 })).toEqual({
			uri: 'hf://models/o/m/a.md',
			[maxBytes as string]: 10,
		});
		expect(n('hf_repo_read_text', { uri: 'hf://models/o/m/a.md', MAX_BYTES: 10 })).toMatchObject({
			[maxBytes as string]: 10,
		});
		// repoType is the repo_type habit.
		expect(n('hf_repo_info', { repo_id: 'org/ds', repoType: 'dataset' })).toMatchObject({ kind: 'dataset' });
	});

	it('accepts Python/REST habits for search filters', () => {
		const shape = tool('hf_models_search').input.shape;
		const key = (loose: string) => Object.keys(shape).find((name) => name.replace(/_/g, '').toLowerCase() === loose);
		const out = n('hf_models_search', {
			author: 'Qwen',
			search: 'coder',
			pipeline_tag: 'text-generation',
			language: 'en',
			inference_provider: ['groq'],
			num_parameters_min: 1,
			filter: ['gguf'],
		}) as Record<string, unknown>;
		expect(out).toEqual({
			[key('authorsany') as string]: ['Qwen'],
			query: 'coder',
			task: 'text-generation',
			[key('languages') ?? key('languagesall') ?? '']: ['en'],
			[key('providersany') as string]: ['groq'],
			[key('parametersmin') ?? key('numparametersmin') ?? '']: 1,
			[key('tagsall') as string]: ['gguf'],
		});
	});

	it('maps fields and sort values to the field spelling, including old Hub names', () => {
		expect(n('hf_models_search', { sort: 'last_modified' })).toEqual({ sort: 'lastModified' });
		expect(n('hf_models_search', { sort: 'trending_score' })).toEqual({ sort: 'trendingScore' });
		expect(n('hf_models_search', { fields: ['created_at', 'DOWNLOADS_ALL_TIME'] })).toEqual({
			fields: ['createdAt', 'downloadsAllTime'],
		});
		expect(n('hf_repo_info', { repos: ['o/m'], fields: ['lastModified'] })).toMatchObject({
			fields: [expect.stringMatching(/^last_?modified$/i)],
		});
		// A value alias applies only when its target is an option.
		const unknown = { sort: 'inferenceProviderMapping' };
		expect(n('hf_models_search', unknown)).toBe(unknown);
	});

	it('wraps a single value given for a list argument', () => {
		expect(n('hf_repo_fulltext_search', { query: 'x', kinds: 'model' })).toEqual({ query: 'x', kinds: ['model'] });
	});
});

describe('PTC argument errors', () => {
	it('names valid arguments for unknown ones and describes missing required ones', () => {
		const result = validate('hf_repo_list_files', { repository_name: 'org/m' });
		const text = result.issues?.map((issue) => issue.message).join(' ') ?? '';
		expect(text).toContain('Unknown argument "repository_name" (valid arguments: ref, path,');
		expect(text).toContain('Missing required argument "ref": Repository or bucket');
	});

	it('does not echo values or odd key names', () => {
		const result = validate('hf_repo_list_files', { ref: 'org/m', 'bad key\n': 'secret-value' });
		const text = result.issues?.map((issue) => issue.message).join(' ') ?? '';
		expect(text).toContain('Unknown argument (valid arguments');
		expect(text).not.toContain('secret-value');
		expect(text).not.toContain('bad key');
	});

	it('uses the same messages for direct callers', async () => {
		await expect(callPtcTool(tool('hf_repo_list_files'), { repo_name: 'x' })).rejects.toThrow(
			/invalid input\. Unknown argument "repo_name" \(valid arguments: ref/
		);
	});

	it('lists a clean input schema', () => {
		const json = advertisedInputSchema(tool('hf_models_search').input)['~standard'].jsonSchema.input({
			target: 'draft-2020-12',
		});
		const text = JSON.stringify(json);
		expect(text).not.toContain('$schema');
		expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER));
		for (const keyword of ['"pattern"', '"maxLength"', '"minLength"', '"maxItems"', '"format"'])
			expect(text).not.toContain(keyword);
		expect(text).toContain('"default"');
		expect(text).toContain('"enum"');
		expect(json).toMatchObject({ type: 'object' });
	});
});
