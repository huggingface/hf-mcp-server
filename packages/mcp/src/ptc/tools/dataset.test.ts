import { describe, expect, it, vi } from 'vitest';
import { callPtcTool, type PtcContext } from '../core/tool.js';
import { boundCell, DATASET_TOOLS } from './dataset.js';

function mockFetch(routes: Record<string, (url: URL) => Response>) {
	return vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		expect(['https://datasets-server.huggingface.co', 'https://huggingface.co']).toContain(url.origin);
		const route = routes[url.pathname];
		return Promise.resolve(route ? route(url) : new Response('{}', { status: 404 }));
	});
}

function call(name: string, input: unknown, ctx: PtcContext) {
	const tool = DATASET_TOOLS.find((t) => t.name === name);
	if (!tool) throw new Error(`missing ${name}`);
	return callPtcTool(tool, input, ctx);
}

describe('DATASET_TOOLS registry', () => {
	it('defines the two v2 dataset tools', () => {
		expect(DATASET_TOOLS.map((t) => t.name)).toEqual(['hf_dataset_structure', 'hf_dataset_rows']);
		for (const tool of DATASET_TOOLS) {
			expect(tool.description.length).toBeGreaterThanOrEqual(250);
			expect(tool.description.length).toBeLessThanOrEqual(700);
		}
	});
});

