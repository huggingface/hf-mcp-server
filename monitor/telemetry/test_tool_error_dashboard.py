"""Synthetic-only cohort and offline visualization regression tests."""
from collections import defaultdict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_tool_error_report import row, batch
from tool_error_cohorts import client_cohort, fs_operation_outcomes
from tool_error_dashboard import compact, render_html, releases, run
from tool_error_report import Metric, assemble, run_window


class CohortTests(unittest.TestCase):
    def test_fs_client_floor_counts_batches_not_operations(self):
        fixtures = [batch(['HF_FS_INVALID_ARGUMENT'], succeeded=1,
                         name='chat-ui-mcp', version='0.1.0',
                         parameters={'operations':[{'cmd':'cat','args':['hf://models/synthetic/a']},
                                                   {'cmd':'cat','args':['hf://models/synthetic/b']}]})]*19
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); day=root/'queries'/'2026-08-01'; day.mkdir(parents=True)
            source=day/'synthetic.jsonl'
            for count in (19,20):
                source.write_text(''.join(json.dumps(fixtures[0])+'\n' for _ in range(count)))
                groups,_=run_window(root,'2026-08-01','2026-08-01',set(),following=False,include_clients=True)
                report=assemble({'current':groups},10,[],5)
                cells=[r for r in report['rows'] if r['dimension']=='fs_client_command']
                self.assertEqual(len(cells),int(count==20))
                if cells:
                    self.assertEqual(cells[0]['calls'],40)
                    self.assertEqual(cells[0]['failure'],20)
                    self.assertEqual(cells[0]['batch']['contributing_batches'],20)
                    self.assertEqual(cells[0]['unit'],'operations')

    def test_hf_clients_explicit_and_wrapped(self):
        for name in ('chat-ui-intern', 'chat-ui-mcp'):
            for suffix in ('', ' (via mcp-remote 0.1.0)'):
                self.assertEqual(client_cohort({'name': name+suffix, 'version': '0.1.0'}),
                                 (name, '0.1.0'))
        self.assertEqual(client_cohort({'name': 'chat-ui-private', 'version': '0.1.0'}),
                         ('Other', 'unreported'))

    def test_markdown_pins_hf_beyond_top_twenty(self):
        from tool_error_report import render
        groups = defaultdict(Metric)
        for i in range(20):
            for _ in range(40):
                groups[('client', 'hf_jobs', 'Claude Code', f'1.0.{i}')].add('success',None,None,None,False)
        for family in ('chat-ui-intern', 'chat-ui-mcp'):
            for _ in range(20):
                groups[('client', 'hf_jobs', family, '0.1.0')].add('success',None,None,None,False)
        report = assemble({'current': groups}, 0, ['hf_jobs'], 5)
        text = render(report, {'current': {'inclusive_event_dates':['2026-08-01','2026-08-01'],
                      'partial_day':False, 'counts':{'registered_tool_calls':840}}})
        for family in ('chat-ui-intern', 'chat-ui-mcp'):
            self.assertIn(f'| {family} / 0.1.0 | 20 | 0.00 |', text)
            self.assertIn(f'| {family} / 0.1.0 | hf_jobs | 20 |', text)
        self.assertIn('Billing | Infra | Tool quality', text)

    def test_public_families_wrappers_and_versions(self):
        for name, family in [('claude-code', 'Claude Code'), ('openai-mcp (synthetic context)', 'OpenAI MCP'),
                             ('Cursor (via mcp-remote 0.1.0)', 'Cursor')]:
            self.assertEqual(client_cohort({'name': name, 'version': 'v2.1.251', 'serverVersion': '0.4.15'}), (family, '2.1.251'))
        for version in ['2.1.251-private', 'private', 123, None]:
            self.assertEqual(client_cohort({'name': 'claude-code', 'version': version})[1], 'unreported')
        self.assertEqual(client_cohort({'name': 'SYNTHETIC_PRIVATE', 'version': '1.0.0'}), ('Other', 'unreported'))
        self.assertEqual(client_cohort({'name': 'claude-code', 'serverVersion': '0.4.15'}), ('Claude Code', 'unreported'))

    def test_fs_alignment_discards_arguments(self):
        r = batch(['HF_FS_INVALID_ARGUMENT'], succeeded=1, parameters={'operations':[
            {'cmd':'cat','args':['hf://spaces/synthetic/private']}, {'cmd':'ls','args':['hf://']}]})
        outcomes = fs_operation_outcomes(r)
        self.assertEqual(outcomes[0][:3], ('cat', 'spaces', 'failure'))
        self.assertEqual(outcomes[1], ('ls', 'root', 'success', None))
        self.assertNotIn('private', repr(outcomes))
        r['parameters']['operations'][0] = {'cmd': 'SYNTHETIC_PRIVATE', 'args':['private://target']}
        self.assertEqual(fs_operation_outcomes(r)[0][:2], ('unknown','other'))
        r['parameters']['operations'].pop()
        self.assertEqual(fs_operation_outcomes(r), [])
        r['hfFsOperationErrorsJson'] = '[{"index":99,"code":"HF_FS_INVALID_ARGUMENT"}]'
        self.assertEqual(fs_operation_outcomes(r), [])

    def test_client_floor_and_unchanged_core_totals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); day=root/'queries'/'2026-08-01'; day.mkdir(parents=True)
            fixtures=[row(name='claude-code', version='1.0.0')]*19+[row(name='Cursor', version='1.0.0')]*21
            (day/'synthetic.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in fixtures))
            plain,_=run_window(root,'2026-08-01','2026-08-01',set(),following=False)
            extended,_=run_window(root,'2026-08-01','2026-08-01',set(),following=False,include_clients=True)
            self.assertEqual(plain[('tool','hf_jobs')].summary(5),extended[('tool','hf_jobs')].summary(5))
            report=assemble({'current':extended},10,[],5)
            clients=[r for r in report['rows'] if r['dimension']=='client']
            self.assertEqual([(r['labels'],r['calls']) for r in clients], [(['Cursor','1.0.0'],21)])
            self.assertEqual(next(r['calls'] for r in report['rows'] if r['dimension']=='tool'),40)


class DashboardTests(unittest.TestCase):
    def fixture(self):
        groups=defaultdict(Metric)
        for _ in range(20): groups[('tool','hf_jobs')].add('success',None,None,None,False)
        report=assemble({'current':groups},10,[],5)
        manifest={'include_clients':True,'client_min_cell_count':20,'client_policy':'client-cohorts-v1',
                  'windows':{'current':{'inclusive_event_dates':['2026-08-01','2026-08-01'],'partial_day':False,'counts':{}}}}
        return report,manifest

    def test_compaction_reconciles_and_rejects_private_reasons(self):
        report,manifest=self.fixture()
        self.assertEqual(compact(report,manifest)['rows'][0]['n'],20)
        report['rows'][0]['reasons']=[{'bucket':'unknown','reason':'SYNTHETIC_PRIVATE','count':1}]
        with self.assertRaises(ValueError): compact(report,manifest)
        report['rows'][0]['reasons']=[]
        report['rows'][0]['failure_buckets']['billing']=1
        with self.assertRaises(ValueError): compact(report,manifest)

    def test_html_escape_and_template_contract(self):
        html=render_html({'x':'</script><img>&'},'<script>__REPORT_DATA__</script>')
        self.assertEqual(html.count('</script>'),1)
        self.assertNotIn('<img>',html)
        with self.assertRaises(ValueError): render_html({},'__REPORT_DATA____REPORT_DATA__')

    def test_release_dates_are_utc_commit_proxies(self):
        with patch('tool_error_dashboard.subprocess.check_output',side_effect=[
                'v0.4.15\nprivate-tag\n', 'a'*40+'\t2026-08-26T23:30:00-02:00\n']):
            result=releases(Path('.'),'2026-08-27','2026-08-27')
        self.assertEqual(result[0]['date'],'2026-08-27')
        self.assertEqual(result[0]['basis'],'release-tag commit date (UTC)')

    def test_hash_mismatch_and_path_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            local=Path(tmp); source=local/'studies'/'input'; source.mkdir(parents=True)
            (source/'report.json').write_text('{}')
            (source/'manifest.json').write_text(json.dumps({'outputs_sha256':{'report.json':'wrong'}}))
            with patch('tool_error_dashboard.ALLOWED_LOCAL_ROOT',local):
                with self.assertRaisesRegex(ValueError,'hash mismatch'): run(source,local,local/'studies'/'out')
                with self.assertRaises(ValueError): run(local/'outside',local,local/'studies'/'out')
            self.assertFalse((local/'studies'/'out').exists())


if __name__=='__main__': unittest.main()
