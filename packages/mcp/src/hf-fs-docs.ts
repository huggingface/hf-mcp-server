import { HUB_URL } from '@huggingface/hub';
import picomatch from 'picomatch';
import { extractMarkdownSection } from './hf-fs-docs-sections.js';
import { sliceUtf8 } from './hf-fs-guidance.js';
import type { HfFsCatResult, HfFsEntry, HfFsLsResult, HfFsParams, HfFsResult, HfFsStatResult } from './hf-fs.js';
import { fetchWithProfile, NETWORK_FETCH_PROFILES } from './network/fetch-profile.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CAT_MAX_BYTES = 20_000;
const MAX_CAT_BYTES = 80_000;
const DEFAULT_LIMIT = 1000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 25;
const PRIMARY_SEARCH_EXCERPT_LENGTH = 1_200;
const SECONDARY_SEARCH_EXCERPT_LENGTH = 400;
const DOC_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const VERSION_SEGMENT_RE = /^(?:main|v\d[^/]*)$/;
const LANGUAGE_SEGMENT_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

interface DocsCatalogEntry {
	id: string;
	url: string;
	category?: string;
}

interface DocsManifestEntry {
	path: string;
	title: string;
	url: string;
}

interface DocsManifest {
	product: string;
	slug: string;
	entries: Map<string, DocsManifestEntry>;
	aliases: Map<string, DocsManifestEntry>;
	directories: Set<string>;
}

interface CacheEntry<T> {
	expiresAt: number;
	value: Promise<T>;
}

interface ParsedDocsUri {
	kind: 'root' | 'product' | 'path';
	uri: string;
	product?: string;
	path: string;
	anchor?: string;
}

interface SemanticSearchHit {
	text: string;
	product: string;
	heading1: string;
	source_page_url: string;
	source_page_title: string;
	heading2?: string;
	heading3?: string;
	heading4?: string;
	heading5?: string;
}

interface FullTextSearchHit {
	url: string;
	hierarchy_lvl0?: string;
	hierarchy_lvl1?: string;
	hierarchy_lvl2?: string;
	content?: string;
}

const catalogCache = new Map<string, CacheEntry<DocsCatalogEntry[]>>();
const manifestCache = new Map<string, CacheEntry<DocsManifest | undefined>>();

export function isDocsUri(uri: string): boolean {
	const base = uri.split('#', 1)[0] ?? uri;
	return base === 'hf://docs' || base.startsWith('hf://docs/');
}

export function parseDocsUri(uri: string): ParsedDocsUri {
	if (!isDocsUri(uri)) {
		throw new Error('EINVAL: URI must start with hf://docs');
	}
	const hash = uri.indexOf('#');
	const baseUri = hash === -1 ? uri : uri.slice(0, hash);
	const anchor = hash === -1 ? undefined : decodeAnchor(uri.slice(hash + 1));
	const location = baseUri.slice('hf://'.length).replace(/\/+$/, '');
	if (location.includes('//')) {
		throw new Error('EINVAL: URI path must not contain empty segments');
	}
	if (location === 'docs') {
		return compactParsedUri({ kind: 'root', uri: anchoredDocsUri('hf://docs', anchor), path: '', anchor });
	}
	const rawSegments = location.split('/').slice(1);
	const segments = rawSegments.map(decodeSegment);
	const product = segments[0];
	if (!product) {
		throw new Error('EINVAL: documentation product must not be empty');
	}
	if (segments.length === 1) {
		return compactParsedUri({
			kind: 'product',
			uri: anchoredDocsUri(`hf://docs/${encodeSegment(product)}`, anchor),
			product,
			path: '',
			anchor,
		});
	}
	const path = segments.slice(1).join('/');
	return compactParsedUri({
		kind: 'path',
		uri: anchoredDocsUri(`hf://docs/${encodeSegment(product)}/${encodePath(path)}`, anchor),
		product,
		path,
		anchor,
	});
}

export class HfFsDocsProvider {
	private readonly hubUrl: string;
	/** cat resolves an unversioned page path (as in docs web URLs) to the current manifest entry. */
	private readonly resolveUnversioned: boolean;

