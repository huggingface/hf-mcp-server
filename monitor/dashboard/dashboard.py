"""Read-only view of completed monitor reports; standard library only."""
import html
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REPORT_ROOT = Path(os.environ.get("REPORT_ROOT", "/reports"))
LIMIT = 100
HISTORY_LIMIT = 3


def esc(value):
    return html.escape(str(value if value is not None else "—"), quote=True)


def load_reports(root):
    reports = []
    for path in sorted(root.rglob("report.json"), reverse=True):
        if not path.with_name("COMPLETE").is_file():
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(report, dict) or not isinstance(report.get("spaces"), list):
            continue
        if not isinstance(report.get("completed_at"), str) or not report["completed_at"]:
            continue
        report["spaces"] = [s for s in report["spaces"] if isinstance(s, dict)
                            and isinstance(s.get("space_id"), str)]
        reports.append(report)
        if len(reports) == LIMIT:
            break
    return sorted(reports, key=lambda r: r["completed_at"], reverse=True)


def space_link(space):
    name = space["space_id"]
    if re.fullmatch(r"[\w.-]+/[\w.-]+", name, flags=re.ASCII):
        return f'<a href="https://huggingface.co/spaces/{esc(name)}">{esc(name)}</a>'
    return esc(name)


def details(space):
    parts = [esc(space[k]) for k in ("detail", "reason") if space.get(k)]
    url = space.get("pr_url")
    if url:
        if isinstance(url, str) and re.fullmatch(
            r"https://huggingface\.co/spaces/[\w.-]+/[\w.-]+/discussions/[0-9]+", url, flags=re.ASCII
        ):
            parts.append(f'<a href="{esc(url)}">PR</a>')
        else:
            parts.append(esc(url))
    for finding in space.get("findings", []) if isinstance(space.get("findings"), list) else []:
        if isinstance(finding, dict):
            parts.append(": ".join(esc(finding[k]) for k in ("severity", "summary") if finding.get(k)))
        else:
            parts.append(esc(finding))
    return "<br>".join(parts) or "—"


def previous_diagnosis(reports, report, space):
    if space.get("outcome") != "held" or space.get("revision") is None:
        return ""
    for earlier in reports:
        if earlier["completed_at"] >= report["completed_at"]:
            continue
        for candidate in earlier["spaces"]:
            if (candidate["space_id"] != space["space_id"]
                    or candidate.get("revision") != space["revision"]):
                continue
            meaningful = any(candidate.get(k) for k in ("reason", "findings", "pr_url"))
            outcome = candidate.get("outcome")
            if not meaningful and outcome in (None, "", "held", "observed"):
                continue
            diagnosis = {k: candidate[k] for k in ("reason", "findings", "pr_url") if k in candidate}
            return (f'<br><strong>Previous diagnosis ({esc(earlier["completed_at"])})</strong>'
                    f'<br>Outcome: {esc(outcome)}<br>{details(diagnosis)}')
    return ""


def row(report, space, previous=""):
    return "<tr>" + "".join(f"<td>{v}</td>" for v in (
        space_link(space), esc(space.get("status")), esc(space.get("stage")),
        esc(report["completed_at"]), esc(space.get("action", "—")) + " / " + esc(space.get("outcome")),
        details(space) + previous,
    )) + "</tr>"


def table(rows):
    return ('<table><thead><tr><th>Space</th><th>Status</th><th>Stage</th>'
            '<th>Last observed</th><th>Action / outcome</th><th>Details</th>'
            '</tr></thead><tbody>' + rows + '</tbody></table>')


def render(root):
    reports = load_reports(root)
    latest = {}
    for report in reports:
        for space in report["spaces"]:
            latest.setdefault(space["space_id"], (report, space))
    body = '<h1>Space monitor</h1><p>Reported status, not live probe. Observations may be stale; check last observed.'
    body += ' Times are report completion timestamps. Refreshes every 60 seconds. <a href="/">Refresh now</a>.</p>'
    body += f'<p>Lookup: last {LIMIT} completed runs.</p>'
    if reports:
        run = reports[0]
        body += f'<h2>Latest run: {esc(run.get("run_id"))}</h2><p>Completed: {esc(run["completed_at"])}'
        body += f'<br>Counts: {esc(run.get("counts"))}<br>Catalog: {esc(run.get("catalog"))}</p>'
    else:
        body += '<p>No completed current reports found.</p>'
    body += '<h2>Latest per Space</h2>' + table(''.join(
        row(*latest[k], previous_diagnosis(reports, *latest[k])) for k in sorted(latest)))
    body += f'<h2>History</h2><p>Latest {HISTORY_LIMIT} runs. Original reports, not current health.</p>'
    for report in reports[:HISTORY_LIMIT]:
        body += f'<details><summary>{esc(report["completed_at"])} — {esc(report.get("run_id"))}</summary>'
        body += table(''.join(row(report, s) for s in report["spaces"])) + '</details>'
    return ('<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="60">'
            '<meta name="viewport" content="width=device-width"><title>Space monitor</title><style>'
            'body{font:16px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}'
            'td,th{border:1px solid #aaa;padding:.5rem;text-align:left;overflow-wrap:anywhere}'
            'summary{cursor:pointer;margin:1rem 0}</style><body>' + body + '</body></html>')


class Handler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        # Private Spaces append a signed query parameter; never log it.
        self.log_message("%s %s %s", self.command, urlsplit(self.path).path, code)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path not in ("/", "/healthz"):
            self.send_error(404)
            return
        health = path == "/healthz"
        data = ("ok\n" if health else render(REPORT_ROOT)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8" if health else "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 7860), Handler).serve_forever()
