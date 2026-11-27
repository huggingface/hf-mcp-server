# PTC bouquet (`?bouquet=ptc`)

The PTC bouquet serves a toolset designed for programmatic tool calling clients (Codex, fast-agent
PTC, code mode): one typed function per Hub operation, strict input/output schemas, and results that
compose in code. It is served by the same MCP server as the legacy bouquets but is fully separate at
the MCP surface: selecting it registers only PTC tools, bypasses user API settings (without fetching them), ignores\n`gradio`, uses its own
instructions, and is tracked on its own **PTC** tab in the management page.

- Source: `packages/mcp/src/ptc/` (toolset; see its README for conventions) and
  `packages/app/src/server/ptc/` (profile detection, access policy, registration, metrics).
- Design record, parity matrix and benchmark mapping: maintained in the companion `hf-mcp-tool-optimisations` repo (`ptc-parity/report.html`).
- The four listing tools' detailed contract (filters, cursors, row-sort exception):
  `packages/mcp/src/ptc/listing/README.md`.

## Mixing

PTC must be selected alone: `?bouquet=ptc` (or aliases `?bouquet=codemode`, `?bouquet=openaiptc`). Any non-empty `mix`
with this profile is rejected with HTTP 400, as is using `ptc`, `codemode`, or `openaiptc` as a mix-in
with another bouquet or user settings. Empty mixes are treated as absent.

## Listing policy

Every tool the request's token can use is listed; clients use their own tool search to choose.
Listing is filtered only on token permission:

| Caller                                                  | Listed                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| No token                                                | Public read tools (search, repository/dataset/paper/docs reads, Space describe/invoke, `hf_whoami`) |
| Token the server could not verify, or a read-only token | Plus job reads (`hf_jobs_list`, `hf_job_get`, ...)                                                  |
| Any other verified token                                | Everything, including repository writes, Jobs and sandboxes                                         |

The Hub still enforces permissions on every call. `DISABLE_TOOLS` applies as usual.

## Instructions

The server instructions in this profile are deliberately one rule-only line (`PTC_INSTRUCTIONS`, 160
characters, the same for every client):

> Pass returned uri values unchanged to follow-up calls. Page with nextCursor (reads: nextOffset),
> other arguments unchanged. returnedCount counts this page only.

Codex `tool_search` and fast-agent `capability_search` index server instructions into every tool
entry, so tool names or task vocabulary there flatten ranking; guidance lives in the tool
descriptions and schema field descriptions instead. The line fits the 250-character first line
Codex 0.167+ shows up front.

## The `hf://` thread

Every returned Hub resource record (repositories, files, papers, collections, docs, people,
discussions) carries `kind`, `id`, `uri` (`hf://...`, or the profile URL for people) and `url`.
Values that are not Hub resources, such as dataset rows, log lines or sandbox processes, do not.
Every argument naming a
Hub resource accepts that `uri` verbatim (or an `owner/name` ID or a huggingface.co URL):
`hf://{models|datasets|spaces|buckets}/OWNER/NAME[@REV][/PATH]`, `hf://papers/ID`,
`hf://collections/OWNER/SLUG-ID`, `hf://docs/PRODUCT/...`. Jobs and sandboxes use their own IDs.
`hf://A/B` always names repository `A/B`. A file in a legacy single-segment repository (`gpt2`,
`squad`) is written with an explicit revision, `hf://models/gpt2@main/config.json`, so it parses back
unambiguously. Paper references are accepted only in whole forms: an arXiv ID (optionally `vN`),
`arxiv:ID`, `hf://papers/ID`, or a huggingface.co/papers or arxiv.org abs/pdf URL.

Other identifiers round-trip too:

- **People:** user and organization records currently use the profile URL as `uri`. Every argument
  naming a person (`handle(s)`, `owner`, `ownersAny`, `author`, `authorsAny`, `submittedBy`,
  `namespace`) accepts a bare name, `@name` or that profile URL, through one parser
  (`parsePersonRef`/`personRefSchema` in `core/refs.ts`). Names are case-insensitive on the Hub: canonical-case redirects
  are followed, records carry the canonical name, and `authorsAny` names are resolved to their
  canonical case before searching (names that match no user or organization are reported in
  `completeness.unknownOwners`).