	constructor(hubUrl?: string, options: { resolveUnversioned?: boolean } = {}) {
		this.hubUrl = (hubUrl ?? HUB_URL).replace(/\/+$/, '');
		this.resolveUnversioned = options.resolveUnversioned ?? false;
	}

	async run(params: HfFsParams): Promise<HfFsResult> {
		validateDocsParams(params);
		switch (params.op) {
			case 'ls':
				return await this.ls(params);
			case 'cat':
				return await this.cat(params);
			case 'attach':
				throw new Error('attach requires a direct repository or bucket file URI.');
			case 'stat':
				return await this.stat(params);
			case 'find':
				return await this.find(params);
			case 'search':
				return await this.search(params);
		}
	}

	private async ls(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parseDocsUri(params.uri);
		assertNoSectionAnchor(parsed, 'ls');
		if (parsed.kind === 'root') {
			if (params.recursive) {
				const { glob, ...findParams } = params;
				return await this.find({ ...findParams, op: 'find', path: glob });
			}
			const products = await this.getAvailableProducts();
			const entries = products.map((product) => productEntry(product));
			return entriesResult(params, entries);
		}
		const manifest = await this.requireManifest(parsed.product);
		if (parsed.kind === 'path' && manifest.entries.has(parsed.path)) {
			throw new Error('ENOTDIR: not a directory');
		}
		if (!manifest.directories.has(parsed.path)) {
			throw new Error('ENOENT: no such file or directory');
		}
		const entries = params.recursive
			? descendantEntries(manifest, parsed.path)
			: immediateEntries(manifest, parsed.path);
		return entriesResult(params, entries, 'ls', parsed.path);
	}

	private async cat(params: HfFsParams): Promise<HfFsCatResult> {
		const parsed = parseDocsUri(params.uri);
		if (!parsed.product || parsed.kind !== 'path') {
			throw new Error(`EISDIR: ${parsed.uri} is a directory`);
		}
		const manifest = await this.requireManifest(parsed.product);
		const entry =
			manifest.entries.get(parsed.path) ??
			(this.resolveUnversioned && !manifest.directories.has(parsed.path)
				? manifest.aliases.get(searchAlias(parsed.path))
				: undefined);
		if (!entry) {
			if (manifest.directories.has(parsed.path)) {
				throw new Error(`EISDIR: ${parsed.uri} is a directory`);
			}
			const corrected = correctedDoubledProductPath(manifest, parsed.path);
			if (corrected) {
				throw new Error(
					`EINVAL: the product appears twice in this documentation URI. Use: ${docsEntryUri(manifest.product, corrected, parsed.anchor)}`
				);
			}
			throw new Error('ENOENT: document is not present in the current llms.txt manifest');
		}
		const { response } = await fetchWithProfile(entry.url, NETWORK_FETCH_PROFILES.hfDocs(), {
			requestInit: { headers: { accept: 'text/markdown, text/plain' } },
		});
		if (!response.ok) {
			throw new Error(`Documentation fetch failed with status ${response.status.toString()} ${response.statusText}`);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('text/markdown') && !contentType.includes('text/plain')) {
			throw new Error(`Documentation fetch returned unsupported content type: ${contentType || 'unknown'}`);
		}
		const content = await response.text();
		const section = parsed.anchor ? extractMarkdownSection(content, parsed.anchor) : undefined;
		if (parsed.anchor && !section) {
			throw new Error(
				`ENOENT: documentation section '#${parsed.anchor}' was not found. Try: cat ${docsEntryUri(manifest.product, entry.path)}`
			);
		}
		const selectedContent = section?.content ?? content;
		const offset = params.offset ?? 0;
		const range = sliceUtf8(selectedContent, offset, normalizedCatMaxBytes(params.max_bytes));
		return {
			uri: entry.path === parsed.path ? parsed.uri : docsEntryUri(manifest.product, entry.path, parsed.anchor),
			op: 'cat',
			path: entry.path,
			content: range.content,
			content_type: 'text/markdown',
			...(section?.heading ? { section: section.heading } : {}),
			bytes: range.bytes,
			truncated: range.truncated,
			...(range.truncated ? { truncation_reason: 'max_bytes', next_offset: range.nextOffset } : {}),
		};
	}

