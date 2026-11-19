import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPersonCaseCache } from '../core/person.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type * as FetchProfileModule from '../../network/fetch-profile.js';

const catalogFetch = vi.hoisted(() => vi.fn());
vi.mock('../../network/fetch-profile.js', async (importOriginal) => ({
	...(await importOriginal<typeof FetchProfileModule>()),
	fetchWithProfile: catalogFetch,
}));
import { callPtcTool, getPtcTool, PtcError, PTC_INSTRUCTIONS, type PtcContext } from '../index.js';

// Compatibility shims: these tests predate the registry and exercise the four listing tools.
const PTC_TOOL_IDS = ['hf_models_search', 'hf_datasets_search', 'hf_spaces_list', 'hf_spaces_search'] as const;
type PtcToolName = (typeof PTC_TOOL_IDS)[number];
function isPtcToolName(name: string): name is PtcToolName {
	return (PTC_TOOL_IDS as readonly string[]).includes(name);
}
function tool(name: PtcToolName) {
	const found = getPtcTool(name);
	if (!found) throw new Error(`Missing tool ${name}`);
	return found;
}
const PTC_TOOL_CONFIGS = PTC_TOOL_IDS.map((name) => ({
	...tool(name),
	schema: tool(name).input,
	outputSchema: tool(name).output,
}));
async function callPtcDiscoveryTool(
	name: PtcToolName,
	input: unknown,
	ctx: PtcContext = {}
): Promise<Record<string, unknown>> {
	return (await callPtcTool(tool(name), input, ctx)).structured;
}
import {
	modelsOutputSchema,
	datasetsOutputSchema,
	spacesListOutputSchema,
	spacesSearchOutputSchema,
} from './records.js';

beforeEach(() => resetPersonCaseCache());

function mockJson(body: unknown = [], headers: HeadersInit = {}) {
	return vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(Response.json(body, { headers })));
}
function inputUrl(input: string | URL | Request | undefined): URL {
	if (!input) throw new Error('Missing request');
	return new URL(input instanceof Request ? input.url : input);
}
/** The index-th listing request (authors_any first resolves names through profile overview requests). */
function requestUrl(mock: ReturnType<typeof mockJson>, index = 0): URL {
	const urls = mock.mock.calls.map((call) => inputUrl(call[0])).filter((url) => !url.pathname.endsWith('/overview'));
	const url = urls[index];
	if (!url) throw new Error('Missing request');
	return url;
}
function config(name: PtcToolName) {
	const result = PTC_TOOL_CONFIGS.find((entry) => entry.name === name);
	if (!result) throw new Error('Missing config');
	return result;
}
function space(id: string, tags: string[] = ['mcp-server'], score = 1) {
	return { id, tags, sdk: 'gradio', runtime: { stage: 'RUNNING' }, semanticRelevancyScore: score };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('discovery definitions and JSON contracts', () => {
	it('exports exactly the four tools with read-only annotations and serializable object schemas', () => {
		expect(PTC_TOOL_IDS).toEqual(['hf_models_search', 'hf_datasets_search', 'hf_spaces_list', 'hf_spaces_search']);
		for (const tool of PTC_TOOL_CONFIGS) {
			expect(isPtcToolName(tool.name)).toBe(true);
			expect(tool.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});
			expect(tool.description.length).toBeGreaterThan(100);
			for (const [schema, io] of [
				[tool.schema, 'input'],
				[tool.outputSchema, 'output'],
			] as const) {
				const json = z.toJSONSchema(schema, { io });
				expect(json.type).toBe('object');
				expect(JSON.parse(JSON.stringify(json))).toEqual(json);
			}
		}
		expect(isPtcToolName('repo_search')).toBe(false);
	});
	it.each(PTC_TOOL_IDS)('%s validates sparse items and the output schema after JSON serialization', async (name) => {
		const semantic = name === 'hf_spaces_search';
		const wire = semantic ? [space('owner/repo')] : [{ id: 'owner/repo', tags: null, author: null }];
		const result = await callPtcDiscoveryTool(name, semantic ? { query: 'image editing' } : {}, {
			fetch: mockJson(wire),
		});
		const parsed: unknown = JSON.parse(JSON.stringify(result));
		expect(config(name).outputSchema.safeParse(parsed).success).toBe(true);
		expect(result.returnedCount).toBe(1);
		expect(result.nextCursor).toBe(null);
		expect(result).not.toHaveProperty('total');
		expect(JSON.stringify(result)).not.toContain('_id');
	});
	it('accepts captured public wire samples, including sparse relationships and very large row counts', async () => {
		const raw: unknown = JSON.parse(readFileSync(new URL('./wire-samples.json', import.meta.url), 'utf8'));
		const samples = z
			.object({
				model: z.object({ items: z.array(z.unknown()) }),
				dataset: z.object({ items: z.array(z.unknown()) }),
				space: z.object({ items: z.array(z.unknown()) }),
				semantic: z.object({ items: z.array(z.unknown()) }),
			})
			.parse(raw);
		const entries: [PtcToolName, unknown[]][] = [
			['hf_models_search', samples.model.items],
			['hf_datasets_search', samples.dataset.items],
			['hf_spaces_list', samples.space.items],
			['hf_spaces_search', samples.semantic.items],
		];
		for (const [name, items] of entries) {
			const result = await callPtcDiscoveryTool(
				name,
				name === 'hf_spaces_search' ? { query: 'remove background' } : {},
				{ fetch: mockJson(items) }
			);
			expect(config(name).outputSchema.safeParse(result).success).toBe(true);
			expect(result.returnedCount).toBe(items.length);
		}
	});
	it('output schemas reject contradictory counts and continuation claims', async () => {
		const listing = await callPtcDiscoveryTool('hf_models_search', {}, { fetch: mockJson([{ id: 'org/model' }]) });
		for (const invalid of [
			{ ...listing, returnedCount: 2 },
			{ ...listing, nextCursor: 'not-empty' },
			{ ...listing, mode: 'listing' },
			{ ...listing, truncation: { local_limit_applied: false, upstream_candidate_limit: null } },
		])
			expect(modelsOutputSchema.safeParse(invalid).success).toBe(false);
		const semantic = await callPtcDiscoveryTool(
			'hf_spaces_search',
			{ query: 'app' },
			{ fetch: mockJson([space('org/app')]) }
		);
		for (const invalid of [
			{ ...semantic, nextCursor: 'not-allowed' },
			{ ...semantic, eligibleCount: 2 },
			{ ...semantic, candidateCount: 0 },
			{ ...semantic, returnedCount: 2 },
		])
			expect(spacesSearchOutputSchema.safeParse(invalid).success).toBe(false);
	});
	it('does not infer missing fields or totals from empty responses', async () => {
		const result = modelsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_models_search', {}, { fetch: mockJson([{ id: 'gpt2' }]) })
		);
		expect(result.items[0]).toMatchObject({
			id: 'gpt2',
			kind: 'model',
			uri: 'hf://models/gpt2',
			url: 'https://huggingface.co/gpt2',
		});
		expect(result.items[0]?.downloads).toBeUndefined();
		expect(result.items[0]?.tags).toBeUndefined();
		expect(result.items[0]?.datasets).toBeUndefined();
		expect(result.completeness).toEqual({
			hasMore: false,
		});
	});
});

