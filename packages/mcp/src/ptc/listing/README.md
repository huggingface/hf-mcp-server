# Compositional discovery

These four listing tools are defined in `../tools/listing.ts` and registered through `../index.ts`.
`callPtcTool` (core/tool.ts) validates strict input and the normalized output.
Definitions expose Zod object input/output schemas and read-only annotations.
Descriptions are provisional, source-grounded text for the description workflow.

## Joining results

All results have `items`, `returned_count` (exactly the array length),
`next_cursor` and `completeness`; `hf_spaces_search` adds `candidate_count`
and `eligible_count`. There is no `source`, `mode` or `truncation` envelope:
the caller already knows which tool (and `source` argument) it used. No total
match counts are inferred. Every repository reference uses:

```json
{
	"kind": "model",
	"id": "owner/model",
	"uri": "hf://models/owner/model",
	"url": "https://huggingface.co/owner/model"
}
```

Dataset and Space URIs use `hf://datasets/ID` and `hf://spaces/ID`; their
web URLs include `/datasets/` and `/spaces/`. Legacy unnamespaced IDs are
accepted. Database `_id` values are never used as repository identifiers.

- Every `items[].id` feeds `ids_any` of the matching listing tool.
- Model IDs feed `hf_spaces_list.models_any` and
  `hf_models_search.base_models_all`.
- Dataset IDs feed `datasets_any` on models/Spaces.
- Model `base_models.models`, `training_datasets`, `spaces` and Space
  `models`/`datasets` contain the same canonical reference objects.
- `training_datasets` is derived from `dataset:ID` tags, not an authoritative
  inventory. Missing optional fields mean unknown/not projected, not zero
  or an empty relationship.
- Model `pipeline_tag` feeds `task`; `library_name` feeds model `libraries`.
  Exact stored tag IDs feed `tags_all` or semantic `tags_any`. Scoped OR
  has stricter grammar. Semantic `category` output is an upstream display
  label, **not necessarily** one of the input category slugs.
- Numeric metadata follows upstream JSON. Counts above
  `Number.MAX_SAFE_INTEGER` can be approximate; exact input parameter
  filters are bounded to safe integers.

## Filtering and projection

`hf_models_search`, `hf_datasets_search`, and `hf_spaces_list` perform
token/prefix name listing, not semantic search or README parsing.
`authors_any`, `ids_any`, and linked `*_any` selectors use top-level OR,
which supports slash-containing IDs. `tags_all` is AND;
`tags_any_groups` is AND of scoped OR groups. Slashes, plus signs, spaces,
commas and nested expressions are rejected inside scoped groups.
Convenience facet arrays are **AND**, with documented kind-specific prefix
translation; use exact stored tags for OR groups.

`fields` is a typed expansion allowlist replacing defaults, not an HTTP
passthrough. Defaults (no `tags`; request `fields: ["tags"]` for them):

- models: `author`, `createdAt`, `lastModified`, `likes`, `downloads`,
  `gated`, `pipeline_tag`, `library_name`;
- datasets: `author`, `createdAt`, `lastModified`, `likes`, `downloads`,
  `gated`, `mainSize`;
- Spaces: `cardData`, `author`, `createdAt`, `lastModified`, `likes`, `sdk`,
  `runtime`, `models`, `datasets`.

Closed vocabularies (`providers_any`, `apps_any`, `stages_any`, semantic
`category`) are advertised as enums, like every other closed vocabulary: their
values double as search vocabulary for tool-search clients (fx lost 1-2 points
when they were plain strings). Input is matched case-insensitively and normalized
to the canonical spelling; an unknown value fails with the list of valid options. IDs/references are always included, and the server may return
the sort field. Reviewed nested metadata only is returned: model config,
safetensors counts, provider mappings and lineage; Space runtime and
presentation. Cards, config extras, staff fields, runtime errors, arbitrary
database fields, file inventories and provider internals are not emitted.
Unknown upstream keys are stripped, but malformed known fields fail safely.
Large nested collections are bounded; over-budget responses fail instead
of silently losing metadata.

Dataset `rows` maps `datasetsServerInfo.numRows` when present (normally
under row sorting); it is not an expansion. `bytes` maps `mainSize`.
Size buckets are tags, not numeric row-range predicates. Experimental
model memory-fit/hardware filtering and arbitrary card paths are omitted.

## Continuation and completeness

Listings use the real upstream `Link` cursor. The opaque tool cursor binds
to endpoint, effective query/projection/page size and explicit auth
context. Repeat the original arguments and pass `next_cursor` as `cursor`.
It is not a URL or an authorization capability. The upstream Link must
retain the same origin, path and query; only its cursor is extracted.
Redirects are not followed, including same-host redirects.

`next_cursor: null` means no usable continuation was supplied. A next Link can
lead to an empty page. `end_of_listing` normally reports this Link condition,
not a snapshot or global completeness guarantee.

**Dataset row-count sort is first-page only.** Live verification confirmed that
upstream dotted-field cursors skip matching datasets. Supplied cursors with
`sort: "rows"` are rejected. When withholding an upstream row-sort continuation,
the result has `next_cursor: null`, `end_of_listing: null`, and
`completeness.pagination_blocked_reason: "upstream_row_sort_cursor"`.
This means blocked, NOT exhausted. Narrow the filters, increase the first-page
limit (up to 100), or choose a different sort. No alternative cursor is fabricated.

`hf_spaces_search` uses the unpaginated semantic endpoint. Only query,
category, repeated SDK and OR-tag filters and include-non-running are sent.
There is **no upstream limit parameter**. The backend retrieves at most
120 candidates before postfilters. Locally, tags/SDK/runtime and
`mcp_only` are enforced before the top-N cap, preserving upstream order.
Appending MCP to OR tags would widen the query, so it is not done.
Without other tags, MCP also narrows the upstream filter.

Semantic `candidate_count` and `eligible_count` are observed counts for
this response, never global matches. `eligible_count > returned_count` means
the local limit dropped eligible candidates. Even when equal, global
completeness is unknown; no pagination/refill is available. With
`source: "curated"`, the counts refer to the operator catalog and
`completeness.scope` is `curated_catalog`. `mcp-server` is metadata,
not proof of a working MCP endpoint.

## Network and evidence

Only fixed HTTPS Hugging Face endpoints are fetched. Authentication is
used only when explicitly supplied via `hfToken`; no ambient token is
read. Token calls can include authorized private repositories (results do
not echo whether a token was used). No
`private=false` wire filter is invented. Requests use GET, omitted browser
credentials, manual redirect handling, an injected-fetch option, a 12.5s
deadline covering body consumption, cancellation and a 4 MiB body budget.
Errors never expose response bodies, tokens or underlying exception causes.
MCP failures set `isError` and return a sanitized diagnostic; known failures also
include `_meta["huggingface.co/ptc-error"]` with `code` and `retryable`.
Input/cursor failures are not retryable; callers should correct their query.
The declared output schemas describe successful pages, not error results.

Evidence: the [public Hub OpenAPI](https://huggingface.co/.well-known/openapi.json) and a
review of the Hub's search and listing behaviour (recorded with the description tooling).
`wire-samples.json` contains anonymous public wire captures (2026-10-29),
including an actual row count above the JS safe-integer range and sparse
optional fields. Semantic captures retain only the first two array items;
fields within those items were not rewritten. Tests run offline.

Run from `packages/mcp`:

```sh
../../node_modules/.bin/vitest run src/ptc/discovery.test.ts
../../node_modules/.bin/tsc --noEmit
../../node_modules/.bin/eslint src/ptc src/index.ts
```