	private async stat(params: HfFsParams): Promise<HfFsStatResult> {
		const parsed = parseDocsUri(params.uri);
		assertNoSectionAnchor(parsed, 'stat');
		if (parsed.kind === 'root') {
			return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: '' };
		}
		const manifest = await this.getManifestForProduct(parsed.product ?? '');
		if (!manifest) {
			return { uri: parsed.uri, op: 'stat', exists: false, type: 'missing', path: parsed.path };
		}
		if (parsed.kind === 'product' || manifest.directories.has(parsed.path)) {
			return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: parsed.path };
		}
		const entry = manifest.entries.get(parsed.path);
		return entry
			? {
					uri: parsed.uri,
					op: 'stat',
					exists: true,
					type: 'file',
					path: parsed.path,
					content_type: 'text/markdown',
					url: entry.url,
				}
			: { uri: parsed.uri, op: 'stat', exists: false, type: 'missing', path: parsed.path };
	}

	private async find(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parseDocsUri(params.uri);
		assertNoSectionAnchor(parsed, 'find');
		if (parsed.kind === 'path') {
			const manifest = await this.requireManifest(parsed.product);
			const exact = manifest.entries.get(parsed.path);
			if (exact) {
				const entry = fileEntry(manifest.product, exact);
				const basePath = parentPath(parsed.path);
				return entriesResult(params, matchesFind(entry, basePath, params) ? [entry] : [], 'find');
			}
		}
		const manifests =
			parsed.kind === 'root'
				? await Promise.all(
						(await this.getAvailableProducts()).map(async (product) => await this.requireManifest(product.id))
					)
				: [await this.requireManifest(parsed.product)];
		const entries = manifests.flatMap((manifest) => {
			const basePath = parsed.kind === 'root' ? '' : parsed.path;
			const descendants = descendantEntries(manifest, basePath);
			const scoped =
				parsed.kind === 'root'
					? descendants.map((entry) => ({ ...entry, path: `${manifest.product}/${entry.path}` }))
					: descendants;
			return scoped.filter((entry) => matchesFind(entry, basePath, params));
		});
		return entriesResult(params, entries, 'find');
	}

	private async search(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parseDocsUri(params.uri);
		const query = params.query?.trim();
		if (!query) {
			throw new Error('EINVAL: search requires query');
		}
		const product = parsed.product;
		const scopedManifest = product ? await this.requireManifest(product) : undefined;
		if (parsed.anchor) {
			throw new Error(
				`EINVAL: search scope must not include a section anchor. Try: search ${stripAnchor(parsed.uri)} "${query}"`
			);
		}
		if (scopedManifest && parsed.kind === 'path') {
			this.validateSearchScope(scopedManifest, parsed, query);
		}
		if (params.entry_type !== undefined && params.entry_type !== 'file') {
			return { uri: params.uri, op: 'search', entries: [] };
		}
		const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
		let entries: HfFsEntry[] = [];
		try {
			const hits = (await this.semanticSearch(query, product, MAX_SEARCH_LIMIT)).map((hit) => ({
				product: hit.product,
				title: hit.heading5 ?? hit.heading4 ?? hit.heading3 ?? hit.heading2 ?? hit.heading1 ?? hit.source_page_title,
				text: hit.text,
				url: hit.source_page_url,
			}));
			entries = await this.resolveSearchHits(hits, parsed, limit);
		} catch {
			// Full-text search below is also the fallback for semantic API failures.
		}
		if (entries.length === 0) {
			const hits = (await this.fullTextSearch(query, scopedManifest?.slug, MAX_SEARCH_LIMIT)).map((hit) => ({
				product: product ?? productFromDocsUrl(hit.url) ?? '',
				title: hit.hierarchy_lvl2 ?? hit.hierarchy_lvl1 ?? hit.hierarchy_lvl0 ?? 'Documentation',
				text: hit.content ?? '',
				url: hit.url,
			}));
			entries = await this.resolveSearchHits(hits, parsed, limit);
		}
		return { uri: params.uri, op: 'search', entries };
	}

	private async resolveSearchHits(
		hits: Array<{ product: string; title: string; text: string; url: string }>,
		scope: ParsedDocsUri,
		limit: number
	): Promise<HfFsEntry[]> {
		const resolved: Array<{
			entry: DocsManifestEntry;
			manifest: DocsManifest;
			hit: { product: string; title: string; text: string; url: string };
			anchor?: string;
		}> = [];
		const seen = new Set<string>();
		for (const hit of hits) {
			if (!hit.product) continue;
			const manifest = await this.getManifestForProduct(hit.product);
			if (!manifest) continue;
			if (scope.product && manifest.product !== scope.product && manifest.slug !== scope.product) continue;
			const match = resolveSearchEntry(manifest, hit.url, this.hubUrl);
			const entry = match?.entry;
			if (!entry || !inSearchScope(entry.path, scope)) continue;
			if (!entry || seen.has(`${manifest.product}/${entry.path}`)) continue;
			seen.add(`${manifest.product}/${entry.path}`);
			resolved.push({ entry, manifest, hit, ...(match.anchor ? { anchor: match.anchor } : {}) });
			if (resolved.length >= limit) break;
		}
		return resolved.map(({ entry, manifest, hit, anchor }, index) =>
			compactEntry({
				type: 'file',
				name: basename(entry.path),
				path: searchResultPath(manifest.product, entry.path, scope),
				uri: docsEntryUri(manifest.product, entry.path, anchor),
				title: hit.title,
				anchor,
				description: cleanExcerpt(
					hit.text,
					index === 0 ? PRIMARY_SEARCH_EXCERPT_LENGTH : SECONDARY_SEARCH_EXCERPT_LENGTH
				),
				library: manifest.product,
				url: hit.url.startsWith('http') ? hit.url : new URL(hit.url, this.hubUrl).toString(),
				content_type: 'text/markdown',
			})
		);
	}

	private validateSearchScope(manifest: DocsManifest, parsed: ParsedDocsUri, query: string): void {
		if (manifest.entries.has(parsed.path) || manifest.directories.has(parsed.path)) return;
		const parts = parsed.path.split('/');
		if (parts[0] === manifest.product || parts[0] === manifest.slug) {
			const corrected = parts.slice(1).join('/');
			if (manifest.entries.has(corrected) || manifest.directories.has(corrected)) {
				throw new Error(
					`EINVAL: the product appears twice in this documentation URI. Use: ${docsEntryUri(manifest.product, corrected)}`
				);
			}
		}
		throw new Error(
			`ENOENT: documentation search scope is not present in the current llms.txt manifest. Try: search hf://docs/${manifest.product} "${query}"`
		);
	}

	private async semanticSearch(
		query: string,
		product: string | undefined,
		limit: number
	): Promise<SemanticSearchHit[]> {
		const url = new URL('/api/docs/search', this.hubUrl);
		url.searchParams.set('q', query);
		url.searchParams.set('limit', limit.toString());
		if (product) url.searchParams.set('product', product);
		return await this.fetchJson<SemanticSearchHit[]>(url);
	}

	private async fullTextSearch(
		query: string,
		product: string | undefined,
		limit: number
	): Promise<FullTextSearchHit[]> {
		const url = new URL('/api/docs/search/full-text', this.hubUrl);
		url.searchParams.set('q', query);
		url.searchParams.set('limit', limit.toString());
		if (product) url.searchParams.set('domain', product);
		const result = await this.fetchJson<{ hits: FullTextSearchHit[] }>(url);
		return result.hits;
	}

	private async getAvailableProducts(): Promise<DocsCatalogEntry[]> {
		const catalog = await this.getCatalog();
		const candidates = catalog.flatMap((entry) => {
			const slug = docsSlug(entry.url);
			return slug ? [{ entry, slug }] : [];
		});
		const manifests = await Promise.all(
			candidates.map(async ({ entry, slug }) => ({ entry, manifest: await this.getManifest(entry.id, slug) }))
		);
		return manifests.flatMap(({ entry, manifest }) => (manifest ? [entry] : []));
	}

	private async getCatalog(): Promise<DocsCatalogEntry[]> {
		const key = this.hubUrl;
		const cached = getFresh(catalogCache, key);
		if (cached) return await cached;
		const value = this.fetchJson<DocsCatalogEntry[]>(new URL('/api/docs', this.hubUrl));
		catalogCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
		try {
			return await value;
		} catch (error) {
			catalogCache.delete(key);
			throw error;
		}
	}

	private async requireManifest(product: string | undefined): Promise<DocsManifest> {
		if (!product) throw new Error('EINVAL: documentation product is required');
		const manifest = await this.getManifestForProduct(product);
		if (!manifest) throw new Error(`ENOENT: no llms.txt manifest is available for documentation product '${product}'`);
		return manifest;
	}

	private async getManifestForProduct(product: string): Promise<DocsManifest | undefined> {
		const catalog = await this.getCatalog();
		const entry = catalog.find((candidate) => candidate.id === product || docsSlug(candidate.url) === product);
		const slug = entry ? docsSlug(entry.url) : undefined;
		return entry && slug ? await this.getManifest(entry.id, slug) : undefined;
	}

	private async getManifest(product: string, slug: string): Promise<DocsManifest | undefined> {
		const key = `${this.hubUrl}/${product}/${slug}`;
		const cached = getFresh(manifestCache, key);
		if (cached) return await cached;
		const value = this.fetchManifest(product, slug);
		manifestCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
		try {
			return await value;
		} catch (error) {
			manifestCache.delete(key);
			throw error;
		}
	}

	private async fetchManifest(product: string, slug: string): Promise<DocsManifest | undefined> {
		const url = new URL(`/docs/${encodeURIComponent(slug)}/llms.txt`, this.hubUrl);
		const { response } = await fetchWithProfile(url, NETWORK_FETCH_PROFILES.hfDocs(), {
			requestInit: { headers: { accept: 'text/plain' } },
		});
		if (response.status === 404) return undefined;
		if (!response.ok) {
			throw new Error(`Documentation manifest fetch failed with status ${response.status.toString()}`);
		}
		return parseManifest(product, slug, await response.text(), this.hubUrl);
	}

	private async fetchJson<T>(url: URL): Promise<T> {
		const { response } = await fetchWithProfile(url, NETWORK_FETCH_PROFILES.hfHub(), {
			requestInit: { headers: { accept: 'application/json' } },
		});
		if (!response.ok) {
			throw new Error(`Documentation API request failed with status ${response.status.toString()}`);
		}
		return (await response.json()) as T;
	}
}