describe('typed query serialization', () => {
	it.each(['hf_models_search', 'hf_datasets_search', 'hf_spaces_list'] as const)(
		'%s bounds defaults and sends repeated projections',
		async (name) => {
			const fetch = mockJson();
			await callPtcDiscoveryTool(name, {}, { fetch });
			const url = requestUrl(fetch);
			expect(url.searchParams.get('limit')).toBe('20');
			expect(url.searchParams.get('sort')).toBe('trendingScore');
			expect(url.searchParams.get('direction')).toBe('-1');
			expect(url.searchParams.getAll('expand')).not.toContain('tags');
			expect(url.searchParams.has('full')).toBe(false);
			expect(url.searchParams.has('search')).toBe(false);
			expect(url.searchParams.has('runtime.stage')).toBe(false);
			const init = fetch.mock.calls[0]?.[1];
			expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
			expect(new Headers(init?.headers).has('authorization')).toBe(false);
		}
	);
	it('serializes model filters with exact AND/OR grammar and parameter/date bounds', async () => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(
			'hf_models_search',
			{
				query: '  llama  ',
				authorsAny: ['meta-llama', 'org'],
				idsAny: ['org/a', 'org/b'],
				papersAny: ['2401.00001', '2402.00002'],
				tagsAll: ['safetensors'],
				tagsAnyGroups: [
					['pytorch', 'tf'],
					['en', 'fr'],
				],
				task: 'text-generation',
				libraries: ['transformers'],
				languages: ['en'],
				licenses: ['apache-2.0'],
				providersAny: ['groq', 'hf-inference'],
				numParametersMin: 0,
				numParametersMax: 8000000000,
				numParametersAny: [7000000000, 8000000000],
				created_at: { gte: '2024-01-01', lt: '2026-10-01T00:00:00+01:00' },
				baseModelRelationsAny: ['quantized', 'finetune'],
				baseModelsAll: ['org/base'],
				baseModelRelation: 'quantized',
				datasetsAny: ['org/d1', 'org/d2'],
				appsAny: ['vllm', 'llama.cpp'],
				gated: false,
				sort: 'numParameters',
				direction: 'asc',
				limit: 100,
				fields: ['safetensors', 'safetensors', 'pipelineTag'],
			},
			{ fetch }
		);
		const params = requestUrl(fetch).searchParams;
		expect(Object.fromEntries(params)).toMatchObject({
			search: 'llama',
			author: 'or:meta-llama,org',
			id: 'or:org/a,org/b',
			arxivIds: 'or:2401.00001,2402.00002',
			pipeline_tag: 'text-generation',
			filter: 'safetensors,or:(pytorch,tf),or:(en,fr),transformers,en,license:apache-2.0,base_model:quantized:org/base',
			inference_provider: 'groq,hf-inference',
			num_parameters: '7000000000,8000000000,min:0,max:8000000000',
			'createdAt[gte]': '2024-01-01',
			'createdAt[lt]': '2026-10-01T00:00:00+01:00',
			base_model_relation: 'quantized,finetune',
			datasets: 'or:org/d1,org/d2',
			apps: 'vllm,llama.cpp',
			gated: 'false',
			sort: 'num_parameters',
			direction: '1',
			limit: '100',
		});
		expect(params.getAll('expand')).toEqual(['safetensors', 'pipeline_tag']);
		for (const unsupported of [
			'query',
			'language',
			'library',
			'base_model',
			'task',
			'skip',
			'page',
			'num_parameters_min',
		])
			expect(params.has(unsupported)).toBe(false);
	});
	it('supports any-provider and inference without conflating cold and frozen', async () => {
		for (const value of [{ anyProvider: true }, { inference: 'cold' }, { inference: 'frozen' }]) {
			const fetch = mockJson();
			await callPtcDiscoveryTool('hf_models_search', value, { fetch });
			const params = requestUrl(fetch).searchParams;
			if ('anyProvider' in value) expect(params.get('inference_provider')).toBe('all');
			else expect(params.get('inference')).toBe(value.inference);
		}
	});
	it('maps dataset facets, dataset type and row/byte sorts without inventing row-range filters', async () => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(
			'hf_datasets_search',
			{
				taskCategoriesAll: ['text-generation'],
				sizeCategoriesAll: ['1K<n<10K'],
				modalities: ['text'],
				formats: ['parquet'],
				libraries: ['pandas'],
				languages: ['en'],
				licenses: ['mit'],
				datasetType: 'benchmark',
				gated: true,
				sort: 'rows',
				direction: 'asc',
				fields: ['mainSize', 'description'],
			},
			{ fetch }
		);
		const params = requestUrl(fetch).searchParams;
		expect(params.get('filter')).toBe(
			'task_categories:text-generation,size_categories:1K<n<10K,modality:text,format:parquet,library:pandas,language:en,license:mit,benchmark:official'
		);
		expect(params.get('sort')).toBe('datasetsServerInfo.numRows');
		expect(params.get('gated')).toBe('true');
		expect(params.getAll('expand')).toEqual(['mainSize', 'description']);
		for (const [dataset_type, tag] of [
			['agent-traces', 'format:agent-traces'],
			['rl-environment', 'rl-environment'],
		]) {
			const other = mockJson();
			await callPtcDiscoveryTool('hf_datasets_search', { dataset_type, sort: 'bytes' }, { fetch: other });
			expect(requestUrl(other).searchParams.get('filter')).toBe(tag);
			expect(requestUrl(other).searchParams.get('sort')).toBe('mainSize');
		}
	});
	it('says how to recover from over-long lists and slashes in OR groups', async () => {
		const fetch = mockJson();
		const ids = Array.from({ length: 51 }, (_, i) => `org/d${String(i)}`);
		await expect(callPtcDiscoveryTool('hf_datasets_search', { idsAny: ids }, { fetch })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining(
				'idsAny: at most 50 values per call; split larger sets into batches of 50'
			) as string,
		});
		await expect(
			callPtcDiscoveryTool('hf_models_search', { tagsAnyGroups: [['base_model:quantized:org/a', 'gguf']] }, { fetch })
		).rejects.toMatchObject({ message: expect.stringContaining('base models: baseModelsAll') as string });
		expect(fetch).not.toHaveBeenCalled();
	});
	it('normalizes guessed gpu- flavor ids and deduplicates before the 50-item cap', async () => {
		const fetch = mockJson();
		const guessed = Array.from({ length: 30 }, (_, i) => [`flavor-${String(i)}`, `GPU-flavor-${String(i)}`]).flat();
		await callPtcDiscoveryTool(
			'hf_spaces_list',
			{ hardwareRequestedAny: ['gpu-t4-small', 't4-small', ...guessed], hardwareCurrentAny: ['GPU-A10G-Large'] },
			{ fetch }
		);
		const params = requestUrl(fetch).searchParams;
		expect(params.get('runtime.hardware.current')).toBe('a10g-large');
		expect(params.get('runtime.hardware.requested')?.split(',')).toHaveLength(31);
		expect(params.get('runtime.hardware.requested')).toMatch(/^or:t4-small,flavor-0,flavor-1,/);
	});
	it('maps Space SDK/runtime/hardware and linked IDs with top-level OR, including MCP AND tags', async () => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(
			'hf_spaces_list',
			{
				sdks: ['gradio', 'docker'],
				runningOnly: true,
				hardwareCurrentAny: ['cpu-basic', 't4-small'],
				hardwareRequestedAny: ['zero-a10g'],
				modelsAny: ['org/model', 'other/model'],
				datasetsAny: ['org/data'],
				mcpOnly: true,
				tagsAnyGroups: [['foo', 'bar']],
				sort: 'id',
				direction: 'asc',
			},
			{ fetch }
		);
		expect(Object.fromEntries(requestUrl(fetch).searchParams)).toMatchObject({
			'cardData.sdk': 'or:gradio,docker',
			'runtime.stage': 'or:RUNNING,RUNNING_BUILDING',
			'runtime.hardware.current': 'or:cpu-basic,t4-small',
			'runtime.hardware.requested': 'zero-a10g',
			models: 'or:org/model,other/model',
			datasets: 'org/data',
			filter: 'or:(foo,bar),mcp-server',
			sort: 'id',
			direction: '1',
		});
	});
	it('allows ascending creation sort and explicit non-running stages', async () => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(
			'hf_spaces_list',
			{ sort: 'createdAt', direction: 'asc', stagesAny: ['SLEEPING', 'PAUSED'] },
			{ fetch }
		);
		expect(requestUrl(fetch).searchParams.get('runtime.stage')).toBe('or:SLEEPING,PAUSED');
	});
});

