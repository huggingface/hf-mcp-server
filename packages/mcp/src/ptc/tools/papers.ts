import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { PtcError, toPtcError } from '../core/errors.js';
import { hubFetch, openCursor, sealCursor } from '../core/hub-http.js';
import { paperItem, parsePaperRef, personRefSchema, repoItem } from '../core/refs.js';
import { definePtcTool, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { sliceUtf8 } from '../../hf-fs-guidance.js';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 2048): string | undefined =>
	typeof value === 'string' && value ? value.slice(0, max) : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const REPO_ID = /^[\w.-]+(?:\/[\w.-]+)?$/;
const ARXIV_ID = /^\d{4}\.\d{4,5}$/;
const DEFAULT_READ_BYTES = 20_000;
const MAX_READ_BYTES = 80_000;
const LIST_ABSTRACT_CHARS = 1_500;

function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
function clip(value: string | undefined, max: number): string | undefined {
	if (!value) return undefined;
	const clean = value.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
function authorNames(value: unknown, max: number): string[] {
	return records(value)
		.filter((author) => author.hidden !== true)
		.flatMap((author) => str(author.name, 200) ?? [])
		.slice(0, max);
}

const itemFields = {
	kind: z.string(),
	id: z.string().describe('arXiv ID.'),
	uri: z.string().describe('hf://papers/ID: pass to hf_paper_get / hf_paper_read.'),
	url: z.string().describe('Hugging Face paper page.'),
};
const paperFields = {
	...itemFields,
	title: z.string().optional(),
	aiSummary: z.string().optional().describe('One-sentence AI summary from Hugging Face, when available.'),
	abstract: z.string().optional().describe('arXiv abstract (truncated in lists; full in hf_paper_get).'),
	authors: z.array(z.string()).max(100).optional(),
	publishedAt: z.string().optional(),
	upvotes: z.number().optional(),
	arxivUrl: z.string().optional(),
	githubRepo: z.string().optional(),
	projectPage: z.string().optional(),
};
const paperRecord = z
	.object({
		...paperFields,
		submittedOnDailyAt: z.string().optional().describe('Date the paper was featured in Daily Papers.'),
		submittedBy: z.string().optional().describe('Daily Papers submitter username.'),
		numComments: z.number().optional(),
	})
	.strict();
type PaperRecord = z.infer<typeof paperRecord>;

/** Projects a paper object (bare or wrapped as {paper, ...} in search/daily feeds). */
function paperRecordOf(value: Json, abstractChars = LIST_ABSTRACT_CHARS): PaperRecord | undefined {
	const paper = isRecord(value.paper) ? value.paper : value;
	const id = str(paper.id, 32);
	if (!id || !ARXIV_ID.test(id)) return undefined;
	const submitter = isRecord(value.submittedBy)
		? value.submittedBy
		: isRecord(paper.submittedOnDailyBy)
			? paper.submittedOnDailyBy
			: undefined;
	return compact({
		...paperItem(id),
		title: clip(str(paper.title, 1000) ?? str(value.title, 1000), 500),
		aiSummary: clip(str(paper.ai_summary, 4000), 1000),
		abstract: clip(str(paper.summary, 20_000) ?? str(value.summary, 20_000), abstractChars),
		authors: authorNames(paper.authors, 20),
		publishedAt: str(paper.publishedAt, 64) ?? str(value.publishedAt, 64),
		upvotes: num(paper.upvotes),
		arxivUrl: `https://arxiv.org/abs/${id}`,
		githubRepo: str(paper.githubRepo, 500),
		projectPage: str(paper.projectPage, 500),
		submittedOnDailyAt: str(paper.submittedOnDailyAt, 64),
		submittedBy: str(submitter?.name, 96) ?? str(submitter?.user, 96),
		numComments: num(value.numComments),
	});
}

const completeness = completenessSchema();
const paperPage = z
	.object({
		items: z.array(paperRecord).max(120),
		returnedCount: z.number().int(),
		nextCursor: z.string().nullable(),
		completeness,
	})
	.strict();

// ---------------------------------------------------------------- hf_papers_search

const hfPapersSearch = definePtcTool({
	name: 'hf_papers_search',
	family: 'papers',
	title: 'Search research papers on Hugging Face',
	description:
		'Search Hugging Face papers (arXiv preprints, research articles) by topic, method, title or question. Returns paper IDs and links, with titles, authors, publication dates, upvotes, AI summaries and abstract excerpts when available. Results are a bounded relevance-ranked set without continuation. See hf_paper_get.',
	input: z
		.object({
			query: z.string().trim().min(1).max(250).describe('Topic, method name, title words or question.'),
			limit: z.number().int().min(1).max(120).default(20).describe('Maximum papers (max 120; no continuation).'),
		})
		.strict(),
	output: paperPage.extend({
		nextCursor: z.null().describe('Always null: paper search has no continuation; raise limit (max 120).'),
	}),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const params = new URLSearchParams({ q: input.query, limit: String(input.limit) });
		const { data } = await hubFetch({ path: '/api/papers/search', params, subject: 'paper search' }, ctx);
		if (!Array.isArray(data)) throw new PtcError('UPSTREAM_RESPONSE', 'paper search: unexpected upstream response.');
		const items = records(data)
			.flatMap((entry) => paperRecordOf(entry) ?? [])
			.slice(0, input.limit);
		return {
			items,
			returnedCount: items.length,
			nextCursor: null,
			completeness: {
				hasMore: false,
				hint: 'Paper search returns at most 120 relevance-ranked results and has no continuation; raise limit.',
			},
		};
	},
});

