"""Independent synthetic fixtures only; no operational rows or identifiers."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tool_error_policy import (BUCKETS, TOOL_OPERATIONS, batch_evidence, classify, operation)
from tool_error_report import Metric, assemble, parser, run, run_window


def row(tool='hf_jobs', success=False, error='API request failed: 402 Payment Required', **extra):
    return {'methodName': tool, 'success': success, 'errorMessage': error,
            'time': '2026-08-01T12:00:00Z', 'serverVersion': '0.4.15',
            'query': 'run', 'parameters': '{}', **extra}


def batch(codes, succeeded=0, **extra):
    n = len(codes) + succeeded
    return row('hf_fs', success=succeeded > 0, error=None,
        hfFsReportingSchema='hf_fs_batch_v1', hfFsOperationsRequested=n,
        hfFsOperationsCompleted=n, hfFsOperationsSucceeded=succeeded,
        hfFsBatchOutcome='complete' if not codes else 'none_succeeded' if not succeeded else 'partial',
        hfFsOperationErrorsJson=json.dumps([{'index': i, 'code': code} for i, code in enumerate(codes)]), **extra)


class PolicyTests(unittest.TestCase):
    def test_all_tools_have_adapters(self):
        for tool in TOOL_OPERATIONS:
            self.assertIn(operation(tool, row()), (*TOOL_OPERATIONS[tool], 'unknown'))
            self.assertEqual(classify(tool, row()).bucket, 'billing')

    def test_provider_categories(self):
        expected = {400:'unknown', 401:'access_or_target', 402:'billing', 403:'access_or_target',
                    404:'access_or_target', 409:'unknown', 422:'unknown', 429:'infrastructure',
                    500:'infrastructure', 502:'infrastructure', 503:'infrastructure', 504:'infrastructure'}
        for status, bucket in expected.items():
            self.assertEqual(classify('hf_jobs', row(error=f'Error executing run: API request failed: {status} Test')).bucket, bucket)
        self.assertEqual(classify('hf_sandbox_exec', row(error='HfApiError: Sandbox RPC /v1/exec failed with 503: {}')).bucket, 'infrastructure')

    def test_no_bare_number_or_keyword_classification(self):
        for text in ('identifier 402', 'timed out somewhere', 'Required payment 402', 'API request failed: 4020',
                     'user command says API request failed: 503', 'private value 401 and quota'):
            self.assertEqual(classify('hf_jobs', row(error=text)).bucket, 'unknown')
        result = classify('hf_jobs', row(error='Error executing run: Unsupported shell syntax in command: "echo API request failed: 402 | timeout"'))
        self.assertEqual((result.bucket, result.reason), ('tool_quality', 'unsupported_shell_syntax'))

    def test_contract_errors(self):
        fixtures = [('hf_jobs', "Error: Invalid parameters for 'run'", 'argument_validation'),
                    ('hf_jobs', 'Invalid timeout format: synthetic', 'invalid_timeout_format'),
                    ('hf_sandbox', 'job id in handle contains unsupported characters.', 'handle_characters'),
                    ('hf_sandbox_exec', 'foreground exec timeout must be <= 55 seconds.', 'foreground_timeout_limit'),
                    ('hf_sandbox_fs', 'EINVAL: PATH must be absolute', 'argument_validation'),
                    ('hf_fs_write', 'EINVAL: missing URI', 'argument_validation'),
                    ('dynamic_space', 'Unknown operation: synthetic', 'unknown_operation')]
        for tool, text, reason in fixtures:
            self.assertEqual(classify(tool, row(error=text)).reason, reason)
            self.assertEqual(classify(tool, row(error=text)).bucket, 'tool_quality')

    def test_success_and_unknown_not_failures(self):
        for value in (True, None, 'false', 0):
            with self.assertRaises(ValueError):
                classify('hf_jobs', row(success=value))
        self.assertEqual(classify('hf_jobs', row(error=None)).bucket, 'unknown')

    def test_operation_adapters(self):
        self.assertEqual(operation('hf_jobs', row(query='uv', parameters='{"cmd":"run"}')), 'uv')
        self.assertEqual(operation('hf_sandbox', row(parameters='{"cmd":"create","args":"<redacted>"}')), 'create')
        self.assertEqual(operation('hf_fs', batch(['HF_FS_NOT_FOUND'])), 'batch')
        self.assertEqual(operation('hf_jobs', row(query='SYNTHETIC_PRIVATE')), 'unknown')
        self.assertEqual(operation('dynamic_space', row(parameters='{"operation":"invoke"}')), 'invoke')

    def test_batch_validity_and_partition(self):
        single = batch(['HF_FS_INVALID_ARGUMENT'])
        self.assertEqual(classify('hf_fs', single).bucket, 'tool_quality')
        mixed = batch(['HF_FS_INVALID_ARGUMENT', 'HF_FS_NOT_FOUND'])
        self.assertEqual(classify('hf_fs', mixed).bucket, 'mixed')
        for field, value in [('hfFsOperationsCompleted', 99), ('hfFsOperationsSucceeded', True),
                             ('hfFsBatchOutcome', 'failed'), ('hfFsOperationErrorsJson', 'invalid')]:
            bad = dict(single, **{field:value})
            self.assertIsNone(batch_evidence(bad))
        self.assertIsNone(batch_evidence(batch(['SECRET_CODE'])))
        duplicate = dict(mixed, hfFsOperationErrorsJson=json.dumps([{'index':0,'code':'HF_FS_NOT_FOUND'}]*2))
        self.assertIsNone(batch_evidence(duplicate))

    def test_partial_metrics_separate_from_failed_calls(self):
        m = Metric()
        item = batch(['HF_FS_NOT_FOUND'], succeeded=1)
        m.add('success', None, batch_evidence(item), 'partial', True)
        m.add('unknown', None, None, None, False)
        m.add('failure', classify('hf_jobs', row()), None, None, False)
        result = m.summary(5)
        self.assertEqual(result['failure'], 1)
        self.assertEqual(result['degraded_calls'], 2)
        self.assertEqual(result['unknown_outcome'], 1)
        self.assertEqual(result['operation_failure_pct_completed'], 50)
        self.assertEqual(sum(result['failure_buckets'].values()), result['failure'])
        self.assertEqual(result['single_class_coverage_pct_failures'], 100)
        self.assertEqual(result['failure_pct_known_outcomes'], 50)


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.logs = self.root / 'mirror'
        self.logs.mkdir()
        self.local = self.root / 'local'
        self.local.mkdir(mode=0o700)
    def tearDown(self):
        self.temp.cleanup()
    def shard(self, day, rows, filename='synthetic.jsonl'):
        folder = self.logs / 'queries' / day
        folder.mkdir(parents=True, exist_ok=True)
        text = ''.join(json.dumps(r)+'\n' for r in rows).encode()
        path = folder / filename
        if filename.endswith('.gz'):
            with gzip.open(path, 'wb') as f:
                f.write(text)
        else:
            path.write_bytes(text)
        return path

    def test_bounded_stream_and_following_day(self):
        source = self.shard('2026-08-01', [row()]*5)
        with source.open('ab') as f:
            f.write(b'x'*(1024*1024+1)+b'\n{bad json\n[]\n')
        self.shard('2026-08-02', [row(), row(time='2026-08-02T12:00:00Z')], 'synthetic.jsonl.gz')
        groups, manifest = run_window(self.logs, '2026-08-01', '2026-08-01', set(), following=True)
        self.assertEqual(groups[('tool','hf_jobs')].calls, 6)
        self.assertEqual(manifest['counts']['oversized_record'], 1)
        self.assertEqual(manifest['counts']['invalid_json'], 1)
        self.assertEqual(manifest['counts']['non_object'], 1)
        self.assertEqual(manifest['counts']['outside_dates'], 1)
        self.assertTrue(manifest['following_day_included'])
        self.assertEqual(manifest['source_files'], 2)
        self.assertNotIn('synthetic.jsonl', json.dumps(manifest))

    def test_symlink_and_missing_day_rejected(self):
        source = self.shard('2026-08-01', [row()])
        source.rename(source.with_suffix('.txt'))
        source.symlink_to(source.with_suffix('.txt'))
        with self.assertRaises(Exception):
            run_window(self.logs, '2026-08-01', '2026-08-01', set(), following=False)
        with self.assertRaises(Exception):
            run_window(self.logs, '2026-08-03', '2026-08-03', set(), following=False)

    def test_popularity_union_and_suppression(self):
        windows = {'current': defaultdict(Metric), 'baseline': defaultdict(Metric)}
        for _ in range(10): windows['current'][('tool','hf_fs')].add('success',None,None,None,False)
        for _ in range(12): windows['baseline'][('tool','hf_jobs')].add('success',None,None,None,False)
        for _ in range(4): windows['current'][('tool','hf_jobs')].add('success',None,None,None,False)
        report = assemble(windows, 1, ['hf_sandbox'], 5)
        self.assertEqual(report['selected_tools'], ['hf_fs','hf_jobs','hf_sandbox'])
        self.assertEqual(len(report['rows']), 2)
        self.assertTrue(all(x['status']=='insufficient_or_absent_population' for x in report['comparison']))

    def test_end_to_end_privacy_determinism_and_no_overwrite(self):
        secret = 'SYNTHETIC_PRIVATE_DO_NOT_OUTPUT'
        rows = [row(error=f'Unsupported shell syntax in command: {secret}', userHash=secret,
                    mcpServerSessionId=secret, parameters=json.dumps({'command':secret}))]*6
        rows += [row(tool=secret), row(serverVersion=secret, version='9.9.9', error=secret)]
        self.shard('2026-08-01', rows)
        output = self.local / 'studies' / 'run-a'
        args = parser().parse_args(['--from-date','2026-08-01','--to-date','2026-08-01',
                                   '--output',str(output), '--log-root',str(self.logs),
                                   '--server-repo',str(self.root)])
        with patch('study_common.ALLOWED_LOCAL_ROOT', self.local), patch('tool_error_report.server_provenance', return_value={'head':'synthetic'}):
            run(args)
            with self.assertRaises(Exception): run(args)
            first = {p.name:p.read_bytes() for p in output.iterdir()}
            args.output = output.with_name('run-b')
            run(args)
            second = {p.name:p.read_bytes() for p in args.output.iterdir()}
        self.assertEqual(first, second)
        for name, content in first.items():
            self.assertNotIn(secret.encode(), content)
            self.assertNotIn(b'mcpServerSessionId', content)
            self.assertEqual((output/name).stat().st_mode & 0o777, 0o600)
        manifest = json.loads(first['manifest.json'])
        self.assertEqual(manifest['windows']['current']['counts']['unregistered_method_observations'], 1)
        for name, h in manifest['outputs_sha256'].items():
            self.assertEqual(h, hashlib.sha256(first[name]).hexdigest())
        report = json.loads(first['report.json'])
        # No fallback from missing/invalid server version to client version.
        self.assertNotIn('9.9.9', json.dumps(report))

    def test_filters_and_unknown_outcomes(self):
        self.shard('2026-08-01', [row()]*5+[row(serverVersion='0.4.16',success=None)])
        groups, manifest = run_window(self.logs, '2026-08-01', '2026-08-01', {'0.4.16'}, following=False)
        self.assertEqual(groups[('tool','hf_jobs')].outcomes['unknown'], 1)
        self.assertEqual(manifest['counts']['version_filtered'], 5)

    def test_independent_deployment_filters_and_deltas(self):
        self.shard('2026-08-01', [row(serverVersion='0.4.15')]*5)
        self.shard('2026-08-02', [row(serverVersion='0.4.16', success=True,
                                     time='2026-08-02T12:00:00Z')]*5)
        output = self.local/'studies'/'comparison'
        args = parser().parse_args(['--from-date','2026-08-02','--to-date','2026-08-02',
            '--baseline-from','2026-08-01','--baseline-to','2026-08-01',
            '--server-version','0.4.16','--baseline-server-version','0.4.15',
            '--log-root',str(self.logs),'--server-repo',str(self.root),'--output',str(output)])
        with patch('study_common.ALLOWED_LOCAL_ROOT',self.local), patch('tool_error_report.server_provenance',return_value={}):
            run(args)
        report = json.loads((output/'report.json').read_text())
        self.assertEqual(report['comparison'][0]['failure_delta_pp'], -100)
        self.assertEqual(report['comparison'][0]['bucket_delta_pp']['billing'], -100)
        manifest = json.loads((output/'manifest.json').read_text())
        self.assertEqual(manifest['windows']['baseline']['server_version_filter'], ['0.4.15'])
        self.assertEqual(manifest['windows']['current']['server_version_filter'], ['0.4.16'])

    def test_utc_event_date_not_filename_date(self):
        self.shard('2026-08-01', [row(time='2026-08-02T00:30:00+01:00')]*5)
        groups, _ = run_window(self.logs,'2026-08-01','2026-08-01',set(),following=False)
        self.assertEqual(groups[('day','hf_jobs','2026-08-01')].calls, 5)

    def test_invalid_cli_windows_and_output(self):
        today = datetime.now(timezone.utc).date().isoformat()
        for flags in (['--min-cell-count','1'], ['--top','0'], ['--baseline-from','2026-07-01'],
                      ['--baseline-from','2026-08-01','--baseline-to','2026-08-03'],
                      ['--server-version','private'], ['--from-date',today,'--to-date',today]):
            args = parser().parse_args(['--from-date','2026-08-01','--to-date','2026-08-01',
                 '--output',str(self.local/'studies'/'bad'), '--log-root',str(self.logs),
                 '--server-repo',str(self.root), *flags])
            with self.assertRaises(Exception): run(args)
        self.shard('2026-08-01', [row()]*5)
        args = parser().parse_args(['--from-date','2026-08-01','--to-date','2026-08-01',
                 '--output',str(self.root/'not-local'), '--log-root',str(self.logs), '--server-repo',str(self.root)])
        with patch('study_common.ALLOWED_LOCAL_ROOT', self.local), patch('tool_error_report.server_provenance',return_value={}):
            with self.assertRaises(Exception): run(args)


if __name__ == '__main__':
    unittest.main()
