# Scheduled Space Monitor

`distribution/bin/bootstrap-monitor.sh` is the scheduled shell entrypoint. It installs the small Python runtime,
creates the unprivileged Doctor user, and starts `monitor.py`.

The monitor reads `DYNAMIC_SPACE_DATA` as a real CSV file, checks the Hub runtime and Gradio MCP schema for every
Space, and records every observation. A failing revision progresses only once per scheduled run:

```text
PAUSED / RUNTIME_ERROR → normal restart → Doctor + revision-pinned PR → hold
other unhealthy stage ────────────────────────→ Doctor + revision-pinned PR → hold
```

`pr-opened`, `pr-failed`, and `needs-human` hold until the Space revision changes. The parent uses `HF_TOKEN` (falling
back to `DEFAULT_HF_TOKEN`) for health reads, restarts, and PR creation. The fast-agent Doctor runs under UID 10001
with only its model key and optional read-only Hub token.
The parent rejects unsafe candidate paths (including symlink traversal), scans candidate content for credentials, and
opens a PR with `parent_commit` set to the diagnosed 40-character revision.

## Configuration

Copy [`job/scheduled.env.example`](job/scheduled.env.example). Useful settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEALTH_TIMEOUT_SECONDS` | `15` | timeout for one HTTP request |
| `HEALTH_ATTEMPTS` / `HEALTH_RETRY_DELAY_SECONDS` | `3` / `2` | bounded retries for transient failures |
| `MAX_DOCTOR_RUNS` | `16` | Doctor cap per run (`0` disables it) |
| `HF_TOKEN` / `DEFAULT_HF_TOKEN` | unset | parent Hub credential for health reads, restarts, and PR creation |
| `RESPONSES_API_KEY` / `OPENAI_API_KEY` | unset | Doctor model key (`RESPONSES_API_KEY` takes precedence) |
| `MONITOR_HF_TOKEN` | unset | optional read-only Doctor Hub token |
| `DOCTOR_MODEL` | `responses.gpt-6-astra?reasoning=medium&service_tier=flex` | Doctor model specification |

`FAST_AGENT_PACKAGE` defaults to `fast-agent-mcp@0.10.16`.
The pinned version has no short `astra` alias, so the monitor uses the explicit provider model
`responses.gpt-6-astra`. A live CLI smoke test verified structured output with medium reasoning and flex.

When the parent Hub credential is present, both restart and PR repair steps are enabled. Token scopes are
user-managed; the monitor does not compare credentials or infer intended scopes. `monitor.py --check` is read-only
and may run as a non-root user with `HF_TOKEN`. Repair execution with the parent credential must run as root so the
Doctor can be launched under its isolated UID.

## State and reports

The ledger at `MONITOR_STATE_ROOT/ledger/` is written and fsynced to a temporary file before atomic replacement.
A restart claim is recorded as `unknown` immediately before the API call, then updated with the observed healthy,
unhealthy, or failed result; later same-revision ledger updates retain that result for Doctor context. Schedule the
Job with `--no-concurrency`; that is the monitor's single-run guarantee.

Reports are written to:

```text
MONITOR_REPORT_ROOT/YYYY/MM/DD/<run-id>/{report.json,COMPLETE}
```

Every immutable report contains healthy, degraded, and unhealthy observations plus treatment outcomes.
After writing `COMPLETE`, the writer updates `MONITOR_REPORT_ROOT/dashboard.json` using only the existing
snapshot and that run's report. It writes a temporary file, fsyncs, and renames it over the snapshot, matching
local/mounted Bucket replacement semantics. It does not chmod the report root or rewrite historical reports.
The existing `--no-concurrency` requirement also protects snapshot updates.

### Dashboard snapshot schema and migration

The current schema is `space-monitor-dashboard/v1`:

```json
{
  "schema_version": "space-monitor-dashboard/v1",
  "latest": {
    "owner/space": {
      "completed_at": "2026-09-07T08:00:00Z",
      "observation": {"space_id": "owner/space", "revision": "revision-sha", "outcome": "held"},
      "diagnosis": {
        "completed_at": "2026-09-07T00:00:00Z",
        "revision": "revision-sha",
        "outcome": "needs-human",
        "reason": "manual fix required"
      }
    }
  },
  "history": []
}
```

`observation` is the full latest per-Space report record. `diagnosis` is null or the most recent meaningful
same-revision outcome with its timestamp, revision, and optional `reason`, `findings`, and `pr_url`.
Repeated holds (including repeated PR URLs) retain the original diagnosis; a changed or missing revision
clears it. Partial/failed catalogs retain absent Spaces and their original observation timestamps without a
history lookup window. `history` contains the latest three **full**, unmodified `space-monitor/v1` reports,
newest first. The dashboard renders the retained diagnosis only for held observations.

For deployment migration, while no monitor run is writing, run this standalone utility from the checkout
against an explicitly selected writable local/mounted reports directory:

```bash
python3 monitor/scripts/build-dashboard-snapshot.py /path/to/reports
```

This is the only history scan: it reads `YYYY/MM/DD/<run-id>/report.json` once each, requires a current
`space-monitor/v1` envelope and `space-monitor-complete/v2` COMPLETE marker, skips symlinks, legacy,
incomplete, and malformed reports, then folds them in completion-time order (timezone-aware; run ID breaks
ties). It atomically replaces only `dashboard.json`; rerunning rebuilds it from history. Keep the checkout's
`distribution/bin/monitor.py` alongside the utility, which imports the writer's functions.

Migrate existing history before switching the dashboard to snapshot reads. Without migration, the next
scheduled run initializes a snapshot with only that run's observations; it cannot recover older absent Spaces
or diagnoses. Missing, invalid, or unsupported snapshots show an empty dashboard without scanning history.
A malformed existing snapshot causes the writer to fail rather than silently discard retained data; rebuild
it with the utility while the writer is idle. Immutable reports remain available if snapshot publication fails.
Mount reports read-only in the dashboard, never state or the local run directory. No repair reset or extra
monitor run is needed: leave treatment state unchanged and wait for the next scheduled run.

## Retry and reset

`provider-rate-limited` and `doctor-timeout` are retried on the next scheduled run. Doctor schema, result, and
authentication failures become `needs-human` with the failure code in the report. `pr-failed` also holds: a failed
request may already have created a PR, so the monitor never retries it automatically.

All holds clear when the revision changes. To retry the same revision after reviewing the report and Hub PRs, delete
its ledger file:

```bash
space_id=owner/space
rm "$MONITOR_STATE_ROOT/ledger/$(printf %s "$space_id" | sha256sum | cut -c1-24).json"
```

## Local validation

```bash
DYNAMIC_SPACE_DATA=monitor/distribution/fixtures/healthy.csv \
python3 monitor/distribution/bin/monitor.py --check

