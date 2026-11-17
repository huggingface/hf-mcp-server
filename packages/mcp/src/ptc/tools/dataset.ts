import { z } from 'zod';
import { definePtcTool, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { PtcError, toPtcError } from '../core/errors.js';
import { DATASETS_SERVER_ORIGIN, hubFetch, openCursor, sealCursor } from '../core/hub-http.js';
import { parseRef, refSchema, repoItem } from '../core/refs.js';

// ---------------------------------------------------------------- helpers

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | undefined =>
	v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);
const str = (v: unknown, max = 512): string | undefined => (typeof v === 'string' && v ? clip(v, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const count = z.number().int().nonnegative();
const datasetRefSchema = z
	.object({ kind: z.literal('dataset'), id: z.string(), uri: z.string(), url: z.string() })
	.strict();
type DatasetRef = z.infer<typeof datasetRefSchema>;

function datasetTarget(ref: string): DatasetRef {
	const parsed = parseRef(ref, 'dataset');
	if (parsed.kind !== 'dataset') throw new PtcError('INVALID_ARGUMENT', 'dataset must be a dataset repository.');
	if (parsed.revision) {
		throw new PtcError('INVALID_ARGUMENT', 'the Dataset Viewer serves the main branch only; drop the @revision.');
	}
	return { ...repoItem('dataset', parsed.id), kind: 'dataset' };
}

async function viewer(path: string, params: Record<string, string | undefined>, ctx: PtcContext): Promise<Json> {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
	const res = await hubFetch(
		{
			origin: DATASETS_SERVER_ORIGIN,
			path,
			params: search,
			subject: `dataset viewer ${path.slice(1)}`,
			timeoutMs: 20_000,
		},
		ctx
	);
	const data = rec(res.data);
	if (!data) throw new PtcError('UPSTREAM_RESPONSE', `dataset viewer ${path.slice(1)}: malformed upstream data.`);
	return data;
}

/** Compact Hugging Face `datasets` feature type, e.g. string, list<int64>, ClassLabel(neg, pos), Image. */
function featureType(feature: unknown, depth = 0): string {
	if (depth > 4) return '…';
	if (Array.isArray(feature)) return `list<${featureType(feature[0], depth + 1)}>`;
	const f = rec(feature);
	if (!f) return 'unknown';
	const type = f._type;
	if (type === 'Value') return str(f.dtype, 64) ?? 'unknown';
	if (type === 'ClassLabel') {
		const names = arr(f.names).filter((n): n is string => typeof n === 'string');
		const shown = names.slice(0, 10).join(', ');
		return `ClassLabel(${shown}${names.length > 10 ? `, … ${String(names.length)} classes` : ''})`;
	}
	if (type === 'Sequence' || type === 'List' || type === 'LargeList')
		return `list<${featureType(f.feature, depth + 1)}>`;
	if (typeof type === 'string') return type;
	const fields = Object.entries(f);
	const shown = fields.slice(0, 20).map(([k, v]) => `${k}: ${featureType(v, depth + 1)}`);
	return `{${shown.join(', ')}${fields.length > 20 ? ', …' : ''}}`;
}

const columnSchema = z.object({ name: z.string(), type: z.string() }).strict();
const MAX_COLUMNS = 200;
function columns(features: unknown): z.infer<typeof columnSchema>[] {
	// /info returns {name: feature}; /rows returns [{name, type}].
	const entries = Array.isArray(features)
		? features.map((f) => [rec(f)?.name, rec(f)?.type] as const)
		: Object.entries(rec(features) ?? {});
	return entries
		.flatMap(([name, type]) =>
			typeof name === 'string' ? [{ name: clip(name, 256), type: clip(featureType(type), 500) }] : []
		)
		.slice(0, MAX_COLUMNS);
}

// ---------------------------------------------------------------- hf_dataset_structure

const SECTIONS = ['splits', 'schema', 'sizes', 'parquet', 'statistics'] as const;
type Section = (typeof SECTIONS)[number];
const MAX_SPLITS = 200;
const MAX_CONFIGS = 20;
const MAX_PARQUET = 50;
const MAX_STAT_ITEMS = 20;

const splitSchema = z
	.object({
		config: z.string(),
		split: z.string(),
		num_rows: count.optional(),
		num_columns: count.optional(),
		parquet_bytes: count.optional(),
		memory_bytes: count.optional(),
		original_bytes: count.optional().describe('Size of the original data files.'),
	})
	.strict();
type Split = z.infer<typeof splitSchema>;

function sizeEntry(raw: unknown): Split | undefined {
	const v = rec(raw);
	const config = str(v?.config, 256);
	const split = str(v?.split, 256);
	if (!v || !config || !split) return undefined;
	return compact({
		config,
		split,
		num_rows: num(v.num_rows),
		num_columns: num(v.num_columns),
		parquet_bytes: num(v.num_bytes_parquet_files),
		memory_bytes: num(v.num_bytes_memory),
		original_bytes: num(v.num_bytes_original_files),
	});
}

/** Keep scalar statistics; bound histograms and frequency tables. */
function compactStatistics(raw: unknown): Json {
	const out: Json = {};
	for (const [key, value] of Object.entries(rec(raw) ?? {})) {
		if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) {
			out[key] = typeof value === 'string' ? clip(value, 200) : value;
		} else if (key === 'histogram') {
			const h = rec(value);
			const hist = arr(h?.hist);
			if (hist.length <= MAX_STAT_ITEMS) out.histogram = { hist, bin_edges: arr(h?.bin_edges) };
			else out.histogram_omitted = true;
		} else if (key === 'frequencies') {
			const top = Object.entries(rec(value) ?? {})
				.filter((e): e is [string, number] => typeof e[1] === 'number')
				.sort((a, b) => b[1] - a[1]);
			out.frequencies = Object.fromEntries(top.slice(0, MAX_STAT_ITEMS).map(([k, n]) => [clip(k, 200), n]));
			if (top.length > MAX_STAT_ITEMS) out.frequencies_truncated = true;
		}
	}
	return out;
}

const structureOutput = z
	.object({
		dataset: datasetRefSchema,
		config: z.string().optional(),
		split: z.string().optional(),
		splits: z.array(splitSchema).max(MAX_SPLITS).optional().describe('Config/split pairs with sizes when known.'),
		splits_truncated: z
			.boolean()
			.optional()
			.describe(`More than ${String(MAX_SPLITS)} config/split pairs exist.`),
		splits_total: count.optional().describe('Config/split pairs before the cap (when truncated).'),
		totals: z
			.object({
				num_rows: count.optional(),
				parquet_bytes: count.optional(),
				memory_bytes: count.optional(),
				original_bytes: count.optional(),
			})
			.strict()
			.optional()
			.describe('Whole-dataset totals (or the config, when config is set).'),
		schema: z
			.array(
				z
					.object({
						config: z.string(),
						columns: z.array(columnSchema).max(MAX_COLUMNS),
						columns_truncated: z.boolean().optional(),
						columns_total: count.optional().describe('Top-level columns in the config (when truncated).'),
					})
					.strict()
			)
			.max(MAX_CONFIGS)
			.optional(),
		schema_truncated: z
			.boolean()
			.optional()
			.describe(`Schemas are shown for the first ${String(MAX_CONFIGS)} configs only; pass config for others.`),
		schema_configs_total: count.optional().describe('Configs with a schema (when schema_truncated).'),
		parquet: z
			.object({
				files: z
					.array(
						z
							.object({
								config: z.string(),
								split: z.string(),
								url: z.string().describe('Direct parquet download URL (auto-converted refs/convert/parquet).'),
								filename: z.string().optional(),
								size: count.optional(),
							})
							.strict()
					)
					.max(MAX_PARQUET),
				truncated: z.boolean(),
				total_files: count.describe('Parquet files matching config/split before the cap.'),
			})
			.strict()
			.optional(),
		statistics: z
			.object({
				num_examples: count.optional(),
				columns: z
					.array(
						z.object({ name: z.string(), type: z.string(), statistics: z.record(z.string(), z.unknown()) }).strict()
					)
					.max(MAX_COLUMNS),
				columns_truncated: z.boolean().optional(),
				columns_total: count.optional().describe('Columns with statistics (when columns_truncated).'),
				partial: z.boolean().optional(),
			})
			.strict()
			.optional(),
		partial: z.boolean().describe('The Dataset Viewer processed only part of the data (large datasets).'),
		pending: count.describe('Configs/splits still being processed.'),
		failed: count.describe('Configs/splits the Dataset Viewer could not process.'),
		unavailable: z
			.array(z.object({ section: z.enum(SECTIONS), code: z.string(), message: z.string() }).strict())
			.max(SECTIONS.length)
			.optional()
			.describe('Requested sections that could not be fetched.'),
		hints: z
			.array(z.string())
			.max(SECTIONS.length)
			.optional()
			.describe('How to narrow the request when a section was truncated.'),
	})
	.strict();
type StructureOutput = z.infer<typeof structureOutput>;

const structureTool = definePtcTool({
	name: 'hf_dataset_structure',
	family: 'dataset',
	title: 'Hugging Face dataset structure',
	description:
		'Inspect Hugging Face dataset structure (splits, subsets, columns) by dataset ID. Get Dataset Viewer schema and feature types, row counts, sizes and parquet download URLs. Select sections to return or narrow to a subset and split; per-column statistics require both. Results may be partial. See hf_dataset_rows.',
	input: z
		.object({
			dataset: refSchema.describe('Dataset: hf://datasets/owner/name (preferred), "owner/name" or URL.'),
			config: z.string().min(1).max(256).optional().describe('Limit to one config (subset): a splits[].config value.'),
			split: z
				.string()
				.min(1)
				.max(256)
				.optional()
				.describe('Limit to one split (splits[].split); required for statistics.'),
			include: z
				.array(z.enum(SECTIONS))
				.min(1)
				.max(SECTIONS.length)
				.optional()
				.describe('Sections to return (default splits, schema, sizes, parquet).'),
		})
		.strict(),
	output: structureOutput,
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const dataset = datasetTarget(input.dataset);
		const include = new Set<Section>(input.include ?? ['splits', 'schema', 'sizes', 'parquet']);
		if (include.has('statistics') && (!input.config || !input.split)) {
			throw new PtcError('INVALID_ARGUMENT', 'statistics requires config and split (see the splits section).');
		}
		const base = { dataset: dataset.id, config: input.config };
		const wantSplit = (s: { split: string }) => !input.split || s.split === input.split;
		let partial = false;
		let pending = 0;
		let failed = 0;
		const status = (data: Json) => {
			partial ||= data.partial === true;
			pending += arr(data.pending).length;
			failed += arr(data.failed).length;
		};

		const out: Partial<StructureOutput> = {};
		const hints: string[] = [];
		let listed: Split[] | undefined;
		let sized: Split[] | undefined;
		const sections: Record<Section, () => Promise<void>> = {
			splits: async () => {
				const data = await viewer('/splits', base, ctx);
				status(data);
				listed = arr(data.splits).flatMap((raw) => {
					const v = rec(raw);
					const config = str(v?.config, 256);
					const split = str(v?.split, 256);
					return config && split && wantSplit({ split }) ? [{ config, split }] : [];
				});
			},
			sizes: async () => {
				const data = await viewer('/size', base, ctx);
				status(data);
				const size = rec(data.size) ?? {};
				sized = arr(size.splits)
					.map(sizeEntry)
					.filter((s): s is Split => !!s && wantSplit(s));
				// Config-scoped /size returns size.config; dataset-wide returns size.dataset plus size.configs[].
				const total = input.config
					? (rec(size.config) ??
						rec(arr(size.configs).find((c) => rec(c)?.config === input.config)) ??
						rec(arr(size.configs)[0]))
					: rec(size.dataset);
				if (total) {
					out.totals = compact({
						num_rows: num(total.num_rows),
						parquet_bytes: num(total.num_bytes_parquet_files),
						memory_bytes: num(total.num_bytes_memory),
						original_bytes: num(total.num_bytes_original_files),
					});
				}
			},
			schema: async () => {
				const data = await viewer('/info', base, ctx);
				status(data);
				const info = rec(data.dataset_info) ?? {};
				const configs = input.config ? [[input.config, info] as const] : Object.entries(info);
				out.schema = configs.slice(0, MAX_CONFIGS).map(([config, value]) => {
					const features = rec(rec(value)?.features) ?? {};
					const cols = columns(features);
					const total = Object.keys(features).length;
					return compact({
						config: clip(config, 256),
						columns: cols,
						columns_truncated: total > cols.length ? true : undefined,
						columns_total: total > cols.length ? total : undefined,
					});
				});
				if (out.schema.some((c) => c.columns_truncated)) {
					hints.push(`schema: at most ${String(MAX_COLUMNS)} columns per config are listed (see columns_total).`);
				}
				if (configs.length > MAX_CONFIGS) {
					out.schema_truncated = true;
					out.schema_configs_total = configs.length;
					hints.push(
						`schema: first ${String(MAX_CONFIGS)} of ${String(configs.length)} configs; pass config to see another (names in splits).`
					);
				}
			},
			parquet: async () => {
				const data = await viewer('/parquet', base, ctx);
				status(data);
				const files = arr(data.parquet_files).flatMap((raw) => {
					const v = rec(raw);
					const config = str(v?.config, 256);
					const split = str(v?.split, 256);
					const url = str(v?.url, 2048);
					if (!config || !split || !url || !wantSplit({ split })) return [];
					return [compact({ config, split, url, filename: str(v?.filename, 512), size: num(v?.size) })];
				});
				out.parquet = {
					files: files.slice(0, MAX_PARQUET),
					truncated: files.length > MAX_PARQUET,
					total_files: files.length,
				};
				if (files.length > MAX_PARQUET) {
					hints.push(
						`parquet: first ${String(MAX_PARQUET)} of ${String(files.length)} files; pass config and split to narrow.`
					);
				}
			},
			statistics: async () => {
				const data = await viewer('/statistics', { ...base, split: input.split }, ctx);
				const stats = arr(data.statistics).flatMap((raw) => {
					const v = rec(raw);
					const name = str(v?.column_name, 256);
					if (!name) return [];
					const type = str(v?.column_type, 64) ?? 'unknown';
					return [{ name, type, statistics: compactStatistics(v?.column_statistics) }];
				});
				if (stats.length > MAX_COLUMNS) {
					hints.push(`statistics: first ${String(MAX_COLUMNS)} of ${String(stats.length)} columns returned.`);
				}
				out.statistics = compact({
					num_examples: num(data.num_examples),
					columns: stats.slice(0, MAX_COLUMNS),
					columns_truncated: stats.length > MAX_COLUMNS ? true : undefined,
					columns_total: stats.length > MAX_COLUMNS ? stats.length : undefined,
					partial: typeof data.partial === 'boolean' ? data.partial : undefined,
				});
			},
		};

		const requested = SECTIONS.filter((s) => include.has(s));
		const errors: { section: Section; error: PtcError }[] = [];
		await Promise.all(
			requested.map(async (section) => {
				try {
					await sections[section]();
				} catch (error) {
					if (ctx.signal?.aborted) throw error;
					errors.push({ section, error: toPtcError(error, `dataset viewer ${section}`) });
				}
			})
		);
		if (errors.length === requested.length && errors[0]) throw errors[0].error;

		// Merge /splits and /size into one config/split list.
		const key = (s: Split) => `${s.config}\u0000${s.split}`;
		const sizes = new Map((sized ?? []).map((s) => [key(s), s] as const));
		const splits = listed ? listed.map((s) => ({ ...s, ...sizes.get(key(s)) })) : sized;
		const result: StructureOutput = {
			dataset,
			...out,
			...(input.config ? { config: input.config } : {}),
			...(input.split ? { split: input.split } : {}),
			...(splits ? { splits: splits.slice(0, MAX_SPLITS) } : {}),
			...(splits && splits.length > MAX_SPLITS ? { splits_truncated: true, splits_total: splits.length } : {}),
			partial,
			pending,
			failed,
			...(errors.length
				? { unavailable: errors.map((e) => ({ section: e.section, code: e.error.code, message: e.error.message })) }
				: {}),
			...(splits && splits.length > MAX_SPLITS
				? { hints: [`splits: first ${String(MAX_SPLITS)} of ${String(splits.length)}; pass config to narrow.`] }
				: {}),
		};
		if (hints.length) result.hints = [...(result.hints ?? []), ...hints].slice(0, SECTIONS.length);
		return result;
	},
});

