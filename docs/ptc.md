# PTC bouquet (`?bouquet=ptc`)

The PTC bouquet serves a toolset designed for programmatic tool calling clients (Codex, fast-agent
PTC, code mode): one typed function per Hub operation, strict input/output schemas, and results that
compose in code. It is served by the same MCP server as the legacy bouquets but is fully separate at
the MCP surface: selecting it registers only PTC tools, bypasses user API settings (without fetching them), ignores\n`gradio`, uses its own
instructions, and is tracked on its own **PTC** tab in the management page.

- Source: `packages/mcp/src/ptc/` (toolset; see its README for conventions) and
  `packages/app/src/server/ptc/` (profile detection, access policy, registration, metrics).
- Design record, parity matrix and benchmark mapping: `docs-internal/ptc-parity/report.html`.
- The four listing tools' detailed contract (filters, cursors, row-sort exception):
  `packages/mcp/src/ptc/listing/README.md`.

## Mixing

PTC must be selected alone: `?bouquet=ptc` or `?bouquet=codemode`. Any non-empty `mix`
with this profile is rejected with HTTP 400, as is using `ptc` or `codemode` as a mix-in
with another bouquet or user settings. Empty mixes are treated as absent.

## Listing policy

Every tool the request's token can use is listed; clients use their own tool search to choose.
Listing is filtered only on token permission:

| Caller                                                  | Listed                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No token                                                | Public read tools (search, repository/dataset/paper/docs reads, Space describe/invoke) |
| Token the server could not verify, or a read-only token | Plus account and job reads (`hf_whoami`, `hf_jobs_list`, ...)                          |
| Any other verified token                                | Everything, including repository writes, Jobs and sandboxes                            |

The Hub still enforces permissions on every call. `DISABLE_TOOLS` applies as usual.

## Instructions

The server instructions in this profile are deliberately one rule-only line (`PTC_INSTRUCTIONS`, 163
characters, the same for every client):

> Pass returned uri values unchanged to follow-up calls. Page with next_cursor (reads: next_offset),
> other arguments unchanged. returned_count counts this page only.

Codex `tool_search` and fast-agent `capability_search` index server instructions into every tool
entry, so tool names or task vocabulary there flatten ranking; guidance lives in the tool
descriptions and schema field descriptions instead. The line fits the 250-character first line
Codex 0.167+ shows up front.

## The `hf://` thread

Every returned record carries `kind`, `id`, `uri` (`hf://...`) and `url`. Every argument naming a
Hub resource accepts that `uri` verbatim (or an `owner/name` ID or a huggingface.co URL):
`hf://{models|datasets|spaces|buckets}/OWNER/NAME[@REV][/PATH]`, `hf://papers/ID`,
`hf://collections/OWNER/SLUG-ID`, `hf://docs/PRODUCT/...`. Jobs and sandboxes use their own IDs.

Other identifiers round-trip too:

- **People:** user and organization records currently use the profile URL as `uri`. Every argument
  naming a person (`handle(s)`, `user`, `org`, `entity`, `owner(s)`, `author`, `authors_any`,
  `submitter`, `namespace`) accepts a bare name, `@name` or that profile URL, through one parser
  (`parsePersonRef`/`personRefSchema` in `core/refs.ts`). Names are case-insensitive on the Hub: canonical-case redirects
  are followed, records carry the canonical name, and `authors_any` names are resolved to their
  canonical case before searching (names that match no user or organization are reported in
  `completeness.unknown_owners`).
- **Discussions:** `hf_discussion_get.ref` accepts the record `id` (`owner/name#N`) or the discussion
  URL without a separate `num`; a repository plus `num` still works.
- **Jobs:** the `kind` argument accepts the record kind (`job`, `scheduled_job`; `scheduled` also works).
- **Docs:** `hf_docs_read` accepts the unversioned page `url` that `hf_docs_search` returns and reads
  the current version.
- **Full-text search:** `repo_ids` accepts returned `uri` values and URLs.

## Results and errors

Successful calls return `structuredContent` (plus a JSON text copy, or media content for images and
Space outputs). Lists return `items`, `returned_count` (never a total), an opaque `next_cursor`
bound to the arguments and token, and `completeness`. Failures set `isError` and carry
`_meta["huggingface.co/ptc-error"] = { code, retryable }`. Messages are sanitized: upstream response
bodies and credentials are not included (a message may echo the reference the caller passed). When a
remote tool (a Space) runs but reports failure, the result carries `isError` with its output.

The `outputSchema` listed in `tools/list` is a compact, open form of each tool's output: types,
enums and constants, records typed one level deep, without field docs or validation limits. Results
always contain the full record, so fields beyond the advertised shape (e.g. `safetensors`, `config`)
are still present.

Arguments are validated strictly, but common habitual names are accepted when the intended
argument is unambiguous (`repo_id`/`repo` with `repo_type` for `ref`/`refs`, `dataset_id` for
`dataset`, `url` for `uri`, `q` for `query`, `max_results` for `limit`; `{repo_id, path}` becomes a
file `uri` for readers). The name of the record field a value came from is accepted too: `uri`,
`url` or `id` for `ref`, `refs`, `dataset`, `space`, `collection` and `paper_id(s)`; a full-uri
`ref` for `uri`; `id` for `job_id` and `sandbox`; and, on tools with a single person argument,
`handle`, `user`, `org`, `entity`, `username`, `uri` or `id` for it. An alias never overrides an
argument that was given, is never applied when the tool defines that name itself, and is skipped
when two arguments of the tool could claim it. Otherwise the error names the unknown argument, lists
the valid ones and describes any missing required argument. Closed value lists are
listed as enums (they double as search vocabulary); they match case-insensitively and an unknown
value fails with the list of valid values.

Default payloads are trimmed. Search results leave out `tags` unless `fields` asks for them, and
`hf_repo_info` returns `chat_template` and the `spaces` list only when they are named in `fields`.
Listing outputs carry `completeness` but no `source`, `truncation` or `mode`. `hf_papers_search`
has no continuation, so its `next_cursor` is always null.

## Metrics

`/api/ptc-metrics` (and the **PTC** tab) report process-local counts since start: PTC requests by
access level, calls and errors per tool, error codes, and the clients (`name@version` from
`initialize`) that used the bouquet.
