/**
 * CI guard for the PTC chaining / naming audit (scripts/ptc-audit.mjs). Runs the static checks and
 * the offline dry run against the source registry and fails on anything not recorded in
 * scripts/ptc-audit/baseline.json. After fixing an issue, refresh the baseline with
 * `node scripts/ptc-audit.mjs --write-baseline` (needs a built dist) and commit it with the fix.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as ptc from '../src/ptc/index.js';
// @ts-expect-error plain ESM script without type declarations
import { baselineKeys, runAudit } from '../scripts/ptc-audit/run.mjs';

type Keys = Record<string, string[]>;

const baseline = JSON.parse(
	readFileSync(new URL('../scripts/ptc-audit/baseline.json', import.meta.url), 'utf8')
) as Keys;

describe('PTC chaining audit', () => {
	let keys: Keys;
	beforeAll(async () => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
		const audit = await runAudit(ptc, { dryRun: true });
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		keys = baselineKeys(audit) as Keys;
	}, 60_000);

	for (const group of [
		'must_findings',
		'broken_chain_hops',
		'dry_run_not_accepted',
		'silent_wrong_kind',
		'alias_refused',
		'unclassified',
		'camel_case',
		'type_conflicts',
	]) {
		it(`introduces no new ${group.replace(/_/g, ' ')}`, () => {
			const known = new Set(baseline[group] ?? []);
			const fresh = (keys[group] ?? []).filter((key) => !known.has(key));
			expect(fresh).toEqual([]);
		});
	}
});
