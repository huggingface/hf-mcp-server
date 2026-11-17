import { z } from 'zod';
import { PtcError } from './errors.js';

/**
 * The `hf://` thread. Every record carries kind/id/uri/url; every input naming a Hub
 * resource is a Ref accepting that uri verbatim, a bare ID, or a huggingface.co URL.
 * Grammar matches legacy hf_fs so existing links keep working:
 *   hf://{models|datasets|spaces|buckets}/OWNER/NAME[@REVISION][/PATH]
 *   hf://papers/ARXIV_ID          hf://collections/OWNER/SLUG-ID
 *   hf://docs/PRODUCT[/VERSION/PAGE][#anchor]
 */
export const REPO_KINDS = ['model', 'dataset', 'space', 'bucket'] as const;
export type RepoKind = (typeof REPO_KINDS)[number];

const SEGMENT = /^[\w.-]+$/;
const ROOT: Record<RepoKind, string> = { model: 'models', dataset: 'datasets', space: 'spaces', bucket: 'buckets' };
const KIND_BY_ROOT: Record<string, RepoKind> = {
	models: 'model',
	datasets: 'dataset',
	spaces: 'space',
	buckets: 'bucket',
};

export const refSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.describe('Repository or file: hf:// uri (preferred), owner/name or URL.');

export const itemSchema = z.object({
	kind: z.string(),
	id: z.string(),
	uri: z.string(),
	url: z.string(),
});
export type PtcItem = z.infer<typeof itemSchema>;

export interface ParsedRef {
	kind: RepoKind | undefined;
	/** owner/name (legacy unnamespaced model IDs allowed) */
	id: string;
	revision?: string;
	/** path inside the repository, without leading slash; '' for the root */
	path: string;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}
function encodePath(path: string): string {
	return path.split('/').filter(Boolean).map(encodeSegment).join('/');
}
function validId(id: string): boolean {
	const parts = id.split('/');
	return parts.length >= 1 && parts.length <= 2 && parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
}
function invalid(ref: string): never {
	throw new PtcError('INVALID_ARGUMENT', `not a valid Hugging Face reference: ${ref.slice(0, 200)}`);
}
function safePath(path: string, ref: string): string {
	const decoded = path
		.split('/')
		.filter(Boolean)
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return invalid(ref);
			}
		});
	// A decoded segment must not smuggle separators or dot-segments (e.g. %2e%2e%2f).
	const unsafe = (s: string) =>
		s === '.' || s === '..' || s.includes('/') || s.includes('\\') || [...s].some((c) => c < ' ');
	if (decoded.some(unsafe)) invalid(ref);
	return decoded.join('/');
}

/**
 * Parse a repository/file Ref. `defaultKind` applies to bare IDs; when it is omitted a
 * bare ID has kind undefined (callers may auto-detect).
 */
