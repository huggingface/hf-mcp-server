# PTC toolset (`?bouquet=ptc`)

The toolset for programmatic tool calling clients. One typed function per operation, structured
output, and the `hf://` thread: every Hub resource record carries `kind/id/uri/url`, and every argument naming a
Hub resource is a `Ref` that accepts that `uri` verbatim (or an `owner/name` ID or a huggingface.co
URL). Served by the same MCP server as the legacy bouquets, but nothing here is shared with them at
the MCP surface: no legacy tool is ever registered in this profile.

Plan, parity matrix and tool-search evidence: `docs-internal/ptc-parity/` (report.html).

## Layout

| Path                | Purpose                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Registry: `PTC_TOOLS`, `getPtcTool`, `ptcToolsForAccess`, public exports                                                           |
| `instructions.ts`   | The one-line PTC server instructions (see the comment for why it is one line)                                                      |
| `core/tool.ts`      | `definePtcTool`, `callPtcTool`, `PtcContext`, `PtcResult`, access levels, annotation presets                                       |
| `core/errors.ts`    | `PtcError` (sanitized, coded), `ptcHttpError`, `toPtcError`                                                                        |
| `core/hub-http.ts`  | `hubFetch` (bounded, cancellable Hub / Dataset Viewer request), `requestPage` (Link-paginated listings), `sealCursor`/`openCursor` |
| `core/refs.ts`      | `Ref` parsing, `hf://` URI/URL builders (`parseRef`, `repoItem`, `fileItem`, ...), person arguments (`personRefSchema`)            |
| `listing/`          | Shipped internals of the four listing tools (schemas, SearchBuilder query, records)                                                |
| `tools/<family>.ts` | Tool definitions per family; each exports `<FAMILY>_TOOLS`                                                                         |

## Conventions for tool authors

- **Define** tools with `definePtcTool({ name, family, title, description, input, output, access, annotations, run })`.
  Input and output are strict `z.object` schemas. `callPtcTool` validates both; `run` never re-validates input.
- **Advertised output schemas** (`core/wire-schema.ts`): `tools/list` lists a smaller, open form of each output
  contract (no field docs except root `returned_count`/`next_cursor`/`next_offset`, no validation keywords, records typed
  one level deep, deeper objects open except Hub references and small flat objects). Results are unchanged and still
  validated against the full zod contract; `wire-schema.test.ts` guards openness and the byte budget.
- **Arguments** (`core/arguments.ts`): `advertisedInputSchema` (registered with the SDK) and `callPtcTool` both
  map unambiguous habitual names (`repo_id`, `repo_type`, `dataset_id`, `url`, `q`, ...) and the record field a value
  came from (`uri`, `url`, `id`, person names on single-person tools) to the tool's own arguments, never overriding a
  given or tool-defined name and skipping names two arguments could claim; they report unknown/missing arguments with
  the valid names and the field doc. It also lists the input schema without
  `$schema` and zod's ±(2^53−1) integer bounds. Input field docs are capped at 80 chars (`registry.test.ts`).
- **Access** (listing is filtered on token permission only):
  `anonymous` (public reads), `authenticated` (needs any token: whoami, job reads),
  `write` (creates, writes, runs or spends: repo create/write, job run/cancel, sandboxes).
- **Annotations**: `READ_ONLY`, `MUTATING` or `DESTRUCTIVE` from `core/tool.ts`. Never mix
  destructive and benign actions in one tool. A tool that can start paid compute (job run/schedule,
  `hf_job_update` run_now, sandboxes) or delete/overwrite data is `DESTRUCTIVE`, so clients confirm
  it; `hf_space_invoke` is `MUTATING` (no paid compute, nothing deleted on the caller's account).
- **Cancellation and budgets**: pass `ctx.signal` to every client (hubFetch does it; reused clients
  take it explicitly), and bound upstream bodies while streaming (`network/read-capped.ts`), never
  after a full `text()`/`json()`. Redact secrets before any truncation.
- **Errors**: throw `PtcError` with a code for expected failures. Anything else is converted by
  `toPtcError`; never put upstream bodies, URLs with credentials, tokens or file contents in messages.
- **HTTP**: use `hubFetch`/`requestPage` (HUB_ORIGIN or DATASETS_SERVER_ORIGIN), passing `ctx` so the
  token, signal, timeout and test `fetch` apply. Reusing an existing helper (`@huggingface/hub`,
  `HfFsTool`, `JobsApiClient`, sandbox clients) is fine; pass `ctx.hfToken` and map errors.
- **Refs**: accept resources as `refSchema` strings and parse with `parseRef`. Return `uri` values
  built by `repoItem`/`fileItem`/`paperItem`/`collectionItem`/`docItem` so they round-trip.
- **People**: every argument naming a user or organization uses `personRefSchema` (or `parsePersonRef` for
  per-item batch parsing) from `core/refs.ts`: a name, `@name` or the profile URL. A person uri scheme is added there.
  Hub names are case-insensitive but some filters compare exactly (listing `author=`, activity `entity=`): resolve
  with `canonicalPersonName(s)` (`core/person.ts`) and emit names from upstream bodies, never the caller's input.
- **Input docs** point at the producer when it is not obvious (e.g. `job_id`: id from hf_jobs_list; `revision`:
  hf_repo_history items[].id), within the 80-char cap.
- **Closed value lists are enums** in `tools/list`, including long ones (`category`, `providers_any`, ...): the
  values are search vocabulary for tool-search clients. Input is matched case-insensitively (`listing/schemas.ts`).
- **Link pagination**: `requestPage` rejects a next Link whose query differs from the request, so send
  every parameter the upstream echoes in its Link (e.g. collections echo `sort`, `expand`, `limit`).
- **Pages**: lists return `{ items, returned_count, next_cursor, completeness }`. `returned_count` is
  `items.length`, never a total. Continuations are opaque (`requestPage` or `sealCursor`), bound to the
  arguments and token. Cursors are HMAC-signed with `PTC_CURSOR_SECRET` (or a fixed built-in key, which keeps them valid
  across replicas and restarts), so they cannot be edited or reused with other arguments. Never invent totals or exhaustion.
- **Budgets**: bound every response (items, bytes, characters). Text reads default to 20 KB, max 80 KB,
  with `next_offset`; images are complete or rejected (8 MiB).
- **Media**: return `new PtcResult(structured, contentBlocks)` to attach images/audio.
- **Descriptions**: lead with "<Verb> Hugging Face <resource + user synonyms>" in the first ~100
  characters, user vocabulary (model card, license, GGUF, demo, GPU...), at most one "see <tool>"
  pointer by name, no parameter dump, 250-650 characters. Field semantics belong in `.describe()`.
- **Tests**: `tools/<family>.test.ts`, mocking `ctx.fetch` (or the reused client). No live network.