function parseManifest(product: string, slug: string, content: string, hubUrl: string): DocsManifest {
	const hub = new URL(hubUrl);
	const prefix = `/docs/${slug}/`;
	const entries = new Map<string, DocsManifestEntry>();
	for (const match of content.matchAll(DOC_LINK_RE)) {
		const title = match[1]?.trim();
		const href = match[2];
		if (!title || !href) continue;
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			continue;
		}
		if (url.origin !== hub.origin || !url.pathname.startsWith(prefix) || !url.pathname.endsWith('.md')) continue;
		const path = decodePath(url.pathname.slice(prefix.length));
		if (!path || path.includes('//') || entries.has(path)) continue;
		entries.set(path, { path, title, url: url.toString() });
	}
	const directories = new Set<string>(['']);
	const aliases = new Map<string, DocsManifestEntry>();
	for (const entry of entries.values()) {
		const parts = entry.path.split('/');
		for (let index = 1; index < parts.length; index += 1) {
			directories.add(parts.slice(0, index).join('/'));
		}
		aliases.set(searchAlias(entry.path), entry);
	}
	return { product, slug, entries, aliases, directories };
}

function immediateEntries(manifest: DocsManifest, directory: string): HfFsEntry[] {
	const prefix = directory ? `${directory}/` : '';
	const children = new Map<string, HfFsEntry>();
	for (const path of manifest.directories) {
		if (!path.startsWith(prefix) || path === directory) continue;
		const relative = path.slice(prefix.length);
		if (!relative || relative.includes('/')) continue;
		children.set(path, {
			type: 'dir',
			name: relative,
			path,
			uri: docsEntryUri(manifest.product, path),
		});
	}
	for (const entry of manifest.entries.values()) {
		if (!entry.path.startsWith(prefix)) continue;
		const relative = entry.path.slice(prefix.length);
		if (!relative || relative.includes('/')) continue;
		children.set(entry.path, fileEntry(manifest.product, entry));
	}
	return [...children.values()].sort(entrySort);
}

