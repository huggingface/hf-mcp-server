/**
 * Assemble the full audit (static checks, dry run, alias probe, chains) for a registry module.
 * Shared by the CLI (scripts/ptc-audit.mjs) and the vitest guard (test/ptc-audit.test.ts).
 */
import { registryTools } from './load.mjs';
import { normalizeTools } from './schema-walk.mjs';
import { edgeObviousness, runStatic, wireVisible } from './audit.mjs';
import { runAliasProbe, runDryRun } from './dry-run.mjs';
import { CHAINS } from './rules.mjs';

const FORM_ALIAS = {
	name: 'id',
	echo: 'id',
	profile_url: 'uri',
	web_url: 'uri',
	job_url: 'url',
	https_url: 'https',
	git_ref: 'git',
	display_name: 'name',
};

/** Resource types whose links are worth reporting individually (identity of a Hub thing). */
export const PRIMARY_TYPES =
	/^(repo:|file$|dir$|file->repo|paper$|collection$|doc$|user$|org$|discussion$|job$|scheduled_job$|sandbox$|process$|flavor$|space_tool$|dataset_config$|dataset_split$|job_kind$)/;

export async function runAudit(ptc, { dryRun = true } = {}) {
	const tools = normalizeTools(registryTools(ptc));
	const result = runStatic(tools);
	const dry = dryRun ? await runDryRun(ptc, ptc) : [];
	const aliases = dryRun ? runAliasProbe(ptc, ptc) : [];

	const dryIndex = new Map();
	for (const r of dry) {
		if (r.negative) continue;
		const key = `${r.consumer}|${r.type}|${r.form.split(' ')[0]}`;
		const prev = dryIndex.get(key);
		if (!prev || (prev !== 'accepted' && r.status === 'accepted')) dryIndex.set(key, r.status);
	}
	const edgeStatus = (edge) => {
		if (!dry.length) return 'unknown';
		const forms = [edge.form, FORM_ALIAS[edge.form]].filter(Boolean);
		const statuses = [];
		for (const type of edge.types)
			for (const form of forms) {
				const s = dryIndex.get(`${edge.to}|${type}|${form}`);
				if (s) statuses.push(s);
			}
		if (!statuses.length && !['id', 'uri', 'url'].includes(edge.form))
			for (const type of edge.types)
				for (const [key, s] of dryIndex) if (key.startsWith(`${edge.to}|${type}|`)) statuses.push(s);
		if (statuses.includes('accepted')) return 'accepted';
		if (statuses.includes('rejected')) return 'rejected';
		return statuses[0] ?? 'untested';
	};
	for (const e of result.graph.edges) {
		e.verbatim = edgeStatus(e);
		e.obvious = edgeObviousness(tools, e);
	}

	const edgeByHop = new Map(result.graph.edges.map((e) => [`${e.from}=>${e.to}`, e]));
	const chains = CHAINS.map((chain) => ({
		id: chain.id,
		title: chain.title,
		hops: chain.hops.map(([from, to]) => {
			const e = edgeByHop.get(`${from}=>${to}`);
			const producer = result.producers.find((p) => `${p.tool}:${p.path}` === from);
			return {
				from,
				to,
				verbatim: e ? e.verbatim : producer ? 'no_type_match' : 'no_producer',
				obvious: e ? e.obvious : [],
				obvious_on_wire: e ? wireVisible(e.obvious) : [],
			};
		}),
	}));

	const brokenHops = chains.flatMap((c) =>
		c.hops.filter((h) => h.verbatim !== 'accepted').map((h) => ({ chain: c.id, ...h }))
	);
	const notAccepted = dry.filter((r) => !r.negative && r.status !== 'accepted');
	const silentWrongKind = dry.filter((r) => r.negative && r.status === 'accepted');
	const primaryEdges = result.graph.edges.filter((e) => e.types.some((t) => PRIMARY_TYPES.test(t)));
	const nonObvious = primaryEdges.filter((e) => e.verbatim === 'accepted' && wireVisible(e.obvious).length === 0);
	const nonObviousAllDocs = primaryEdges.filter((e) => e.verbatim === 'accepted' && e.obvious.length === 0);
	const byCheck = {};
	for (const f of result.findings) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
	const count = (sev) => result.findings.filter((f) => f.severity === sev).length;

	const summary = {
		tools: tools.length,
		findings: { must: count('must'), should: count('should'), info: count('info'), byCheck },
		producers: result.producers.length,
		consumers: result.graph.consumers.length,
		edges: result.graph.edges.length,
		primary_edges: primaryEdges.length,
		primary_edges_verbatim: primaryEdges.filter((e) => e.verbatim === 'accepted').length,
		primary_edges_rejected: primaryEdges.filter((e) => e.verbatim === 'rejected').length,
		primary_edges_non_obvious_on_wire: nonObvious.length,
		primary_edges_non_obvious_with_output_docs: nonObviousAllDocs.length,
		orphans: result.graph.orphans.map((o) => o.consumer),
		dead_end_types: result.graph.deadEnds.map((d) => d.type),
		dry_run: { probes: dry.length, not_accepted: notAccepted.length, silent_wrong_kind: silentWrongKind.length },
		alias_refusals: aliases.reduce((n, a) => n + a.refused.length, 0),
		chain_hops: chains.reduce((n, c) => n + c.hops.length, 0),
		chain_hops_broken: brokenHops.length,
	};
	return { tools, result, dry, aliases, chains, brokenHops, notAccepted, silentWrongKind, nonObvious, summary };
}