bash monitor/tests/test-distribution.sh
```

For a repair Job, use `bash /monitor-src/distribution/bin/bootstrap-monitor.sh` with `--no-concurrency`, writable
report/state storage, and the applicable secrets. Local Doctor output and candidate files live under
`LOCAL_ROOT/<run-id>` and are deleted after the run.

## Schedule

Upload the source to a Bucket (replace `YOUR_NAMESPACE`), then schedule an eight-hourly Job:

```bash
hf buckets sync monitor/distribution hf://buckets/YOUR_NAMESPACE/monitor/source
hf jobs scheduled run \
  --namespace YOUR_NAMESPACE --name space-monitor --no-concurrency \
  --flavor cpu-basic --timeout 3h \
  --env MONITOR_ROOT=/monitor --env MAX_DOCTOR_RUNS=4 \
  --secrets HF_TOKEN --secrets RESPONSES_API_KEY \
  --volume hf://buckets/YOUR_NAMESPACE/monitor/source:/monitor-src/distribution:ro \
  --volume hf://buckets/YOUR_NAMESPACE/monitor/state:/monitor/state:rw \
  --volume hf://buckets/YOUR_NAMESPACE/monitor/reports:/monitor/reports:rw \
  '0 */8 * * *' python:3.13-slim-bookworm \
  bash /monitor-src/distribution/bin/bootstrap-monitor.sh
```

Only upload `distribution/`, never credentials or raw agent logs. Omit `HF_TOKEN` to disable restarts and PR creation.
Pin the container image digest in deployment if reproducible builds are required.

## Dashboard

[evalstate/space-monitor](https://huggingface.co/spaces/evalstate/space-monitor) is a private, read-only dashboard.
Its source is in `dashboard/`. It mounts only the reports Bucket prefix at `/reports:ro`, requires no runtime
credentials, and refreshes every minute. It reads only `dashboard.json` once per page request, with no directory scan. The snapshot supplies the latest
per-Space observations, retained same-revision diagnoses for held Spaces, and three full reports for history.
It does not probe Spaces live; expanded history shows the original reports.

```bash
python3 monitor/tests/test-dashboard.py
```

The active schedule is `evalstate/6a9aa933259f8e97255de234`: every eight hours at 00:00, 08:00, and 16:00 UTC,
with no concurrency, four Doctor diagnoses per run, and a three-hour Job timeout. The old v7 schedule remains paused.
