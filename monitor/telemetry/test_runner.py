"""Mounted temporary fixtures only; never use the operational mirror."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run as runner
from test_tool_error_report import row


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / 'PRIVATE_INPUT_SENTINEL'
        self.output = self.root / 'out'
        self.output.mkdir(mode=0o700)
        day = self.input / 'queries/2026-08-01'
        day.mkdir(parents=True)
        self.shard = day / 'PRIVATE_SHARD_SENTINEL.jsonl'
        self.shard.write_text(''.join(json.dumps(row(name='chat-ui-mcp', version='0.1.0',
            userHash='PRIVATE_ROW_SENTINEL'))+'\n' for _ in range(20)))
        self.shard.chmod(0o400)
        self.before = self.shard.read_bytes()
        # A sessions link must remain entirely untouched.
        (self.input / 'sessions').symlink_to(self.root / 'nonexistent')
        self.args = runner.parser().parse_args([
            '--input-root', str(self.input), '--output-root', str(self.output),
            '--server-repo', str(self.root), '--run-name', 'synthetic',
            '--from-date', '2026-08-01', '--to-date', '2026-08-01'])

    def execute(self):
        with patch('tool_error_report.server_provenance', return_value={'head': 'synthetic'}), \
             patch('tool_error_dashboard.releases', return_value=[]):
            return runner.run(self.args)

    def test_publication_privacy_and_readonly(self):
        target = self.execute()
        self.assertEqual(self.before, self.shard.read_bytes())
        self.assertEqual((target/'COMPLETE').read_text().strip(), runner.sha(target/'publication.json'))
        publication = json.loads((target/'publication.json').read_text())
        for name, digest in publication['outputs_sha256'].items():
            self.assertEqual(runner.sha(target/name), digest)
        for path in target.rglob('*'):
            if path.is_file():
                self.assertNotIn(b'PRIVATE_', path.read_bytes())
                self.assertEqual(path.stat().st_mode & 0o077, 0)
        visual = json.loads((target/'dashboard/visualization-manifest.json').read_text())
        self.assertEqual(visual['views'], ['pulse', 'cohorts', 'opportunities', 'filesystem'])
        with self.assertRaises(ValueError):
            self.execute()

    def test_overlap_links_permissions_and_traversal(self):
        for output in (self.input, self.input/'queries'):
            self.args.output_root = output
            with self.assertRaises(Exception): self.execute()
        link = self.root/'link'
        link.symlink_to(self.output)
        self.args.output_root = link
        with self.assertRaises(Exception): self.execute()
        self.args.output_root = self.output
        self.output.chmod(0o755)
        with self.assertRaises(Exception): self.execute()
        self.output.chmod(0o700)
        self.args.run_name = '../escape'
        with self.assertRaises(Exception): self.execute()

    def test_failure_never_completes(self):
        with patch('tool_error_dashboard.run', side_effect=ValueError('synthetic')):
            with self.assertRaises(Exception): self.execute()
        self.assertFalse(list(self.output.rglob('COMPLETE')))
        self.assertFalse((self.output/'synthetic').exists())

    def test_source_symlink_rejected(self):
        other = self.root/'other.jsonl'
        other.write_bytes(self.before)
        self.shard.unlink()
        self.shard.symlink_to(other)
        with self.assertRaises(Exception): self.execute()
        self.assertFalse(list(self.output.rglob('COMPLETE')))

    def test_tampered_dashboard_never_completes(self):
        original = runner.dashboard.run
        def tamper(*args):
            original(*args)
            (args[2]/'dashboard.html').write_text('tampered')
        with patch('tool_error_dashboard.run', side_effect=tamper):
            with self.assertRaises(Exception): self.execute()
        self.assertFalse(list(self.output.rglob('COMPLETE')))