// ---------------------------------------------------------------- hf_daily_papers

const hfDailyPapers = definePtcTool({
	name: 'hf_daily_papers',
	family: 'papers',
	title: 'Hugging Face Daily Papers',
	description:
		"Browse Hugging Face daily papers (AI research, arXiv preprints) by featured date or trending rank. Select today's date, an ISO week or a month, optionally narrowing to one submitter. Order by newest featured first or trending. Returns paper IDs and links, with titles, upvotes, comment counts, summaries and submitters when available; supports pagination. See hf_papers_search.",
	input: z
		.object({
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
				.optional()
				.describe('Papers featured on this day (YYYY-MM-DD).'),
			week: z
				.string()
				.regex(/^\d{4}-W\d{2}$/, 'expected YYYY-Www')
				.optional()
				.describe('Papers featured in this ISO week, e.g. 2026-W46.'),
			month: z
				.string()
				.regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM')
				.optional()
				.describe('Papers featured in this month (YYYY-MM).'),
			sort: z
				.enum(['publishedAt', 'trending'])
				.default('publishedAt')
				.describe('publishedAt: newest first; trending: trending ranking.'),
			submittedBy: personRefSchema('Only papers submitted by this user (name or profile uri).').optional(),
			limit: z.number().int().min(1).max(100).default(50).describe('Papers per page (max 100).'),
			cursor: z.string().max(4096).optional().describe('nextCursor from a previous call with the same arguments.'),
		})
		.strict(),
	output: paperPage,
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const periods = [input.date, input.week, input.month].filter(Boolean);
		if (periods.length > 1) throw new PtcError('INVALID_ARGUMENT', 'pass at most one of date, week or month.');
		const { cursor, ...binding } = input;
		const page = Number(openCursor(cursor, ['hf_daily_papers', binding], ctx) ?? '0');
		const fetchPage = async (p: number) => {
			const params = new URLSearchParams({ p: String(p), limit: String(input.limit), sort: input.sort });
			if (input.date) params.set('date', input.date);
			if (input.week) params.set('week', input.week);
			if (input.month) params.set('month', input.month);
			if (input.submittedBy) params.set('submitter', input.submittedBy);
			const { data, headers } = await hubFetch({ path: '/api/daily_papers', params, subject: 'daily papers' }, ctx);
			if (!Array.isArray(data)) throw new PtcError('UPSTREAM_RESPONSE', 'daily papers: unexpected upstream response.');
			return { rows: records(data), headers };
		};
		const { rows, headers } = await fetchPage(page);
		const items = rows.flatMap((entry) => paperRecordOf(entry) ?? []).slice(0, input.limit);
		let hasNext = rows.length > 0 && /rel="?next"?/.test(headers.get('link') ?? '');
		// The Hub links even its last nonempty page. A short linked page is ambiguous; check p+1 at the same limit.
		if (hasNext && rows.length < input.limit) hasNext = (await fetchPage(page + 1)).rows.length > 0;
		return {
			items,
			returnedCount: items.length,
			nextCursor: hasNext ? sealCursor(['hf_daily_papers', binding], ctx, String(page + 1)) : null,
			completeness: { hasMore: hasNext },
		};
	},
});

