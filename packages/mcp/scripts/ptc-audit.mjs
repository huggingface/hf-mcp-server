#!/usr/bin/env node
/**
 * PTC chaining and naming audit (deterministic; no network).
 *
 *   node scripts/ptc-audit.mjs                   static checks + offline dry run + alias probe (needs a built dist)
 *   node scripts/ptc-audit.mjs --no-dry-run      static checks only
 *   node scripts/ptc-audit.mjs --out DIR         artefact directory (default docs-internal/ptc-parity/audit)
 *   node scripts/ptc-audit.mjs --write-baseline  record current known issues in scripts/ptc-audit/baseline.json
 *   node scripts/ptc-audit.mjs --strict          exit 1 on anything not in the baseline (what CI should run)
 *
 * Live chaining against a running server (read-only, anonymous): scripts/ptc-chain-live.mjs.
 * CI guard over the source registry: test/ptc-audit.test.ts (vitest).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRegistry } from './ptc-audit/load.mjs';
import { mermaidFamilies, mermaidTools } from './ptc-audit/audit.mjs';
import { PRIMARY_TYPES, baselineKeys, dryRunMarkdown, runAudit } from './ptc-audit/run.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outDir = resolve(option('--out', new URL('../../../docs-internal/ptc-parity/audit', import.meta.url).pathname));
const baselinePath = new URL('./ptc-audit/baseline.json', import.meta.url);

const { ptc } = await loadRegistry();
const audit = await runAudit(ptc, { dryRun: !flag('--no-dry-run') });
const { tools, result, dry, aliases, chains, summary, brokenHops, nonObvious } = audit;

mkdirSync(outDir, { recursive: true });
let prettier;
try {
	prettier = await import('prettier');
} catch {
	prettier = undefined;
}
const written = [];
const write = (name, data) => {
	const path = resolve(outDir, name);
	writeFileSync(path, typeof data === 'string' ? `${data}\n` : `${JSON.stringify(data, null, '\t')}\n`);
	written.push(path);
};
write('summary.json', summary);
write('inventory.json', result.inventory);
write('findings.json', result.findings);
const full = flag('--full-graph');
const reported = full
	? result.graph.edges
	: result.graph.edges.filter(
			(e) => e.form !== 'url' && e.types.some((t) => PRIMARY_TYPES.test(t)) && e.fromTool !== e.toTool
		);
write('graph.json', {
	note: full
		? 'all edges'
		: 'id/uri/scalar edges carrying a Hub identity (PRIMARY_TYPES) between different tools (url-form edges omitted); --full-graph for all',
	columns: ['from', 'form', 'to', 'types', 'verbatim', 'obvious'],
	producers: result.producers.map((p) => [`${p.tool}:${p.path}`, p.form, p.types.join(',')]),
	consumers: result.graph.consumers.map((c) => [c.key, c.linkTypes.join(',')]),
	edges: reported.map((e) => [e.from, e.form, e.to, e.types.join(','), e.verbatim, e.obvious.join(',')]),
	orphans: result.graph.orphans,
	dead_ends: result.graph.deadEnds,
});
write('dry-run.json', dry);
write('dry-run.md', dryRunMarkdown(dry));
write('aliases.json', aliases);
write('chains.json', chains);
const byConsumer = {};
for (const e of nonObvious) {
	const entry = (byConsumer[e.to] ??= { count: 0, producers: new Set() });
	entry.count++;
	entry.producers.add(e.from.replace(/\[\]/g, '').replace(/\.(id|uri|url)$/, `.$1`));
}
write(
	'non-obvious.json',
	Object.fromEntries(
		Object.entries(byConsumer)
			.sort((a, b) => b[1].count - a[1].count)
			.map(([k, v]) => [k, { count: v.count, examples: [...v.producers].slice(0, 8) }])
	)
);
write(
	'graph.mmd',
	[
		'%% family-level links carried by Hub references (id/uri forms), verbatim-accepted; label = distinct tool pairs',
		mermaidFamilies(
			tools,
			result.graph.edges.filter(
				(e) =>
					e.verbatim === 'accepted' &&
					['id', 'uri'].includes(e.form) &&
					e.fromTool !== e.toTool &&
					e.types.some((t) => /^(repo:|file|dir|paper|collection|doc|discussion|job|sandbox|user|org)/.test(t))
			),
			() => 'accepted'
		),
		'',
		'%% tool-level links carried by hf:// uris (repo/file/paper/collection/doc) and profile uris, verbatim-accepted',
		mermaidTools(
			result.graph.edges,
			(e) =>
				e.verbatim === 'accepted' &&
				e.form === 'uri' &&
				e.types.some((t) => /^(repo:|file|dir|paper|collection|user|org|doc)/.test(t))
		),
	].join('\n')
);

// keep artefacts prettier-clean (the repo runs prettier --check .)
if (prettier)
	for (const path of written.filter((p) => /\.(json|md)$/.test(p))) {
		const options = (await prettier.resolveConfig(path)) ?? {};
		writeFileSync(path, await prettier.format(readFileSync(path, 'utf8'), { ...options, filepath: path }));
	}

const keys = baselineKeys(audit);
if (flag('--write-baseline')) {
	let text = `${JSON.stringify(keys, null, '\t')}\n`;
	if (prettier) {
		const options = (await prettier.resolveConfig(baselinePath.pathname)) ?? {};
		text = await prettier.format(text, { ...options, parser: 'json' });
	}
	writeFileSync(baselinePath, text);
	console.log(`baseline written: ${baselinePath.pathname}`);
}
let regressions = [];
let fixed = [];
try {
	const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
	for (const [group, list] of Object.entries(keys)) {
		const known = new Set(baseline[group] ?? []);
		const now = new Set(list);
		regressions.push(...list.filter((k) => !known.has(k)).map((k) => `${group}: ${k}`));
		fixed.push(...[...known].filter((k) => !now.has(k)).map((k) => `${group}: ${k}`));
	}
} catch {
	regressions = [];
}

console.log(`PTC audit: ${summary.tools} tools -> ${outDir}`);
console.log(
	`findings: must ${summary.findings.must}, should ${summary.findings.should}, info ${summary.findings.info}`
);
console.log(
	`  by check: ${Object.entries(summary.findings.byCheck)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ')}`
);
console.log(
	`graph: ${summary.producers} producer fields, ${summary.consumers} consumer args; primary edges ${summary.primary_edges} (${summary.primary_edges_verbatim} verbatim, ${summary.primary_edges_rejected} rejected, ${summary.primary_edges_non_obvious_on_wire} accepted but non-obvious from tools/list; ${summary.primary_edges_non_obvious_with_output_docs} even with output field docs)`
);
console.log(`orphans: ${summary.orphans.length}; dead-end types: ${summary.dead_end_types.join(', ')}`);
console.log(
	`dry run: ${summary.dry_run.probes} probes, ${summary.dry_run.not_accepted} not accepted, ${summary.dry_run.silent_wrong_kind} wrong-kind values silently accepted; alias refusals ${summary.alias_refusals}`
);
console.log(`chains: ${summary.chain_hops_broken}/${summary.chain_hops} hops not verbatim`);
for (const h of brokenHops) console.log(`  [${h.chain}] ${h.from} -> ${h.to}: ${h.verbatim}`);
if (fixed.length)
	console.log(
		`fixed since baseline (${fixed.length}); rerun with --write-baseline:\n  ${fixed.slice(0, 20).join('\n  ')}`
	);
if (regressions.length)
	console.log(`NEW vs baseline (${regressions.length}):\n  ${regressions.slice(0, 40).join('\n  ')}`);
if (flag('--strict') && regressions.length) process.exitCode = 1;