describe('default projections and closed vocabularies', () => {
	it('default fields omit tags, which remain selectable via fields', async () => {
		const fetch = mockJson([{ id: 'org/model', tags: ['en'] }]);
		const result = await callPtcDiscoveryTool('hf_models_search', { fields: ['tags'] }, { fetch });
		expect(requestUrl(fetch).searchParams.getAll('expand')).toEqual(['tags']);
		expect((result.items as { tags?: string[] }[])[0]?.tags).toEqual(['en']);
		const defaults = mockJson();
		await callPtcDiscoveryTool('hf_datasets_search', {}, { fetch: defaults });
		expect(requestUrl(defaults).searchParams.getAll('expand')).toEqual([
			'author',
			'createdAt',
			'lastModified',
			'likes',
			'downloads',
			'gated',
			'mainSize',
		]);
	});
	it.each([
		['hf_models_search', { providersAny: ['Groq', 'hf-inference'] }, 'inference_provider', 'groq,hf-inference'],
		['hf_models_search', { appsAny: ['LLAMA.CPP'] }, 'apps', 'llama.cpp'],
		['hf_spaces_list', { stagesAny: ['running', 'Sleeping'] }, 'runtime.stage', 'or:RUNNING,SLEEPING'],
		['hf_spaces_search', { category: 'OCR' }, 'category', 'ocr'],
	] as const)('%s accepts %j case-insensitively, sending canonical values', async (name, input, key, value) => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(name, input, { fetch });
		expect(requestUrl(fetch).searchParams.get(key)).toBe(value);
	});
	it.each([
		['hf_models_search', { providersAny: ['groq', 'auto'] }, 'Use anyProvider=true'],
		['hf_models_search', { appsAny: ['bad app!'] }, 'App IDs must be lowercase slugs'],
		['hf_spaces_list', { stagesAny: ['UP'] }, 'stagesAny.0: Invalid option: expected one of "NO_APP_FILE"'],
		['hf_spaces_search', { category: 'nope' }, 'category: Invalid option: expected one of "image-generation"'],
	] as const)('%s rejects %j listing the valid values', async (name, input, message) => {
		const fetch = mockJson();
		const error: unknown = await callPtcDiscoveryTool(name, input, { fetch }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PtcError);
		expect((error as Error).message).toContain(message);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('advertises closed vocabularies as enums and keeps dynamic provider/app IDs open', () => {
		const props = (name: PtcToolName) =>
			(z.toJSONSchema(tool(name).input, { io: 'input' }) as { properties: Record<string, unknown> }).properties;
		const models = props('hf_models_search');
		for (const [schema, key] of [
			[props('hf_spaces_list'), 'stagesAny'],
			[props('hf_spaces_search'), 'category'],
		] as const) {
			const json = JSON.stringify(schema[key]);
			expect(json, key).toContain('"enum"');
		}
		for (const key of ['providersAny', 'appsAny'] as const) {
			const json = JSON.stringify(models[key]);
			expect(json, key).not.toContain('"enum"');
		}
	});
});

describe('validation rejects unsupported or unrepresentable inputs before HTTP', () => {
	const invalid: [PtcToolName, unknown][] = [
		...[-1, 0, 101, 1.1, '20'].map((limit): [PtcToolName, unknown] => ['hf_models_search', { limit }]),
		['hf_models_search', { sort: 'downloadsAllTime' }],
		['hf_spaces_list', { sort: 'downloads' }],
		['hf_datasets_search', { sort: 'num_parameters' }],
		['hf_models_search', { direction: 'asc' }],
		['hf_models_search', { sort: 'lastModified', direction: 'asc' }],
		['hf_models_search', { providersAny: ['auto'] }],
		['hf_models_search', { providersAny: ['groq'], anyProvider: true }],
		['hf_models_search', { providersAny: ['groq'], inference: 'cold' }],
		['hf_models_search', { anyProvider: true, inference: 'warm' }],
		['hf_models_search', { numParametersMin: -1 }],
		['hf_models_search', { numParametersMin: 2, numParametersMax: 1 }],
		['hf_models_search', { numParametersAny: [1.5] }],
		['hf_models_search', { numParametersMax: Number.MAX_SAFE_INTEGER + 1 }],
		['hf_models_search', { created_at: { gte: '2025-01-01', gt: '2025-01-01' } }],
		['hf_models_search', { created_at: { lte: '2024-01-01', gte: '2025-01-01' } }],
		['hf_models_search', { created_at: { lt: '2025-01-01', lte: '2025-01-02' } }],
		['hf_models_search', { created_at: {} }],
		['hf_models_search', { created_at: { gte: 'tomorrow' } }],
		['hf_models_search', { baseModelRelation: 'quantized' }],
		['hf_datasets_search', { fields: ['datasetsServerInfo'] }],
		['hf_spaces_list', { fields: ['cardTitle'] }],
		['hf_models_search', { fields: ['cardData'] }],
		['hf_models_search', { tagsAnyGroups: [['dataset:org/a', 'dataset:org/b']] }],
		['hf_models_search', { tagsAnyGroups: [['a+b', 'c']] }],
		['hf_models_search', { tagsAll: ['or:a,b'] }],
		['hf_models_search', { tagsAll: ['a,b'] }],
		['hf_models_search', { tagsAll: ['or:foo'] }],
		['hf_models_search', { authorsAny: ['a,b'] }],
		['hf_models_search', { idsAny: ['https://example.com'] }],
		['hf_models_search', { idsAny: ['org/..'] }],
		['hf_models_search', { idsAny: ['org/repo/extra'] }],
		['hf_models_search', { tagsAll: Array.from({ length: 51 }, () => 'x') }],
		['hf_spaces_list', { runningOnly: true, stagesAny: ['RUNNING'] }],
		['hf_spaces_list', { sdk: 'flask' }],
		['hf_spaces_list', { hardware: 'gpu' }],
		['hf_datasets_search', { rows_min: 1 }],
		['hf_models_search', { private: false }],
		['hf_spaces_search', {}],
		['hf_spaces_search', { query: '  ' }],
		['hf_spaces_search', { query: 'x'.repeat(251) }],
		['hf_spaces_search', { category: 'not-a-category' }],
		...['cursor', 'sort', 'direction', 'authorsAny', 'fields', 'modelsAny', 'tagsAll', 'agents', 'url'].map(
			(key): [PtcToolName, unknown] => ['hf_spaces_search', { query: 'hi', [key]: 'x' }]
		),
		['hf_models_search', null],
		['hf_models_search', []],
	];
	it.each(invalid)('%s rejects %j', async (name, input) => {
		const fetch = mockJson();
		await expect(callPtcDiscoveryTool(name, input, { fetch })).rejects.toThrow('invalid input');
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('normalized typed field mapping and composition', () => {
	it('maps model pipeline, library, safetensors, provider array, config and canonical lineage/linked references', async () => {
		const result = modelsOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_models_search',
				{},
				{
					fetch: mockJson([
						{
							id: 'org/model',
							author: 'org',
							_id: 'internal',
							pipeline_tag: 'text-generation',
							library_name: 'transformers',
							createdAt: '2026-01-01T00:00:00Z',
							lastModified: '2026-02-01T00:00:00Z',
							downloads: 0,
							downloadsAllTime: 42,
							likes: 2,
							private: false,
							gated: 'manual',
							num_parameters: 100,
							safetensors: { total: 100, parameters: { BF16: 100 }, arbitrary: 'secret' },
							baseModels: { relation: 'quantized', models: [{ _id: 'not-a-repo-id', id: 'org/base' }] },
							spaces: ['org/demo'],
							tags: ['dataset:org/data', 'dataset:not a valid id', 'en'],
							config: {
								architectures: ['LlamaForCausalLM'],
								model_type: 'llama',
								tokenizer_config: { tokenizer_class: 'LlamaTokenizer' },
								arbitrary: 'secret',
							},
							transformersInfo: { auto_model: 'AutoModelForCausalLM', pipeline_tag: 'text-generation' },
							inferenceProviderMapping: [
								{ provider: 'groq', providerId: 'llama3', task: 'conversational', status: 'live', _id: 'secret' },
							],
						},
					]),
				}
			)
		);
		const item = result.items[0];
		expect(item).toMatchObject({
			kind: 'model',
			id: 'org/model',
			uri: 'hf://models/org/model',
			url: 'https://huggingface.co/org/model',
			pipelineTag: 'text-generation',
			libraryName: 'transformers',
			downloads: 0,
			downloadsAllTime: 42,
			numParameters: 100,
			safetensors: { total: 100, parameters: { BF16: 100 } },
			transformersInfo: { autoModel: 'AutoModelForCausalLM', pipelineTag: 'text-generation' },
			baseModels: [{ id: 'org/base', kind: 'model' }],
			baseModelRelation: 'quantized',
			spaces: [{ id: 'org/demo', uri: 'hf://spaces/org/demo' }],
			datasets: [{ id: 'org/data', uri: 'hf://datasets/org/data' }],
			inferenceProviders: [{ provider: 'groq', providerId: 'llama3', task: 'conversational' }],
		});
		expect(JSON.stringify(result)).not.toContain('secret');
		expect(JSON.stringify(result)).not.toContain('_id');
		const fetch = mockJson();
		await callPtcDiscoveryTool('hf_spaces_list', { modelsAny: result.items.map((v) => v.id) }, { fetch });
		expect(requestUrl(fetch).searchParams.get('models')).toBe('org/model');
		await callPtcDiscoveryTool('hf_datasets_search', { idsAny: item?.datasets?.map((v) => v.id) }, { fetch });
		expect(requestUrl(fetch, 1).searchParams.get('id')).toBe('org/data');
	});
	it('names the createdAt bound keys in its description', () => {
		const createdAt = z.toJSONSchema(tool('hf_models_search').input, { io: 'input' }).properties as Record<
			string,
			{ description?: string }
		>;
		expect(createdAt.createdAt?.description).toMatch(/\{gt\|gte, lt\|lte\}/);
	});

	it('gives GGUF-only models a parameter count from gguf.total without passing GGUF metadata through', async () => {
		const fetch = mockJson([
			{
				id: 'org/gguf-only',
				gguf: { total: 4947698560, architecture: 'qwen', context_length: 262144, chat_template: '{{ secret }}' },
			},
			{ id: 'org/both', safetensors: { total: 100, parameters: { BF16: 100 } }, gguf: { total: 99 } },
			{ id: 'org/none' },
		]);
		const result = modelsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_models_search', { fields: ['numParameters'] }, { fetch })
		);
		expect(requestUrl(fetch).searchParams.getAll('expand')).toEqual(['safetensors', 'gguf']);
		expect(result.items.map((item) => item.numParameters)).toEqual([4947698560, 100, undefined]);
		// A projection of safetensors/gguf: neither breakdown is returned unless requested.
		for (const leaked of ['secret', '"gguf"', 'architecture', 'context_length', '"safetensors"'])
			expect(JSON.stringify(result)).not.toContain(leaked);

		const both = modelsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_models_search', { fields: ['numParameters', 'safetensors'] }, { fetch })
		);
		expect(requestUrl(fetch, 1).searchParams.getAll('expand')).toEqual(['safetensors', 'gguf']);
		expect(both.items[1]?.safetensors).toEqual({ total: 100, parameters: { BF16: 100 } });
	});

	it('keeps the safetensors projection (and its cursor binding) without gguf', async () => {
		// Cursors are MAC-bound to the effective query, expand list included: an unchanged expand list keeps
		// cursors issued before numParameters existed valid, and the page small.
		const first = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
			const next = inputUrl(input);
			next.searchParams.set('cursor', 'upstream');
			return Promise.resolve(
				Response.json([{ id: 'org/a', safetensors: { total: 7 } }], {
					headers: { link: `<${String(next)}>; rel="next"` },
				})
			);
		});
		const args = { fields: ['safetensors'], limit: 1 };
		const page = modelsOutputSchema.parse(await callPtcDiscoveryTool('hf_models_search', args, { fetch: first }));
		expect(requestUrl(first).searchParams.getAll('expand')).toEqual(['safetensors']);
		expect(page.items[0]).toMatchObject({ safetensors: { total: 7 }, numParameters: 7 });
		const second = mockJson();
		await callPtcDiscoveryTool('hf_models_search', { ...args, cursor: page.nextCursor }, { fetch: second });
		expect(requestUrl(second).searchParams.get('cursor')).toBe('upstream');
		expect(requestUrl(second).searchParams.getAll('expand')).toEqual(['safetensors']);
	});

	it('explains an oversized numParameters page instead of raising the response budget', async () => {
		const oversized = () =>
			vi
				.fn<typeof globalThis.fetch>()
				.mockImplementation(() =>
					Promise.resolve(new Response('[]', { headers: { 'content-length': String(5 * 1024 * 1024) } }))
				);
		await expect(
			callPtcDiscoveryTool('hf_models_search', { fields: ['numParameters'], limit: 100 }, { fetch: oversized() })
		).rejects.toMatchObject({
			code: 'UPSTREAM_RESPONSE',
			message: expect.stringContaining('smaller limit') as unknown,
		});
		await expect(
			callPtcDiscoveryTool('hf_models_search', { fields: ['likes'] }, { fetch: oversized() })
		).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE', message: expect.not.stringContaining('limit') as unknown });
	});

	it('returns a reported zero but leaves an unknown row count absent in a batch of IDs', async () => {
		const ids = ['org/empty', 'org/unknown'];
		const fetch = mockJson([
			{ id: ids[0], datasetsServerInfo: { numRows: 0 } },
			{ id: ids[1], datasetsServerInfo: { numRows: null } },
		]);
		const result = datasetsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_datasets_search', { idsAny: ids, limit: ids.length, sort: 'numRows' }, { fetch })
		);
		const params = requestUrl(fetch).searchParams;
		expect(params.get('id')).toBe('or:org/empty,org/unknown');
		expect(params.get('limit')).toBe('2');
		expect(params.get('sort')).toBe('datasetsServerInfo.numRows');
		expect(result.items[0]?.numRows).toBe(0);
		expect(result.items[1]?.id).toBe('org/unknown');
		expect(JSON.parse(JSON.stringify(result.items[1]))).not.toHaveProperty('numRows');
	});

	it('maps dataset rows/bytes, optional strings and gates without using a fabricated total', async () => {
		const result = datasetsOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_datasets_search',
				{ sort: 'rows' },
				{
					fetch: mockJson([
						{
							id: 'org/data',
							datasetsServerInfo: { numRows: 123, secret: 'excluded' },
							mainSize: 456,
							description: 'plain text',
							citation: '@article{}',
							paperswithcode_id: 'dataset-name',
							gated: 'auto',
						},
					]),
				}
			)
		);
		expect(result.items[0]).toMatchObject({
			id: 'org/data',
			kind: 'dataset',
			uri: 'hf://datasets/org/data',
			url: 'https://huggingface.co/datasets/org/data',
			numRows: 123,
			mainSize: 456,
			paperswithcodeId: 'dataset-name',
			gated: 'auto',
		});
	});
	it('normalizes runtime and card presentation while stripping privileged/admin and raw metadata', async () => {
		const result = spacesListOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_spaces_list',
				{},
				{
					fetch: mockJson([
						{
							id: 'org/demo',
							sdk: 'gradio',
							models: ['org/model'],
							datasets: ['org/data'],
							cardData: { title: 'Demo', emoji: '🔥', short_description: 'Useful', secrets: 'never return' },
							runtime: {
								stage: 'SLEEPING',
								hardware: { current: null, requested: 't4-small' },
								replicas: { current: null, requested: 'auto' },
								gcTimeout: 300,
								abuse: { reason: 'never return' },
								errorMessage: 'never return',
							},
							region: 'us',
							subdomain: 'org-demo',
							resourceGroup: { id: 'never return' },
						},
					]),
				}
			)
		);
		expect(result.items[0]).toMatchObject({
			title: 'Demo',
			emoji: '🔥',
			shortDescription: 'Useful',
			models: [{ id: 'org/model', kind: 'model', url: 'https://huggingface.co/org/model' }],
			datasets: [{ id: 'org/data', kind: 'dataset' }],
			runtime: {
				stage: 'SLEEPING',
				hardware: { current: null, requested: 't4-small' },
				replicas: { current: null, requested: 'auto' },
			},
		});
		expect(JSON.stringify(result)).not.toContain('never return');
	});
});