/**
 * Stable keys for the CI baseline: known issues are listed, anything new fails the guard.
 */
export function baselineKeys(audit) {
	return {
		must_findings: audit.result.findings
			.filter((f) => f.severity === 'must')
			.map((f) => `${f.check}|${f.tool}|${f.path}`)
			.sort(),
		broken_chain_hops: audit.brokenHops.map((h) => `${h.from} -> ${h.to}: ${h.verbatim}`).sort(),
		dry_run_not_accepted: [
			...new Set(audit.notAccepted.map((r) => `${r.consumer}|${r.type}|${r.form}|${r.status}`)),
		].sort(),
		silent_wrong_kind: audit.silentWrongKind.map((r) => `${r.consumer}|${r.value}`).sort(),
		alias_refused: audit.aliases.flatMap((a) => a.refused.map((name) => `${a.consumer}<-${name}`)).sort(),
		unclassified: audit.result.findings
			.filter((f) => f.check.startsWith('unclassified') || f.check === 'stale_rule')
			.map((f) => `${f.check}|${f.tool}|${f.path}`)
			.sort(),
		snake_case: audit.result.findings
			.filter((f) => f.check === 'snake_case_name' || f.check === 'snake_case_enum')
			.map((f) => `${f.tool}|${f.path}`)
			.sort(),
		type_conflicts: audit.result.findings
			.filter((f) => f.check === 'type_conflict')
			.map((f) => f.path)
			.sort(),
	};
}

/** Markdown matrix of the dry run: consumer x (type, form) -> outcome. */
export function dryRunMarkdown(dry) {
	const mark = (s) => (s === 'accepted' ? 'yes' : s === 'unverified' ? 'yes?' : s === 'rejected' ? '**NO**' : s);
	const rows = new Map();
	for (const r of dry) {
		const key = `${r.consumer}|${r.type}`;
		const list = rows.get(key) ?? [];
		list.push(`${r.form}: ${mark(r.status)}${r.negative ? ' (should be NO)' : ''}`);
		rows.set(key, list);
	}
	const lines = ['| consumer | producer type | forms -> accepted verbatim |', '| --- | --- | --- |'];
	for (const [key, list] of rows) {
		const [consumer, type] = key.split('|');
		lines.push(`| ${consumer} | ${type} | ${list.join('; ')} |`);
	}
	return lines.join('\n');
}
