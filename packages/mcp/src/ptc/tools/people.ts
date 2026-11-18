import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { PtcError } from '../core/errors.js';
import { HUB_ORIGIN, hubFetch, openCursor, requestPage, sealCursor } from '../core/hub-http.js';
import {
	collectionItem,
	itemSchema,
	paperItem,
	parseRef,
	refSchema,
	REPO_KINDS,
	repoItem,
	repoUrl,
	type PtcItem,
	type RepoKind,
	parsePersonRef,
	personRefSchema,
} from '../core/refs.js';
import { canonicalPersonName } from '../core/person.js';
import { definePtcTool, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';

/**
 * People and community (read-only): profiles, org members, follow graph, likes, activity, discussions.
 * Profiles have no hf:// form: person/org records use the profile page URL as `uri` and `url`,
 * and every handle argument accepts that URL back.
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 2048): string | undefined =>
	typeof value === 'string' && value ? value.slice(0, max) : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
function compact<T extends Json>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const HANDLE = /^[A-Za-z0-9][\w.-]{0,95}$/;
const REPO_ID = /^[\w.-]+(?:\/[\w.-]+)?$/;
const FANOUT_CONCURRENCY = 5;

// ---------------------------------------------------------------- shared helpers

function profileUrl(handle: string): string {
	return `${HUB_ORIGIN}/${handle}`;
}

function personItem(kind: 'user' | 'org', handle: string): PtcItem {
	return { kind, id: handle, uri: profileUrl(handle), url: profileUrl(handle) };
}

/** Person arguments share one parser (core/refs.ts): a name, "@name" or the profile uri of a record. */
const parseHandle = parsePersonRef;

function avatar(value: unknown): string | undefined {
	const raw = str(value, 1024);
	if (!raw) return undefined;
	if (raw.startsWith('/')) return `${HUB_ORIGIN}${raw}`;
	return raw.startsWith('https://') ? raw : undefined;
}

/** Repo kind from an upstream type string ("model", "dataset", "space", "bucket"). */
function repoKind(value: unknown): RepoKind | undefined {
	return REPO_KINDS.find((kind) => kind === value);
}

function repoRef(kind: unknown, id: unknown): PtcItem | undefined {
	const k = repoKind(kind);
	const repoId = str(id, 256);
	return k && repoId && REPO_ID.test(repoId) ? repoItem(k, repoId) : undefined;
}

async function mapLimit<T, R>(
	values: readonly T[],
	limit: number,
	fn: (value: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0;
	const worker = async () => {
		while (next < values.length) {
			const index = next++;
			results[index] = await fn(values[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
	return results;
}

/** Re-throw NOT_FOUND with a subject the caller can act on (requestPage labels everything "listing"). */
function renameNotFound(error: unknown, subject: string): never {
	if (error instanceof PtcError && error.code === 'NOT_FOUND') {
		throw new PtcError('NOT_FOUND', `${subject} not found (or not visible to this token).`);
	}
	throw error;
}

const personSchema = z
	.object({
		kind: z.enum(['user', 'org']),
		// Username or organization name.
		id: z.string(),
		// Profile page URL (people have no hf:// form); every handle argument accepts it.
		uri: z.string(),
		url: z.string(),
		fullname: z.string().optional(),
		avatarUrl: z.string().optional(),
		isPro: z.boolean().optional(),
		role: z.string().optional().describe('admin, write, contributor or read; when visible to the token.'),
		// company, university, community...
		orgType: z.string().optional(),
	})
	.strict();
type Person = z.infer<typeof personSchema>;

/** Whitelisted person fields only: never emails, email domains or internal ids. */
function personOf(row: unknown): Person | undefined {
	if (!isRecord(row)) return undefined;
	const kind: Person['kind'] = row.type === 'org' ? 'org' : 'user';
	const handle = str(row.user, 96) ?? str(row.name, 96);
	if (!handle || !HANDLE.test(handle)) return undefined;
	return compact({
		...personItem(kind, handle),
		kind,
		fullname: str(row.fullname, 200),
		avatarUrl: avatar(row.avatarUrl),
		isPro: bool(row.isPro),
		role: str(row.role, 32),
		orgType: str(row.orgType, 32),
	});
}

// ---------------------------------------------------------------- bounded paging over any upstream

/**
 * Position in an upstream feed: `up` is the upstream page token (a requestPage cursor, a page number
 * or a feed cursor) and `skip` the rows already returned from that page. Sealed into nextCursor.
 */
interface ScanState {
	up?: string;
	skip: number;
	/** Auto-detected profile kind the upstream token belongs to (hf_follow_graph). */
	as?: 'user' | 'org';
}
const scanStateSchema = z
	.object({
		up: z.string().max(8192).optional(),
		skip: z.number().int().min(0).max(100_000),
		as: z.enum(['user', 'org']).optional(),
	})
	.strict();
type PageFetcher = (up: string | undefined) => Promise<{ rows: unknown[]; next: string | null }>;
interface ScanResult<T> {
	items: T[];
	next: ScanState | null;
	scanned: number;
	pages: number;
	/** Stopped because the page budget ran out, not because limit was reached or the feed ended. */
	pageCapHit: boolean;
}

async function scan<T>(
	fetchPage: PageFetcher,
	start: ScanState,
	limit: number,
	accept: (row: unknown) => T | undefined,
	maxPages: number
): Promise<ScanResult<T>> {
	const items: T[] = [];
	let state = start;
	let scanned = 0;
	let pages = 0;
	while (pages < maxPages) {
		const { rows, next } = await fetchPage(state.up);
		pages++;
		for (let i = state.skip; i < rows.length; i++) {
			scanned++;
			const item = accept(rows[i]);
			if (item !== undefined) items.push(item);
			if (items.length >= limit) {
				if (i + 1 < rows.length)
					return { items, next: { up: state.up, skip: i + 1 }, scanned, pages, pageCapHit: false };
				return { items, next: next ? { up: next, skip: 0 } : null, scanned, pages, pageCapHit: false };
			}
		}
		if (!next) return { items, next: null, scanned, pages, pageCapHit: false };
		state = { up: next, skip: 0 };
	}
	return { items, next: state, scanned, pages, pageCapHit: true };
}

function openScan(cursor: string | undefined, binding: unknown, ctx: PtcContext): ScanState {
	const raw = openCursor(cursor, binding, ctx);
	if (raw === undefined) return { skip: 0 };
	try {
		const state = scanStateSchema.parse(JSON.parse(raw));
		return {
			...(state.up !== undefined ? { up: state.up } : {}),
			skip: state.skip,
			...(state.as ? { as: state.as } : {}),
		};
	} catch {
		throw new PtcError('INVALID_CURSOR', 'invalid cursor; reuse the original arguments and authentication.');
	}
}

function sealScan(state: ScanState | null, binding: unknown, ctx: PtcContext): string | null {
	return state ? sealCursor(binding, ctx, JSON.stringify(state)) : null;
}

/** Link-paginated array endpoint as a PageFetcher (`up` is the requestPage cursor). */
function linkPages(
	path: string,
	params: URLSearchParams,
	ctx: PtcContext,
	maxRows: number,
	subject: string
): PageFetcher {
	return async (up) => {
		try {
			const page = await requestPage(path, params, up, ctx, maxRows);
			return { rows: page.rows, next: page.nextCursor };
		} catch (error) {
			return renameNotFound(error, subject);
		}
	};
}

/** Endpoint returning its whole list at once (no upstream paging): offsets are applied locally. */
function wholeList(path: string, ctx: PtcContext, subject: string, maxBytes: number): PageFetcher {
	return async () => {
		const response = await hubFetch({ path, subject, maxBytes }, ctx);
		if (!Array.isArray(response.data))
			throw new PtcError('UPSTREAM_RESPONSE', `${subject}: unexpected upstream response.`);
		return { rows: response.data, next: null };
	};
}

/** Diagnostics: upstream pages read for this call, rows inspected before local filters. */
const scanExtras = {
	pagesScanned: z.number().int().optional(),
	rowsScanned: z.number().int().optional(),
};

function pageOutput<T extends z.ZodType, E extends z.ZodRawShape>(item: T, extras?: E) {
	return z
		.object({
			items: z.array(item),
			returnedCount: z.number().int(),
			nextCursor: z.string().nullable(),
			completeness: completenessSchema(extras),
		})
		.strict();
}

const limitSchema = (def: number, max: number) =>
	z
		.number()
		.int()
		.min(1)
		.max(max)
		.default(def)
		.describe(`Maximum items to return (default ${String(def)}, max ${String(max)}).`);
const cursorSchema = z
	.string()
	.max(16384)
	.optional()
	.describe('nextCursor from a previous call with the same arguments.');
const handleSchema = (what: string) => personRefSchema(`${what}: a username, organization name or profile uri.`);

// ---------------------------------------------------------------- hf_profile_get

const SOCIAL_URL: Record<string, (handle: string) => string> = {
	twitter: (h) => `https://x.com/${h}`,
	github: (h) => `https://github.com/${h}`,
	linkedin: (h) => (/^(in|company)\//.test(h) ? `https://www.linkedin.com/${h}` : `https://www.linkedin.com/in/${h}`),
	bluesky: (h) => `https://bsky.app/profile/${h}`,
};

function socialsOf(value: unknown): Record<string, string> | undefined {
	const handles = isRecord(value) && isRecord(value.socialHandles) ? value.socialHandles : undefined;
	if (!handles) return undefined;
	const out: Record<string, string> = {};
	for (const [key, toUrl] of Object.entries(SOCIAL_URL)) {
		const raw = str(handles[key], 300)?.trim().replace(/^@/, '');
		if (!raw) continue;
		if (/^https:\/\//i.test(raw)) out[key] = raw;
		else if (/^[\w./-]+$/.test(raw)) out[key] = toUrl(raw);
	}
	return Object.keys(out).length ? out : undefined;
}

/** Organizations listed per profile; organizationsTruncated and numOrganizations report a cut (as numSplits does). */
const MAX_ORGS = 100;

const countsSchema = z
	.object({
		followers: z.number().optional(),
		following: z.number().optional(),
		following_orgs: z.number().optional(),
		likes: z.number().optional(),
		models: z.number().optional(),
		datasets: z.number().optional(),
		spaces: z.number().optional(),
		buckets: z.number().optional(),
		discussions: z.number().optional(),
		papers: z.number().optional(),
		upvotes: z.number().optional(),
		members: z.number().optional(),
	})
	.strict()
	.describe('May include private or gated items that listings do not show.');

const profileSchema = z
	.object({
		kind: z.enum(['user', 'org']),
		id: z.string(),
		uri: z.string(),
		url: z.string(),
		fullname: z.string().optional(),
		// Profile bio / organization description.
		bio: z.string().optional(),
		avatarUrl: z.string().optional(),
		isPro: z.boolean().optional(),
		// Organization plan (team, enterprise...).
		plan: z.string().optional(),
		verified: z.boolean().optional(),
		createdAt: z.string().optional(),
		counts: countsSchema,
		organizations: z
			.array(personSchema)
			.max(MAX_ORGS)
			.optional()
			.describe(`First ${String(MAX_ORGS)}; numOrganizations is the total when organizationsTruncated.`),
		organizationsTruncated: z.literal(true).optional(),
		numOrganizations: z.number().int().optional(),
		// Social profile URLs by network (twitter, github, linkedin, bluesky).
		socials: z.record(z.string(), z.string()).optional(),
	})
	.strict();
type Profile = z.infer<typeof profileSchema>;

const itemErrorSchema = z
	.object({ ref: z.string(), error: z.object({ code: z.string(), message: z.string() }).strict() })
	.strict();

/** The canonical display case from the upstream body (users: user, orgs: name), never the caller's input case. */
function canonicalHandle(handle: string, data: Json): string {
	const lower = handle.toLowerCase();
	return (
		[str(data.user, 96), str(data.name, 96)].find(
			(name) => name !== undefined && name.toLowerCase() === lower && HANDLE.test(name)
		) ?? handle
	);
}

function profileOf(kind: 'user' | 'org', input: string, data: Json): Profile {
	const handle = canonicalHandle(input, data);
	const allOrgs = Array.isArray(data.orgs) ? data.orgs : undefined;
	const orgs = allOrgs
		?.slice(0, MAX_ORGS)
		.map((org) => (isRecord(org) ? personOf({ ...org, type: 'org' }) : undefined))
		.filter((org): org is Person => org !== undefined);
	const counts = compact({
		followers: num(data.numFollowers),
		following: num(data.numFollowing),
		following_orgs: num(data.numFollowingOrgs),
		likes: num(data.numLikes),
		models: num(data.numModels),
		datasets: num(data.numDatasets),
		spaces: num(data.numSpaces),
		buckets: num(data.numBuckets),
		discussions: num(data.numDiscussions),
		papers: num(data.numPapers),
		upvotes: num(data.numUpvotes),
		members: num(data.numUsers),
	});
	const truncated = allOrgs !== undefined && allOrgs.length > MAX_ORGS;
	return compact({
		...personItem(kind, handle),
		kind,
		fullname: str(data.fullname, 200),
		bio: str(data.details, 2000),
		avatarUrl: avatar(data.avatarUrl),
		isPro: bool(data.isPro),
		plan: str(data.plan, 32),
		verified: bool(data.isVerified),
		createdAt: str(data.createdAt, 64),
		counts,
		organizations: orgs,
		// The overview has no org count: the upstream list length is the total.
		...(truncated ? { organizationsTruncated: true as const, numOrganizations: allOrgs.length } : {}),
	});
}

async function fetchProfile(
	handle: string,
	kind: 'user' | 'org' | undefined,
	includeSocials: boolean,
	ctx: PtcContext
): Promise<Profile> {
	const kinds: ('user' | 'org')[] = kind ? [kind] : ['user', 'org'];
	for (const k of kinds) {
		const base = `/api/${k === 'user' ? 'users' : 'organizations'}/${encodeURIComponent(handle)}`;
		const overview = await hubFetch({ path: `${base}/overview`, subject: 'profile', allowStatus: [404] }, ctx);
		if (overview.status === 404) continue;
		if (!isRecord(overview.data)) throw new PtcError('UPSTREAM_RESPONSE', 'profile: unexpected upstream response.');
		const profile = profileOf(k, handle, overview.data);
		if (includeSocials) {
			try {
				const socials = await hubFetch({ path: `${base}/socials`, subject: 'socials', allowStatus: [404] }, ctx);
				const links = socialsOf(socials.data);
				if (links) profile.socials = links;
			} catch {
				// socials are optional enrichment
			}
		}
		return profile;
	}
	throw new PtcError(
		'NOT_FOUND',
		`profile ${handle} not found${kind ? ` as ${kind === 'org' ? 'an organization' : 'a user'}` : ''}.`
	);
}

const profileTool = definePtcTool({
	name: 'hf_profile_get',
	family: 'people',
	title: 'Get Hugging Face user or organization profiles',
	description:
		'Look up Hugging Face user or organization profiles by handle: full name, bio, avatar, follower and following counts, numbers of models, datasets and Spaces, organizations, plan and social links (GitHub, X/Twitter, LinkedIn). Accepts several handles at once; user vs organization is detected automatically. Counts come from the profile overview and may include items an anonymous listing cannot see. For the signed-in account see hf_whoami.',
	input: z
		.object({
			handles: z
				// Parsed per item in run (parsePersonRef), so one bad handle is an error entry, not a failed call.
				.array(z.string().trim().min(1).max(200))
				.min(1)
				.max(20)
				.describe('Up to 20 usernames or organization names (or profile uris).'),
			kind: z
				.enum(['user', 'org'])
				.optional()
				.describe('Skip auto-detection: look up only users or only organizations.'),
			includeSocials: z
				.boolean()
				.default(true)
				.describe('Also fetch social profile links (one extra request per handle).'),
		})
		.strict(),
	output: z
		.object({
			items: z
				.array(z.union([profileSchema, itemErrorSchema]))
				.describe('One per handle, in order: a profile or {ref, error}.'),
			returnedCount: z.number(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const items = await mapLimit(input.handles, FANOUT_CONCURRENCY, async (raw) => {
			try {
				return await fetchProfile(parseHandle(raw), input.kind, input.includeSocials, ctx);
			} catch (error) {
				if (error instanceof PtcError && error.code !== 'CANCELLED') {
					return { ref: raw.slice(0, 200), error: { code: error.code, message: error.message } };
				}
				throw error;
			}
		});
		return { items, returnedCount: items.length };
	},
});

// ---------------------------------------------------------------- hf_org_members

const membersTool = definePtcTool({
	name: 'hf_org_members',
	family: 'people',
	title: 'List Hugging Face organization members',
	description:
		'List the members of a Hugging Face organization (team, company or community org): usernames, full names, avatars, PRO status and roles where visible, with cursor paging. Set adminsOnly to list only the organization admins; that needs a token which can see the member list. Member lists are bounded per call; continue with nextCursor. For the organization overview and member count see hf_profile_get.',
	input: z
		.object({
			handle: handleSchema('Organization'),
			adminsOnly: z.boolean().default(false).describe('List only admins (requires a token that can see them).'),
			limit: limitSchema(100, 500),
			cursor: cursorSchema.describe('nextCursor from a previous call (same args); large lists take 10s of pages.'),
		})
		.strict(),
	output: pageOutput(personSchema),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const org = parseHandle(input.handle, 'handle');
		const binding = ['hf_org_members', org, input.adminsOnly, input.limit];
		const state = openScan(input.cursor, binding, ctx);
		const path = `/api/organizations/${encodeURIComponent(org)}/members${input.adminsOnly ? '/admins' : ''}`;
		// Upstream accepts limit >= 10 and echoes it in its Link header.
		const upstreamLimit = Math.max(10, input.limit);
		const params = new URLSearchParams({ limit: String(upstreamLimit) });
		const fetchPage = linkPages(path, params, ctx, Math.max(upstreamLimit, 1000), `organization ${org}`);
		const result = await scan(fetchPage, state, input.limit, personOf, 2);
		return {
			items: result.items,
			returnedCount: result.items.length,
			nextCursor: sealScan(result.next, binding, ctx),
			completeness: { hasMore: result.next !== null },
		};
	},
});

// ---------------------------------------------------------------- hf_follow_graph

const followTool = definePtcTool({
	name: 'hf_follow_graph',
	family: 'people',
	title: 'List Hugging Face followers and following',
	description:
		'List who follows a Hugging Face user or organization, or who a user follows (people, or organizations with following_orgs), with cursor paging. Returns usernames or organization names with full names, avatars and PRO status; each record uri is accepted by hf_profile_get. User vs organization is detected automatically; organizations only have followers. Use it to explore a community around an author or lab.',
	input: z
		.object({
			handle: handleSchema('User or organization'),
			relation: z
				.enum(['followers', 'following', 'following_orgs'])
				.default('followers')
				.describe('followers, following, or organizations followed (users only).'),
			kind: z.enum(['user', 'org']).optional().describe('Skip auto-detection of user vs organization.'),
			limit: limitSchema(100, 500),
			cursor: cursorSchema.describe('nextCursor from a previous call (same args); large lists take 10s of pages.'),
		})
		.strict(),
	output: pageOutput(personSchema),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const handle = parseHandle(input.handle);
		if (input.kind === 'org' && input.relation !== 'followers') {
			throw new PtcError('UNSUPPORTED', 'organizations only have followers; use relation "followers".');
		}
		const binding = ['hf_follow_graph', handle, input.relation, input.kind ?? null, input.limit];
		const state = openScan(input.cursor, binding, ctx);
		const encoded = encodeURIComponent(handle);
		const subject = `profile ${handle}`;
		let detected = input.kind ? undefined : state.as;
		let fetchPage: PageFetcher;
		if (input.relation === 'following_orgs') {
			// Returns the full list at once (no paging); offsets are applied locally.
			fetchPage = wholeList(`/api/users/${encoded}/following/orgs`, ctx, subject, 4 * 1024 * 1024);
		} else if (input.relation === 'following') {
			// Ignores `limit` (fixed pages of up to 500) and omits it from its Link header.
			fetchPage = linkPages(`/api/users/${encoded}/following`, new URLSearchParams(), ctx, 1000, subject);
		} else {
			const params = new URLSearchParams({ limit: String(Math.max(10, input.limit)) });
			const userPages = linkPages(`/api/users/${encoded}/followers`, params, ctx, 1000, subject);
			const orgPages = linkPages(`/api/organizations/${encoded}/followers`, params, ctx, 1000, subject);
			if (input.kind === 'user') fetchPage = userPages;
			else if (input.kind === 'org') fetchPage = orgPages;
			else {
				// Upstream cursors are bound to the endpoint, so the detected kind travels in nextCursor.
				fetchPage = async (up) => {
					if (detected === 'org') return orgPages(up);
					if (detected === 'user') return userPages(up);
					try {
						const page = await userPages(up);
						detected = 'user';
						return page;
					} catch (error) {
						if (!(error instanceof PtcError && error.code === 'NOT_FOUND')) throw error;
						const page = await orgPages(up);
						detected = 'org';
						return page;
					}
				};
			}
		}
		const result = await scan(fetchPage, state, input.limit, personOf, 2);
		const next = result.next && detected ? { ...result.next, as: detected } : result.next;
		return {
			items: result.items,
			returnedCount: result.items.length,
			nextCursor: sealScan(next, binding, ctx),
			completeness: { hasMore: next !== null },
		};
	},
});

// ---------------------------------------------------------------- hf_user_likes

const likedRepoSchema = z
	.object({
		kind: z.enum(['model', 'dataset', 'space', 'bucket']),
		id: z.string(),
		uri: z.string(),
		url: z.string(),
		likedAt: z.string().optional(),
		likes: z.number().optional().describe('Popularity sorts only.'),
		downloads: z.number().optional().describe('Last 30 days; popularity sorts only.'),
	})
	.strict();
type LikedRepo = z.infer<typeof likedRepoSchema>;

const LIKES_RANKING_WINDOW = 50;

function likedRepoOf(row: unknown, kinds: Set<string> | undefined): LikedRepo | undefined {
	if (!isRecord(row) || !isRecord(row.repo)) return undefined;
	const ref = repoRef(row.repo.type, row.repo.name);
	if (!ref || (kinds && !kinds.has(ref.kind))) return undefined;
	return compact({ ...ref, kind: ref.kind as RepoKind, likedAt: str(row.createdAt, 64) });
}

async function enrichPopularity(repo: LikedRepo, ctx: PtcContext): Promise<LikedRepo> {
	const params = new URLSearchParams();
	params.append('expand[]', 'likes');
	if (repo.kind !== 'space') params.append('expand[]', 'downloads');
	try {
		const response = await hubFetch(
			{ path: `/api/${repo.kind}s/${repo.id}`, params, subject: 'repository', allowStatus: [401, 403, 404] },
			ctx
		);
		if (!isRecord(response.data)) return repo;
		return compact({ ...repo, likes: num(response.data.likes), downloads: num(response.data.downloads) });
	} catch (error) {
		if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
		return repo;
	}
}

const likesTool = definePtcTool({
	name: 'hf_user_likes',
	family: 'people',
	title: "List a Hugging Face user's liked repositories",
	description:
		"List the models, datasets and Spaces a Hugging Face user has liked (favorites, bookmarks), most recent first with cursor paging, or ranked by the liked repositories' likes or downloads within a bounded window of the most recent likes. Filter by repository kind. Returns repository hf:// URIs with the like date, ready for repository tools. For who liked a given repository see hf_repo_likers.",
	input: z
		.object({
			handle: handleSchema('User'),
			kindsAny: z
				.array(z.enum(['model', 'dataset', 'space']))
				.min(1)
				.max(3)
				.optional()
				.describe('Only these repository kinds (default: all).'),
			sort: z
				.enum(['recent', 'likes', 'downloads'])
				.default('recent')
				.describe(
					`recent (paged); likes/downloads rerank the ${String(LIKES_RANKING_WINDOW)} latest likes (no paging).`
				),
			limit: limitSchema(50, 100),
			cursor: cursorSchema,
		})
		.strict(),
	output: pageOutput(likedRepoSchema, {
		...scanExtras,
		rankingWindow: z.number().int().optional().describe('Popularity sorts rank only this many most recent likes.'),
	}),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const user = parseHandle(input.handle, 'handle');
		const kinds = input.kindsAny ? new Set<string>(input.kindsAny) : undefined;
		const binding = ['hf_user_likes', user, [...(kinds ?? [])].sort(), input.sort, input.limit];
		const path = `/api/users/${encodeURIComponent(user)}/likes`;
		const accept = (row: unknown) => likedRepoOf(row, kinds);
		if (input.sort === 'recent') {
			const state = openScan(input.cursor, binding, ctx);
			const pageSize = kinds ? 100 : Math.max(10, input.limit);
			const fetchPage = linkPages(path, new URLSearchParams({ limit: String(pageSize) }), ctx, 1000, `user ${user}`);
			const result = await scan(fetchPage, state, input.limit, accept, kinds ? 5 : 2);
			return {
				items: result.items,
				returnedCount: result.items.length,
				nextCursor: sealScan(result.next, binding, ctx),
				completeness: compact({
					hasMore: result.next !== null,
					reason: result.pageCapHit ? ('page_budget' as const) : undefined,
					pagesScanned: result.pages,
					rowsScanned: result.scanned,
				}),
			};
		}
		if (input.cursor) throw new PtcError('INVALID_CURSOR', 'popularity-sorted likes have no further pages.');
		const fetchPage = linkPages(path, new URLSearchParams({ limit: '100' }), ctx, 1000, `user ${user}`);
		const window = await scan(fetchPage, { skip: 0 }, LIKES_RANKING_WINDOW, accept, 5);
		const enriched = await mapLimit(window.items, FANOUT_CONCURRENCY, (repo) => enrichPopularity(repo, ctx));
		const key = input.sort === 'likes' ? 'likes' : 'downloads';
		const ranked = enriched.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1)).slice(0, input.limit);
		return {
			items: ranked,
			returnedCount: ranked.length,
			nextCursor: null,
			completeness:
				window.next === null
					? { hasMore: false, rankingWindow: window.items.length }
					: {
							hasMore: true,
							truncated: true,
							reason: 'ranking_window' as const,
							rankingWindow: window.items.length,
							hint: 'Ranked among the most recent likes only; older likes are not considered.',
						},
		};
	},
});

// ---------------------------------------------------------------- hf_repo_likers

/** Ref with a required repository kind (bare IDs default to model). */
/**
 * A discussion is named by its record id (owner/name#N, hf:// uri#N), its page URL
 * (.../discussions/N[/files]) or a repository plus num. A number in ref and num must agree.
 */
function discussionTarget(value: string, num: number | undefined): { ref: string; num: number } {
	const match = /(?:#|\/discussions\/)(\d{1,8})(?:\/files)?\/?$/.exec(value.trim());
	const fromRef = match?.[1] ? Number(match[1]) : undefined;
	if (fromRef !== undefined && num !== undefined && fromRef !== num)
		throw new PtcError('INVALID_ARGUMENT', 'num conflicts with the discussion number in discussion.');
	const resolved = fromRef ?? num;
	if (resolved === undefined || resolved < 1)
		throw new PtcError(
			'INVALID_ARGUMENT',
			'Missing required argument "num": discussion number (or pass the discussion uri or id as discussion).'
		);
	return { ref: match ? value.trim().slice(0, match.index) : value, num: resolved };
}

function repoOf(ref: string): { kind: Exclude<RepoKind, 'bucket'>; id: string } {
	const parsed = parseRef(ref, 'model');
	if (!parsed.kind || parsed.kind === 'bucket') {
		throw new PtcError('UNSUPPORTED', 'expected a model, dataset or Space reference.');
	}
	if (parsed.path) throw new PtcError('INVALID_ARGUMENT', 'expected a repository reference, not a file path.');
	return { kind: parsed.kind, id: parsed.id };
}

const likersTool = definePtcTool({
	name: 'hf_repo_likers',
	family: 'people',
	title: 'List users who liked a Hugging Face repository',
	description:
		'List the users who liked a Hugging Face model, dataset or Space (its fans, likers, stargazers), most recent first, with cursor paging. Returns usernames, full names, avatars and PRO status; each record uri is accepted by hf_profile_get and hf_user_likes. The Hub returns the whole liker list at once, so each page re-reads it and applies the offset locally.',
	input: z
		.object({
			repo: refSchema.describe('Model, dataset or Space: hf:// uri (preferred), owner/name (models), or URL.'),
			limit: limitSchema(100, 1000),
			cursor: cursorSchema.describe('nextCursor from a previous call (same args); large lists take 10s of pages.'),
		})
		.strict(),
	output: pageOutput(personSchema),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const repo = repoOf(input.repo);
		const binding = ['hf_repo_likers', repo.kind, repo.id, input.limit];
		const state = openScan(input.cursor, binding, ctx);
		const fetchPage = wholeList(
			`/api/${repo.kind}s/${repo.id}/likers`,
			ctx,
			`${repo.kind} ${repo.id}`,
			16 * 1024 * 1024
		);
		const result = await scan(fetchPage, state, input.limit, personOf, 1);
		return {
			items: result.items,
			returnedCount: result.items.length,
			nextCursor: sealScan(result.next, binding, ctx),
			completeness: { hasMore: result.next !== null },
		};
	},
});

// ---------------------------------------------------------------- hf_activity

const ACTIVITY_TYPES = [
	'like',
	'update',
	'publish',
	'discussion',
	'upvote',
	'paper',
	'paper-daily',
	'paper-discussion',
	'collection',
	'article',
	'social-post',
] as const;

const activitySchema = z
	.object({
		// Open string: ACTIVITY_TYPES plus future upstream types.
		type: z.string(),
		createdAt: z.string().optional(),
		// Username that acted.
		actor: z.string().optional(),
		// Organization the event belongs to (organization feeds).
		org: z.string().optional(),
		// A repository/paper/collection item (hf:// uri) or an article/post page.
		target: itemSchema.strict().optional(),
		// Upvoted item type (paper, collection, article, changelog).
		targetType: z.string().optional(),
		title: z.string().optional(),
		discussion: z
			.object({
				num: z.number(),
				title: z.string().optional(),
				status: z.string().optional(),
				type: z.enum(['discussion', 'pull_request']),
				url: z.string(),
			})
			.strict()
			.optional(),
	})
	.strict();
type ActivityEvent = z.infer<typeof activitySchema>;

function pageItem(kind: string, path: unknown, title?: string): PtcItem | undefined {
	const p = str(path, 500);
	if (!p?.startsWith('/') || p.startsWith('//')) return undefined;
	const url = `${HUB_ORIGIN}${p}`;
	return { kind, id: title ?? p, uri: url, url };
}

function activityOf(row: unknown, types: Set<string> | undefined): ActivityEvent | undefined {
	if (!isRecord(row)) return undefined;
	const type = str(row.type, 64);
	if (!type || (types && !types.has(type))) return undefined;
	let target: PtcItem | undefined;
	let title: string | undefined;
	let discussion: ActivityEvent['discussion'];
	const repo = repoRef(row.repoType, row.repoId);
	if (repo) target = repo;
	if (type === 'discussion' && repo && isRecord(row.discussionData)) {
		const d = row.discussionData;
		const n = num(d.num);
		title = str(d.title, 300);
		if (n !== undefined)
			discussion = compact({
				num: n,
				title,
				status: str(d.status, 32),
				type: d.isPullRequest === true ? ('pull_request' as const) : ('discussion' as const),
				url: `${repoUrl(repo.kind as RepoKind, repo.id)}/discussions/${String(n)}`,
			});
	}
	const paper = isRecord(row.paper) ? row.paper : undefined;
	if (paper) {
		const id = str(paper.id, 32);
		if (id && /^\d{4}\.\d{4,5}$/.test(id)) target = paperItem(id);
		title = str(paper.title, 300);
	}
	if (isRecord(row.collection)) {
		const slug = str(row.collection.slug, 300);
		if (slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) target = collectionItem(slug);
		title = str(row.collection.title, 300);
	}
	if (isRecord(row.blog)) {
		title = str(row.blog.title, 300);
		target = pageItem('article', row.blog.url) ?? target;
	}
	if (isRecord(row.socialPost)) {
		title = str(row.socialPost.rawContent, 300)?.replace(/\s+/g, ' ');
		target = pageItem('post', row.socialPost.url) ?? target;
	}
	let targetType: string | undefined;
	if (type === 'upvote' && isRecord(row.target)) {
		targetType = str(row.targetType, 32);
		const t = row.target;
		title = str(t.title, 300);
		if (targetType === 'paper' && typeof t.id === 'string' && /^\d{4}\.\d{4,5}$/.test(t.id)) target = paperItem(t.id);
		else if (targetType === 'collection' && typeof t.slug === 'string' && /^[\w.-]+\/[\w.-]+$/.test(t.slug))
			target = collectionItem(t.slug);
		else target = pageItem(targetType ?? 'page', row.targetUrl) ?? target;
	}
	return compact({
		type,
		createdAt: str(row.time, 64),
		actor: str(row.user, 96),
		org: str(row.org, 96),
		target,
		targetType: targetType,
		title,
		discussion,
	});
}

const ACTIVITY_CURSOR = /^[\w+/=-]{1,1024}$/;

function activityPages(feedType: 'user' | 'org', entity: string, pageSize: number, ctx: PtcContext): PageFetcher {
	return async (up) => {
		const params = new URLSearchParams({ feedType, entity, limit: String(pageSize) });
		if (up) params.set('cursor', up);
		const response = await hubFetch({ path: '/api/recent-activity', params, subject: `activity of ${entity}` }, ctx);
		const data = response.data;
		if (!isRecord(data) || !Array.isArray(data.recentActivity))
			throw new PtcError('UPSTREAM_RESPONSE', 'activity: unexpected upstream response.');
		const next = typeof data.cursor === 'string' && ACTIVITY_CURSOR.test(data.cursor) ? data.cursor : null;
		return { rows: data.recentActivity, next: data.recentActivity.length ? next : null };
	};
}

const activityTool = definePtcTool({
	name: 'hf_activity',
	family: 'people',
	title: 'Recent activity of a Hugging Face user or organization',
	description:
		'Recent public activity of a Hugging Face user or organization (feed, timeline): new and updated models, datasets and Spaces, likes, upvotes, papers, collections, articles, posts and discussions, newest first, with cursor paging. Filter by event type. Each event links its target as an hf:// uri for follow-up calls. The feed is not exhaustive: counts derived from it are lower bounds. For commits of one repository see hf_repo_history.',
	input: z
		.object({
			handle: handleSchema('User or organization'),
			kind: z.enum(['user', 'org']).optional().describe('Skip auto-detection of user vs organization feed.'),
			typesAny: z
				.array(z.enum(ACTIVITY_TYPES))
				.min(1)
				.max(ACTIVITY_TYPES.length)
				.optional()
				.describe('Only these event types (filtered locally over a bounded number of feed pages).'),
			limit: limitSchema(50, 100),
			cursor: cursorSchema,
		})
		.strict(),
	output: pageOutput(activitySchema, scanExtras),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const entity = parseHandle(input.handle, 'handle');
		const types = input.typesAny ? new Set<string>(input.typesAny) : undefined;
		const binding = ['hf_activity', entity, input.kind ?? null, [...(types ?? [])].sort(), input.limit];
		const state = openScan(input.cursor, binding, ctx);
		const pageSize = types ? 100 : input.limit;
		const accept = (row: unknown) => activityOf(row, types);
		const maxPages = types ? 5 : 2;
		const run = (name: string, feedType: 'user' | 'org') =>
			scan(activityPages(feedType, name, pageSize, ctx), state, input.limit, accept, maxPages);
		const feed = async (name: string): Promise<ScanResult<ActivityEvent>> => {
			if (input.kind) return await run(name, input.kind);
			try {
				return await run(name, 'user');
			} catch (error) {
				if (!(error instanceof PtcError && error.code === 'NOT_FOUND')) throw error;
				return await run(name, 'org');
			}
		};
		let result: ScanResult<ActivityEvent>;
		try {
			result = await feed(entity);
		} catch (error) {
			// The feed's entity= is case-sensitive (404 for EVALSTATE): retry once with the canonical case.
			if (!(error instanceof PtcError && error.code === 'NOT_FOUND')) throw error;
			const canonical = await canonicalPersonName(entity, ctx);
			if (!canonical || canonical === entity) throw error;
			result = await feed(canonical);
		}
		return {
			items: result.items,
			returnedCount: result.items.length,
			nextCursor: sealScan(result.next, binding, ctx),
			completeness: compact({
				hasMore: result.next !== null,
				reason: result.pageCapHit ? ('page_budget' as const) : undefined,
				pagesScanned: result.pages,
				rowsScanned: result.scanned,
			}),
		};
	},
});

// ---------------------------------------------------------------- hf_discussions_list

const discussionSummarySchema = z
	.object({
		kind: z.literal('discussion'),
		id: z.string().describe('owner/name#num'),
		// Discussion page URL (no hf:// form); hf_discussion_get accepts it.
		uri: z.string(),
		url: z.string(),
		repo: itemSchema.strict(),
		num: z.number(),
		title: z.string().optional(),
		status: z.string().optional().describe('open, closed, merged or draft.'),
		type: z.enum(['discussion', 'pull_request']),
		author: z.string().optional(),
		createdAt: z.string().optional(),
		numComments: z.number().optional(),
		pinned: z.boolean().optional(),
	})
	.strict();
type DiscussionSummary = z.infer<typeof discussionSummarySchema>;

function discussionUrl(kind: RepoKind, id: string, n: number): string {
	return `${repoUrl(kind, id)}/discussions/${String(n)}`;
}

function discussionOf(row: unknown, fallback: { kind: RepoKind; id: string }): DiscussionSummary | undefined {
	if (!isRecord(row)) return undefined;
	const n = num(row.num);
	if (n === undefined) return undefined;
	const repo =
		(isRecord(row.repo) ? repoRef(row.repo.type, row.repo.name) : undefined) ?? repoItem(fallback.kind, fallback.id);
	const kind = repo.kind as RepoKind;
	const url = discussionUrl(kind, repo.id, n);
	return compact({
		kind: 'discussion' as const,
		id: `${repo.id}#${String(n)}`,
		uri: url,
		url,
		repo,
		num: n,
		title: str(row.title, 500),
		status: str(row.status, 32),
		type: row.isPullRequest === true ? ('pull_request' as const) : ('discussion' as const),
		author: isRecord(row.author) ? str(row.author.name, 96) : undefined,
		createdAt: str(row.createdAt, 64),
		numComments: num(row.numComments),
		pinned: bool(row.pinned),
	});
}

const DISCUSSIONS_PAGE = 50;
const OWNER_MAX_REPOS = 50;

interface DiscussionFilters {
	status: 'open' | 'closed' | 'all';
	type: 'discussion' | 'pull_request' | 'all';
	author?: string;
}

async function discussionsPage(
	repo: { kind: RepoKind; id: string },
	page: number,
	filters: DiscussionFilters,
	ctx: PtcContext
): Promise<{ rows: unknown[]; count?: number }> {
	const params = new URLSearchParams({ p: String(page) });
	if (filters.status !== 'all') params.set('status', filters.status);
	if (filters.type !== 'all') params.set('type', filters.type);
	if (filters.author) params.set('author', filters.author);
	const response = await hubFetch(
		{ path: `/api/${repo.kind}s/${repo.id}/discussions`, params, subject: `discussions of ${repo.id}` },
		ctx
	);
	const data = response.data;
	if (!isRecord(data) || !Array.isArray(data.discussions))
		throw new PtcError('UPSTREAM_RESPONSE', 'discussions: unexpected upstream response.');
	return { rows: data.discussions.slice(0, DISCUSSIONS_PAGE), count: num(data.count) };
}

/** An owner's repositories (up to OWNER_MAX_REPOS, most liked first) and the overview repo count. */
async function ownerRepos(
	owner: string,
	ctx: PtcContext
): Promise<{ repos: { kind: RepoKind; id: string }[]; truncated: boolean; totalKnown?: number }> {
	// Profile first: its name is the canonical case, and the listings' author= filter is case-sensitive.
	let totalKnown: number | undefined;
	let canonical = owner;
	let missing = false;
	try {
		const profile = await fetchProfile(owner, undefined, false, ctx);
		canonical = profile.id;
		const c = profile.counts;
		if (c.models !== undefined || c.datasets !== undefined || c.spaces !== undefined)
			totalKnown = (c.models ?? 0) + (c.datasets ?? 0) + (c.spaces ?? 0);
	} catch (error) {
		if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
		missing = error instanceof PtcError && error.code === 'NOT_FOUND';
	}
	const kinds = ['model', 'dataset', 'space'] as const;
	const lists = await Promise.all(
		kinds.map(async (kind) => {
			const params = new URLSearchParams({ author: canonical, sort: 'likes', limit: String(OWNER_MAX_REPOS) });
			const response = await hubFetch({ path: `/api/${kind}s`, params, subject: `${kind}s of ${owner}` }, ctx);
			const rows = Array.isArray(response.data) ? response.data.slice(0, OWNER_MAX_REPOS) : [];
			return rows.flatMap((row) => {
				const id = isRecord(row) ? str(row.id, 256) : undefined;
				return id && REPO_ID.test(id) ? [{ kind, id, likes: isRecord(row) ? (num(row.likes) ?? 0) : 0 }] : [];
			});
		})
	);
	const all = lists.flat().sort((a, b) => b.likes - a.likes);
	if (missing && all.length === 0) throw new PtcError('NOT_FOUND', `owner ${owner} not found.`);
	const listTruncated = lists.some((list) => list.length >= OWNER_MAX_REPOS) || all.length > OWNER_MAX_REPOS;
	return {
		repos: all.slice(0, OWNER_MAX_REPOS).map(({ kind, id }) => ({ kind, id })),
		truncated: listTruncated || (totalKnown !== undefined && totalKnown > Math.min(all.length, OWNER_MAX_REPOS)),
		totalKnown,
	};
}

const discussionsListTool = definePtcTool({
	name: 'hf_discussions_list',
	family: 'people',
	title: 'List Hugging Face discussions and pull requests',
	description:
		'List discussions and pull requests on a Hugging Face model, dataset or Space (community tab), or across the repositories of a user or organization: title, author, status, type, comment count and dates, newest first, filtered by status, type or author. Owner mode scans a bounded set of the most-liked repositories and reports its coverage. Read one thread with hf_discussion_get.',
	input: z
		.object({
			repo: refSchema.optional().describe('Repository: hf:// uri (preferred), owner/name or URL. Not with owner.'),
			owner: handleSchema('Owner to scan (not with repo)').optional(),
			status: z
				.enum(['open', 'closed', 'all'])
				.default('open')
				.describe('open (incl. draft PRs), closed (incl. merged), or all.'),
			type: z.enum(['discussion', 'pull_request', 'all']).default('all'),
			author: personRefSchema('Only threads opened by this user (name or profile uri).').optional(),
			limit: limitSchema(50, 100),
			cursor: cursorSchema,
		})
		.strict(),
	output: pageOutput(discussionSummarySchema, {
		total: z.number().int().optional().describe('Hub match count, when reported.'),
		reposScanned: z.number().int().optional().describe('owner: repositories read, of numRepos.'),
		numRepos: z.number().int().optional(),
		reposFailed: z.number().int().optional().describe('owner: repositories that could not be read.'),
	}),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		if (!input.repo === !input.owner) throw new PtcError('INVALID_ARGUMENT', 'pass exactly one of repo or owner.');
		const filters: DiscussionFilters = {
			status: input.status,
			type: input.type,
			...(input.author ? { author: parseHandle(input.author, 'author') } : {}),
		};
		if (input.repo) {
			const repo = repoOf(input.repo);
			const binding = ['hf_discussions_list', repo.kind, repo.id, filters, input.limit];
			const state = openScan(input.cursor, binding, ctx);
			let total: number | undefined;
			const fetchPage: PageFetcher = async (up) => {
				const page = up ? Number(up) : 0;
				if (!Number.isInteger(page) || page < 0 || page > 10_000)
					throw new PtcError('INVALID_CURSOR', 'invalid cursor.');
				const result = await discussionsPage(repo, page, filters, ctx);
				total = result.count;
				const more =
					result.rows.length >= DISCUSSIONS_PAGE &&
					(result.count === undefined || (page + 1) * DISCUSSIONS_PAGE < result.count);
				return { rows: result.rows, next: more ? String(page + 1) : null };
			};
			const result = await scan(fetchPage, state, input.limit, (row) => discussionOf(row, repo), 3);
			return {
				items: result.items,
				returnedCount: result.items.length,
				nextCursor: sealScan(result.next, binding, ctx),
				completeness: compact({ hasMore: result.next !== null, total }),
			};
		}
		const owner = parseHandle(input.owner ?? '', 'owner');
		const binding = ['hf_discussions_list', 'owner', owner, filters, input.limit];
		const state = openScan(input.cursor, binding, ctx);
		const { repos, truncated, totalKnown } = await ownerRepos(owner, ctx);
		let failed = 0;
		let perRepoTruncated = 0;
		const perRepo = await mapLimit(repos, FANOUT_CONCURRENCY, async (repo) => {
			try {
				const page = await discussionsPage(repo, 0, filters, ctx);
				if ((page.count ?? 0) > page.rows.length) perRepoTruncated++;
				return page.rows.flatMap((row) => discussionOf(row, repo) ?? []);
			} catch (error) {
				if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
				failed++;
				return [];
			}
		});
		const merged = perRepo
			.flat()
			.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
		const offset = state.skip;
		const items = merged.slice(offset, offset + input.limit);
		const next = offset + input.limit < merged.length ? { skip: offset + input.limit } : null;
		return {
			items,
			returnedCount: items.length,
			nextCursor: sealScan(next, binding, ctx),
			completeness: compact({
				hasMore: next !== null || truncated || perRepoTruncated > 0,
				truncated: truncated || perRepoTruncated > 0 || undefined,
				reason: truncated || perRepoTruncated > 0 ? ('owner_fanout_cap' as const) : undefined,
				reposScanned: repos.length - failed,
				numRepos: totalKnown,
				reposFailed: failed || undefined,
				hint: `Scans up to ${String(OWNER_MAX_REPOS)} most-liked repositories and the newest ${String(DISCUSSIONS_PAGE)} matching threads of each.`,
			}),
		};
	},
});

// ---------------------------------------------------------------- hf_discussion_get

const COMMENT_MAX_CHARS = 4000;
const COMMENTS_TOTAL_CHARS = 20_000;
const MAX_TIMELINE = 100;
const MAX_FILES = 300;
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

const commentSchema = z
	.object({
		id: z.string().optional(),
		author: z.string().optional(),
		createdAt: z.string().optional(),
		text: z.string().optional().describe('Markdown, clipped; absent for hidden comments.'),
		textTruncated: z.boolean().optional(),
		edited: z.boolean().optional(),
		hidden: z.boolean().optional(),
	})
	.strict();

const timelineSchema = z
	.object({
		// commit, status-change, title-change, pinning-change, ...
		type: z.string(),
		author: z.string().optional(),
		createdAt: z.string().optional(),
		// Commit subject and oid, new status, or new title.
		detail: z.string().optional(),
	})
	.strict();

const changedFileSchema = z
	.object({
		path: z.string(),
		change: z.enum(['added', 'deleted', 'modified', 'renamed']),
		// Previous path for renames.
		from: z.string().optional(),
	})
	.strict();

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo git's C-style path quoting ("caf\303\251.txt": octal UTF-8 bytes, \t, \", \\). */
function unquoteGitPath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
	const bytes: number[] = [];
	const body = value.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const char = body[i] ?? '';
		if (char !== '\\') {
			bytes.push(...new TextEncoder().encode(char));
			continue;
		}
		const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
		if (octal) {
			bytes.push(parseInt(octal[0], 8) & 0xff);
			i += 3;
			continue;
		}
		const next = body[i + 1] ?? '';
		bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
		i++;
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Split the next (possibly quoted) token off `value`: [token, rest]. */
function quotedToken(value: string): [string, string] | undefined {
	for (let i = 1; i < value.length; i++) {
		if (value[i] === '\\') i++;
		else if (value[i] === '"') return [value.slice(0, i + 1), value.slice(i + 1).replace(/^ /, '')];
	}
	return undefined;
}

const stripSide = (path: string, side: 'a' | 'b'): string | undefined =>
	path.startsWith(`${side}/`) ? path.slice(2) : undefined;

/** Old and new path of a `diff --git` header; unquoted paths may contain spaces. */
function gitHeaderPaths(rest: string): [string, string] | undefined {
	let left: string;
	let right: string;
	if (rest.startsWith('"')) {
		const token = quotedToken(rest);
		if (!token) return undefined;
		[left, right] = [unquoteGitPath(token[0]), unquoteGitPath(token[1])];
	} else if (rest.endsWith('"') && rest.includes(' "')) {
		const at = rest.lastIndexOf(' "');
		[left, right] = [rest.slice(0, at), unquoteGitPath(rest.slice(at + 1))];
	} else {
		// Unquoted: "a/X b/X" when unchanged (X may contain " b/"), else split at the first " b/".
		const half = (rest.length - 1) / 2;
		const at = Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3) ? half : rest.indexOf(' b/');
		if (at < 0) return undefined;
		[left, right] = [rest.slice(0, at), rest.slice(at + 1)];
	}
	const from = stripSide(left, 'a');
	const to = stripSide(right, 'b');
	return from !== undefined && to !== undefined ? [from, to] : undefined;
}

/**
 * Parse a unified git diff into a file list. Paths come from the `diff --git` header, refined by the
 * extended headers (rename from/to, ---/+++), which git writes unambiguously even for spaces.
 */
export function changedFilesFromDiff(diff: string): z.infer<typeof changedFileSchema>[] {
	const files: z.infer<typeof changedFileSchema>[] = [];
	let current: { path: string; from: string; change: z.infer<typeof changedFileSchema>['change'] } | undefined;
	let inHunk = false;
	const header = (value: string) => unquoteGitPath(value.replace(/\t$/, ''));
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const paths = gitHeaderPaths(line.slice('diff --git '.length).replace(/\r$/, ''));
			current = paths ? { from: paths[0], path: paths[1], change: 'modified' } : undefined;
			if (current) files.push(current);
			inHunk = false;
			continue;
		}
		if (!current || inHunk) continue;
		if (line.startsWith('@@')) inHunk = true;
		else if (line.startsWith('new file mode')) current.change = 'added';
		else if (line.startsWith('deleted file mode')) current.change = 'deleted';
		else if (line.startsWith('rename from ')) current.from = header(line.slice(12));
		else if (line.startsWith('rename to ')) current.path = header(line.slice(10));
		else if (line.startsWith('--- ')) {
			const from = stripSide(header(line.slice(4)), 'a');
			if (from !== undefined) current.from = from;
		} else if (line.startsWith('+++ ')) {
			const to = stripSide(header(line.slice(4)), 'b');
			if (to !== undefined) current.path = to;
		}
	}
	return files.map(({ path, from, change }) =>
		change === 'modified' && from !== path ? { path, change: 'renamed' as const, from } : { path, change }
	);
}