export function parseRef(ref: string, defaultKind?: RepoKind): ParsedRef {
	const value = ref.trim();
	if (value.startsWith('hf://')) return parseHfUri(value);
	if (/^https?:\/\//i.test(value)) return parseWebUrl(value);
	const [first] = value.split('/');
	if (first && KIND_BY_ROOT[first]) return parseHfUri(`hf://${value}`);
	if (!validId(value)) invalid(ref);
	return { kind: defaultKind, id: value, path: '' };
}

function parseHfUri(value: string): ParsedRef {
	const body = value.slice('hf://'.length).replace(/\/+$/, '');
	const [root = '', ...rest] = body.split('/');
	const kind = KIND_BY_ROOT[root];
	if (!kind) {
		// hf://owner/name shorthand for models (legacy hf_fs accepted it)
		if (root && rest.length >= 1 && SEGMENT.test(root)) return parseHfUri(`hf://models/${body}`);
		invalid(value);
	}
	// Legacy unnamespaced IDs (gpt2, squad): see LEGACY IDS on repoUri. A first segment carrying
	// @REVISION is a single-segment ID, so the rest is a path; a lone segment is the repository root.
	const legacy = rest[0]?.includes('@') || rest.length === 1;
	if (legacy && rest[0] && (kind === 'model' || kind === 'dataset')) {
		const at = rest[0].indexOf('@');
		const name = at >= 0 ? rest[0].slice(0, at) : rest[0];
		if (!name || !validId(name)) invalid(value);
		let revision: string | undefined;
		if (at >= 0) {
			try {
				revision = decodeURIComponent(rest[0].slice(at + 1));
			} catch {
				invalid(value);
			}
			if (!revision) invalid(value);
		}
		return { kind, id: name, ...(revision ? { revision } : {}), path: safePath(rest.slice(1).join('/'), value) };
	}
	const [owner, nameRev, ...pathParts] = rest;
	if (!owner || !nameRev) invalid(value);
	const at = nameRev.indexOf('@');
	const name = at >= 0 ? nameRev.slice(0, at) : nameRev;
	let revision: string | undefined;
	if (at >= 0) {
		try {
			revision = decodeURIComponent(nameRev.slice(at + 1));
		} catch {
			invalid(value);
		}
		if (!revision) invalid(value);
	}
	const id = `${owner}/${name}`;
	if (!validId(id)) invalid(value);
	return { kind, id, ...(revision ? { revision } : {}), path: safePath(pathParts.join('/'), value) };
}

const FILE_ROUTES = new Set(['blob', 'resolve', 'tree']);

function parseWebUrl(value: string): ParsedRef {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalid(value);
	}
	if (url.protocol !== 'https:' || !['huggingface.co', 'www.huggingface.co', 'hf.co'].includes(url.hostname))
		invalid(value);
	const segments = url.pathname.split('/').filter(Boolean);
	let kind: RepoKind = 'model';
	if (segments[0] && KIND_BY_ROOT[segments[0]]) {
		kind = KIND_BY_ROOT[segments[0]] ?? 'model';
		segments.shift();
	}
	// Legacy single-segment IDs: datasets/squad, or a model/dataset file route (gpt2/blob/main/x).
	// A bare https://huggingface.co/NAME stays invalid: it is usually a user or organization page.
	const legacy =
		(kind === 'dataset' && segments.length === 1) ||
		((kind === 'model' || kind === 'dataset') && segments.length >= 3 && FILE_ROUTES.has(segments[1] ?? ''));
	const [owner, name, route, revision, ...path] = legacy ? [segments[0], '', ...segments.slice(1)] : segments;
	if (!owner || (!name && !legacy)) invalid(value);
	const id = legacy ? owner : `${owner}/${name}`;
	if (!validId(id)) invalid(value);
	if (route === 'blob' || route === 'resolve' || route === 'tree') {
		if (kind === 'bucket') return { kind, id, path: safePath([revision ?? '', ...path].join('/'), value) };
		const rev = revision ? decodeURIComponent(revision) : undefined;
		return { kind, id, ...(rev && rev !== 'main' ? { revision: rev } : {}), path: safePath(path.join('/'), value) };
	}
	if (route) invalid(value);
	return { kind, id, path: '' };
}

/** Require a known kind (after defaults/auto-detection). */
export function requireKind(parsed: ParsedRef, ref: string): RepoKind {
	if (!parsed.kind)
		throw new PtcError('INVALID_ARGUMENT', `kind is ambiguous for ${ref.slice(0, 200)}; pass an hf:// uri or kind.`);
	return parsed.kind;
}

/**
 * LEGACY IDS. hf://models/A/B is always repository A/B (owner/name). A legacy single-segment ID
 * (gpt2, squad) with a path is therefore written with an explicit revision, defaulting to main:
 * hf://models/gpt2@main/config.json. parseRef reads a first segment with @ as a single-segment ID,
 * so every uri emitted here parses back to the same kind, id, revision and path.
 */
export function repoUri(kind: RepoKind, id: string, revision?: string, path = ''): string {
	const p = encodePath(path);
	const legacy = !id.includes('/') && p !== '';
	const rev = revision ? `@${encodeSegment(revision)}` : legacy ? '@main' : '';
	return `hf://${ROOT[kind]}/${id.split('/').map(encodeSegment).join('/')}${rev}${p ? `/${p}` : ''}`;
}

export function repoUrl(kind: RepoKind, id: string, revision?: string, path = '', isDir = false): string {
	const base = `https://huggingface.co/${kind === 'model' ? '' : `${ROOT[kind]}/`}${id}`;
	if (!path) return revision ? `${base}/tree/${encodeSegment(revision)}` : base;
	if (kind === 'bucket') return `${base}/${isDir ? 'tree' : 'resolve'}/${encodePath(path)}`;
	return `${base}/${isDir ? 'tree' : 'blob'}/${encodeSegment(revision ?? 'main')}/${encodePath(path)}`;
}

export function repoItem(kind: RepoKind, id: string): PtcItem {
	return { kind, id, uri: repoUri(kind, id), url: repoUrl(kind, id) };
}

export function fileItem(kind: RepoKind, id: string, path: string, type: 'file' | 'dir', revision?: string): PtcItem {
	return {
		kind: type,
		id: path,
		uri: repoUri(kind, id, revision, path),
		url: repoUrl(kind, id, revision, path, type === 'dir'),
	};
}

