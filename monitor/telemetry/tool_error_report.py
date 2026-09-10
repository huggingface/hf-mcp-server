#!/usr/bin/env python3
"""Repeatable private aggregate reporting; never syncs or publishes automatically."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess

from data_fill import check_source_root, consume_source, event_date, select_sources, selected_dates
from study_common import checked_output, write_private
from tool_error_policy import (POLICY_VERSION, BUCKETS, TOOL_OPERATIONS, FS_CODE_BUCKET,
                               batch_evidence, classify, operation)

from tool_error_cohorts import CLIENT_POLICY_VERSION, HF_CLIENT_FAMILIES, client_cohort, fs_operation_outcomes

REPORT_SCHEMA = 'tool-error-report-v2'
VERSION = re.compile(r'\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,30})?\Z')
SOURCE_FILES = ('packages/mcp/src/sandbox-tool.ts', 'packages/mcp/src/jobs/jobs-tool.ts',
                'packages/mcp/src/jobs/commands/utils.ts', 'packages/mcp/src/hf-fs-errors.ts',
                'packages/app/src/server/mcp-server.ts')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pct(n: int, d: int) -> float | None:
    return round(100 * n / d, 4) if d else None


def server_provenance(root: Path) -> dict:
    root = root.expanduser().resolve(strict=True)
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
    tracked_diff = git('diff', 'HEAD', '--', *SOURCE_FILES)
    return {'head': git('rev-parse', 'HEAD'),
            'tracked_dirty': bool(git('status', '--porcelain', '--untracked-files=no')),
            'relevant_diff_sha256': hashlib.sha256(tracked_diff.encode()).hexdigest(),
            'source_sha256': {name: digest(root / name) for name in SOURCE_FILES},
            'meaning': 'local source context only; not proof of deployed build identity'}


class Metric:
    def __init__(self):
        self.calls = 0
        self.outcomes = Counter()
        self.buckets = Counter()
        self.reasons = Counter()
        self.batch = Counter()
        self.operation_buckets = Counter()
        self.operation_codes = Counter()

    def add(self, outcome: str, failure, batch, batch_label: object, is_fs: bool):
        self.calls += 1
        self.outcomes[outcome] += 1
        if failure:
            self.buckets[failure.bucket] += 1
            self.reasons[(failure.bucket, failure.reason)] += 1
        if is_fs:
            if isinstance(batch_label, str) and batch_label in ('complete', 'partial', 'none_succeeded', 'failed', 'cancelled'):
                self.batch['observed_' + batch_label] += 1
                # Degraded union never double-counts partial calls already marked failed.
                if batch_label == 'partial' and outcome != 'failure':
                    self.batch['partial_without_call_failure'] += 1
            if batch is None:
                self.batch['without_validated_completed_batch'] += 1
            else:
                self.batch['validated_calls'] += 1
                self.batch['operations_requested'] += batch.requested
                self.batch['operations_completed'] += batch.completed
                self.batch['operations_succeeded'] += batch.succeeded
                for code in batch.codes:
                    self.operation_codes[code] += 1
                    self.operation_buckets[FS_CODE_BUCKET[code]] += 1

    def summary(self, minimum: int) -> dict:
        failed = self.outcomes['failure']
        assert sum(self.buckets.values()) == failed
        assert sum(self.outcomes.values()) == self.calls
        assert sum(self.operation_codes.values()) == self.batch['operations_completed'] - self.batch['operations_succeeded']
        # This is a cell-volume floor, not differential privacy or per-count k-anonymity.
        reasons = [{'bucket': b, 'reason': r, 'count': n}
                   for (b, r), n in sorted(self.reasons.items()) if n >= minimum]
        return {'calls': self.calls, 'success': self.outcomes['success'], 'failure': failed,
                'unknown_outcome': self.outcomes['unknown'], 'failure_pct_all_calls': pct(failed, self.calls),
                'failure_pct_known_outcomes': pct(failed, self.calls - self.outcomes['unknown']),
                'failure_buckets': {b: self.buckets[b] for b in BUCKETS},
                'bucket_pct_all_calls': {b: pct(self.buckets[b], self.calls) for b in BUCKETS},
                'single_class_coverage_pct_failures': pct(failed - self.buckets['unknown'] - self.buckets['mixed'], failed),
                'reasons': reasons,
                'suppressed_reason_observations': sum(n for n in self.reasons.values() if n < minimum),
                'degraded_calls': failed + self.batch['partial_without_call_failure'],
                'batch': dict(sorted(self.batch.items())),
                'operation_error_buckets': dict(sorted(self.operation_buckets.items())),
                'operation_error_codes': dict(sorted(self.operation_codes.items())),
                'operation_failure_pct_completed': pct(sum(self.operation_codes.values()), self.batch['operations_completed'])}


def run_window(root: Path, start: str, end: str, versions: set[str], *, following: bool, include_clients: bool = False) -> tuple[dict, dict]:
    days = selected_dates([], start, end)
    if not days or len(days) > 31:
        raise ValueError('window must span 1-31 dates')
    sources, _ = select_sources(root, 'shards', days, None)
    next_day = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    included_following = following and (root / 'queries' / next_day).exists()
    if included_following:
        extra, _ = select_sources(root, 'shards', [next_day], None)
        sources += extra
    if len(sources) > 2048:
        raise ValueError('too many shards')
    groups = defaultdict(Metric)
    counts = Counter()
    files = []
    folder_counts = Counter()
    for source in sources:
        lines = 0
        def consume(raw):
            nonlocal lines
            if raw is not None and not raw.strip():
                return
            lines += 1
            if raw is None:
                counts['oversized_record'] += 1
                return
            try:
                row = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                counts['invalid_json'] += 1
                return
            if not isinstance(row, dict):
                counts['non_object'] += 1
                return
            day = event_date(row.get('time'))
            if day is None:
                counts['invalid_date'] += 1
                return
            if not start <= day <= end:
                counts['outside_dates'] += 1
                return
            counts['in_window_rows'] += 1
            # Never fall back to client version or arbitrary source labels.
            value = row.get('serverVersion')
            version = value if isinstance(value, str) and VERSION.fullmatch(value) else 'unknown'
            if versions and version not in versions:
                counts['version_filtered'] += 1
                return
            tool = row.get('methodName')
            if not isinstance(tool, str) or tool not in TOOL_OPERATIONS:
                counts['unregistered_method_observations'] += 1
                return
            counts['registered_tool_calls'] += 1
            op = operation(tool, row)
            outcome = 'success' if row.get('success') is True else 'failure' if row.get('success') is False else 'unknown'
            failure = classify(tool, row) if outcome == 'failure' else None
            batch = batch_evidence(row) if tool == 'hf_fs' else None
            keys = [('tool', tool), ('day', tool, day), ('version', tool, version),
                    ('day_version', tool, day, version), ('day_operation', tool, day, op),
                    ('operation', tool, op), ('version_operation', tool, version, op)]
            if include_clients:
                family, client_version = client_cohort(row)
                counts['recognized_client_family_calls' if family != 'Other' else 'other_client_calls'] += 1
                if client_version != 'unreported':
                    counts['numeric_client_version_calls'] += 1
                keys += [('client', tool, family, client_version),
                         ('day_client', tool, day, family, client_version),
                         ('client_operation', tool, op, family, client_version)]
            for key in keys:
                groups[key].add(outcome, failure, batch, row.get('hfFsBatchOutcome'), tool == 'hf_fs')
            if tool == 'hf_fs':
                fs_items = fs_operation_outcomes(row)
                counts['fs_shape_aligned_operations'] += len(fs_items)
                touched = set()
                for command, resource, op_outcome, op_failure in fs_items:
                    fs_keys = [('fs_operation', tool, command, resource),
                               ('fs_command', tool, command),
                               ('fs_day_command', tool, day, command)]
                    if include_clients:
                        fs_keys.append(('fs_client_command', tool, command, family, client_version))
                    for key in fs_keys:
                        groups[key].add(op_outcome, op_failure, None, None, False)
                        touched.add(key)
                for key in touched:
                    groups[key].batch['contributing_batches'] += 1
        stored_hash, _ = consume_source(source, consume)
        files.append({'sha256': stored_hash, 'records': lines, 'folder_date': source.shard_date})
        folder_counts[source.shard_date] += 1
    if not counts['registered_tool_calls']:
        raise ValueError('no registered tool calls in selected window')
    return groups, {'inclusive_event_dates': [start, end], 'counts': dict(counts),
                    'following_day_included': bool(included_following),
                    'source_nonempty_records': sum(f['records'] for f in files),
                    'source_files': len(files), 'folder_file_counts': dict(sorted(folder_counts.items())),
                    'source_content_multiset_sha256': hashlib.sha256('\n'.join(sorted(f['sha256'] for f in files)).encode()).hexdigest(),
                    'folder_content_multisets': {d: hashlib.sha256('\n'.join(sorted(f['sha256'] for f in files if f['folder_date'] == d)).encode()).hexdigest() for d in sorted(folder_counts)},
                    'completeness': 'unknown; late flush beyond following day not covered',
                    'deduplication': 'none; repeated rows/calls remain observations'}


def ranking(groups: dict, minimum: int) -> list[dict]:
    eligible = [(key[1], metric.calls) for key, metric in groups.items() if key[0] == 'tool']
    total = sum(n for _, n in eligible)
    return [{'tool': tool, 'calls': n, 'share_registered_calls_pct': pct(n, total)}
            for tool, n in sorted(eligible, key=lambda item: (-item[1], item[0])) if n >= minimum]


def assemble(windows: dict, top: int, tools: list[str], minimum: int, client_minimum: int = 20) -> dict:
    rankings = {name: ranking(groups, minimum) for name, groups in windows.items()}
    selected = set(tools)
    for ranks in rankings.values():
        selected.update(r['tool'] for r in ranks[:top])
    rows = []
    for name, groups in windows.items():
        for key, metric in sorted(groups.items()):
            cell_minimum = max(minimum, client_minimum) if 'client' in key[0] else minimum
            population = metric.batch['contributing_batches'] if key[0] == 'fs_client_command' else metric.calls
            if key[1] in selected and population >= cell_minimum:
                rows.append({'window': name, 'dimension': key[0], 'tool': key[1],
                             'labels': list(key[2:]), 'unit': 'operations' if key[0].startswith('fs_') else 'calls', **metric.summary(cell_minimum)})
    comparisons = []
    if 'baseline' in windows:
        for tool in sorted(selected):
            current = windows['current'].get(('tool', tool))
            baseline = windows['baseline'].get(('tool', tool))
            if not current or not baseline or min(current.calls, baseline.calls) < minimum:
                comparisons.append({'tool': tool, 'status': 'insufficient_or_absent_population'})
                continue
            c, b = current.summary(minimum), baseline.summary(minimum)
            comparisons.append({'tool': tool, 'status': 'descriptive_only',
                'failure_delta_pp': round(100 * (c['failure']/c['calls'] - b['failure']/b['calls']), 4),
                'bucket_delta_pp': {bucket: round(100 * (c['failure_buckets'][bucket]/c['calls'] - b['failure_buckets'][bucket]/b['calls']), 4) for bucket in BUCKETS}})
    return {'schema': REPORT_SCHEMA, 'policy': POLICY_VERSION, 'selected_tools': sorted(selected),
            'ranking': rankings, 'rows': rows, 'comparison': comparisons}


def render(report: dict, manifests: dict) -> str:
    lines = ['# Tool error report', '', f'Policy: `{POLICY_VERSION}`. Private aggregate review material.', '',
             'Rates use all observed calls. Billing/infrastructure/tool-quality counts are mutually exclusive failed-call classes.',
             'Tool quality = contract/recovery friction candidate, not a proven defect. Access/target and unresolved failures remain separate.',
             'Successful tool calls do not establish readiness, successful process exit, or task completion.',
             'No deduplication or user/session linkage. Completeness unknown; comparisons are descriptive, not causal.', '']
    for name, manifest in manifests.items():
        lines += [f'## {name}: {manifest["inclusive_event_dates"][0]} through {manifest["inclusive_event_dates"][1]}', '',
                  f'Partial UTC date included: **{manifest["partial_day"]}**. Registered calls: {manifest["counts"]["registered_tool_calls"]:,}.', '',
                  '| Tool | Calls | Failure % | Billing | Infra | Tool quality | Access/target | Mixed | Unknown | Classified % of failures |',
                  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
        for row in sorted(report['rows'], key=lambda r: (-r['calls'], r['tool'])):
            if row['window'] == name and row['dimension'] == 'tool':
                values = ' | '.join(str(row['failure_buckets'][b]) for b in BUCKETS)
                coverage = row['single_class_coverage_pct_failures']
                lines.append(f'| {row["tool"]} | {row["calls"]} | {row["failure_pct_all_calls"]} | {values} | {coverage if coverage is not None else "N/A"} |')
        clients = [r for r in report['rows'] if r['window'] == name and r['dimension'] == 'client']
        if clients:
            totals = defaultdict(Counter)
            for r in clients:
                total = totals[tuple(r['labels'])]
                total.update({'calls': r['calls'], 'failure': r['failure']})
                total.update(r['failure_buckets'])
            ranked = sorted(totals, key=lambda k: (-totals[k]['calls'], k))
            selected = ranked[:20]
            selected += [k for k in ranked if k[0] in HF_CLIENT_FAMILIES and k not in selected]
            lines += ['', '### Client performance: top 20 + pinned Hugging Face clients', '',
                      'Ranked across selected tools, using visible client/tool cells only. HF clients are added beyond the top 20, without duplicates.',
                      'Cell floors still apply; absent/suppressed means insufficient evidence, not zero errors. Versions are self-reported.',
                      'All category columns are failed-call counts; failure rates use visible calls. Other remains an unidentified aggregate.', '',
                      '| Client / version | Calls | Failure % | Billing | Infra | Tool quality | Access/target | Mixed | Unknown |',
                      '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
            for key in selected:
                total = totals[key]
                values = ' | '.join(str(total[b]) for b in BUCKETS)
                lines.append(f'| {key[0]} / {key[1]} | {total["calls"]} | {100*total["failure"]/total["calls"]:.2f} | {values} |')
            for family in HF_CLIENT_FAMILIES:
                if not any(k[0] == family for k in totals):
                    lines.append(f'\n{family}: absent or below the client cell floor in this window.')
            lines += ['', '#### Hugging Face clients by tool', '',
                      '| Client / version | Tool | Calls | Failure % | Billing | Infra | Tool quality | Access/target | Mixed | Unknown |',
                      '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
            for r in sorted(clients, key=lambda r: (r['labels'], -r['calls'], r['tool'])):
                if r['labels'][0] in HF_CLIENT_FAMILIES:
                    values = ' | '.join(str(r['failure_buckets'][b]) for b in BUCKETS)
                    lines.append(f'| {" / ".join(r["labels"])} | {r["tool"]} | {r["calls"]} | {r["failure_pct_all_calls"]} | {values} |')
        lines += ['', '### Largest fixed reasons', '', '| Tool | Class | Reason | Failures |', '|---|---|---|---:|']
        reasons = [(r['tool'], reason) for r in report['rows'] if r['window'] == name and r['dimension'] == 'tool' for reason in r['reasons']]
        for tool, reason in sorted(reasons, key=lambda item: (-item[1]['count'], item[0], item[1]['reason']))[:20]:
            lines.append(f'| {tool} | {reason["bucket"]} | {reason["reason"]} | {reason["count"]} |')
        lines += ['', '### Operation hotspots', '', '| Tool / operation | Failures / calls | Failure % |', '|---|---:|---:|']
        ops = [r for r in report['rows'] if r['window'] == name and r['dimension'] == 'operation' and r['failure']]
        for row in sorted(ops, key=lambda r: (-r['failure'], r['tool'], r['labels']))[:20]:
            lines.append(f'| {row["tool"]} / {row["labels"][0]} | {row["failure"]} / {row["calls"]} | {row["failure_pct_all_calls"]} |')
        for row in report['rows']:
            if row['window'] == name and row['dimension'] == 'tool' and row['tool'] == 'hf_fs':
                lines += ['', f'hf_fs degraded calls (failure or partial): **{row["degraded_calls"]}/{row["calls"]}**.',
                          f'Validated completed-operation failure rate: **{row["operation_failure_pct_completed"]}%**.',
                          f'Batch counters: `{json.dumps(row["batch"], sort_keys=True)}`.',
                          f'Operation error classes: `{json.dumps(row["operation_error_buckets"], sort_keys=True)}`.']
        lines += ['']
    if report['comparison']:
        lines += ['## Current minus baseline', '', '| Tool | Failure delta (pp) | Billing delta | Infra delta | Tool-quality delta |', '|---|---:|---:|---:|---:|']
        for row in report['comparison']:
            if row['status'] == 'descriptive_only':
                d = row['bucket_delta_pp']
                lines.append(f'| {row["tool"]} | {row["failure_delta_pp"]} | {d["billing"]} | {d["infrastructure"]} | {d["tool_quality"]} |')
            else:
                lines.append(f'| {row["tool"]} | Insufficient/absent population | — | — | — |')
    lines += ['', 'See report.json for popularity, daily/version/operation splits, reasons and unknown-outcome denominators.',
              'Top tools are the union of each window’s top N plus explicit --tool selections. Ranking is within the fixed public registry only.',
              'Unregistered methods are counted, never named. Do not publish these files without review.', '']
    return '\n'.join(lines)


def csv_text(report: dict) -> str:
    output = io.StringIO()
    fields = ['window', 'dimension', 'tool', 'labels', 'unit', 'calls', 'failure', 'unknown_outcome', 'failure_pct_all_calls', *BUCKETS]
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in report['rows']:
        record = {key: row[key] for key in fields if key in row}
        record['labels'] = '/'.join(row['labels'])
        record.update(row['failure_buckets'])
        writer.writerow(record)
    return output.getvalue()


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--log-root', type=Path, default=os.environ.get('HF_MCP_LOG_ROOT'))
    p.add_argument('--server-repo', type=Path, default=os.environ.get('HF_MCP_SERVER_REPO'))
    p.add_argument('--from-date', required=True)
    p.add_argument('--to-date', required=True)
    p.add_argument('--baseline-from')
    p.add_argument('--baseline-to')
    p.add_argument('--server-version', action='append', default=[])
    p.add_argument('--baseline-server-version', action='append', default=None,
                   help='Baseline filter; defaults to the current window version filter')
    p.add_argument('--tool', choices=sorted(TOOL_OPERATIONS), action='append', default=[])
    p.add_argument('--top', type=int, default=10)
    p.add_argument('--min-cell-count', type=int, default=5)
    p.add_argument('--include-clients', action='store_true')
    p.add_argument('--client-min-cell-count', type=int, default=20)
    p.add_argument('--allow-partial-day', action='store_true')
    p.add_argument('--no-following-day', action='store_true')
    p.add_argument('--output', required=True, type=Path)
    return p


def run(args: argparse.Namespace) -> dict:
    if not args.log_root or not args.server_repo:
        raise ValueError('log root and server repo required')
    if not 0 <= args.top <= len(TOOL_OPERATIONS) or args.min_cell_count < 5 or args.client_min_cell_count < 20:
        raise ValueError('invalid reporting limits')
    if args.top == 0 and not args.tool:
        raise ValueError('select tools or top N')
    baseline_versions = args.server_version if args.baseline_server_version is None else args.baseline_server_version
    if any(not VERSION.fullmatch(v) for v in [*args.server_version, *baseline_versions]):
        raise ValueError('invalid version filter')
    if args.baseline_server_version is not None and not args.baseline_from:
        raise ValueError('baseline version requires baseline dates')
    if bool(args.baseline_from) != bool(args.baseline_to):
        raise ValueError('both baseline dates required')
    windows = {'current': (args.from_date, args.to_date)}
    if args.baseline_from:
        windows['baseline'] = (args.baseline_from, args.baseline_to)
    today = datetime.now(timezone.utc).date().isoformat()
    for start, end in windows.values():
        days = selected_dates([], start, end)
        if not days or len(days) > 31 or end > today or (end == today and not args.allow_partial_day):
            raise ValueError('invalid or partial window')
    if args.baseline_to and args.baseline_to >= args.from_date:
        raise ValueError('baseline must precede current window')
    code_paths = {'policy_sha256': Path(__file__).with_name('tool_error_policy.py'),
                  'reporter_sha256': Path(__file__),
                  'reader_sha256': Path(__file__).with_name('data_fill.py'),
                  'cohorts_sha256': Path(__file__).with_name('tool_error_cohorts.py')}
    code_hashes = {key: digest(path) for key, path in code_paths.items()}
    root = check_source_root(args.log_root)
    target = Path(os.path.abspath(args.output.expanduser()))
    if root == target or root in target.parents or target in root.parents:
        raise ValueError('source and output overlap')
    server = server_provenance(args.server_repo)
    # Refuse existing output; owner-only ignored study directory. No overwrite switch.
    output = checked_output(args.output, overwrite=False)
    groups, manifests = {}, {}
    for name, (start, end) in windows.items():
        version_filter = set(baseline_versions if name == 'baseline' else args.server_version)
        groups[name], manifests[name] = run_window(root, start, end, version_filter, following=not args.no_following_day, include_clients=args.include_clients)
        manifests[name]['server_version_filter'] = sorted(version_filter)
        manifests[name]['partial_day'] = end == today
    report = assemble(groups, args.top, args.tool, args.min_cell_count, args.client_min_cell_count)
    if not report['rows']:
        raise ValueError('no reportable cells')
    if code_hashes != {key: digest(path) for key, path in code_paths.items()}:
        raise ValueError('reporting code changed during extraction')
    command = ['python3', 'monitor/telemetry/run.py',
               '--input-root', '$INPUT_ROOT', '--server-repo', '$HF_MCP_SERVER_REPO',
               '--from-date', args.from_date, '--to-date', args.to_date,
               '--top', str(args.top), '--min-cell-count', str(args.min_cell_count),
               '--output-root', '$OUTPUT_ROOT', '--run-name', 'NEW-RUN-NAME']
    if args.baseline_from:
        command += ['--baseline-from', args.baseline_from, '--baseline-to', args.baseline_to]
    for flag, values in (('--server-version', args.server_version),
                         ('--baseline-server-version', args.baseline_server_version or []), ('--tool', args.tool)):
        for value in values:
            command += [flag, value]
    if args.include_clients:
        command += ['--include-clients', '--client-min-cell-count', str(args.client_min_cell_count)]
    if args.allow_partial_day:
        command += ['--allow-partial-day']
    if args.no_following_day:
        command += ['--no-following-day']
    manifest = {'schema': REPORT_SCHEMA, 'policy': POLICY_VERSION, 'run_date': today,
                'reproduction_argv_with_environment_placeholders': command,
                'registry': TOOL_OPERATIONS, 'buckets': BUCKETS, 'windows': manifests,
                'client_policy': CLIENT_POLICY_VERSION, 'client_min_cell_count': args.client_min_cell_count,
                'include_clients': args.include_clients,
                'options': {'server_versions': sorted(set(args.server_version)),
                            'baseline_server_versions': sorted(set(baseline_versions)), 'top': args.top,
                            'tools': sorted(set(args.tool)), 'min_cell_count': args.min_cell_count,
                            'following_day': not args.no_following_day, 'allow_partial_day': args.allow_partial_day},
                **code_hashes,
                'server': server, 'seed': None, 'model': None, 'generated_card': None,
                'review_status': 'private_aggregate_unreviewed',
                'suppression': 'cell-volume floor, NOT per-count k-anonymity; small counts can be inferred',
                'source_digest_definition': 'sorted stored-byte SHA256 strings, newline joined without final newline; content not filenames/order'}
    write_private(output / 'report.json', report)
    write_private(output / 'report.csv', csv_text(report))
    write_private(output / 'report.md', render(report, manifests))
    manifest['outputs_sha256'] = {name: digest(output / name) for name in ('report.json', 'report.csv', 'report.md')}
    # Manifest written last marks a complete run.
    write_private(output / 'manifest.json', manifest)
    return {'policy': POLICY_VERSION, 'selected_tools': report['selected_tools'], 'report_cells': len(report['rows'])}


def main() -> int:
    args = parser().parse_args()
    try:
        result = run(args)
    except Exception:
        print('Tool report failed. Check dates, paths, permissions and existing output; no source details emitted.')
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
