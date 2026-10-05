# Passive tool telemetry — portable first milestone

Run from a fresh **server checkout**, with Python >=3.11 and Git available.
Python standard library only: no pip, uv, Node, network access, token, or model
is required by the runtime. `run.py` is the supported entry point. No operational
records are bundled. No job or schedule has been deployed.

## Mounted execution

Provision an input dataset mount **read-only** at `/mount/input`, containing
`queries/YYYY-MM-DD/*.jsonl` or `*.jsonl.gz`. Provision a **private read-write**
output bucket mount at `/mount/output` (owner-only directory permissions, 0700).
The runtime does not fetch inputs or refresh mirrors. Mount credentials and
access policy belong to the job platform, not this package.

From the server repository root:

```bash
python3 --version
git --version
python3 -m unittest discover -s monitor/telemetry -p 'test_*.py'
python3 monitor/telemetry/run.py --help
python3 monitor/telemetry/run.py \
  --input-root /mount/input --output-root /mount/output \
  --server-repo "$PWD" --run-name daily-2026-09-09 \
  --from-date 2026-09-09 --to-date 2026-09-09 \
  --baseline-from 2026-09-08 --baseline-to 2026-09-08
```

Use a new run name each time. Dates are explicit inclusive UTC event dates;
windows are bounded to 31 days, baseline must precede current, and current-day
runs require `--allow-partial-day`. The optional following-day shard folder is
included by default for late flushing; use `--no-following-day` to disable.
Requested date folders must exist; completeness remains unknown. Version filters
are independent (`--server-version`, `--baseline-server-version`); see `--help`.
All five dashboard views are always enabled: pulse, cohorts, opportunities,
filesystem, Dynamic Spaces. The portable runner enables client aggregation by default.

For local smoke use, substitute a synthetic input directory and a freshly created
private output directory (`mkdir -m 700 /tmp/telemetry-output`). Do not use the
private operational mirror for tests. The test suite creates all fixtures itself.

## Outputs and publication

Each completed run contains `report/{report.json,report.csv,report.md,manifest.json}`,
`dashboard/{dashboard.html,visualization-manifest.json}`, `publication.json`, and
`COMPLETE`. HTML is standalone with no external assets or requests.

Generation happens in `.RUN.pending`; failures leave incomplete aggregates for
operator inspection, never a completion marker. Existing names are not overwritten
or automatically deleted. Report and dashboard hashes are verified, then all
artifact hashes are recorded and rechecked. On POSIX storage, the staging directory
is renamed into place and `COMPLETE` is atomically renamed **last**. Its content is
the SHA-256 of `publication.json`; that manifest binds every report/dashboard file
and the portable runtime source hashes. Consumers must verify the marker, manifest,
and every listed file before reading a run. Never infer success from a directory,
report manifest, or dashboard alone.

**Bucket/FUSE caveat:** rename, chmod, exclusive create, fsync, and visibility may
not have POSIX semantics. This implementation fails closed on reported filesystem
errors; it cannot guarantee bucket-level transactions or durability. Validate mount
behavior before scheduling, use a single writer and unique run names, and require
consumer-side hash verification/retry after eventual visibility. No mutable
`latest` pointer is maintained. Provision bucket privacy independently of POSIX
modes. Unsupported permission emulation requires a platform decision, not disabling
these checks silently. Output directories must not be concurrently modified by
untrusted processes (path checks are not a sandbox against mount replacement).

## Privacy and semantics

Only dated query shards are selected. No `sessions/` reads, identifier linkage,
downloads, model calls, or source-file writes occur. Input/output overlap, symlink
components, reused runs, and non-private output roots are rejected. The bounded
reader retains its size/decompression limits and before/after file checks.
Private paths, shard filenames, raw rows, prompts, arguments, error text, identifiers,
and individual source hashes are not persisted. Source provenance uses aggregate
content-multiset hashes and date/count coverage. Runtime failures use fixed messages.

Taxonomy, batch evidence, dashboard views, popularity selection, cohort floors, and
suppression are preserved from the source reporter. Minimum cell volume is 5;
client floor is 20, including contributing-batch floors. These are **not per-count
k-anonymity**: small outcomes can be inferred. Attribution is not proof of blame or
task failure. Outputs remain **private aggregates, unreviewed**; review and approve
before sharing, and never make the output bucket public by default.

## Source and deployment provenance

