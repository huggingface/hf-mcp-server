# Compositional discovery

These four listing tools are defined in `../tools/listing.ts` and registered through `../index.ts`.
`callPtcTool` (core/tool.ts) validates strict input and the normalized output.
Definitions expose Zod object input/output schemas and read-only annotations.
Descriptions are provisional, source-grounded text for the description workflow.

## Joining results

All results have `items`, `returnedCount` (exactly the array length),
`nextCursor` and `completeness`; `hf_spaces_search` adds `candidateCount`
and `eligibleCount`. There is no `source`, `mode` or `truncation` envelope:
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

- Every `items[].id` feeds `idsAny` of the matching listing tool.
- Model IDs feed `hf_spaces_list.modelsAny` and
  `hf_models_search.baseModelsAll`.
- Dataset IDs feed `datasetsAny` on models/Spaces.
- Model `baseModels`, `datasets`, `spaces` and Space
  `models`/`datasets` contain the same canonical reference objects.
- A model's `datasets` is derived from `dataset:ID` tags, not an authoritative
  inventory. Missing optional fields mean unknown/not projected, not zero
  or an empty relationship.
- Model `pipelineTag` feeds `task`; `libraryName` feeds model `librariesAll`.
  Exact stored tag IDs feed `tagsAll` or semantic `tagsAny`. Scoped OR
  has stricter grammar. Semantic `category` output is an upstream display
  label, **not necessarily** one of the input category slugs.
- Numeric metadata follows upstream JSON. Counts above
  `Number.MAX_SAFE_INTEGER` can be approximate; exact input parameter
  filters are bounded to safe integers.

## Filtering and projection

`hf_models_search`, `hf_datasets_search`, and `hf_spaces_list` perform
token/prefix name listing, not semantic search or README parsing.
`authorsAny`, `idsAny`, and linked `*Any` selectors use top-level OR,
which supports slash-containing IDs. `tagsAll` and the other `*All` facets are AND;
`tagsAnyGroups` is AND of scoped OR groups. Slashes, plus signs, spaces,
commas and nested expressions are rejected inside scoped groups.
Convenience facet arrays are **AND**, with documented kind-specific prefix
translation; use exact stored tags for OR groups.

`fields` is a typed expansion allowlist replacing defaults, not an HTTP
passthrough. Its values are the record field names (camelCase); snake spellings and
the Hub expand names (`inferenceProviderMapping`, `cardData`) are accepted as input.
`sort` values `numParameters`, `numRows` and `mainSize` map to the Hub's sort keys.
Defaults (no `tags`; request `fields: ["tags"]` for them):

- models: `author`, `createdAt`, `lastModified`, `likes`, `downloads`,
  `gated`, `pipelineTag`, `libraryName`;
- datasets: `author`, `createdAt`, `lastModified`, `likes`, `downloads`,
  `gated`, `mainSize`;
- Spaces: `title`, `emoji`, `shortDescription`, `author`, `createdAt`, `lastModified`, `likes`, `sdk`,
  `runtime`, `models`, `datasets`.

Closed vocabularies (`providersAny`, `appsAny`, `stagesAny`, semantic
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

For bulk row counts use `hf_datasets_search` with `sort: "numRows"`. For a known set
of IDs, pass `idsAny` in batches of at most 50 and set `limit` to the batch size. Read
`items[].numRows`: absent means unknown; a reported zero is zero. This is not a selectable
expansion. `mainSize` is stored size in bytes, not a row count. Use `hf_dataset_structure`
for an individual dataset's splits, schema or parquet details, not once per listing hit.
A Hub listing does not guarantee Dataset Viewer data, especially for gated repositories.
Size buckets are tags, not numeric row-range predicates. Experimental
model memory-fit/hardware filtering and arbitrary card paths are omitted.

## Continuation and completeness

Listings use the real upstream `Link` cursor. The opaque tool cursor binds
to endpoint, effective query/projection/page size and explicit auth
context. Repeat the original arguments and pass `nextCursor` as `cursor`.
It is not a URL or an authorization capability. The upstream Link must
retain the same origin, path and query; only its cursor is extracted.
Redirects are not followed, including same-host redirects.

`nextCursor: null` means no usable continuation was supplied. A next Link can
lead to an empty page. `completeness.hasMore` normally reports this Link condition,
not a snapshot or global completeness guarantee.

**Dataset row-count sort is first-page only.** Live verification confirmed that
upstream dotted-field cursors skip matching datasets. Supplied cursors with
`sort: "numRows"` are rejected. When withholding an upstream row-sort continuation,
the result has `nextCursor: null`, `completeness.hasMore: true` and
`completeness.reason: "row_sort_cursor"`.
This means blocked, NOT exhausted. Narrow the filters, increase the first-page
limit (up to 100), or choose a different sort. No alternative cursor is fabricated.

`hf_spaces_search` uses the unpaginated semantic endpoint. Only query,
category, repeated SDK and OR-tag filters and include-non-running are sent.
There is **no upstream limit parameter**. The backend retrieves at most
120 candidates before postfilters. Locally, tags/SDK/runtime and
`mcpOnly` are enforced before the top-N cap, preserving upstream order.
Appending MCP to OR tags would widen the query, so it is not done.
Without other tags, MCP also narrows the upstream filter.

Semantic `candidateCount` and `eligibleCount` are observed counts for
this response, never global matches. `eligibleCount > returnedCount` means
the local limit dropped eligible candidates. Even when equal, global
completeness is unknown; no pagination/refill is available
(`completeness.hasMore` is true with reason `items_cap` when the limit dropped some). With
`source: "curated"`, the counts refer to the operator catalog. `mcp-server` is metadata,
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