function timelineDetail(type: string, data: Json): string | undefined {
	if (type === 'commit') {
		const oid = str(data.oid, 64);
		return [str(data.subject, 300), oid ? `(${oid.slice(0, 12)})` : undefined].filter(Boolean).join(' ') || undefined;
	}
	if (type === 'status-change') return str(data.status, 32);
	if (type === 'title-change') return str(data.to, 300) ?? str(data.title, 300);
	if (type === 'pinning-change')
		return data.pinned === true ? 'pinned' : data.pinned === false ? 'unpinned' : undefined;
	if (type === 'locking-change')
		return data.locked === true ? 'locked' : data.locked === false ? 'unlocked' : undefined;
	return undefined;
}

const discussionGetTool = definePtcTool({
	name: 'hf_discussion_get',
	family: 'people',
	title: 'Read a Hugging Face discussion or pull request',
	description:
		'Read one Hugging Face discussion or pull request (community tab thread): title, status, author, comments in order (bounded text, with cursor continuation), the event timeline (commits, status and title changes) and, for pull requests, the changed files parsed from the diff. Pass the repository and the discussion number from hf_discussions_list. Comment text is markdown and may be truncated per comment.',
	input: z
		.object({
			discussion: refSchema.describe('Discussion uri or id (owner/name#N), or a repository uri with num.'),
			num: z
				.number()
				.int()
				.min(1)
				.max(10_000_000)
				.optional()
				.describe('Discussion or pull request number (not needed when discussion names one).'),
			include: z
				.array(z.enum(['comments', 'files']))
				.max(2)
				.optional()
				.describe('Parts to include (default both; files: pull requests only).'),
			limit: limitSchema(50, 200).describe('Maximum comments to return (default 50, max 200).'),
			cursor: cursorSchema.describe('nextCursor from a previous call: continues the comments.'),
		})
		.strict(),
	output: discussionSummarySchema
		.extend({
			locked: z.boolean().optional(),
			numComments: z.number().describe('Whole thread.'),
			comments: z.array(commentSchema).optional(),
			returnedCount: z.number().describe('Comments in this page.'),
			nextCursor: z.string().nullable(),
			timeline: z.array(timelineSchema).optional().describe('Non-comment events; first page only, up to 100.'),
			files: z.array(changedFileSchema).optional().describe('Pull requests: first page only.'),
			filesTruncated: z.boolean().optional().describe('More files changed, or the diff hit the size budget.'),
			// Raw diff of the pull request.
			diffUrl: z.string().optional(),
			targetBranch: z.string().optional(),
			mergeCommit: z.string().optional(),
			conflictingFiles: z.array(z.string()).optional(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: async (input, ctx) => {
		const { ref, num } = discussionTarget(input.discussion, input.num);
		const repo = repoOf(ref);
		const include = new Set(input.include ?? ['comments', 'files']);
		const binding = ['hf_discussion_get', repo.kind, repo.id, num, [...include].sort(), input.limit];
		const offset = openScan(input.cursor, binding, ctx).skip;
		const response = await hubFetch(
			{
				path: `/api/${repo.kind}s/${repo.id}/discussions/${String(num)}`,
				subject: `discussion #${String(num)} of ${repo.id}`,
				maxBytes: 8 * 1024 * 1024,
			},
			ctx
		);
		const data = response.data;
		if (!isRecord(data)) throw new PtcError('UPSTREAM_RESPONSE', 'discussion: unexpected upstream response.');
		const summary = discussionOf({ ...data, numComments: undefined }, repo);
		if (!summary) throw new PtcError('UPSTREAM_RESPONSE', 'discussion: unexpected upstream response.');
		const events = Array.isArray(data.events) ? data.events.filter(isRecord) : [];
		const commentEvents = events.filter((e) => e.type === 'comment');
		const authorOf = (e: Json) => (isRecord(e.author) ? str(e.author.name, 96) : undefined);

		let comments: z.infer<typeof commentSchema>[] | undefined;
		let next: ScanState | null = null;
		if (include.has('comments')) {
			comments = [];
			let budget = COMMENTS_TOTAL_CHARS;
			for (let i = offset; i < commentEvents.length; i++) {
				const event = commentEvents[i] as Json;
				const d = isRecord(event.data) ? event.data : {};
				const hidden = d.hidden === true;
				const raw = !hidden && isRecord(d.latest) && typeof d.latest.raw === 'string' ? d.latest.raw : undefined;
				const text = raw?.slice(0, COMMENT_MAX_CHARS);
				if (comments.length >= input.limit || (comments.length > 0 && (text?.length ?? 0) > budget)) {
					next = { skip: i };
					break;
				}
				budget -= text?.length ?? 0;
				comments.push(
					compact({
						id: str(event.id, 64),
						author: authorOf(event),
						createdAt: str(event.createdAt, 64),
						text,
						textTruncated: raw !== undefined && raw.length > COMMENT_MAX_CHARS ? true : undefined,
						edited: bool(d.edited),
						hidden: hidden || undefined,
					})
				);
			}
		}

		const first = offset === 0;
		const timeline = first
			? events
					.filter((e) => e.type !== 'comment')
					.slice(0, MAX_TIMELINE)
					.map((e) => {
						const type = str(e.type, 64) ?? 'event';
						return compact({
							type,
							author: authorOf(e),
							createdAt: str(e.createdAt, 64),
							detail: timelineDetail(type, isRecord(e.data) ? e.data : {}),
						});
					})
			: undefined;

		const changes = isRecord(data.changes) ? data.changes : {};
		let files: z.infer<typeof changedFileSchema>[] | undefined;
		let filesTruncated: boolean | undefined;
		const isPr = summary.type === 'pull_request';
		if (first && isPr && include.has('files')) {
			const diffPath = `${new URL(repoUrl(repo.kind, repo.id)).pathname}/discussions/${String(num)}/files.diff`;
			try {
				const diff = await hubFetch(
					{ path: diffPath, as: 'text', subject: 'pull request diff', maxBytes: DIFF_MAX_BYTES },
					ctx
				);
				const all = changedFilesFromDiff(typeof diff.data === 'string' ? diff.data : '');
				files = all.slice(0, MAX_FILES);
				filesTruncated = all.length > MAX_FILES || undefined;
			} catch (error) {
				if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
				files = [];
				filesTruncated = true;
			}
		}
		const conflicts = Array.isArray(data.filesWithConflicts)
			? data.filesWithConflicts.filter((f): f is string => typeof f === 'string').slice(0, 100)
			: [];
		const { numComments: _count, ...header } = summary;
		return compact({
			...header,
			locked: bool(data.locked),
			numComments: commentEvents.length,
			...(comments ? { comments } : {}),
			returnedCount: comments?.length ?? 0,
			nextCursor: sealScan(next, binding, ctx),
			timeline,
			files,
			filesTruncated: filesTruncated,
			diffUrl: isPr ? `${summary.url}/files.diff` : undefined,
			targetBranch: isPr ? str(changes.base, 200) : undefined,
			mergeCommit: isPr ? str(changes.mergeCommitId, 64) : undefined,
			conflictingFiles: conflicts.length ? conflicts : undefined,
		});
	},
});

export const PEOPLE_TOOLS: readonly PtcTool[] = [
	profileTool,
	membersTool,
	followTool,
	likesTool,
	likersTool,
	activityTool,
	discussionsListTool,
	discussionGetTool,
];