describe('semantic candidates, OR tags and rank preservation', () => {
	it('sends only supported repeated query parameters, never an upstream limit, expand or cursor', async () => {
		const fetch = mockJson();
		await callPtcDiscoveryTool(
			'hf_spaces_search',
			{
				query: 'remove image background',
				category: 'background-removal',
				sdks: ['gradio', 'docker'],
				tagsAny: ['tag-a', 'tag-b'],
				limit: 7,
				mcpOnly: true,
			},
			{ fetch }
		);
		const params = requestUrl(fetch).searchParams;
		expect(params.getAll('sdk')).toEqual(['gradio', 'docker']);
		expect(params.getAll('filter')).toEqual(['tag-a', 'tag-b']);
		expect([...params.keys()]).toEqual(['q', 'category', 'includeNonRunning', 'sdk', 'sdk', 'filter', 'filter']);
		expect(params.get('includeNonRunning')).toBe('false');
	});
	it('enforces OR tags AND mcp_only before cap, without sorting or claiming global completeness', async () => {
		const fetch = mockJson([
			space('org/not-mcp', ['tag-a'], 9),
			space('org/wrong-tag', ['mcp-server'], 8),
			space('org/first', ['tag-b', 'mcp-server'], 0.2),
			space('org/second', ['tag-a', 'mcp-server'], 0.9),
			space('org/third', ['tag-a', 'tag-b', 'mcp-server'], 0.8),
		]);
		const result = spacesSearchOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_spaces_search',
				{ query: 'capability', tagsAny: ['tag-a', 'tag-b'], mcpOnly: true, limit: 2 },
				{ fetch }
			)
		);
		expect(result.items.map((item) => item.id)).toEqual(['org/first', 'org/second']);
		expect(result.items.map((item) => item.semanticScore)).toEqual([0.2, 0.9]);
		expect(result).toMatchObject({
			nextCursor: null,
			candidateCount: 5,
			eligibleCount: 3,
			returnedCount: 2,
			completeness: { hasMore: true, reason: 'items_cap' },
		});
	});
	it('narrows upstream to MCP only when there is no explicit OR tag group', async () => {
		const fetch = mockJson([space('org/no-tags', []), space('org/mcp')]);
		const result = await callPtcDiscoveryTool('hf_spaces_search', { category: 'image', mcpOnly: true }, { fetch });
		expect(requestUrl(fetch).searchParams.getAll('filter')).toEqual(['mcp-server']);
		expect(result.returnedCount).toBe(1);
	});
	it('checks SDK/runtime constraints before limit, and supports include_non_running', async () => {
		const wire = [
			{ ...space('org/static'), sdk: 'static' },
			{ ...space('org/sleep'), runtime: { stage: 'SLEEPING' } },
			{ ...space('org/missing-runtime'), runtime: undefined },
			{ ...space('org/run-build'), runtime: { stage: 'RUNNING_BUILDING' } },
		];
		const result = spacesSearchOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_spaces_search',
				{ query: 'app', sdks: ['gradio'], limit: 1 },
				{ fetch: mockJson(wire) }
			)
		);
		expect(result.items.map((i) => i.id)).toEqual(['org/run-build']);
		const all = spacesSearchOutputSchema.parse(
			await callPtcDiscoveryTool(
				'hf_spaces_search',
				{ query: 'app', sdks: ['gradio'], includeNonRunning: true },
				{ fetch: mockJson(wire) }
			)
		);
		expect(all.items.map((i) => i.id)).toEqual(['org/sleep', 'org/missing-runtime', 'org/run-build']);
	});
	it('defaults to local 20, caps at 100 and does not invent a continuation for 120 candidates', async () => {
		for (const limit of [undefined, 100]) {
			const result = spacesSearchOutputSchema.parse(
				await callPtcDiscoveryTool(
					'hf_spaces_search',
					{ query: 'app', limit },
					{ fetch: mockJson(Array.from({ length: 120 }, (_, i) => space(`org/app-${String(i)}`))) }
				)
			);
			expect(result.returnedCount).toBe(limit ?? 20);
			expect(result.candidateCount).toBe(120);
			expect(result.nextCursor).toBeNull();
			expect(result.eligibleCount).toBe(120);
		}
	});
	it('reports no local truncation for empty candidates but still no global completeness', async () => {
		const result = spacesSearchOutputSchema.parse(
			await callPtcDiscoveryTool('hf_spaces_search', { query: 'nothing' }, { fetch: mockJson() })
		);
		expect(result.returnedCount).toBe(0);
		expect(result.eligibleCount).toBe(0);
		expect(result.completeness.hasMore).toBe(false);
	});
});