- **Discussions:** `hf_discussion_get.discussion` accepts the record `id` (`owner/name#N`) or the discussion
  URL without a separate `num`; a repository plus `num` still works (`repo` is accepted for it).
- **Jobs:** the `kind` argument accepts the record kind (`job`, `scheduled_job`; `scheduled` also works).
- **Docs:** `hf_docs_read` accepts the unversioned page `url` that `hf_docs_search` returns and reads
  the current version. An explicit version or language (`.../v4.57.0/en/quicktour`) reads that page
  when the Hub serves it, and otherwise fails with a pointer to the current version.
- **Full-text search:** `idsAny` accepts returned `uri` values and URLs.

## Results and errors

Successful calls return `structuredContent` (plus a JSON text copy, or media content for images and
Space outputs). Lists return `items`, `returnedCount` (never a total), an opaque `nextCursor`
signed with a server key (HMAC over the arguments, token and position, so it cannot be edited or
replayed with other arguments; set `PTC_CURSOR_SECRET` to make it unforgeable), and `completeness`:
`hasMore` (more results exist, with or without a continuation), `truncated` and `reason` when a cap or
blocked pagination stopped the tool (`row_sort_cursor`, `page_budget`, `ranking_window`, `owner_fanout_cap`,
`items_cap`, `text_budget`), an optional `hint`, and per-tool extras such as `total`. Reads continue with
`nextOffset`.
An invalid cursor fails with `INVALID_CURSOR`: repeat the call without `cursor`. Failures set `isError` and carry
`_meta["huggingface.co/ptc-error"] = { code, retryable }`. Messages are sanitized: upstream response
bodies and credentials are not included (a message may echo the reference the caller passed). When a
remote tool (a Space) runs but reports failure, the result carries `isError` with its output.

The `outputSchema` listed in `tools/list` is a compact, open form of each tool's output: types,
enums and constants, records typed one level deep, without field docs or validation limits. Results
always contain the full record, so fields beyond the advertised shape (e.g. `safetensors`, `config`)
are still present.

Argument and output names are camelCase. Arguments are validated strictly, but a name that differs
only in case or separators is accepted (`max_bytes` for `maxBytes`), and so are common habitual
names when the intended argument is unambiguous (`repo_id`/`ref` with `repo_type` for `repo`/`repos`; `repo_type` accepts
`model`, `dataset`, `space` or `bucket` in any case, singular or plural, and any other value is
rejected; `model_id`/`dataset_id`/`space_id` keep their kind; `dataset_id` for
`dataset`, `url` for `uri`, `q` for `query`, `max_results` for `limit`; `{repo_id, path}` becomes a
file `uri` for readers). The name of the record field a value came from is accepted too: `uri`,
`url` or `id` for `repo`, `repos`, `dataset`, `space`, `collection`, `discussion` and `paper(s)`; a
full-uri `ref` or `repo` for `uri`; `id` or `job_id` for `job`, `id` for `sandbox`; and, on tools with a single person argument,
`handle(s)`, `user`, `org`, `entity`, `username`, `uri` or `id` for it. The names the tools used before
the camelCase rename (`ref`, `paper_ids`, `owners`, `submitter`, `length`, `comments_limit`, ...) are accepted too. An alias never overrides an
argument that was given, is never applied when the tool defines that name itself, and is skipped
when two arguments of the tool could claim it. Otherwise the error names the unknown argument, lists
the valid ones and describes any missing required argument. Closed value lists are
listed as enums (they double as search vocabulary); every enum argument, single or array, matches
case-insensitively (`sort: "Downloads"`), `fields`/`sort` values also accept snake spellings and Hub
expand names (`last_modified`, `inferenceProviderMapping`), and an unknown value fails with the list of valid values.

Default payloads are trimmed. Search results leave out `tags` unless `fields` asks for them, and
`hf_repo_info` returns `chatTemplate` and the `spaces` list only when they are named in `fields`.
Listing outputs carry `completeness` but no `source`, `truncation` or `mode`. `hf_papers_search`
has no continuation, so its `nextCursor` is always null.

## Metrics

`/api/ptc-metrics` (and the **PTC** tab) report counts since start (aggregated across cluster workers when `MCP_WORKERS > 1`): PTC requests by
access level, per-bouquet alias breakdown (`ptc`, `codemode`, `openaiptc`), calls and errors per tool, error codes, and the clients (`name@version` from
`initialize`, keyed by bouquet) that used the profile.
