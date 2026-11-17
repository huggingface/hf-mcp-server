import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { PtcError } from '../core/errors.js';
import { openCursor, sealCursor } from '../core/hub-http.js';
import { docItem } from '../core/refs.js';
import { definePtcTool, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { HfFsDocsProvider, parseDocsUri } from '../../hf-fs-docs.js';
import type { HfFsCatResult, HfFsEntry, HfFsLsResult } from '../../hf-fs.js';

// Reuses the legacy hf_fs docs provider: /api/docs catalog, llms.txt manifests (cached 10 min),
// semantic search with full-text fallback, and #anchor section extraction.
const HUB = 'https://huggingface.co';
const DEFAULT_READ_BYTES = 20_000;
const MAX_READ_BYTES = 80_000;
const DEFAULT_INDEX_LIMIT = 200;
const MAX_INDEX_LIMIT = 1000;

function provider(ctx: PtcContext): HfFsDocsProvider {
	return new HfFsDocsProvider(HUB, { resolveUnversioned: true, ...(ctx.signal ? { signal: ctx.signal } : {}) });
}

/** Run a docs provider operation; a cancelled request surfaces as CANCELLED, not an upstream failure. */
async function runDocs<T>(ctx: PtcContext, operation: (docs: HfFsDocsProvider) => Promise<unknown>): Promise<T> {
	try {
		return (await operation(provider(ctx))) as T;
	} catch (error) {
		if (ctx.signal?.aborted) throw new PtcError('CANCELLED', 'request cancelled.');
		throw error;
	}
}

/** True when the provider reported a manifest folder (hf_fs EISDIR), with or without the prefix. */
function isDirectoryError(error: unknown): boolean {
	return error instanceof Error && /^EISDIR\b/.test(error.message);
}

/** Accept hf://docs/..., a bare "product[/path]" or a huggingface.co/docs URL; return an hf://docs URI. */
function toDocsUri(value: string | undefined): string {
	const raw = (value ?? '').trim();
	if (!raw || raw === 'hf://docs' || raw === 'hf://docs/') return 'hf://docs';
	if (raw.startsWith('hf://docs/')) return raw;
	const web = /^https:\/\/(?:www\.)?huggingface\.co\/docs\/([^?#]+)(#.*)?$/.exec(raw);
	if (web?.[1]) {
		const path = web[1].replace(/\/+$/, '');
		const page = path.includes('/') && !path.endsWith('.md') ? `${path}.md` : path;
		return `hf://docs/${page}${web[2] ?? ''}`;
	}
	if (/^[\w.-]+(?:\/[^\s?]*)?(?:#.*)?$/.test(raw) && !raw.includes('://')) return `hf://docs/${raw}`;
	throw new PtcError(
		'INVALID_ARGUMENT',
		'expected an hf://docs URI, a docs product name, or a huggingface.co/docs URL.'
	);
}

function absoluteUrl(url: string | undefined, fallback: string): string {
	if (!url) return fallback;
	try {
		return new URL(url, HUB).toString();
	} catch {
		return fallback;
	}
}

/** Build the canonical doc Item for an hf://docs entry URI (anchor kept in uri). */
function docRef(entryUri: string, url: string | undefined) {
	const parsed = parseDocsUri(entryUri);
	const id = [parsed.product, parsed.path].filter(Boolean).join('/');
	const item = docItem(id, absoluteUrl(url, `${HUB}/docs/${id.replace(/\.md$/, '')}`));
	return parsed.anchor ? { ...item, uri: `${item.uri}#${encodeURIComponent(parsed.anchor)}` } : item;
}

const docEntry = z
	.object({
		kind: z.literal('doc'),
		id: z.string().describe('product/path of the page (or the product name).'),
		uri: z.string().describe('hf://docs URI (with #anchor for sections): pass to hf_docs_read.'),
		url: z.string(),
		title: z.string().optional(),
		anchor: z.string().optional().describe('Section anchor within the page.'),
		excerpt: z.string().optional(),
		category: z.string().optional(),
	})
	.strict();
type DocEntry = z.infer<typeof docEntry>;

function entryOf(entry: HfFsEntry, withExcerpt = false): DocEntry | undefined {
	if (!entry.uri) return undefined;
	const ref = docRef(entry.uri, entry.url);
	const compact = Object.fromEntries(
		Object.entries({
			...ref,
			kind: 'doc' as const,
			title: entry.title?.slice(0, 500),
			anchor: entry.anchor?.slice(0, 500),
			excerpt: withExcerpt ? entry.description : undefined,
			category: entry.type === 'dir' ? entry.description : undefined,
		}).filter(([, v]) => v !== undefined)
	);
	return compact as DocEntry;
}

// ---------------------------------------------------------------- hf_docs_search

const hfDocsSearch = definePtcTool({
	name: 'hf_docs_search',
	family: 'docs',
	title: 'Search Hugging Face documentation',
	description:
		'Search Hugging Face documentation (docs, how-to guides, API reference) by question or keywords. Find relevant pages for products such as Transformers, Hub or PEFT, optionally restricting results to a product or documentation folder. Returns page URIs with section anchors and excerpts when available; results are bounded search candidates. Then hf_docs_read.',
	input: z
		.object({
			query: z.string().trim().min(1).max(250).describe('Question or keywords, e.g. "load a LoRA adapter".'),
			product: z
				.string()
				.trim()
				.regex(/^[\w.-]{1,100}$/)
				.optional()
				.describe('Docs product, e.g. transformers, hub, peft (see hf_docs_read).'),
			scope: z
				.string()
				.trim()
				.max(1000)
				.optional()
				.describe('hf://docs/PRODUCT[/PATH] to search one folder; overrides product.'),
			limit: z.number().int().min(1).max(25).default(10).describe('Maximum hits (max 25).'),
		})
		.strict(),
	output: z
		.object({
			items: z.array(docEntry).max(25),
			returnedCount: z.number().int(),
			nextCursor: z.null(),
			completeness: completenessSchema(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const uri = input.scope ? toDocsUri(input.scope) : input.product ? `hf://docs/${input.product}` : 'hf://docs';
		const result = await runDocs<HfFsLsResult>(ctx, (docs) =>
			docs.run({ op: 'search', uri, query: input.query, limit: input.limit })
		);
		const items = result.entries.flatMap((entry) => entryOf(entry, true) ?? []).slice(0, input.limit);
		return {
			items,
			returnedCount: items.length,
			nextCursor: null,
			completeness: { hasMore: false },
		};
	},
});

// ---------------------------------------------------------------- hf_docs_read

async function readIndex(uri: string, input: { glob?: string; limit: number; cursor?: string }, ctx: PtcContext) {
	const binding = ['hf_docs_read', uri, input.glob ?? null, input.limit];
	const offset = Number(openCursor(input.cursor, binding, ctx) ?? '0');
	const result = await runDocs<HfFsLsResult>(ctx, (docs) =>
		docs.run({
			op: 'find',
			uri,
			entry_type: 'file',
			...(input.glob ? { path: input.glob } : {}),
			offset,
			limit: input.limit,
		})
	);
	const items = result.entries.flatMap((entry) => entryOf(entry) ?? []);
	return {
		mode: 'index' as const,
		uri,
		items,
		returnedCount: items.length,
		nextCursor: result.truncated ? sealCursor(binding, ctx, String(offset + result.entries.length)) : null,
		completeness: { hasMore: !!result.truncated },
	};
}

const hfDocsRead = definePtcTool({
	name: 'hf_docs_read',
	family: 'docs',
	title: 'Read Hugging Face documentation',
	description:
		'Read Hugging Face documentation pages (docs, guides, sections) by URI or URL. Returns page text or an anchored section as Markdown. Supply a product name to browse its page index, optionally filtered by a page-path glob, or omit the URI to list documentation products. Continue page text with nextOffset or the index with nextCursor. See hf_docs_search.',
	input: z
		.object({
			uri: z
				.string()
				.trim()
				.max(1000)
				.optional()
				.describe('hf://docs/PRODUCT[/PAGE.md], product name or docs URL. Omit to list products.'),
			glob: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.optional()
				.describe('Index mode: glob over page paths, e.g. "**/quicktour*".'),
			offset: z.number().int().min(0).default(0).describe('Page mode: byte offset to start from (use nextOffset).'),
			max_bytes: z
				.number()
				.int()
				.min(1)
				.max(MAX_READ_BYTES)
				.default(DEFAULT_READ_BYTES)
				.describe('Page mode: maximum bytes of Markdown (default 20000, max 80000).'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_INDEX_LIMIT)
				.default(DEFAULT_INDEX_LIMIT)
				.describe('Index mode: maximum pages listed (max 1000).'),
			cursor: z.string().max(4096).optional().describe('Index mode: nextCursor from a previous call.'),
		})
		.strict(),
	output: z
		.object({
			mode: z.enum(['products', 'index', 'page']).describe('products: product list; index: page list; page: Markdown.'),
			uri: z.string(),
			items: z.array(docEntry).max(MAX_INDEX_LIMIT).optional(),
			returnedCount: z.number().int().optional(),
			nextCursor: z.string().nullable().optional(),
			completeness: completenessSchema().optional(),
			kind: z.literal('doc').optional(),
			id: z.string().optional(),
			url: z.string().optional(),
			section: z.string().optional().describe('Heading of the extracted #section.'),
			content: z.string().optional(),
			offset: z.number().int().optional(),
			bytes: z.number().int().optional(),
			nextOffset: z.number().int().nullable().optional().describe('Pass as offset to continue; null at the end.'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const uri = toDocsUri(input.uri);
		const parsed = parseDocsUri(uri);
		if (parsed.kind === 'root') {
			const result = await runDocs<HfFsLsResult>(ctx, (docs) => docs.run({ op: 'ls', uri }));
			const items = result.entries.flatMap((entry) => entryOf(entry) ?? []);
			return {
				mode: 'products' as const,
				uri,
				items,
				returnedCount: items.length,
				nextCursor: null,
				completeness: { hasMore: false },
			};
		}
		if (parsed.kind === 'product') return await readIndex(uri, input, ctx);
		let page: HfFsCatResult;
		try {
			page = await runDocs<HfFsCatResult>(ctx, (docs) =>
				docs.run({ op: 'cat', uri, offset: input.offset, max_bytes: input.max_bytes })
			);
		} catch (error) {
			// A folder inside the manifest: list its pages instead.
			if (isDirectoryError(error) && !parsed.anchor) {
				return await readIndex(uri, input, ctx);
			}
			throw error;
		}
		const ref = docRef(page.uri, undefined);
		return {
			mode: 'page' as const,
			...ref,
			kind: 'doc' as const,
			...(page.section ? { section: page.section } : {}),
			content: page.content,
			offset: input.offset,
			bytes: page.bytes,
			nextOffset: page.next_offset ?? null,
		};
	},
});

/** Documentation: search and read. */
export const DOCS_TOOLS: readonly PtcTool[] = [hfDocsSearch, hfDocsRead];
