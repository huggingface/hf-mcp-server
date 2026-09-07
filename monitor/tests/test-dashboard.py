import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import urlopen

spec = importlib.util.spec_from_file_location("dashboard", Path(__file__).parents[1] / "dashboard/dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def report(self, number, spaces, complete=True, **extra):
        directory = self.root / f"{number:03}"
        directory.mkdir()
        data = dict(run_id=str(number), completed_at=f"2026-09-{number:02}T00:00:00Z", spaces=spaces)
        (directory / "report.json").write_text(json.dumps(data | extra))
        if complete:
            (directory / "COMPLETE").touch()
        return directory

    def test_partial_catalog_and_hold_history(self):
        self.report(1, [dict(space_id="a/one", status="UNHEALTHY", revision="sha-one", outcome="needs-human", reason="manual fix",
                             findings=[dict(severity="error", summary="broken import")],
                             pr_url="https://huggingface.co/spaces/a/one/discussions/1"),
                        dict(space_id="a/two", status="HEALTHY")])
        self.report(2, [dict(space_id="a/one", status="UNHEALTHY", revision="sha-one", outcome="held", detail="runtime-error")])
        page = dashboard.render(self.root)
        current, history = page.split('<h2>History</h2>')
        self.assertIn('a/two', current)
        self.assertIn('held', current)
        self.assertIn('manual fix', current)
        self.assertIn('Previous diagnosis (2026-09-01T00:00:00Z)', current)
        self.assertIn('error: broken import', current)
        self.assertNotIn("&#x27;summary&#x27;", current)
        self.assertIn('Outcome: needs-human', current)
        self.assertIn('runtime-error', current)
        self.assertIn('2026-09-02T00:00:00Z</td>', current)
        self.assertIn('href="https://huggingface.co/spaces/a/one/discussions/1"', current)
        self.assertIn('manual fix', history)
        self.assertIn('href="https://huggingface.co/spaces/a/one/discussions/1"', history)
        self.assertIn('2026-09-01', current)
        self.assertIn('not live probe', page)

    def test_history_limit_preserves_older_lookup(self):
        self.report(1, [dict(space_id="a/held", revision="same", outcome="needs-human",
                             reason="older diagnosis"),
                        dict(space_id="a/older", status="HEALTHY")])
        for number in range(2, 6):
            self.report(number, [dict(space_id="a/held", revision="same", outcome="held")])
        self.report(6, [], complete=False)
        current, history = dashboard.render(self.root).split('<h2>History</h2>')
        self.assertEqual(len(dashboard.load_reports(self.root)), 5)
        self.assertEqual(history.count('<details>'), 3)
        summaries = [f'2026-09-{number:02}T00:00:00Z — {number}</summary>' for number in (5, 4, 3)]
        self.assertTrue(all(summary in history for summary in summaries))
        self.assertLess(history.index(summaries[0]), history.index(summaries[1]))
        self.assertLess(history.index(summaries[1]), history.index(summaries[2]))
        self.assertNotIn('2026-09-02', history)
        self.assertNotIn('2026-09-06', history)
        self.assertNotIn('older diagnosis', history)
        self.assertNotIn('a/older', history)
        self.assertIn('a/older', current)
        self.assertIn('older diagnosis', current)
        self.assertIn('Previous diagnosis (2026-09-01T00:00:00Z)', current)
        self.assertIn('held', current)

    def test_previous_diagnosis_revision_and_space_scope(self):
        for revision, latest_revision in (("sha-one", "sha-one"), ("sha-two", "sha-one"),
                                          (None, "sha-one"), (None, None)):
            with self.subTest(revision=revision, latest_revision=latest_revision):
                self.report(1, [dict(space_id="a/one", revision=revision, reason="old diagnosis")])
                self.report(2, [dict(space_id="a/one", revision=revision, reason="new diagnosis"),
                                dict(space_id="a/other", revision="sha-one", reason="other space")])
                self.report(3, [dict(space_id="a/one", revision=revision, outcome="held")])
                self.report(4, [dict(space_id="a/one", revision=latest_revision, outcome="held")])
                current = dashboard.render(self.root).split('<h2>History</h2>')[0]
                one_row = current.split('<tbody>')[1].split('</tr>')[0]
                self.assertNotIn('old diagnosis', one_row)
                self.assertNotIn('other space', one_row)
                if revision == "sha-one":
                    self.assertIn('new diagnosis', one_row)
                    self.assertIn('Previous diagnosis (2026-09-02T00:00:00Z)', one_row)
                else:
                    self.assertNotIn('Previous diagnosis', one_row)
                    self.assertNotIn('new diagnosis', one_row)
                for path in self.root.iterdir():
                    for file in path.iterdir():
                        file.unlink()
                    path.rmdir()

    def test_invalid_and_incomplete_ignored(self):
        self.report(1, [], complete=False)
        bad = self.report(2, [])
        (bad / 'report.json').write_text('{broken')
        self.report(3, None, summary={'spaces': []})
        self.report(4, [], completed_at=None)
        self.report(5, [None, 'bad', {'space_id': 'a/ok'}])
        self.assertEqual([r['run_id'] for r in dashboard.load_reports(self.root)], ['5'])
        self.assertIn('a/ok', dashboard.render(self.root))

    def test_escape_and_links(self):
        attack = '<script>alert("x")</script>'
        for i, url in enumerate(['javascript:alert(1)', 'https://huggingface.co.evil/spaces/a/b/discussions/1',
                                 'https://evil@huggingface.co/spaces/a/b/discussions/1'], 1):
            self.report(i, [dict(space_id=attack, status=attack, stage=attack, reason=attack,
                                 findings=[attack], pr_url=url)], run_id=attack)
        page = dashboard.render(self.root)
        self.assertNotIn('<script>', page)
        self.assertIn('&lt;script&gt;', page)
        self.assertNotIn('href="javascript:', page)
        self.assertNotIn('href="https://', page)

    def test_bound_and_health(self):
        for number in range(1, 105):
            self.report(number, [])
        self.assertEqual(len(dashboard.load_reports(self.root)), 100)
        server = dashboard.ThreadingHTTPServer(('127.0.0.1', 0), dashboard.Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with urlopen(f'http://127.0.0.1:{server.server_port}/healthz') as response:
                self.assertEqual(response.read(), b'ok\n')
            logs = io.StringIO()
            with contextlib.redirect_stderr(logs):
                for path in ('/?__sign=test-signature', '/?embed=true&__sign=test-signature', '/healthz?probe=1'):
                    with urlopen(f'http://127.0.0.1:{server.server_port}{path}') as response:
                        self.assertEqual(response.status, 200)
                        content = response.read()
                        self.assertIn(b'ok' if path.startswith('/healthz') else b'Space monitor', content)
            self.assertNotIn('test-signature', logs.getvalue())
            self.assertNotIn('__sign', logs.getvalue())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