describe('real Link pagination and query integrity', () => {
	function paginated(transform: (url: URL) => void = () => undefined) {
		return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
			const next = inputUrl(input);
			next.searchParams.set('cursor', 'upstream+/=opaque');
			transform(next);
			return Promise.resolve(
				Response.json([{ id: 'org/repo' }], { headers: { link: `<${String(next)}>; rel="next"` } })
			);
		});
	}
	it.each(['hf_models_search', 'hf_datasets_search', 'hf_spaces_list'] as const)(
		'%s returns opaque cursors, preserves the query, and stops on no Link',
		async (name) => {
			const first = paginated();
			const args = { query: 'test', limit: 1, fields: ['likes'] };
			const page = await callPtcDiscoveryTool(name, args, { fetch: first });
			expect(typeof page.nextCursor).toBe('string');
			expect(page.nextCursor).not.toBe('upstream+/=opaque');
			const second = mockJson();
			const end = await callPtcDiscoveryTool(name, { ...args, cursor: page.nextCursor }, { fetch: second });
			expect(requestUrl(second).searchParams.get('cursor')).toBe('upstream+/=opaque');
			expect(requestUrl(second).searchParams.get('search')).toBe('test');
			expect(end).toMatchObject({ items: [], nextCursor: null, returnedCount: 0 });
		}
	);
	it('blocks the known dotted row-sort cursor instead of silently skipping datasets', async () => {
		// Real Hub row-sort cursors select numRows:null even after populated rows.
		// Keep the first page usable without presenting that cursor as safe or exhausted.
		const fetch = paginated();
		const page = datasetsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_datasets_search', { sort: 'rows', limit: 1 }, { fetch })
		);
		expect(page.nextCursor).toBeNull();
		expect(page.completeness).toMatchObject({
			hasMore: true,
			reason: 'row_sort_cursor',
		});
		// Not truncated: the server instructions are what tell a client this null cursor is blocked paging, not the end.
		expect(page.completeness.truncated).toBeUndefined();
		expect(PTC_INSTRUCTIONS).toMatch(/hasMore with null cursor = paging blocked/);
		expect(page.items).toHaveLength(1);
		expect(
			datasetsOutputSchema.safeParse({
				...page,
				completeness: { ...page.completeness, reason: undefined },
			}).success
		).toBe(false);
		fetch.mockClear();
		await expect(
			callPtcDiscoveryTool('hf_datasets_search', { sort: 'rows', cursor: 'anything' }, { fetch })
		).rejects.toThrow('Row-sort pagination is unavailable');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('retains ordinary end-of-listing semantics for a row-sorted page with no Link', async () => {
		const result = datasetsOutputSchema.parse(
			await callPtcDiscoveryTool('hf_datasets_search', { sort: 'rows' }, { fetch: mockJson() })
		);
		expect(result.completeness.hasMore).toBe(false);
		expect(result.completeness.reason).toBeUndefined();
	});

	it('accepts qs array reserialization in the Link, quoted/unquoted rel and previous links', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
			const url = inputUrl(input);
			const expand = url.searchParams.getAll('expand');
			url.searchParams.delete('expand');
			expand.forEach((field, index) => url.searchParams.append(`expand[${String(index)}]`, field));
			url.searchParams.set('cursor', 'real-cursor');
			return Promise.resolve(
				Response.json([], { headers: { link: `</previous>; rel="prev", <${String(url)}>; rel=next` } })
			);
		});
		expect((await callPtcDiscoveryTool('hf_models_search', {}, { fetch })).nextCursor).not.toBeNull();
	});
	it('rejects changed input, tool, limit, fields or authentication before a second request', async () => {
		const page = await callPtcDiscoveryTool(
			'hf_models_search',
			{ query: 'first' },
			{ fetch: paginated(), hfToken: 'test-secret' }
		);
		for (const [name, changes, hfToken] of [
			['hf_models_search', { query: 'second' }, 'test-secret'],
			['hf_models_search', { limit: 2 }, 'test-secret'],
			['hf_models_search', { fields: ['likes'] }, 'test-secret'],
			['hf_models_search', {}, undefined],
			['hf_datasets_search', {}, 'test-secret'],
		] as const) {
			const fetch = mockJson();
			await expect(
				callPtcDiscoveryTool(name, { query: 'first', ...changes, cursor: page.nextCursor }, { fetch, hfToken })
			).rejects.toThrow('changed query');
			expect(fetch).not.toHaveBeenCalled();
		}
		expect(Buffer.from(String(page.nextCursor), 'base64url').toString()).not.toContain('test-secret');
	});
	it.each([
		(url: URL) => {
			url.hostname = 'evil.example';
		},
		(url: URL) => {
			url.protocol = 'http:';
		},
		(url: URL) => {
			url.username = 'token';
		},
		(url: URL) => {
			url.pathname = '/api/datasets';
		},
		(url: URL) => {
			url.searchParams.set('search', 'changed');
		},
		(url: URL) => {
			url.searchParams.set('limit', '1000');
		},
		(url: URL) => {
			url.searchParams.set('adminSearch', 'true');
		},
		(url: URL) => {
			url.hash = 'fragment';
		},
		(url: URL) => {
			url.searchParams.append('cursor', 'another');
		},
		(url: URL) => {
			url.searchParams.delete('cursor');
		},
	])('rejects unsafe or altered continuation URLs, never follows them', async (transform) => {
		const fetch = paginated(transform);
		await expect(callPtcDiscoveryTool('hf_models_search', {}, { fetch, hfToken: 'test-secret' })).rejects.toThrow(
			'pagination'
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('rejects arbitrary cursor URLs and malformed encodings', async () => {
		for (const cursor of ['https://evil.example', 'not-json', Buffer.from('{}').toString('base64url')]) {
			const fetch = mockJson();
			await expect(callPtcDiscoveryTool('hf_models_search', { cursor }, { fetch })).rejects.toThrow('cursor');
			expect(fetch).not.toHaveBeenCalled();
		}
	});
	it('fails duplicate next links and looping cursors', async () => {
		const first = paginated();
		const page = await callPtcDiscoveryTool('hf_models_search', {}, { fetch: first });
		await expect(
			callPtcDiscoveryTool('hf_models_search', { cursor: page.nextCursor }, { fetch: paginated() })
		).rejects.toThrow('pagination');
		const duplicate = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
			const url = inputUrl(input);
			url.searchParams.set('cursor', 'new');
			return Promise.resolve(
				Response.json([], { headers: { link: `<${String(url)}>; rel="next", <${String(url)}>; rel="next"` } })
			);
		});
		await expect(callPtcDiscoveryTool('hf_models_search', {}, { fetch: duplicate })).rejects.toThrow('pagination');
	});
});

