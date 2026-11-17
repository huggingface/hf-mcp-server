import { describe, expect, it } from 'vitest';
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
			refs: ['org/m'],
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
		expect(n('hf_repo_info', { id: 'o/m' })).toEqual({ refs: ['o/m'] });
		expect(n('hf_repo_info', { uris: ['hf://models/o/m'] })).toEqual({ refs: ['hf://models/o/m'] });
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
			expect(JSON.stringify(result.value), name).toContain('"julien-c"');
			expect(JSON.stringify(result.value), name).not.toContain(profile);
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