// ---------------------------------------------------------------- hf_dataset_rows

/** Aggregate text budget for all cells of one page (keys + serialized values, markers excluded). */
const ROWS_CHAR_BUDGET = 60_000;
const MAX_CELL_CHARS = 2_000;
const MIN_CELL_CHARS = 200;
const BUDGET_MARKER = '…[omitted: page text budget reached]';

function boundCell(value: unknown, limit: number): { value: unknown; truncated: boolean } {
	if (limit <= 0) return { value: BUDGET_MARKER, truncated: true };
	if (typeof value === 'string') {
		return value.length > limit
			? { value: `${value.slice(0, limit)}…[truncated ${String(value.length - limit)} chars]`, truncated: true }
			: { value, truncated: false };
	}
	if (value === null || typeof value !== 'object') return { value, truncated: false };
	const json = JSON.stringify(value);
	return json.length > limit
		? { value: `${json.slice(0, limit)}…[truncated JSON, ${String(json.length)} chars total]`, truncated: true }
		: { value, truncated: false };
}

interface RowItem {
	row_idx: number;
	row: Json;
	truncated_cells?: string[];
	omitted_columns?: number;
}

const textLength = (value: unknown): number =>
	typeof value === 'string' ? value.length : (JSON.stringify(value) ?? '').length;