// ---------------------------------------------------------------- hf_paper_get

const LINKED_KINDS = [
	['models', 'model', 'linkedModels', 'numTotalModels'],
	['datasets', 'dataset', 'linkedDatasets', 'numTotalDatasets'],
	['spaces', 'space', 'linkedSpaces', 'numTotalSpaces'],
] as const;
const linkedRepo = z
	.object({
		kind: z.string(),
		id: z.string(),
		uri: z.string(),
		url: z.string(),
		likes: z.number().optional(),
		downloads: z.number().optional(),
		pipelineTag: z.string().optional(),
		description: z.string().optional(),
	})
	.strict();
const linkedGroup = z
	.object({
		total: z.number().optional().describe('Total repositories citing the paper (upstream count).'),
		items: z.array(linkedRepo).max(20).describe('First few linked repositories only.'),
	})
	.strict();
const paperDetail = z
	.object({
		...paperFields,
		aiKeywords: z.array(z.string()).max(50).optional(),
		githubStars: z.number().optional(),
		linked: z
			.object({ models: linkedGroup, datasets: linkedGroup, spaces: linkedGroup })
			.strict()
			.describe(
				'Repositories that cite this paper: first few per kind plus totals. For the full lists use hf_models_search / hf_datasets_search / hf_spaces_list with papersAny=[ID].'
			),
	})
	.strict();
const itemError = z
	.object({
		ref: z.string(),
		error: z
			.object({
				code: z.enum(['not_found', 'auth_required', 'gated', 'invalid', 'upstream_error']),
				message: z.string(),
			})
			.strict(),
	})
	.strict();

function paperDetailOf(data: Json): z.infer<typeof paperDetail> | undefined {
	const base = paperRecordOf(data, 20_000);
	if (!base) return undefined;
	const { submittedOnDailyAt: _d, submittedBy: _s, numComments: _c, ...fields } = base;
	const all = authorNames(data.authors, 100);
	const linked = Object.fromEntries(
		LINKED_KINDS.map(([key, kind, field, total]) => [
			key,
			compact({
				total: num(data[total]),
				items: records(data[field])
					.flatMap((repo) => {
						const id = str(repo.id, 256);
						if (!id || !REPO_ID.test(id)) return [];
						return [
							compact({
								...repoItem(kind, id),
								likes: num(repo.likes),
								downloads: num(repo.downloads),
								pipelineTag: str(repo.pipeline_tag, 100),
								description: clip(str(repo.shortDescription, 1000), 300),
							}),
						];
					})
					.slice(0, 20),
			}),
		])
	) as z.infer<typeof paperDetail>['linked'];
	return compact({
		...fields,
		authors: all,
		aiKeywords: Array.isArray(data.ai_keywords)
			? data.ai_keywords.flatMap((keyword) => str(keyword, 200) ?? []).slice(0, 50)
			: undefined,
		githubStars: num(data.githubStars),
		linked,
	});
}

async function getPaper(
	ref: string,
	ctx: PtcContext
): Promise<z.infer<typeof paperDetail> | z.infer<typeof itemError>> {
	let id: string;
	try {
		id = parsePaperRef(ref);
	} catch {
		return { ref, error: { code: 'invalid', message: 'not an arXiv ID or hf://papers URI.' } };
	}
	try {
		const { status, data } = await hubFetch(
			{ path: `/api/papers/${id}`, subject: `paper ${id}`, allowStatus: [404] },
			ctx
		);
		if (status === 404)
			return { ref, error: { code: 'not_found', message: `paper ${id} is not on Hugging Face Papers.` } };
		const detail = isRecord(data) ? paperDetailOf(data) : undefined;
		return detail ?? { ref, error: { code: 'upstream_error', message: `paper ${id}: unexpected upstream response.` } };
	} catch (error) {
		const ptc = toPtcError(error, `paper ${id}`);
		if (ptc.code === 'CANCELLED') throw ptc;
		const code = ptc.code === 'AUTH_REQUIRED' || ptc.code === 'FORBIDDEN' ? 'auth_required' : 'upstream_error';
		return { ref, error: { code, message: ptc.message } };
	}
}