`source-manifest.json` freezes SHA-256 values of the original
`hf-mcp-optimise/scripts/` working-tree files copied on 2026-09-10, including the
then-untracked reporter/dashboard/tests. No optimise checkout is needed at runtime.
`data_fill.py`, `snapshot_names.py`, and the helper closure were vendored rather
than risk changing bounded parsing semantics. Their unused extraction/study APIs
are not supported entry points; the runner calls only query-reader and aggregate
I/O functions. No ad hoc study modules or data were copied.

Portable changes: explicit private output boundary in `study_common.py`, complete
writes/fsync, dashboard input boundary and four-view status text, reproduction
command placeholders, and fixture setup for pre-provisioned roots. The new runner
adds mount validation, publication and runtime hashes. Original source hashes are
not claims that adapted files remain byte-identical.

`--server-repo` is a local source checkout, not a deployed-server lookup. Reports
record HEAD, tracked dirty status, relevant diff hash, and handler source hashes.
Release markers are Git tag **commit dates**, not deploy/publish dates. For a job
image, pin an immutable server commit (including this package), include Git metadata
and release tags, and record the image digest externally. For example, during image
construction use `git checkout --detach "$SERVER_COMMIT"` in the cloned server
repository; do not fetch source dynamically in the telemetry job. Working-tree
provenance is supported for development and clearly labeled as local context.

## Next step: approved scheduled HF Job

After branch publication, validate a pinned job image and the platform's dataset
read-only / output-bucket read-write mounts with synthetic inputs, including
interrupted publication and bucket visibility. Then an operator can configure a
daily job using the exact runner command above with explicit previous-day/baseline
dates and a unique run name. Decide retention, review access, and failed-run alerts
before enabling it. Scheduling and any remote installation are intentionally outside
this milestone; there is no custom fetcher or fabricated deployment configuration.

## Dynamic Spaces query-log slice

The dedicated **Dynamic Spaces** tab uses only published `dynamic_space` query
aggregates in the selected window, independently of the global Scope/Signal
filters. It displays observed row, explicit failure, and unknown-outcome counts
by operation. The top KPI cards are still scope-wide, not execution metrics.
Absent tools/cells may be unselected or below publication floors, not zero;
visible operation counts need not sum to the tool total.

**Historical/unversioned execution denominators are incomplete.** Invoke successes
and exceptions could go only to Gradio events; some early rejections were unlogged.
After deploying this change, the producer emits `dynamicSpaceReportingSchema=dynamic_space_outcome_v1`,
bounded `query` operations, privacy-preserving `parameters={}`, and boolean `success`
for every handler-entered call, including successful invokes and caught exceptions.
Failures additionally carry `dynamicSpaceStage` and `dynamicSpaceErrorCode`.
Coverage starts at handler entry: SDK input validation before entry is not covered.
Use the exact per-row marker, not a date or server version, as the deployment
boundary; rollout windows may contain both generations.

Policy `tool-errors-v3` reads operation from `query` ONLY for that exact marker:
find, discover, view_parameters, invoke, help, unknown. It does not recover a
canonical operation from parameters. Other markers and unversioned rows retain
the historical parameter adapter (including search/add/remove/list and evidenced
help). Structured failure classification also requires the exact marker and an
allowlisted stage/code pair. Validation and unsupported-schema codes describe
tool-quality contract friction, not blame. Selection/configuration failures are
access-or-target; metadata/schema fetch, invocation, general operation, and
unexpected failures retain unknown root cause with distinct bounded reasons.
Typed HTTP fetch failures distinguish authentication, authorization, missing-or-inaccessible
targets, and service unavailability; no error-message keyword matching is used.
Malformed or unsupported canonical metadata remains unknown; raw text cannot
override it. Missing success is still unknown, not an inferred outcome.

Recompute **both windows** under v3; do not compare policies. The aggregate
report schema remains v2 (no field changes). Current aggregates do not separate
canonical and legacy coverage. The Dynamic Spaces tab therefore remains
counts-only: do not interpret mixed-window counts as invocation success rates
or discovery-to-inspection-to-execution funnels. Scope-wide metrics elsewhere
are observed query-call metrics, not complete execution rates.
This reader does not ingest Gradio events, join sessions, or deduplicate requests.
Combining streams requires explicit event identity and overlap/deduplication
rules. Catalog monitor health in `monitor/dashboard` remains a separate signal.
