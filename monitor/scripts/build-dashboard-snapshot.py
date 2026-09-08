#!/usr/bin/env python3
"""One-off migration. Requires an explicit report root and an idle monitor writer."""
import argparse
import importlib.util
import json
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location(
    "monitor", Path(__file__).resolve().parents[1] / "distribution/bin/monitor.py")
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def build_snapshot(root):
    root = root.resolve(strict=True)
    reports = []
    # Only the documented current layout. No legacy recursive summary lookup.
    for path in root.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/*/report.json"):
        relative = path.relative_to(root)
        if not re.fullmatch(r"[A-Za-z0-9._-]+", path.parent.name):
            continue
        if any((root.joinpath(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
            continue
        marker = path.with_name("COMPLETE")
        if marker.is_symlink() or not marker.is_file() or not path.is_file():
            continue
        try:
            complete = json.loads(marker.read_text(encoding="utf-8"))
            report = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(complete, dict) or complete.get("schema_version") != "space-monitor-complete/v2":
            continue
        if not monitor.valid_dashboard_report(report) or report["run_id"] != path.parent.name:
            continue
        reports.append(report)
    snapshot = monitor.empty_dashboard()
    for report in sorted(reports, key=monitor.report_order):
        snapshot = monitor.update_dashboard(snapshot, report)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_root", type=Path, help="Explicit local/mounted reports directory (read/write)")
    args = parser.parse_args()
    snapshot = build_snapshot(args.report_root)
    monitor.write_dashboard(args.report_root, snapshot)
    print(f'Wrote {args.report_root / "dashboard.json"}: {len(snapshot["latest"])} Spaces')


if __name__ == "__main__":
    main()