const rowsTool = definePtcTool({
	name: 'hf_dataset_rows',
	family: 'dataset',
	title: 'Read rows from a Hugging Face dataset',
	description:
		'Read Hugging Face dataset rows (samples, previews, records) for a chosen subset and split. Use the Dataset Viewer to filter and sort with SQL-like expressions, or choose a separate full-text search in string columns. Returns row values and indices, column names and types, and indicators of truncated cells. Pages contain up to 100 rows, with offset or cursor continuation. See hf_dataset_structure.',
	input: z
		.object({
			dataset: refSchema.describe('Dataset: hf://datasets/owner/name (preferred), "owner/name" or URL.'),
			config: z.string().min(1).max(256).describe('Config from hf_dataset_structure splits[].config, e.g. "default".'),
			split: z.string().min(1).max(256).describe('Split from hf_dataset_structure splits[].split, e.g. "train".'),
			offset: z.number().int().min(0).default(0).describe('First row index.'),
			length: z.number().int().min(1).max(100).default(20).describe('Rows to return (max 100).'),
			where: z
				.string()
				.min(1)
				.max(2000)
				.optional()
				.describe('SQL-like filter, e.g. "label = 1 AND \\"lang\\" = \'en\'".'),
			orderby: z.string().min(1).max(500).optional().describe('Sort, e.g. "score DESC" (Dataset Viewer /filter).'),
			search: z
				.string()
				.min(1)
				.max(500)
				.optional()
				.describe('Full-text search in string columns; cannot be combined with where/orderby.'),
			cursor: z
				.string()
				.max(4096)
				.optional()
				.describe('next_cursor from a previous call with the same arguments (overrides offset).'),
		})
		.strict(),
	output: z
		.object({
			dataset: datasetRefSchema,
			config: z.string(),
			split: z.string(),
			mode: z.enum(['rows', 'filter', 'search']),
			columns: z.array(columnSchema).max(MAX_COLUMNS),
			items: z
				.array(
					z
						.object({
							row_idx: count,
							row: z.record(z.string(), z.unknown()),
							truncated_cells: z
								.array(z.string())
								.max(MAX_COLUMNS)
								.optional()
								.describe('Columns whose values were truncated (by the Dataset Viewer or this tool).'),
							omitted_columns: count
								.optional()
								.describe(`Columns beyond the first ${String(MAX_COLUMNS)} that were left out of row.`),
						})
						.strict()
				)
				.max(100),
			returned_count: count.describe('items.length.'),
			offset: count,
			next_offset: count.nullable().describe('Offset of the next page; null when no more rows.'),
			next_cursor: z.string().nullable().describe('Pass back as cursor with all other arguments unchanged.'),
			completeness: z
				.object({
					scope: z.literal('rows_page'),
					global_complete: z.literal(false),
					num_rows_total: count.optional().describe('Rows in the split, or matching rows for filter/search.'),
					partial: z.boolean().optional().describe('Only part of a large split was indexed for filter/search.'),
					text_budget_exhausted: z
						.boolean()
						.optional()
						.describe(
							`The ~${String(ROWS_CHAR_BUDGET / 1000)}k-character page budget was reached: later cells are replaced by a marker and the page may end early; continue with next_offset or request fewer rows.`
						),
				})
				.strict(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const dataset = datasetTarget(input.dataset);
		if (input.search && (input.where || input.orderby)) {
			throw new PtcError('INVALID_ARGUMENT', 'search cannot be combined with where/orderby; use one mode.');
		}
		const mode: 'rows' | 'filter' | 'search' = input.search
			? 'search'
			: input.where || input.orderby
				? 'filter'
				: 'rows';
		const binding = [
			'hf_dataset_rows',
			dataset.id,
			input.config,
			input.split,
			input.where,
			input.orderby,
			input.search,
			input.length,
		];
		const cursorOffset = openCursor(input.cursor, binding, ctx);
		const offset = cursorOffset !== undefined ? Number(cursorOffset) : input.offset;
		const data = await viewer(
			`/${mode}`,
			{
				dataset: dataset.id,
				config: input.config,
				split: input.split,
				offset: String(offset),
				length: String(input.length),
				where: input.where,
				orderby: input.orderby,
				query: input.search,
			},
			ctx
		);
		const rawRows = arr(data.rows).slice(0, input.length);
		const cols = columns(data.features);
		// Fair share per cell, then a hard aggregate budget across every row and cell of the page.
		const width = Math.min(MAX_COLUMNS, Math.max(1, cols.length));
		const cellLimit = Math.max(
			MIN_CELL_CHARS,
			Math.min(MAX_CELL_CHARS, Math.floor(ROWS_CHAR_BUDGET / Math.max(1, rawRows.length * width)))
		);
		let used = 0;
		let consumed = 0;
		let budgetExhausted = false;
		const items: RowItem[] = [];
		for (const [index, raw] of rawRows.entries()) {
			// Stop at a row boundary once the budget is spent; next_offset resumes from here.
			if (used >= ROWS_CHAR_BUDGET && items.length) {
				budgetExhausted = true;
				break;
			}
			consumed++;
			const v = rec(raw);
			const row = rec(v?.row);
			if (!v || !row) continue;
			const truncated = new Set(arr(v.truncated_cells).filter((c): c is string => typeof c === 'string'));
			const entries = Object.entries(row);
			const bounded: Json = {};
			for (const [key, value] of entries.slice(0, MAX_COLUMNS)) {
				const name = clip(key, 256);
				used += name.length;
				const cell = boundCell(value, Math.min(cellLimit, ROWS_CHAR_BUDGET - used));
				if (cell.truncated) truncated.add(name);
				if (cell.value !== BUDGET_MARKER) used += textLength(cell.value);
				else budgetExhausted = true;
				bounded[name] = cell.value;
			}
			items.push(
				compact({
					row_idx: num(v.row_idx) ?? offset + index,
					row: bounded,
					truncated_cells: truncated.size ? [...truncated].slice(0, MAX_COLUMNS) : undefined,
					omitted_columns: entries.length > MAX_COLUMNS ? entries.length - MAX_COLUMNS : undefined,
				})
			);
		}
		const total = num(data.num_rows_total);
		const nextOffset = offset + consumed;
		const hasNext =
			consumed > 0 &&
			(consumed < rawRows.length || (total !== undefined ? nextOffset < total : rawRows.length >= input.length));
		return {
			dataset,
			config: input.config,
			split: input.split,
			mode,
			columns: cols,
			items,
			returned_count: items.length,
			offset,
			next_offset: hasNext ? nextOffset : null,
			next_cursor: hasNext ? sealCursor(binding, ctx, String(nextOffset)) : null,
			completeness: compact({
				scope: 'rows_page' as const,
				global_complete: false as const,
				num_rows_total: total,
				partial: typeof data.partial === 'boolean' ? data.partial : undefined,
				text_budget_exhausted: budgetExhausted || undefined,
			}),
		};
	},
});

/** Dataset Viewer: structure (+statistics) and rows. */
export const DATASET_TOOLS: readonly PtcTool[] = [structureTool, rowsTool];
