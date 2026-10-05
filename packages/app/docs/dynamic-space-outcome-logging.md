# Canonical dynamic_space outcomes

With Query logging enabled and configured, each call entering the registered
`dynamic_space` handler attempts to emit one Query event
with `dynamicSpaceReportingSchema: "dynamic_space_outcome_v1"`. Coverage begins at
handler entry: SDK validation failures and requests rejected before dispatch are
outside this denominator.

`success` is determined by the returned MCP `isError` flag (or false for a thrown
exception). Failures carry `dynamicSpaceStage` and `dynamicSpaceErrorCode` from
shared `ToolResult`/`InvokeResult.errorMetadata`, without parsing error text.
Server-only failures are:

- `configuration` / `invoke_disabled`: `gradio=none` prevents invocation.
- `unexpected` / `unexpected_error`: handler exception, or error result lacking
  structured metadata.

Successful events omit stage/code. Operation labels are bounded to `help` (no
operation), `find`, `discover`, `view_parameters`, `invoke`, or `unknown`.
Canonical events retain existing request/session/client correlation and duration,
but intentionally log empty parameters and no response or exception text. They
do not record space names, tool arguments, search text, or successful output.

Existing Gradio detail events remain supplemental and must not be counted as
additional canonical query outcomes. Inner dynamic handler query logging is
removed; the outer outcome wrapper owns the Query event.

Unit tests cover disabled invoke, raw response success, returned MCP errors,
formatted setup failures, help and non-invoke operations, missing metadata,
exceptions, bounded labels, request correlation, and query serialization.

Error responses expose the same bounded stage/code in
`_meta["huggingface.co/dynamic-space"]`; raw upstream content and `isError`
remain intact. Known HTTP metadata/schema failures offer specific recovery
guidance; untyped exceptions are not guessed to be authentication or timeout
failures. Logging is best effort, not proof of durable delivery.

## Compatible input improvements

- `parameters` accepts a structured object or the existing JSON-object string.
- `tool_name` selects an exact endpoint for both inspection and invocation.
  Omission preserves first-tool selection. Use the same name for both operations.
- Generated invocation examples preserve native values and escape the entire
  outer request. Array/object placeholders remain illustrative, not proof of
  full JSON Schema validity.
- Discovery does not probe every result for live adapter compatibility. Its
  guidance explicitly requires inspection; MCP discovery is not a readiness guarantee.

The offline telemetry dashboard includes a Dynamic Spaces counts-only tab.
Historical/unversioned and canonical records must not be treated as one complete
invocation denominator. Recompute both comparison windows under the updated
classifier, and reconcile older Gradio/query streams separately before making
historical reliability claims.

## Lightweight live panel

The live `/metrics` dashboard shows **Dynamic Spaces live** beside `hf_fs live`.
`/api/transport-metrics` includes `dynamicSpaceMetrics`: total completed calls,
per-operation succeeded/failed counts, bounded failure-stage totals, and the last
update timestamp. These counters advance once in the canonical outcome wrapper,
independently of remote logging, and reset when the process restarts.

This is intentionally not a funnel or task-success metric. In-flight calls and
pre-handler validation rejections are excluded. Direct `gr_*` tool calls belong
to the existing Gradio metrics, not this panel. No prompts, arguments, Space names,
tool names, or request/session identifiers are retained in these live counters.
