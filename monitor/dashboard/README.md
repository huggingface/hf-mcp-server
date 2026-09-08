---
title: Space monitor
sdk: docker
app_port: 7860
---

Read-only, dependency-free dashboard. Use this directory as the HF Space source.
Mount published reports read-only at `/reports` (override with `REPORT_ROOT`).
No tokens or state mount are needed. The non-root user must have read access.

Locally: `python3 -B dashboard.py`, then open http://localhost:7860.
`/healthz` verifies the server is running, not report freshness or Space health.
Each page request reads only `/reports/dashboard.json` once; it never scans report directories.
The current schema is `space-monitor-dashboard/v1`, maintained by the monitor writer. History displays
three full reports; latest per-Space observations survive partial catalogs, and held observations retain
same-revision diagnoses across repeated holds without a history lookup limit. Missing or invalid snapshots
show an empty dashboard, not a fallback scan.

Before switching an existing deployment, build the snapshot once while the monitor writer is idle:

```bash
python3 monitor/scripts/build-dashboard-snapshot.py /path/to/reports
```

Run from the repository checkout with the report root writable. The utility imports the monitor writer,
skips legacy/malformed/incomplete reports and symlinks, orders current reports by completion time,
and replaces only `dashboard.json`. See [snapshot schema and migration](../README.md#dashboard-snapshot-schema-and-migration).
Leave repair state and scheduling unchanged; wait for the next scheduled run after migration.
