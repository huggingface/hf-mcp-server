#!/usr/bin/env node
/**
 * Live PTC chaining check (read-only, anonymous). Calls real tools on a running server, takes the
 * identifier fields of each result and feeds them verbatim into the consuming tools. Bounded to
 * about 60 calls; every call uses anonymous read-only tools.
 *
 *   node scripts/ptc-chain-live.mjs [--endpoint http://localhost:3000/mcp?bouquet=ptc] [--out DIR]
 *
 * Output: chain-live.json (one row per hop: producer field, value, consumer argument, outcome).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mcpRequest } from './ptc-audit/load.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const endpoint = option('--endpoint', 'http://localhost:3000/mcp?bouquet=ptc');
const outDir = resolve(option('--out', new URL('../.ptc-audit-out', import.meta.url).pathname));
const MAX_CALLS = Number(option('--max-calls', '80'));

let calls = 0;
const rows = [];

async function call(name, args) {
	if (calls >= MAX_CALLS) return { skipped: true };
	calls++;
	const started = Date.now();
	try {
		const result = await mcpRequest(endpoint, 'tools/call', { name, arguments: args });
		const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
		if (result.isError) return { error: text.slice(0, 300), ms: Date.now() - started };
		return { data: result.structuredContent ?? JSON.parse(text || '{}'), ms: Date.now() - started };
	} catch (error) {
		return { error: String(error.message ?? error).slice(0, 300), ms: Date.now() - started };
	}
}

/** One hop: feed `value` (taken from producer `from`) into `tool.arg`. Returns the consumer result. */
async function hop(chain, from, value, tool, arg, extra = {}, { array = false } = {}) {
	if (value === undefined || value === null) {
		rows.push({ chain, from, to: `${tool}.${arg}`, value: null, outcome: 'no_value' });
		return undefined;
	}
	const args = { ...extra, [arg]: array ? [value] : value };
	const r = await call(tool, args);
	const outcome = r.skipped
		? 'skipped'
		: r.error
			? /INVALID_ARGUMENT|invalid input|not a valid|must|expected/i.test(r.error)
				? 'rejected'
				: 'error'
			: 'ok';
	rows.push({ chain, from, to: `${tool}.${arg}`, value, outcome, error: r.error, ms: r.ms });
	return r.data;
}

const first = (list, pred = () => true) => (Array.isArray(list) ? list.find(pred) : undefined);