describe('safe failures, budgets and cancellation', () => {
	it.each([301, 302, 400, 401, 403, 429, 500, 501])(
		'sanitizes HTTP %i without leaking bodies/tokens or following redirects',
		async (status) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValue(
					new Response('raw secret response', { status, headers: { location: 'https://evil.example' } })
				);
			const error: unknown = await callPtcDiscoveryTool(
				'hf_models_search',
				{},
				{ fetch, hfToken: 'test-secret' }
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PtcError);
			expect(String(error)).not.toMatch(/raw secret|test-secret|evil/);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-secret');
		}
	);
	it('does not surface fetch exception messages or causes', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new Error('test-secret', { cause: 'raw response' }));
		const error: unknown = await callPtcDiscoveryTool('hf_models_search', {}, { fetch }).catch((e: unknown) => e);
		expect(String(error)).not.toContain('test-secret');
		expect(error).not.toHaveProperty('cause');
	});
	it.each([
		{},
		null,
		'text',
		[{ id: 3 }],
		[{ id: 'org/repo', likes: 'many' }],
		[{ id: 'org/repo', runtime: { stage: 3 } }],
	])('rejects malformed upstream data %j without leaking it', async (body) => {
		await expect(callPtcDiscoveryTool('hf_spaces_list', {}, { fetch: mockJson(body) })).rejects.toBeInstanceOf(
			PtcError
		);
	});
	it('rejects invalid JSON rather than parsing Markdown or returning an empty success', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('# model list\nsecret'));
		await expect(callPtcDiscoveryTool('hf_models_search', {}, { fetch })).rejects.toThrow('malformed JSON');
	});
	it('rejects excessive record counts, content-length and streamed body size', async () => {
		await expect(
			callPtcDiscoveryTool('hf_models_search', { limit: 1 }, { fetch: mockJson([{ id: 'a' }, { id: 'b' }]) })
		).rejects.toThrow('bounded contract');
		await expect(
			callPtcDiscoveryTool(
				'hf_spaces_search',
				{ query: 'app' },
				{ fetch: mockJson(Array.from({ length: 121 }, () => space('o/r'))) }
			)
		).rejects.toThrow('bounded contract');
		await expect(
			callPtcDiscoveryTool('hf_models_search', {}, { fetch: mockJson([], { 'content-length': '5000000' }) })
		).rejects.toThrow('size budget');
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(() => Promise.resolve(new Response(' '.repeat(4 * 1024 * 1024 + 1))));
		await expect(callPtcDiscoveryTool('hf_models_search', {}, { fetch })).rejects.toThrow('size budget');
	});
	it('rejects an already-aborted signal before HTTP', async () => {
		const fetch = mockJson();
		const controller = new AbortController();
		controller.abort();
		await expect(callPtcDiscoveryTool('hf_models_search', {}, { fetch, signal: controller.signal })).rejects.toThrow(
			'cancelled'
		);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('cancels an in-flight injected fetch even if the transport ignores the signal', async () => {
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => undefined));
		const promise = callPtcDiscoveryTool('hf_models_search', {}, { fetch, signal: controller.signal });
		const assertion = expect(promise).rejects.toThrow('cancelled');
		controller.abort();
		await assertion;
		expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});
	it('cancels body reads and applies a bounded timeout through body consumption', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({ cancel });
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream));
		const promise = callPtcDiscoveryTool('hf_models_search', {}, { fetch });
		const assertion = expect(promise).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(12500);
		await assertion;
		expect(cancel).toHaveBeenCalled();
		expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('clears the timeout after successful completion', async () => {
		vi.useFakeTimers();
		await callPtcDiscoveryTool('hf_models_search', {}, { fetch: mockJson() });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('hf_spaces_search source curated (operator catalog)', () => {
	const CSV = [
		'acme/bg-remover,Background Removal,"Remove image backgrounds"',
		'acme/tts,Speech Synthesis,"Text to speech, many voices"',
		'not a valid id,Other,"skipped"',
		'acme/upscaler,Image Upscaling,Upscale images 4x',
	].join('\n');
	afterEach(() => {
		vi.unstubAllEnvs();
		catalogFetch.mockReset();
	});

	it('returns UNSUPPORTED without a configured catalog and never calls the Hub', async () => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', '');
		const fetch = mockJson();
		const error = await callPtcDiscoveryTool('hf_spaces_search', { source: 'curated' }, { fetch }).catch(
			(e: unknown) => e
		);
		expect(error).toMatchObject({ code: 'UNSUPPORTED' });
		expect((error as Error).message).toContain('no curated Space catalog');
		expect(fetch).not.toHaveBeenCalled();
		expect(catalogFetch).not.toHaveBeenCalled();
	});

	it('lists the whole catalog as Space records without query or category', async () => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', 'https://example.com/spaces.csv');
		catalogFetch.mockImplementation(() => Promise.resolve({ response: new Response(CSV) }));
		const fetch = mockJson();
		const result = await callPtcDiscoveryTool('hf_spaces_search', { source: 'curated' }, { fetch });
		expect(fetch).not.toHaveBeenCalled();
		expect(catalogFetch.mock.calls[0]?.[0]).toBe('https://example.com/spaces.csv');
		expect(spacesSearchOutputSchema.safeParse(result).success).toBe(true);
		expect(result).not.toHaveProperty('mode');
		expect(result).not.toHaveProperty('source');
		expect(result).not.toHaveProperty('truncation');
		expect(result).toMatchObject({
			completeness: { hasMore: false },
			candidateCount: 3,
			eligibleCount: 3,
			returnedCount: 3,
			nextCursor: null,
		});
		expect((result.items as unknown[])[0]).toEqual({
			kind: 'space',
			id: 'acme/bg-remover',
			uri: 'hf://spaces/acme/bg-remover',
			url: 'https://huggingface.co/spaces/acme/bg-remover',
			category: 'Background Removal',
			shortDescription: 'Remove image backgrounds',
		});
	});

	it('filters locally by category slug and query terms, then applies the limit', async () => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', 'https://example.com/spaces.csv');
		catalogFetch.mockImplementation(() => Promise.resolve({ response: new Response(CSV) }));
		const byCategory = await callPtcDiscoveryTool('hf_spaces_search', {
			source: 'curated',
			category: 'background-removal',
		});
		expect((byCategory.items as { id: string }[]).map((i) => i.id)).toEqual(['acme/bg-remover']);
		const byQuery = await callPtcDiscoveryTool('hf_spaces_search', { source: 'curated', query: 'IMAGE', limit: 1 });
		expect(byQuery).toMatchObject({ eligibleCount: 2, returnedCount: 1 });
	});

	it('hides the operator URL and upstream details when the catalog fails to load', async () => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', 'https://secret.example.com/spaces.csv');
		catalogFetch.mockResolvedValue({ response: new Response('boom', { status: 500 }) });
		const error = await callPtcDiscoveryTool('hf_spaces_search', { source: 'curated' }).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
		expect(String((error as Error).message)).not.toContain('secret');
	});

	it('refuses an oversized catalog while streaming, without buffering it', async () => {
		vi.stubEnv('DYNAMIC_SPACE_DATA', 'https://example.com/spaces.csv');
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new TextEncoder().encode('acme/x,Cat,"d"\n'.repeat(4096)));
			},
		});
		catalogFetch.mockResolvedValue({ response: new Response(body) });
		const error = await callPtcDiscoveryTool('hf_spaces_search', { source: 'curated' }).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'UPSTREAM_RESPONSE' });
		expect((error as Error).message).toContain('too large');
		// About 64 KB per chunk against a 1 MB budget: reading stops just past it.
		expect(pulled).toBeLessThan(40);
	});

	it('rejects hub-only filters with curated, and still requires query or category for hub', async () => {
		for (const input of [
			{ source: 'curated', sdks: ['gradio'] },
			{ source: 'curated', tagsAny: ['mcp-server'] },
			{ source: 'curated', mcpOnly: true },
			{ source: 'hub' },
			{ source: 'other', query: 'x' },
		]) {
			await expect(callPtcDiscoveryTool('hf_spaces_search', input)).rejects.toThrow('invalid input');
		}
		expect(catalogFetch).not.toHaveBeenCalled();
	});

	it('omits constant mode/source/truncation and rejects them if supplied', async () => {
		const fetch = mockJson([space('owner/a')]);
		const semantic = await callPtcDiscoveryTool('hf_spaces_search', { query: 'remove background' }, { fetch });
		expect(Object.keys(semantic).sort()).toEqual([
			'candidateCount',
			'completeness',
			'eligibleCount',
			'items',
			'nextCursor',
			'returnedCount',
		]);
		for (const bad of [
			{ ...semantic, mode: 'semantic' },
			{ ...semantic, truncation: { local_limit_applied: false, upstream_candidate_limit: 120 } },
			{ ...semantic, source: { service: 'huggingface_hub', endpoint: '/api/spaces/semantic-search' } },
		]) {
			expect(spacesSearchOutputSchema.safeParse(bad).success).toBe(false);
		}
	});
});