describe('hf_dataset_structure', () => {
	const routes = {
		'/splits': () =>
			Response.json({
				splits: [
					{ dataset: 'o/d', config: 'default', split: 'train' },
					{ dataset: 'o/d', config: 'default', split: 'test' },
				],
				pending: [],
				failed: [],
			}),
		'/size': () =>
			Response.json({
				size: {
					dataset: { dataset: 'o/d', num_rows: 30, num_bytes_parquet_files: 300, num_bytes_memory: 900 },
					configs: [],
					splits: [
						{
							dataset: 'o/d',
							config: 'default',
							split: 'train',
							num_rows: 20,
							num_columns: 2,
							num_bytes_parquet_files: 200,
						},
						{ dataset: 'o/d', config: 'default', split: 'test', num_rows: 10, num_columns: 2 },
					],
				},
				partial: false,
				pending: [],
				failed: [],
			}),
		'/info': () =>
			Response.json({
				dataset_info: {
					default: {
						features: {
							text: { dtype: 'string', _type: 'Value' },
							label: { names: ['neg', 'pos'], _type: 'ClassLabel' },
							tokens: { feature: { dtype: 'int64', _type: 'Value' }, _type: 'List' },
						},
					},
				},
				partial: false,
			}),
		'/parquet': () => new Response('{}', { status: 500 }),
	};

	it('merges splits and sizes, compacts the schema and reports unavailable sections', async () => {
		const r = await call('hf_dataset_structure', { dataset: 'hf://datasets/o/d' }, { fetch: mockFetch(routes) });
		expect(r.structured).toMatchObject({
			dataset: { kind: 'dataset', id: 'o/d', uri: 'hf://datasets/o/d' },
			splits: [
				{ config: 'default', split: 'train', numRows: 20, numColumns: 2, parquetSize: 200 },
				{ config: 'default', split: 'test', numRows: 10 },
			],
			totals: { numRows: 30, parquetSize: 300, memorySize: 900 },
			schema: [
				{
					config: 'default',
					columns: [
						{ name: 'text', type: 'string' },
						{ name: 'label', type: 'ClassLabel(neg, pos)' },
						{ name: 'tokens', type: 'list<int64>' },
					],
				},
			],
			partial: false,
			unavailable: [{ section: 'parquet', code: 'UPSTREAM_HTTP' }],
		});
	});

	it('requires config and split for bounded statistics', async () => {
		await expect(
			call('hf_dataset_structure', { dataset: 'o/d', include: ['statistics'] }, { fetch: mockFetch({}) })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		const fetch = mockFetch({
			'/statistics': (url) => {
				expect(url.searchParams.get('split')).toBe('train');
				return Response.json({
					num_examples: 20,
					statistics: [
						{
							column_name: 'label',
							column_type: 'class_label',
							column_statistics: {
								nan_count: 0,
								n_unique: 30,
								frequencies: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${String(i)}`, i])),
							},
						},
					],
					partial: false,
				});
			},
		});
		const r = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', config: 'default', split: 'train', include: ['statistics'] },
			{ fetch }
		);
		const stats = r.structured.statistics as { columns: { statistics: Record<string, unknown> }[] };
		expect(Object.keys(stats.columns[0]?.statistics.frequencies as object)).toHaveLength(20);
		expect(stats.columns[0]?.statistics).toMatchObject({
			n_unique: 30,
			frequenciesTruncated: true,
			frequencies: { c29: 29 },
		});
	});

	it('reports top-level partial when only the statistics are partial (R7)', async () => {
		const fetch = mockFetch({
			'/splits': () => Response.json({ splits: [{ config: 'c', split: 'train' }], partial: false }),
			'/statistics': () =>
				Response.json({
					num_examples: 5,
					statistics: [{ column_name: 'x', column_type: 'int', column_statistics: { min: 1 } }],
					partial: true,
				}),
		});
		const r = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', config: 'c', split: 'train', include: ['splits', 'statistics'] },
			{ fetch }
		);
		expect(r.structured.statistics).toMatchObject({ partial: true });
		expect(r.structured.partial).toBe(true);
	});

	it('reads config totals from the config-scoped /size shape (A8)', async () => {
		// Captured 2026-11-16 from GET /size?dataset=stanfordnlp/imdb&config=plain_text.
		const imdbConfigSize = {
			size: {
				config: {
					dataset: 'stanfordnlp/imdb',
					config: 'plain_text',
					num_bytes_original_files: 83446840,
					num_bytes_parquet_files: 83446840,
					num_bytes_memory: 132577254,
					num_rows: 100000,
					num_columns: 2,
					estimated_num_rows: null,
				},
				splits: [
					{
						dataset: 'stanfordnlp/imdb',
						config: 'plain_text',
						split: 'train',
						num_bytes_parquet_files: 20979968,
						num_bytes_memory: 33290791,
						num_rows: 25000,
						num_columns: 2,
						estimated_num_rows: null,
					},
					{
						dataset: 'stanfordnlp/imdb',
						config: 'plain_text',
						split: 'test',
						num_bytes_parquet_files: 20470363,
						num_bytes_memory: 32468164,
						num_rows: 25000,
						num_columns: 2,
						estimated_num_rows: null,
					},
					{
						dataset: 'stanfordnlp/imdb',
						config: 'plain_text',
						split: 'unsupervised',
						num_bytes_parquet_files: 41996509,
						num_bytes_memory: 66818299,
						num_rows: 50000,
						num_columns: 2,
						estimated_num_rows: null,
					},
				],
			},
			partial: false,
		};
		const fetch = mockFetch({
			'/size': (url) => {
				expect(url.searchParams.get('config')).toBe('plain_text');
				return Response.json(imdbConfigSize);
			},
		});
		const r = await call(
			'hf_dataset_structure',
			{ dataset: 'stanfordnlp/imdb', config: 'plain_text', include: ['sizes'] },
			{ fetch }
		);
		expect(r.structured.totals).toEqual({
			numRows: 100000,
			parquetSize: 83446840,
			memorySize: 132577254,
			originalSize: 83446840,
		});
		expect(r.structured.splits).toHaveLength(3);

		// The dataset-wide shape (size.configs[]) still works when a config is requested.
		const wide = mockFetch({
			'/size': () =>
				Response.json({
					size: {
						dataset: { num_rows: 1 },
						configs: [
							{ config: 'other', num_rows: 5 },
							{ config: 'plain_text', num_rows: 7 },
						],
						splits: [],
					},
				}),
		});
		const w = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', config: 'plain_text', include: ['sizes'] },
			{ fetch: wide }
		);
		expect(w.structured.totals).toEqual({ numRows: 7 });
	});

	it('flags capped configs, columns, parquet files and statistics with narrowing hints (A10)', async () => {
		const features = Object.fromEntries(
			Array.from({ length: 250 }, (_, i) => [`c${String(i)}`, { dtype: 'int64', _type: 'Value' }])
		);
		const fetch = mockFetch({
			'/info': () =>
				Response.json({
					dataset_info: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`cfg${String(i)}`, { features }])),
				}),
			'/parquet': () =>
				Response.json({
					parquet_files: Array.from({ length: 60 }, (_, i) => ({
						config: 'cfg0',
						split: 'train',
						url: `https://huggingface.co/x/${String(i)}.parquet`,
					})),
				}),
		});
		const r = await call('hf_dataset_structure', { dataset: 'o/d', include: ['schema', 'parquet'] }, { fetch });
		const out = r.structured as {
			schema: { columns: unknown[]; columnsTruncated?: boolean; numColumns?: number }[];
			schemaTruncated?: boolean;
			numSchemaConfigs?: number;
			parquet: { files: unknown[]; truncated: boolean; numFiles: number };
			hints?: string[];
		};
		expect(out.schema).toHaveLength(20);
		expect(out.schema[0]).toMatchObject({ columnsTruncated: true, numColumns: 250 });
		expect(out.schema[0]?.columns).toHaveLength(200);
		expect(out).toMatchObject({ schemaTruncated: true, numSchemaConfigs: 25 });
		expect(out.parquet).toMatchObject({ truncated: true, numFiles: 60 });
		expect(out.hints?.join(' ')).toMatch(/pass config/);
		expect(out.hints?.join(' ')).toMatch(/config and split/);

		const stats = mockFetch({
			'/statistics': () =>
				Response.json({
					num_examples: 1,
					statistics: Array.from({ length: 230 }, (_, i) => ({
						column_name: `c${String(i)}`,
						column_type: 'int',
						column_statistics: { histogram: { hist: Array.from({ length: 30 }, () => 1), bin_edges: [] } },
					})),
				}),
		});
		const s = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', config: 'cfg0', split: 'train', include: ['statistics'] },
			{ fetch: stats }
		);
		expect(s.structured.statistics).toMatchObject({ columnsTruncated: true, numColumns: 230 });
		const first = (s.structured.statistics as { columns: { statistics: Record<string, unknown> }[] }).columns[0];
		expect(first?.statistics).toEqual({ histogramOmitted: true });
		expect(s.structured.hints).toEqual([expect.stringMatching(/first 200 of 230 columns/)]);
	});

	it('throws when every requested section fails', async () => {
		await expect(
			call('hf_dataset_structure', { dataset: 'o/missing', include: ['splits'] }, { fetch: mockFetch({}) })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('hf_dataset_rows', () => {
	const rowsBody = (offset: number) => ({
		features: [
			{ feature_idx: 0, name: 'text', type: { dtype: 'string', _type: 'Value' } },
			{ feature_idx: 1, name: 'meta', type: { a: { dtype: 'string', _type: 'Value' } } },
		],
		rows: [
			{ row_idx: offset, row: { text: 'x'.repeat(5000), meta: { a: 'short' } }, truncated_cells: [] },
			{ row_idx: offset + 1, row: { text: 'ok', meta: { a: 'y'.repeat(5000) } }, truncated_cells: ['text'] },
		],
		num_rows_total: 3,
		num_rows_per_page: 100,
		partial: false,
	});

	it('reads rows, truncates long cells with markers and pages by cursor', async () => {
		const fetch = mockFetch({ '/rows': (url) => Response.json(rowsBody(Number(url.searchParams.get('offset')))) });
		const r = await call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'train', limit: 2 }, { fetch });
		const items = r.structured.items as { row: Record<string, unknown>; truncatedCells?: string[] }[];
		expect(String(items[0]?.row.text)).toMatch(/…\[truncated \d+ chars\]$/);
		expect(items[0]?.truncatedCells).toEqual(['text']);
		expect(items[1]?.row.meta).toMatchObject({ a: expect.stringMatching(/…\[truncated \d+ chars\]$/) as unknown });
		expect(items[1]?.truncatedCells).toEqual(['text', 'meta']);
		expect(r.structured).toMatchObject({
			mode: 'rows',
			columns: [
				{ name: 'text', type: 'string' },
				{ name: 'meta', type: '{a: string}' },
			],
			nextCursor: expect.any(String) as string,
			completeness: { hasMore: true, total: 3 },
		});
		const next = await call(
			'hf_dataset_rows',
			{ dataset: 'o/d', config: 'default', split: 'train', limit: 2, cursor: r.structured.nextCursor },
			{ fetch }
		);
		expect(next.structured).toMatchObject({ offset: 2, nextCursor: null });
	});

	it('routes where/orderby to /filter and search to /search', async () => {
		const fetch = mockFetch({
			'/filter': (url) => {
				expect(url.searchParams.get('where')).toBe('"label" = 1');
				expect(url.searchParams.get('orderby')).toBe('"score" DESC');
				return Response.json({ ...rowsBody(0), num_rows_total: 2 });
			},
			'/search': (url) => {
				expect(url.searchParams.get('query')).toBe('cat');
				return Response.json({ ...rowsBody(0), num_rows_total: 2 });
			},
		});
		const base = { dataset: 'hf://datasets/o/d', config: 'default', split: 'train' };
		const f = await call('hf_dataset_rows', { ...base, where: '"label" = 1', orderby: '"score" DESC' }, { fetch });
		expect(f.structured).toMatchObject({ mode: 'filter', nextCursor: null });
		const s = await call('hf_dataset_rows', { ...base, search: 'cat' }, { fetch });
		expect(s.structured.mode).toBe('search');
		await expect(call('hf_dataset_rows', { ...base, search: 'cat', where: 'x = 1' }, { fetch })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
		await expect(call('hf_dataset_rows', { ...base, dataset: 'hf://models/o/m' }, { fetch })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		});
	});

	it('suggests plain row reads when the Viewer filter endpoint fails', async () => {
		const fetch = mockFetch({ '/filter': () => new Response('', { status: 500 }) });
		await expect(
			call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'test', where: '"label" = 0' }, { fetch })
		).rejects.toMatchObject({
			code: 'UPSTREAM_HTTP',
			retryable: true,
			message: expect.stringContaining('read rows without where/orderby/search and filter them locally') as string,
		});
	});

	it('bounds the whole page by an aggregate text budget on wide data (A11)', async () => {
		const width = 300;
		const row = (i: number) => ({
			row_idx: i,
			row: Object.fromEntries(
				Array.from({ length: width }, (_, c) => [
					`col${String(c)}`,
					c % 2 ? 'w'.repeat(500) : { nested: 'n'.repeat(500) },
				])
			),
			truncated_cells: [],
		});
		const fetch = mockFetch({
			'/rows': (url) => {
				const offset = Number(url.searchParams.get('offset'));
				return Response.json({
					features: Array.from({ length: width }, (_, c) => ({
						feature_idx: c,
						name: `col${String(c)}`,
						type: { dtype: 'string', _type: 'Value' },
					})),
					rows: Array.from({ length: 20 }, (_, i) => row(offset + i)),
					num_rows_total: 1000,
				});
			},
		});
		const r = await call('hf_dataset_rows', { dataset: 'o/d', config: 'c', split: 'train', limit: 20 }, { fetch });
		const out = r.structured as {
			items: { row: Record<string, unknown>; truncatedCells?: string[]; omittedColumns?: number }[];
			nextCursor: string | null;
			completeness: { truncated?: boolean; reason?: string };
		};
		const text = out.items.reduce(
			(n, item) => n + Object.entries(item.row).reduce((m, [k, v]) => m + k.length + JSON.stringify(v).length, 0),
			0
		);
		// Values plus keys stay near the 60k budget (markers and JSON quoting are the only overhead).
		expect(text).toBeLessThan(80_000);
		expect(out.items.length).toBeGreaterThanOrEqual(1);
		expect(out.items.length).toBeLessThan(20);
		expect(out.items[0]?.omittedColumns).toBe(100);
		expect(Object.keys(out.items[0]?.row ?? {})).toHaveLength(200);
		expect(Object.values(out.items.at(-1)?.row ?? {})).toContain('…[omitted: page text budget reached]');
		expect(out.items[0]?.row.col0).toMatchObject({
			nested: expect.stringMatching(/…\[truncated \d+ chars\]$/) as unknown,
		});
		expect(out.completeness).toMatchObject({
			truncated: true,
			reason: 'text_budget',
			hint: expect.stringContaining('nextCursor') as unknown,
		});
		// The page ends at a row boundary; nextCursor resumes right after the last returned row.
		expect(out.nextCursor).toEqual(expect.any(String));
	});

	it('preserves nested list/object structure (e.g. conversation roles) when truncating and supports maxCellChars', async () => {
		const fetch = mockFetch({
			'/rows': () =>
				Response.json({
					features: [
						{
							feature_idx: 0,
							name: 'conversations',
							type: [{ role: { dtype: 'string', _type: 'Value' }, content: { dtype: 'string', _type: 'Value' } }],
						},
					],
					rows: [
						{
							row_idx: 0,
							row: {
								conversations: [
									{ role: 'user', content: 'A'.repeat(4000) },
									{ role: 'assistant', content: 'B'.repeat(4000) },
								],
							},
							truncated_cells: [],
						},
					],
					num_rows_total: 1,
				}),
		});
		const r = await call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'train', limit: 1 }, { fetch });
		const items = r.structured.items as {
			row: { conversations: { role: string; content: string }[] };
			truncatedCells?: string[];
		}[];
		const conv = items[0]?.row.conversations;
		expect(Array.isArray(conv)).toBe(true);
		expect(conv?.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(conv?.[0]?.content).toMatch(/…\[truncated \d+ chars\]$/);
		expect(items[0]?.truncatedCells).toEqual(['conversations']);

		const big = await call(
			'hf_dataset_rows',
			{ dataset: 'o/d', config: 'default', split: 'train', limit: 1, maxCellChars: 10_000 },
			{ fetch }
		);
		const bigItems = big.structured.items as {
			row: { conversations: { role: string; content: string }[] };
			truncatedCells?: string[];
		}[];
		expect(bigItems[0]?.row.conversations[0]?.content).toHaveLength(4000);
		expect(bigItems[0]?.truncatedCells).toBeUndefined();
	});

	it('returns a clean INVALID_ARGUMENT listing available splits when a bad split triggers HTTP 500', async () => {
		const fetch = mockFetch({
			'/rows': () => new Response('Internal Server Error', { status: 500 }),
			'/splits': () =>
				Response.json({
					splits: [
						{ dataset: 'o/d', config: 'default', split: 'train_ru' },
						{ dataset: 'o/d', config: 'default', split: 'test_ru' },
					],
				}),
		});
		await expect(
			call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'train' }, { fetch })
		).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('default/train_ru') as unknown,
		});
	});

	it('diagnoses renamed, gated, and viewer-unavailable datasets on 404', async () => {
		const movedFetch = mockFetch({
			'/api/datasets/AI-MO/NuminaMath-CoT': () =>
				new Response(null, { status: 307, headers: { location: '/api/datasets/project-numina/NuminaMath-CoT' } }),
		});
		await expect(
			call('hf_dataset_structure', { dataset: 'AI-MO/NuminaMath-CoT', include: ['splits'] }, { fetch: movedFetch })
		).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringContaining('project-numina/NuminaMath-CoT') as unknown,
		});

		const noViewerFetch = mockFetch({
			'/api/datasets/org/raw-ds': () => Response.json({ id: 'org/raw-ds', gated: false }),
		});
		await expect(
			call('hf_dataset_structure', { dataset: 'org/raw-ds', include: ['splits'] }, { fetch: noViewerFetch })
		).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringContaining('hf_repo_list_files') as unknown,
		});
	});

	it('reports gated access from the Hub auth-check, not from the gated flag alone', async () => {
		const gatedFetch = (authCheck: number) =>
			mockFetch({
				'/api/datasets/org/gated-ds': () => Response.json({ id: 'org/gated-ds', gated: 'manual' }),
				'/api/datasets/org/gated-ds/auth-check': () => new Response(null, { status: authCheck }),
			});
		const run = (authCheck: number) =>
			call('hf_dataset_structure', { dataset: 'org/gated-ds', include: ['splits'] }, { fetch: gatedFetch(authCheck) });
		const page = 'https://huggingface.co/datasets/org/gated-ds';
		// Anonymous caller.
		await expect(run(401)).rejects.toMatchObject({
			code: 'AUTH_REQUIRED',
			message: expect.stringContaining(page) as unknown,
		});
		// Authenticated, access not granted (or pending for manual gating).
		await expect(run(403)).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: expect.stringMatching(
				/not been granted access \(or the request is still pending\); request access at https:\/\/huggingface\.co\/datasets\/org\/gated-ds/
			) as unknown,
		});
		// Access granted: the Viewer simply has no data; never tell the caller to accept access.
		await expect(run(200)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringMatching(/^(?!.*request access).*this account has access/) as unknown,
		});
		// Access unknown (probe failed): neutral wording, original code kept.
		await expect(run(404)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			message: expect.stringContaining('if this account has not accepted its conditions') as unknown,
		});
	});

	it('keeps the original rows error when the /splits validation call itself fails', async () => {
		const fetch = mockFetch({
			'/rows': () => new Response('{}', { status: 500 }),
			'/splits': () => new Response('{}', { status: 400 }),
		});
		await expect(
			call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'train' }, { fetch })
		).rejects.toMatchObject({ code: 'UPSTREAM_HTTP', message: expect.stringContaining('HTTP 500') as unknown });

		// A 404 from /rows still reaches the Hub diagnosis when /splits rejects the request.
		const notFound = mockFetch({
			'/rows': () => new Response('{}', { status: 404 }),
			'/splits': () => new Response('{}', { status: 422 }),
			'/api/datasets/o/d': () => Response.json({ id: 'o/d', gated: false }),
		});
		await expect(
			call('hf_dataset_rows', { dataset: 'o/d', config: 'default', split: 'train' }, { fetch: notFound })
		).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('hf_repo_list_files') as unknown });
	});

	it('rejects splitsOffset/schemaOffset past the end with the total, but allows offset 0 on empty lists', async () => {
		const fetch = mockFetch({
			'/splits': () =>
				Response.json({ splits: Array.from({ length: 3 }, (_, i) => ({ config: `c${String(i)}`, split: 'train' })) }),
			'/info': (url) =>
				Response.json({
					dataset_info: url.searchParams.get('config')
						? { features: { x: { dtype: 'int64', _type: 'Value' } } }
						: { a: { features: {} }, b: { features: {} } },
				}),
		});
		await expect(
			call('hf_dataset_structure', { dataset: 'o/d', include: ['splits'], splitsOffset: 3 }, { fetch })
		).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('3 splits in total, so use an offset from 0 to 2') as unknown,
		});
		await expect(
			call('hf_dataset_structure', { dataset: 'o/d', include: ['splits', 'schema'], schemaOffset: 2 }, { fetch })
		).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('2 schema configs in total') as unknown,
		});
		await expect(
			call('hf_dataset_structure', { dataset: 'o/d', config: 'a', include: ['schema'], schemaOffset: 1 }, { fetch })
		).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
			message: expect.stringContaining('config is set') as unknown,
		});
		const inRange = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', include: ['splits'], splitsOffset: 2 },
			{ fetch }
		);
		expect(inRange.structured.splits).toHaveLength(1);

		const empty = mockFetch({
			'/splits': () => Response.json({ splits: [] }),
			'/info': () => Response.json({ dataset_info: {} }),
		});
		const r = await call('hf_dataset_structure', { dataset: 'o/d', include: ['splits', 'schema'] }, { fetch: empty });
		expect(r.structured.splits).toEqual([]);
		expect(r.structured.schema).toEqual([]);
		await expect(
			call('hf_dataset_structure', { dataset: 'o/d', include: ['splits'], splitsOffset: 1 }, { fetch: empty })
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('use offset 0') as unknown });
	});

	it('pages splits and schema configs with splitsOffset and schemaOffset', async () => {
		const fetch = mockFetch({
			'/splits': () =>
				Response.json({
					splits: Array.from({ length: 205 }, (_, i) => ({ config: `c${String(i)}`, split: 'train' })),
				}),
			'/info': () =>
				Response.json({
					dataset_info: Object.fromEntries(
						Array.from({ length: 25 }, (_, i) => [
							`cfg${String(i)}`,
							{ features: { x: { dtype: 'int64', _type: 'Value' } } },
						])
					),
				}),
		});
		const p2 = await call(
			'hf_dataset_structure',
			{ dataset: 'o/d', include: ['splits', 'schema'], splitsOffset: 200, schemaOffset: 20 },
			{ fetch }
		);
		expect(p2.structured.splits).toHaveLength(5);
		expect(p2.structured.splitsTruncated).toBeUndefined();
		expect(p2.structured.numSplits).toBe(205);
		expect(p2.structured.schema).toHaveLength(5);
		expect(p2.structured.schemaTruncated).toBeUndefined();
		expect(p2.structured.numSchemaConfigs).toBe(25);
	});
});