function descendantEntries(manifest: DocsManifest, directory: string): HfFsEntry[] {
	const prefix = directory ? `${directory}/` : '';
	return [
		...[...manifest.directories]
			.filter((path) => path.startsWith(prefix) && path !== directory)
			.map((path) => ({
				type: 'dir' as const,
				name: basename(path),
				path,
				uri: docsEntryUri(manifest.product, path),
			})),
		...[...manifest.entries.values()]
			.filter((entry) => entry.path.startsWith(prefix))
			.map((entry) => fileEntry(manifest.product, entry)),
	].sort(entrySort);
}

function fileEntry(product: string, entry: DocsManifestEntry): HfFsEntry {
	return {
		type: 'file',
		name: basename(entry.path),
		path: entry.path,
		uri: docsEntryUri(product, entry.path),
		title: entry.title,
		url: entry.url,
		content_type: 'text/markdown',
	};
}

function productEntry(entry: DocsCatalogEntry): HfFsEntry {
	return compactEntry({
		type: 'dir',
		name: entry.id,
		path: entry.id,
		uri: `hf://docs/${encodeSegment(entry.id)}`,
		description: entry.category,
		url: entry.url,
	});
}

function entriesResult(params: HfFsParams, source: HfFsEntry[], op: 'ls' | 'find' = 'ls', basePath = ''): HfFsLsResult {
	const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
	const filtered = source.filter((entry) => {
		if (params.entry_type && params.entry_type !== entry.type) return false;
		const relative = basePath ? entry.path.slice(`${basePath}/`.length) : entry.path;
		return !matcher || matcher(relative);
	});
	const offset = params.offset ?? 0;
	const limit = params.limit ?? DEFAULT_LIMIT;
	const entries = filtered.slice(offset, offset + limit);
	const truncated = offset + entries.length < filtered.length;
	return {
		uri: params.uri,
		op,
		entries,
		...(op === 'find' && entries.length === 0 && (params.name || params.path)
			? {
					warnings: [
						'--name matches a basename; --path matches the complete path relative to the find root. Try --name "*term*" or --path "**/*term*".',
					],
				}
			: {}),
		...(truncated ? { truncated: true, truncation_reason: 'entry_limit' as const } : {}),
	};
}

