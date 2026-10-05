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
Only `report.json` beside `COMPLETE` is read; legacy nested summaries are ignored.
History displays only the latest three completed runs. Lookup still reads up to 100 completed runs,
scanning reverse-sorted report paths, for latest per-Space observations and previous held diagnoses.
Partial catalogs retain other Spaces' observations within that lookup window.

Dynamic Spaces request observability lives in the separate offline
`monitor/telemetry` dashboard's dedicated query-log tab. This monitor only reads
catalog reports; it does not load telemetry publications or merge monitor health
with query/Gradio outcomes. Query logs lack the full execution denominator, so
neither dashboard claims Dynamic Spaces invocation success rates or funnels.