export function paperItem(paperId: string): PtcItem {
	return { kind: 'paper', id: paperId, uri: `hf://papers/${paperId}`, url: `https://huggingface.co/papers/${paperId}` };
}

export function collectionItem(slug: string): PtcItem {
	return {
		kind: 'collection',
		id: slug,
		uri: `hf://collections/${slug}`,
		url: `https://huggingface.co/collections/${slug}`,
	};
}

export function docItem(path: string, url: string): PtcItem {
	return { kind: 'doc', id: path, uri: `hf://docs/${path}`, url };
}

/** Collections: accept hf://collections/OWNER/SLUG-ID, OWNER/SLUG-ID, or the web URL. */
export function parseCollectionRef(ref: string): string {
	const value = ref
		.trim()
		.replace(/^hf:\/\/collections\//, '')
		.replace(/^https:\/\/huggingface\.co\/collections\//, '');
	const [owner, slug, ...rest] = value.split('/').filter(Boolean);
	if (!owner || !slug || rest.length || !SEGMENT.test(owner) || !SEGMENT.test(slug)) invalid(ref);
	return `${owner}/${slug}`;
}

const ARXIV_ID = String.raw`(\d{4}\.\d{4,5})(?:v\d+)?`;
/** Anchored paper forms; anything else (e.g. an id buried in another URL) is rejected. */
const PAPER_FORMS = [
	new RegExp(`^${ARXIV_ID}$`),
	new RegExp(`^hf://papers/${ARXIV_ID}/?$`),
	new RegExp(`^arxiv:${ARXIV_ID}$`, 'i'),
];
const PAPER_URLS: { hosts: string[]; path: RegExp }[] = [
	{
		hosts: ['huggingface.co', 'www.huggingface.co', 'hf.co'],
		path: new RegExp(`^/papers/${ARXIV_ID}(?:/.*)?$`),
	},
	{ hosts: ['arxiv.org', 'www.arxiv.org'], path: new RegExp(`^/(?:abs|pdf)/${ARXIV_ID}(?:\\.pdf)?/?$`) },
];

/**
 * Papers: accept a bare arXiv ID (optionally vN), hf://papers/ID, arxiv:ID,
 * https://huggingface.co/papers/ID[/...] or https://arxiv.org/abs|pdf/ID[vN][.pdf]. Returns the ID without version.
 */
export function parsePaperRef(ref: string): string {
	const value = ref.trim();
	for (const form of PAPER_FORMS) {
		const match = form.exec(value);
		if (match?.[1]) return match[1];
	}
	if (/^https:\/\//i.test(value)) {
		let url: URL | undefined;
		try {
			url = new URL(value);
		} catch {
			url = undefined;
		}
		const rule =
			url && !url.username && !url.password && !url.port && PAPER_URLS.find((r) => r.hosts.includes(url.hostname));
		const match = url && rule ? rule.path.exec(url.pathname) : null;
		if (match?.[1]) return match[1];
	}
	return invalid(ref);
}

/**
 * People: the one parser for every argument naming a user or organization (handle(s), user, org, entity,
 * owner(s), authorsAny, submittedBy, namespace, ...). Accepts a bare name, "@name" and the profile URL that
 * user/org records return as uri/url. A future person uri scheme is added here only.
 */
const PERSON_NAME = /^[A-Za-z0-9][\w.-]{0,95}$/;
const PROFILE_PREFIX = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/(?:organizations\/)?/i;

function personName(value: string): string {
	return value.trim().replace(PROFILE_PREFIX, '').replace(/^@/, '').replace(/\/+$/, '');
}

/** The user or organization name in `value`, or a sanitized INVALID_ARGUMENT naming `field`. */
export function parsePersonRef(value: string, field = 'handle'): string {
	const name = personName(value);
	if (!PERSON_NAME.test(name))
		throw new PtcError('INVALID_ARGUMENT', `${field} is not a valid Hugging Face user or organization name.`);
	return name;
}

/** Schema for a person argument: validates and yields the bare name (see parsePersonRef). */
export function personRefSchema(description?: string): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> {
	const schema = z
		.string()
		.trim()
		.min(1)
		.max(200)
		.transform((value, ctx) => {
			const name = personName(value);
			if (PERSON_NAME.test(name)) return name;
			ctx.addIssue({ code: 'custom', message: 'expected a user or organization name or profile uri.' });
			return z.NEVER;
		});
	return description ? schema.describe(description) : schema;
}