function matchesFind(entry: HfFsEntry, basePath: string, params: HfFsParams): boolean {
	if (params.entry_type && params.entry_type !== entry.type) return false;
	const relative = basePath ? entry.path.slice(`${basePath}/`.length) : entry.path;
	if (params.name && !picomatch(params.name, { dot: true })(entry.name ?? basename(entry.path))) return false;
	return !params.path || picomatch(params.path, { dot: true })(relative);
}

function resolveSearchEntry(
	manifest: DocsManifest,
	value: string,
	hubUrl: string
): { entry: DocsManifestEntry; anchor?: string } | undefined {
	let url: URL;
	try {
		url = new URL(value, hubUrl);
	} catch {
		return undefined;
	}
	const slugPrefix = `/docs/${manifest.slug}/`;
	const prefix = url.pathname.startsWith(slugPrefix)
		? slugPrefix
		: url.pathname.startsWith(`/docs/${manifest.product}/`)
			? `/docs/${manifest.product}/`
			: undefined;
	if (!prefix) return undefined;
	const entry =
		manifest.entries.get(decodePath(url.pathname.slice(prefix.length))) ??
		manifest.aliases.get(searchAlias(url.pathname.slice(prefix.length)));
	if (!entry) return undefined;
	const anchor = url.hash ? decodeAnchor(url.hash.slice(1)) : undefined;
	return { entry, ...(anchor ? { anchor } : {}) };
}

function searchAlias(path: string): string {
	const parts = decodePath(path).replace(/\/+$/, '').split('/');
	if (VERSION_SEGMENT_RE.test(parts[0] ?? '')) parts.shift();
	if (LANGUAGE_SEGMENT_RE.test(parts[0] ?? '')) parts.shift();
	let normalized = parts.join('/');
	if (normalized.endsWith('.html')) normalized = normalized.slice(0, -5);
	if (!normalized.endsWith('.md')) normalized += '.md';
	return normalized;
}