describe('boundCell', () => {
	const size = (v: unknown) => (typeof v === 'string' ? v.length : JSON.stringify(v).length);
	const marker = '…[omitted: page text budget reached]';
	const samples: unknown[] = [
		'x'.repeat(5000),
		'line\n"quoted"\t'.repeat(300),
		'😀'.repeat(400),
		12345678901234,
		true,
		null,
		[],
		{},
		Array.from({ length: 50 }, (_, i) => i * 1000),
		Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'c'.repeat(300) })),
		{ meta: { a: { b: { c: { d: { e: { f: { g: 'deep'.repeat(100) } } } } } } }, tags: ['t'.repeat(50), 'u'] },
		{ ['k'.repeat(100)]: 'v'.repeat(100), small: 1, other: 'o'.repeat(500) },
		['a', 'b', 'c'],
	];

	it('never exceeds the limit, and marks truncated only when something was cut', () => {
		for (const value of samples) {
			for (let limit = 0; limit <= 400; limit++) {
				const r = boundCell(value, limit);
				if (r.value === marker) {
					// The marker replaces a cell only when the value did not fit.
					expect(size(value)).toBeGreaterThan(limit);
					expect(r.truncated).toBe(true);
					continue;
				}
				expect(size(r.value), `limit ${String(limit)} for ${JSON.stringify(value).slice(0, 40)}`).toBeLessThanOrEqual(
					limit
				);
				expect(r.truncated).toBe(JSON.stringify(r.value) !== JSON.stringify(value));
				// Output stays valid, well-formed JSON (no lone surrogates).
				expect(JSON.stringify(r.value)).not.toMatch(/\\ud[89ab]/);
			}
		}
	});

	it('uses the budget marker only when too little remains to be useful', () => {
		expect(boundCell('x'.repeat(100), 31).value).toBe(marker);
		expect(boundCell('x'.repeat(100), 40).value).toMatch(/^x+…\[truncated \d+ chars\]$/);
		expect(boundCell(42, 2)).toEqual({ value: 42, truncated: false });
		expect(boundCell(42, 1).value).toBe(marker);
		expect(boundCell('short', 5)).toEqual({ value: 'short', truncated: false });
	});

	it('keeps conversation roles and reports omitted items within the limit', () => {
		const conv = Array.from({ length: 30 }, (_, i) => ({
			role: i % 2 ? 'assistant' : 'user',
			content: 'c'.repeat(300),
		}));
		const r = boundCell(conv, 1000);
		const out = r.value as unknown[];
		expect(JSON.stringify(out).length).toBeLessThanOrEqual(1000);
		expect(out.at(-1)).toMatch(/^…\[\d+ more items omitted\]$/);
		for (const m of out.slice(0, -1)) expect((m as { role: string }).role).toMatch(/^(user|assistant)$/);
	});
});
