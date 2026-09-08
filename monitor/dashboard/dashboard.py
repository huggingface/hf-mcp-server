"""Read-only view of completed monitor reports; standard library only."""
import html
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REPORT_ROOT = Path(os.environ.get("REPORT_ROOT", "/reports"))
HISTORY_LIMIT = 3


def esc(value):
    return html.escape(str(value if value is not None else "—"), quote=True)


def load_snapshot(root):
    empty = {"latest": {}, "history": []}
    try:
        snapshot = json.loads((root / "dashboard.json").read_text(encoding="utf-8"))
        if (not isinstance(snapshot, dict)
                or snapshot.get("schema_version") != "space-monitor-dashboard/v1"
                or not isinstance(snapshot.get("latest"), dict)
                or not isinstance(snapshot.get("history"), list)):
            return empty
        for entry in snapshot["latest"].values():
            if (not isinstance(entry, dict) or not isinstance(entry.get("completed_at"), str)
                    or not isinstance(entry.get("observation"), dict)
                    or not isinstance(entry["observation"].get("space_id"), str)
                    or not isinstance(entry.get("diagnosis"), (dict, type(None)))):
                return empty
        for report in snapshot["history"]:
            if (not isinstance(report, dict) or report.get("schema_version") != "space-monitor/v1"
                    or not isinstance(report.get("completed_at"), str)
                    or not isinstance(report.get("spaces"), list)
                    or not all(isinstance(s, dict) and isinstance(s.get("space_id"), str)
                               for s in report["spaces"])):
                return empty
        return snapshot
    except (OSError, ValueError):
        return empty


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


def previous_diagnosis(entry):
    space = entry["observation"]
    diagnosis = entry.get("diagnosis")
    if space.get("outcome") != "held" or not space.get("revision") or not diagnosis:
        return ""
    if (diagnosis.get("revision") != space["revision"]
            or diagnosis.get("completed_at") == entry["completed_at"]):
        return ""
    return (f'<br><strong>Previous diagnosis ({esc(diagnosis.get("completed_at"))})</strong>'
            f'<br>Outcome: {esc(diagnosis.get("outcome"))}<br>{details(diagnosis)}')


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
    snapshot = load_snapshot(root)
    reports = snapshot["history"]
    latest = snapshot["latest"]
    body = '<h1>Space monitor</h1><p>Reported status, not live probe. Observations may be stale; check last observed.'
    body += ' Times are report completion timestamps. Refreshes every 60 seconds. <a href="/">Refresh now</a>.</p>'
    body += '<p>Lookup: writer-maintained snapshot.</p>'
    if reports:
        run = reports[0]
        body += f'<h2>Latest run: {esc(run.get("run_id"))}</h2><p>Completed: {esc(run["completed_at"])}'
        body += f'<br>Counts: {esc(run.get("counts"))}<br>Catalog: {esc(run.get("catalog"))}</p>'
    else:
        body += '<p>No current dashboard snapshot found.</p>'
    body += '<h2>Latest per Space</h2>' + table(''.join(
        row(latest[k], latest[k]["observation"], previous_diagnosis(latest[k])) for k in sorted(latest)))
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