describe('hf:// thread for listing selectors (A15)', () => {
	it('accepts returned uris and urls for ID selectors and paper IDs', async () => {
		const fetch = mockJson([]);
		await callPtcDiscoveryTool(
			'hf_models_search',
			{
				idsAny: ['hf://models/org/model', 'https://huggingface.co/org/other'],
				datasetsAny: ['hf://datasets/org/data'],
				papersAny: ['hf://papers/1706.03762'],
			},
			{ fetch }
		);
		const params = requestUrl(fetch).searchParams;
		expect(params.get('id')).toBe('or:org/model,org/other');
		expect(params.get('datasets')).toBe('org/data');
		expect(params.get('arxivIds')).toBe('1706.03762');
	});
	it('accepts the anchored paper ref forms and drops the version', async () => {
		const fetch = mockJson([]);
		const refs = [
			'2106.09685v2',
			'arxiv:2106.09685',
			'https://huggingface.co/papers/2106.09685',
			'https://arxiv.org/abs/2106.09685v1',
			'https://arxiv.org/pdf/2106.09685',
		];
		await callPtcDiscoveryTool('hf_models_search', { papersAny: refs }, { fetch });
		expect(requestUrl(fetch).searchParams.get('arxivIds')).toBe(`or:${Array(5).fill('2106.09685').join(',')}`);
	});
	it('rejects uris with a revision or path, and non-arXiv paper IDs', async () => {
		const fetch = mockJson([]);
		for (const input of [
			{ idsAny: ['hf://models/org/model@dev'] },
			{ idsAny: ['hf://models/org/model/config.json'] },
			{ papersAny: ['not-a-paper'] },
			{ papersAny: ['https://evil.example/2106.09685oops'] },
			{ papersAny: ['https://huggingface.co/papers/2106.09685oops'] },
			{ papersAny: ['x2106.09685'] },
		]) {
			await expect(callPtcDiscoveryTool('hf_models_search', input, { fetch })).rejects.toThrow('invalid input');
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('fields projection', () => {
	it('treats an empty fields list as the default projection', async () => {
		const fetch = mockJson([]);
		await callPtcDiscoveryTool('hf_models_search', { fields: [] }, { fetch });
		expect(requestUrl(fetch).searchParams.getAll('expand')).toContain('downloads');
	});
});

describe('authors_any letter case', () => {
	function hub(routes: Record<string, (url: URL) => Response>) {
		return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
			const url = inputUrl(input);
			const route = routes[url.pathname];
			return Promise.resolve(route ? route(url) : Response.json({}, { status: 404 }));
		});
	}

	it('sends the canonical owner case (author= is case-sensitive) and reports unknown owners', async () => {
		const fetch = hub({
			'/api/users/EVALSTATE/overview': (url) =>
				new Response(null, { status: 307, headers: { location: url.pathname.replace('EVALSTATE', 'evalstate') } }),
			'/api/users/evalstate/overview': () => Response.json({ user: 'evalstate' }),
			'/api/organizations/qwen/overview': () => Response.json({ name: 'Qwen' }),
			'/api/models': () => Response.json([]),
			'/api/datasets': () => Response.json([]),
		});
		const result = await callPtcDiscoveryTool(
			'hf_models_search',
			{ authorsAny: ['EVALSTATE', 'qwen', 'no-such-owner'] },
			{ fetch }
		);
		expect(requestUrl(fetch).searchParams.get('author')).toBe('or:evalstate,Qwen,no-such-owner');
		expect(result.completeness).toMatchObject({ unknownOwners: ['no-such-owner'] });
		// Cached per process: a second call makes only the listing request.
		fetch.mockClear();
		await callPtcDiscoveryTool('hf_datasets_search', { authorsAny: ['QWEN'] }, { fetch });
		expect(fetch.mock.calls.map((call) => inputUrl(call[0] as string).pathname)).toEqual(['/api/datasets']);
		expect(requestUrl(fetch).searchParams.get('author')).toBe('Qwen');
	});

	it('keeps names as given when the lookup fails, and makes no lookup without authors_any', async () => {
		const fetch = hub({
			'/api/users/Some-Org/overview': () => Response.json({}, { status: 503 }),
			'/api/spaces': () => Response.json([]),
		});
		const result = await callPtcDiscoveryTool('hf_spaces_list', { authorsAny: ['Some-Org'] }, { fetch });
		expect(requestUrl(fetch).searchParams.get('author')).toBe('Some-Org');
		expect(result.completeness).not.toHaveProperty('unknownOwners');
		fetch.mockClear();
		await callPtcDiscoveryTool('hf_spaces_list', {}, { fetch });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('accepts openrouter inference provider, avoids double-prefixing license facets, and lowercases languages', async () => {
		const fetch = hub({
			'/api/models': () => Response.json([]),
			'/api/datasets': () => Response.json([]),
		});
		await callPtcDiscoveryTool(
			'hf_models_search',
			{
				providersAny: ['openrouter'],
				licensesAll: ['license:apache-2.0', 'MIT'],
				languagesAll: ['pt-BR'],
			},
			{ fetch }
		);
		const mUrl = requestUrl(fetch);
		expect(mUrl.searchParams.get('inference_provider')).toBe('openrouter');
		expect(mUrl.searchParams.get('filter')).toBe('pt-br,license:apache-2.0,license:mit');

		fetch.mockClear();
		await callPtcDiscoveryTool(
			'hf_datasets_search',
			{
				licensesAll: ['license:cc-by-4.0'],
				languagesAll: ['language:zh-CN'],
			},
			{ fetch }
		);
		const dUrl = requestUrl(fetch);
		expect(dUrl.searchParams.get('filter')).toBe('language:zh-cn,license:cc-by-4.0');
	});

	it('adds completeness hints on empty hardware+query spaces list and empty multi-word spaces search', async () => {
		const fetch = hub({
			'/api/spaces': () => Response.json([]),
			'/api/spaces/semantic-search': () => Response.json([]),
		});
		const listRes = await callPtcDiscoveryTool(
			'hf_spaces_list',
			{ hardwareCurrentAny: ['zero-a10g'], query: 'flux' },
			{ fetch }
		);
		expect((listRes.completeness as { hint?: string }).hint).toMatch(/hardware/i);

		const searchRes = await callPtcDiscoveryTool(
			'hf_spaces_search',
			{ query: 'mcp server image generation' },
			{ fetch }
		);
		expect((searchRes.completeness as { hint?: string }).hint).toMatch(/multi-word|hf_spaces_list/i);
	});
});