// --- search -> inspect -> read -> history ------------------------------------------------------
{
	const chain = 'search-inspect-read';
	const search = await call('hf_models_search', { query: 'Qwen2.5-0.5B-Instruct', authorsAny: ['Qwen'], limit: 3 });
	rows.push({
		chain,
		from: '(start)',
		to: 'hf_models_search',
		outcome: search.error ? 'error' : 'ok',
		error: search.error,
	});
	const model = first(search.data?.items);
	const info = await hop(
		chain,
		'hf_models_search:items[].uri',
		model?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	const rec = first(info?.items);
	await hop(chain, 'hf_models_search:items[].id', model?.id, 'hf_repo_info', 'repos', {}, { array: true });
	await hop(chain, 'hf_models_search:items[].url', model?.url, 'hf_repo_info', 'repos', {}, { array: true });
	const files = await hop(chain, 'hf_repo_info:items[].uri', rec?.uri, 'hf_repo_list_files', 'repo');
	const readme =
		first(files?.items, (f) => f.kind === 'file' && /README\.md$/.test(f.path)) ??
		first(files?.items, (f) => f.kind === 'file');
	const text = await hop(chain, 'hf_repo_list_files:items[].uri', readme?.uri, 'hf_repo_read_text', 'uri', {
		maxBytes: 200,
	});
	await hop(chain, 'hf_repo_list_files:items[].url', readme?.url, 'hf_repo_read_text', 'uri', { maxBytes: 200 });
	await hop(chain, 'hf_repo_read_text:nextOffset', text?.nextOffset, 'hf_repo_read_text', 'offset', {
		uri: readme?.uri,
		maxBytes: 200,
	});
	const history = await hop(chain, 'hf_repo_read_text:uri', text?.uri, 'hf_repo_history', 'repo', { limit: 2 });
	await hop(chain, 'hf_repo_history:items[].id', first(history?.items)?.id, 'hf_repo_list_files', 'revision', {
		repo: rec?.uri,
		limit: 2,
	});
	await hop(chain, 'hf_repo_history:items[].uri', first(history?.items)?.uri, 'hf_repo_list_files', 'repo', {
		limit: 2,
	});
	await hop(chain, 'hf_repo_list_files:nextCursor', files?.nextCursor ?? undefined, 'hf_repo_list_files', 'cursor', {
		repo: rec?.uri,
	});
	// lineage
	const lineage = 'lineage';
	await hop(
		lineage,
		'hf_repo_info:items[].baseModels[].uri',
		first(rec?.baseModels)?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	// spaces is opt-in (fields), not part of the default hf_repo_info payload.
	const withSpaces = rec?.uri ? await call('hf_repo_info', { repos: [rec.uri], fields: ['spaces'] }) : undefined;
	await hop(
		lineage,
		'hf_repo_info(fields: spaces):items[].spaces[].uri',
		first(first(withSpaces?.data?.items)?.spaces)?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	await hop(
		lineage,
		'hf_models_search:items[].author',
		model?.author,
		'hf_profile_get',
		'handles',
		{},
		{ array: true }
	);
	await hop(
		lineage,
		'hf_repo_info:items[].author',
		rec?.author,
		'hf_models_search',
		'authorsAny',
		{ limit: 1 },
		{ array: true }
	);
	await hop(lineage, 'hf_repo_info:items[].uri', rec?.uri, 'hf_discussions_list', 'repo', { limit: 2 });
}

// --- dataset structure -> rows -------------------------------------------------------------------
{
	const chain = 'dataset';
	const search = await call('hf_datasets_search', { query: 'squad', authorsAny: ['rajpurkar'], limit: 2 });
	const ds = first(search.data?.items);
	const structure = await hop(chain, 'hf_datasets_search:items[].uri', ds?.uri, 'hf_dataset_structure', 'dataset', {
		include: ['splits'],
	});
	const split = first(structure?.splits);
	await hop(
		chain,
		'hf_dataset_structure:dataset.uri + splits[].config/split',
		structure?.dataset?.uri,
		'hf_dataset_rows',
		'dataset',
		{ config: split?.config, split: split?.split, length: 1 }
	);
	await hop(chain, 'hf_datasets_search:items[].uri', ds?.uri, 'hf_repo_info', 'repos', {}, { array: true });
}

// --- papers <-> repos ----------------------------------------------------------------------------
{
	const chain = 'papers-repos';
	const search = await call('hf_papers_search', { query: 'Qwen2.5 technical report', limit: 2 });
	const paper = first(search.data?.items);
	const got = await hop(
		chain,
		'hf_papers_search:items[].uri',
		paper?.uri,
		'hf_paper_get',
		'papers',
		{},
		{ array: true }
	);
	const p = first(got?.items);
	await hop(chain, 'hf_papers_search:items[].uri', paper?.uri, 'hf_paper_read', 'paper', { maxBytes: 200 });
	await hop(
		chain,
		'hf_paper_get:items[].linked.models.items[].uri',
		first(p?.linked?.models?.items)?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	await hop(chain, 'hf_paper_get:items[].id', p?.id, 'hf_models_search', 'papersAny', { limit: 1 }, { array: true });
	await hop(chain, 'hf_paper_get:items[].uri', p?.uri, 'hf_collections_search', 'contains', { limit: 1 });
	await hop(
		chain,
		'hf_repo_info:items[].tags (arxiv:ID)',
		'arxiv:2412.15115',
		'hf_models_search',
		'papersAny',
		{ limit: 1 },
		{ array: true }
	);
}

// --- collections -----------------------------------------------------------------------------------
{
	const chain = 'collections';
	const search = await call('hf_collections_search', { query: 'qwen', limit: 2 });
	const coll = first(search.data?.items);
	const got = await hop(chain, 'hf_collections_search:items[].uri', coll?.uri, 'hf_collection_get', 'collection');
	await hop(chain, 'hf_collections_search:items[].id', coll?.id, 'hf_collection_get', 'collection');
	const repoItem = first(got?.items, (i) => ['model', 'dataset', 'space'].includes(i.kind));
	await hop(chain, 'hf_collection_get:items[].uri (repo)', repoItem?.uri, 'hf_repo_info', 'repos', {}, { array: true });
	const paperItem = first(got?.items, (i) => i.kind === 'paper');
	if (paperItem)
		await hop(
			chain,
			'hf_collection_get:items[].uri (paper)',
			paperItem.uri,
			'hf_paper_get',
			'papers',
			{},
			{ array: true }
		);
	await hop(chain, 'hf_collection_get:owner', got?.owner, 'hf_profile_get', 'handles', {}, { array: true });
}

// --- people ------------------------------------------------------------------------------------------
{
	const chain = 'people';
	const profiles = await call('hf_profile_get', { handles: ['julien-c'] });
	const prof = first(profiles.data?.items);
	const followers = await hop(chain, 'hf_profile_get:items[].uri', prof?.uri, 'hf_follow_graph', 'handle', {
		limit: 2,
	});
	const follower = first(followers?.items);
	const likes = await hop(chain, 'hf_follow_graph:items[].uri', follower?.uri, 'hf_user_likes', 'handle', { limit: 2 });
	const ownLikes = await hop(chain, 'hf_profile_get:items[].uri', prof?.uri, 'hf_user_likes', 'handle', { limit: 2 });
	const liked = first(likes?.items) ?? first(ownLikes?.items);
	const likers = await hop(chain, 'hf_user_likes:items[].uri', liked?.uri, 'hf_repo_likers', 'repo', { limit: 2 });
	await hop(
		chain,
		'hf_repo_likers:items[].uri',
		first(likers?.items)?.uri,
		'hf_profile_get',
		'handles',
		{},
		{ array: true }
	);
	const org = first(prof?.organizations);
	const members = await hop(chain, 'hf_profile_get:items[].organizations[].uri', org?.uri, 'hf_org_members', 'handle', {
		limit: 2,
	});
	await hop(chain, 'hf_org_members:items[].uri', first(members?.items)?.uri, 'hf_activity', 'handle', { limit: 3 });
	await hop(
		chain,
		'hf_profile_get:items[].uri',
		prof?.uri,
		'hf_models_search',
		'authorsAny',
		{ limit: 1 },
		{ array: true }
	);
	await hop(chain, 'hf_profile_get:items[].organizations[].uri', org?.uri, 'hf_buckets_list', 'owner', { limit: 1 });
	await hop(
		chain,
		'hf_profile_get:items[].id',
		prof?.id,
		'hf_collections_search',
		'ownersAny',
		{ limit: 1 },
		{ array: true }
	);
	const activity = await call('hf_activity', { handle: 'huggingface', limit: 8 });
	const target = first(activity.data?.items, (i) => i.target?.uri?.startsWith('hf://'));
	if (target?.target?.kind === 'paper')
		await hop(
			chain,
			'hf_activity:items[].target.uri (paper)',
			target.target.uri,
			'hf_paper_get',
			'papers',
			{},
			{ array: true }
		);
	else if (target?.target?.kind === 'collection')
		await hop(
			chain,
			'hf_activity:items[].target.uri (collection)',
			target.target.uri,
			'hf_collection_get',
			'collection'
		);
	else
		await hop(
			chain,
			'hf_activity:items[].target.uri (repo)',
			target?.target?.uri,
			'hf_repo_info',
			'repos',
			{},
			{ array: true }
		);
	// discussions
	const list = await call('hf_discussions_list', {
		repo: 'hf://models/Qwen/Qwen2.5-0.5B-Instruct',
		limit: 2,
		status: 'all',
	});
	const d = first(list.data?.items);
	await hop(chain, 'hf_discussions_list:items[].repo.uri + num', d?.repo?.uri, 'hf_discussion_get', 'discussion', {
		num: d?.num,
		limit: 1,
	});
	await hop(chain, 'hf_discussions_list:items[].uri + num', d?.uri, 'hf_discussion_get', 'discussion', {
		num: d?.num,
		limit: 1,
	});
	await hop(chain, 'hf_discussions_list:items[].uri (no num)', d?.uri, 'hf_discussion_get', 'discussion', {
		limit: 1,
	});
	await hop(chain, 'hf_discussions_list:items[].id + num', d?.id, 'hf_discussion_get', 'discussion', {
		num: d?.num,
		limit: 1,
	});
	await hop(chain, 'hf_discussions_list:items[].author', d?.author, 'hf_profile_get', 'handles', {}, { array: true });
	const daily = await call('hf_daily_papers', { limit: 3 });
	const sub = first(daily.data?.items, (i) => i.submittedBy);
	await hop(chain, 'hf_daily_papers:items[].submittedBy', sub?.submittedBy, 'hf_daily_papers', 'submittedBy', {
		limit: 1,
	});
}

// --- discovery misc --------------------------------------------------------------------------------
{
	const chain = 'discovery-misc';
	const lookup = await call('hf_hub_lookup', { query: 'llama', limit: 1 });
	const byKind = (data, kind) => (data?.items ?? []).filter((i) => i.kind === kind);
	const r = Object.fromEntries(['model', 'user', 'org', 'collection', 'paper'].map((k) => [k, byKind(lookup.data, k)]));
	await hop(
		chain,
		'hf_hub_lookup:items[].uri (model)',
		first(r.model)?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	await hop(
		chain,
		'hf_hub_lookup:items[].uri (user)',
		first(r.user)?.uri,
		'hf_profile_get',
		'handles',
		{},
		{ array: true }
	);
	await hop(chain, 'hf_hub_lookup:items[].uri (org)', first(r.org)?.uri, 'hf_org_members', 'handle', { limit: 1 });
	await hop(
		chain,
		'hf_hub_lookup:items[].uri (collection)',
		first(r.collection)?.uri,
		'hf_collection_get',
		'collection'
	);
	await hop(
		chain,
		'hf_hub_lookup:items[].uri (paper)',
		first(r.paper)?.uri,
		'hf_paper_get',
		'papers',
		{},
		{ array: true }
	);
	const buckets = await call('hf_hub_lookup', { query: 'data', kindsAny: ['bucket'], limit: 1 });
	await hop(chain, 'hf_hub_lookup:items[].uri (bucket)', first(buckets.data?.items)?.uri, 'hf_repo_list_files', 'repo');
	await hop(
		chain,
		'hf_hub_lookup:items[].uri (bucket) (+limit)',
		first(buckets.data?.items)?.uri,
		'hf_repo_list_files',
		'repo',
		{ limit: 2 }
	);
	const ft = await call('hf_repo_fulltext_search', { query: 'trained on SEC filings', limit: 2 });
	const hit = first(ft.data?.items);
	await hop(chain, 'hf_repo_fulltext_search:items[].fileUri', hit?.fileUri, 'hf_repo_read_text', 'uri', {
		maxBytes: 200,
	});
	await hop(
		chain,
		'hf_repo_fulltext_search:items[].uri',
		hit?.uri,
		'hf_repo_fulltext_search',
		'idsAny',
		{ query: 'SEC' },
		{ array: true }
	);
	await hop(
		chain,
		'hf_repo_fulltext_search:items[].id',
		hit?.id,
		'hf_repo_fulltext_search',
		'idsAny',
		{ query: 'SEC' },
		{ array: true }
	);
	const trending = await call('hf_trending', { kind: 'model', limit: 1 });
	await hop(
		chain,
		'hf_trending:items[].uri',
		first(trending.data?.items)?.uri,
		'hf_repo_info',
		'repos',
		{},
		{ array: true }
	);
	const docs = await call('hf_docs_search', { query: 'load a LoRA adapter', limit: 2 });
	const doc = first(docs.data?.items);
	await hop(chain, 'hf_docs_search:items[].uri', doc?.uri, 'hf_docs_read', 'uri', { maxBytes: 300 });
	await hop(chain, 'hf_docs_search:items[].url', doc?.url, 'hf_docs_read', 'uri', { maxBytes: 300 });
	await hop(chain, 'hf_docs_search:items[].id', doc?.id, 'hf_docs_read', 'uri', { maxBytes: 300 });
	const spaces = await call('hf_spaces_list', {
		models_any: ['black-forest-labs/FLUX.1-dev'],
		limit: 1,
		fields: ['models'],
	});
	const sp = first(spaces.data?.items);
	await hop(
		chain,
		'hf_spaces_list:items[].models[].id',
		first(sp?.models)?.id,
		'hf_spaces_list',
		'models_any',
		{ limit: 1 },
		{ array: true }
	);
	await hop(
		chain,
		'hf_spaces_list:items[].models[].uri',
		first(sp?.models)?.uri,
		'hf_spaces_list',
		'models_any',
		{ limit: 1 },
		{ array: true }
	);
}

const summary = {
	endpoint,
	calls,
	hops: rows.filter((r) => r.to && r.from !== '(start)').length,
	ok: rows.filter((r) => r.outcome === 'ok').length,
	rejected: rows.filter((r) => r.outcome === 'rejected').length,
	error: rows.filter((r) => r.outcome === 'error').length,
	no_value: rows.filter((r) => r.outcome === 'no_value').length,
};
mkdirSync(outDir, { recursive: true });
const livePath = resolve(outDir, 'chain-live.json');
let liveText = `${JSON.stringify({ summary, rows }, null, '\t')}\n`;
try {
	const prettier = await import('prettier');
	liveText = await prettier.format(liveText, {
		...((await prettier.resolveConfig(livePath)) ?? {}),
		filepath: livePath,
	});
} catch {
	// prettier unavailable
}
writeFileSync(livePath, liveText);
console.log(JSON.stringify(summary));
for (const r of rows)
	if (r.outcome !== 'ok')
		console.log(
			`${r.outcome.padEnd(9)} [${r.chain}] ${r.from} -> ${r.to}  ${String(r.value ?? '').slice(0, 70)}  ${r.error ? `| ${r.error.slice(0, 160)}` : ''}`
		);