function productFromDocsUrl(value: string): string | undefined {
	try {
		const parts = new URL(value, HUB_URL).pathname.split('/');
		return parts[1] === 'docs' ? parts[2] : undefined;
	} catch {
		return undefined;
	}
}

function docsSlug(value: string): string | undefined {
	const match = value.match(/^\/docs\/([^/]+)\/?$/);
	return match?.[1];
}

function cleanExcerpt(value: string, maxLength: number): string | undefined {
	const clean = value
		.replace(/<[^>]*>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!clean) return undefined;
	return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function validateDocsParams(params: HfFsParams): void {
	if (params.sort !== undefined) throw new Error('EINVAL: sort is not supported for documentation');
	if (params.op === 'search') {
		if ((params.query?.trim().length ?? 0) > 250) throw new Error('EINVAL: documentation search query is too long');
		if (params.limit !== undefined && params.limit > MAX_SEARCH_LIMIT) {
			throw new Error(`EINVAL: documentation search limit must be between 1 and ${MAX_SEARCH_LIMIT.toString()}`);
		}
	}
}

function normalizedCatMaxBytes(value: number | undefined): number {
	return value === undefined ? DEFAULT_CAT_MAX_BYTES : value === 0 ? MAX_CAT_BYTES : value;
}

function getFresh<T>(cache: Map<string, CacheEntry<T>>, key: string): Promise<T> | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt > Date.now()) return entry.value;
	cache.delete(key);
	return undefined;
}

function entrySort(left: HfFsEntry, right: HfFsEntry): number {
	return left.type === right.type ? left.path.localeCompare(right.path) : left.type === 'dir' ? -1 : 1;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function parentPath(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

function docsEntryUri(product: string, path: string, anchor?: string): string {
	return anchoredDocsUri(`hf://docs/${encodeSegment(product)}/${encodePath(path)}`, anchor);
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

function encodePath(value: string): string {
	return value.split('/').map(encodeSegment).join('/');
}

function decodeSegment(value: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new Error('EINVAL: URI contains invalid percent-encoding');
	}
	if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
		throw new Error('EINVAL: URI contains an invalid path segment');
	}
	return decoded;
}

function decodePath(value: string): string {
	return value.split('/').map(decodeSegment).join('/');
}

function decodeAnchor(value: string): string {
	if (!value) throw new Error('EINVAL: documentation section anchor must not be empty');
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new Error('EINVAL: documentation section anchor contains invalid percent-encoding');
	}
	if (
		decoded.length > 500 ||
		[...decoded].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127;
		})
	) {
		throw new Error('EINVAL: documentation section anchor is invalid');
	}
	return decoded;
}

function anchoredDocsUri(uri: string, anchor: string | undefined): string {
	return anchor ? `${uri}#${encodeURIComponent(anchor)}` : uri;
}

function stripAnchor(uri: string): string {
	const hash = uri.indexOf('#');
	return hash === -1 ? uri : uri.slice(0, hash);
}

function compactParsedUri(uri: ParsedDocsUri): ParsedDocsUri {
	return Object.fromEntries(Object.entries(uri).filter(([, value]) => value !== undefined)) as ParsedDocsUri;
}

function inSearchScope(path: string, scope: ParsedDocsUri): boolean {
	return scope.kind !== 'path' || path === scope.path || path.startsWith(`${scope.path}/`);
}

function assertNoSectionAnchor(parsed: ParsedDocsUri, op: 'ls' | 'find' | 'stat'): void {
	if (parsed.anchor) {
		throw new Error(`EINVAL: section anchors apply only to documentation file reads, not ${op}`);
	}
}

function searchResultPath(product: string, path: string, scope: ParsedDocsUri): string {
	if (scope.kind === 'root') return `${product}/${path}`;
	if (scope.kind === 'product') return path;
	if (path === scope.path) return basename(path);
	return path.slice(scope.path.length + 1);
}

function correctedDoubledProductPath(manifest: DocsManifest, path: string): string | undefined {
	const parts = path.split('/');
	if (parts[0] !== manifest.product && parts[0] !== manifest.slug) return undefined;
	const corrected = parts.slice(1).join('/');
	return manifest.entries.has(corrected) || manifest.directories.has(corrected) ? corrected : undefined;
}

function compactEntry(entry: HfFsEntry): HfFsEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HfFsEntry;
}
