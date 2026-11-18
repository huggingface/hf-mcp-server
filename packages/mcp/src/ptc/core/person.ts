import { PtcError } from './errors.js';
import { hubFetch } from './hub-http.js';
import type { PtcContext } from './tool.js';

/**
 * Canonical letter case of user/org names. Hub names are unique without regard to case and most
 * name routes redirect to the canonical case, but some filters compare exactly: the repository
 * listings' author= (models, datasets, Spaces) and the activity feed's entity= return nothing for
 * "qwen" or "EVALSTATE". Callers of those filters resolve names here first.
 *
 * One anonymous overview request per name (users first, then organizations), cached per process,
 * so only public facts (a public name's case) are cached. Not found -> null. Network or upstream
 * failures keep the name as given and are not cached: resolution never fails the caller's call.
 */
const TTL_MS = 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;
const CONCURRENCY = 5;
const NAME = /^[A-Za-z0-9][\w.-]{0,95}$/;
const cache = new Map<string, { name: string | null; expires: number }>();

/** Test seam. */
export function resetPersonCaseCache(): void {
	cache.clear();
}

function remember(key: string, name: string | null): void {
	if (cache.size >= MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { name, expires: Date.now() + (name ? TTL_MS : NOT_FOUND_TTL_MS) });
}

async function lookup(name: string, ctx: PtcContext): Promise<string | null> {
	// Anonymous on purpose: the cache must never hold what only a token can see.
	const anonymous: PtcContext = { signal: ctx.signal, fetch: ctx.fetch };
	for (const [root, field] of [
		['users', 'user'],
		['organizations', 'name'],
	] as const) {
		const response = await hubFetch(
			{ path: `/api/${root}/${encodeURIComponent(name)}/overview`, subject: 'profile', allowStatus: [404] },
			anonymous
		);
		if (response.status === 404) continue;
		const data = response.data as Record<string, unknown> | undefined;
		const found = data?.[field];
		if (typeof found === 'string' && found.toLowerCase() === name.toLowerCase() && NAME.test(found)) return found;
		return name;
	}
	return null;
}

/** The canonical case of `name`, null when no such user or organization exists. */
export async function canonicalPersonName(name: string, ctx: PtcContext): Promise<string | null> {
	const key = name.toLowerCase();
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now()) return hit.name;
	try {
		const resolved = await lookup(name, ctx);
		remember(key, resolved);
		return resolved;
	} catch (error) {
		if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
		return name;
	}
}

/** Resolve several names; `unknown` lists those that are no user or organization (kept as given). */
export async function canonicalPersonNames(
	names: readonly string[],
	ctx: PtcContext
): Promise<{ names: string[]; unknown: string[] }> {
	const out: string[] = new Array<string>(names.length);
	const unknown: string[] = [];
	for (let i = 0; i < names.length; i += CONCURRENCY) {
		const batch = names.slice(i, i + CONCURRENCY);
		const resolved = await Promise.all(batch.map((name) => canonicalPersonName(name, ctx)));
		resolved.forEach((value, j) => {
			const given = batch[j] as string;
			out[i + j] = value ?? given;
			if (value === null) unknown.push(given);
		});
	}
	return { names: out, unknown };
}