const hfPaperGet = definePtcTool({
	name: 'hf_paper_get',
	family: 'papers',
	title: 'Get research paper details',
	description:
		'Get Hugging Face paper details (arXiv metadata, authors, abstract) by ID or URL. Accepts batches and hf://papers URIs. Available details include title, full abstract, AI summary, keywords, publication date, upvotes, GitHub and project links, plus citing models, datasets and Spaces with upstream totals; linked repositories are previews per kind. Returns per-paper errors inline. See hf_paper_read.',
	input: z
		.object({
			papers: z
				.array(z.string().trim().min(1).max(300))
				.min(1)
				.max(20)
				.describe('Up to 20 arXiv IDs (2405.02730), hf://papers uris or paper URLs.'),
		})
		.strict(),
	output: z
		.object({
			items: z.array(z.union([paperDetail, itemError])).max(20),
			returnedCount: z.number().int(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const items = await Promise.all(input.papers.map((ref) => getPaper(ref, ctx)));
		return { items, returnedCount: items.length };
	},
});

// ---------------------------------------------------------------- hf_paper_read

function fallbackMarkdown(id: string, paper: Json): string {
	const authors = authorNames(paper.authors, 100);
	const lines = [
		`# ${str(paper.title, 1000) ?? id}`,
		'',
		'> The full paper is not available as Markdown; this document contains metadata and the abstract.',
		`> PDF: https://arxiv.org/pdf/${id}`,
		'',
		...(authors.length ? [`**Authors:** ${authors.join(', ')}`] : []),
		...(str(paper.publishedAt) ? [`**Published:** ${str(paper.publishedAt) ?? ''}`] : []),
		`**arXiv:** ${id}`,
		...(str(paper.ai_summary) ? ['', '## AI summary', '', str(paper.ai_summary, 4000) ?? ''] : []),
		...(str(paper.summary) ? ['', '## Abstract', '', str(paper.summary, 20_000) ?? ''] : []),
	];
	return `${lines.join('\n')}\n`;
}

const hfPaperRead = definePtcTool({
	name: 'hf_paper_read',
	family: 'papers',
	title: 'Read a research paper as Markdown',
	description:
		"Read a research paper's full text as Markdown by arXiv ID, hf://papers URI or paper URL. Returns content and a source marker identifying full text or an abstract-only fallback. Reads byte chunks; pass nextOffset as offset to continue until null. See hf_paper_get.",
	input: z
		.object({
			paper: z.string().trim().min(1).max(300).describe('arXiv ID, hf://papers URI, or paper/arXiv URL.'),
			offset: z.number().int().min(0).default(0).describe('Byte offset to start reading from (use nextOffset).'),
			maxBytes: z
				.number()
				.int()
				.min(1)
				.max(MAX_READ_BYTES)
				.default(DEFAULT_READ_BYTES)
				.describe('Maximum bytes of Markdown to return (default 20000, max 80000).'),
		})
		.strict(),
	output: z
		.object({
			...itemFields,
			source: z.enum(['full_text', 'abstract_only']),
			content: z.string(),
			offset: z.number().int(),
			bytes: z.number().int().describe('Bytes returned in content.'),
			size: z.number().int(),
			nextOffset: z.number().int().nullable().describe('Pass as offset to continue; null at the end.'),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	async run(input, ctx) {
		const id = parsePaperRef(input.paper);
		const md = await hubFetch(
			{ path: `/papers/${id}.md`, as: 'text', subject: `paper ${id} text`, allowStatus: [404] },
			ctx
		);
		let text = typeof md.data === 'string' && md.status !== 404 ? md.data : '';
		let source: 'full_text' | 'abstract_only' = 'full_text';
		if (!text.trim()) {
			const { data } = await hubFetch({ path: `/api/papers/${id}`, subject: `paper ${id}` }, ctx);
			text = fallbackMarkdown(id, isRecord(data) ? data : {});
			source = 'abstract_only';
		}
		const total = new TextEncoder().encode(text).byteLength;
		if (input.offset > total)
			throw new PtcError('INVALID_ARGUMENT', `offset is beyond the end (${String(total)} bytes).`);
		const slice = sliceUtf8(text, input.offset, input.maxBytes);
		return {
			...paperItem(id),
			source,
			content: slice.content,
			offset: input.offset,
			bytes: slice.bytes,
			size: total,
			nextOffset: slice.nextOffset ?? null,
		};
	},
});

/** Papers: search, daily feed, details, full text. */
export const PAPERS_TOOLS: readonly PtcTool[] = [hfPapersSearch, hfDailyPapers, hfPaperGet, hfPaperRead];
