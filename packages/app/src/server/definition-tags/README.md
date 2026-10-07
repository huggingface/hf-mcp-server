# Definition tags

Implementation of the MCP "Definition Tags" SEP (draft; see
`transports-wg/proposals/XXXX-definition-tags.md`). No SDK or client changes are
required, and no capability is advertised: tags are advisory.

Results carry a single top-level `tag` field beside `ttlMs` and `cacheScope`, as
proposed for `CacheableResult`. What it covers is fixed by the method that produced
the result, so the method is not on the wire in responses. Clients hold one tag per
method and send them back as a map keyed by method in request `_meta`
(`io.modelcontextprotocol/knownTags`).

The SDK's result schemas are loose objects, so an extra top-level field passes
validation on both sides without any schema change.

| Method            | Tag covers                                                      | Checked on `tools/call` |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| `tools/list`      | the complete tool list                                          | yes                     |
| `server/discover` | `supportedVersions`, `capabilities` and `instructions` together | yes                     |
| `skills/list`     | the complete skills catalog (entries, not the files)            | no (tag only)           |

The server honours neither old tags nor "honor and signal": it either ignores
hints (ineligible requests) or rejects stale ones.

## When tags are offered

Tags (and tag checks) are only offered where the **complete tool list is
cheap to build**: no per-user settings fetch, and at most the default Gradio Space
(whose metadata and schema are cached). See `policy.ts`.

| Request                                                                          | Eligible |
| -------------------------------------------------------------------------------- | -------- |
| Anonymous (no token, or `?anon`), no gradio selection                            | yes      |
| Named bouquet other than `all` (`?bouquet=search`), no gradio selection          | yes      |
| Authenticated without a bouquet, or with `bouquet=all` (settings fetch / Gradio) | no       |
| Explicit gradio selection other than `none`                                      | no       |
| stdio                                                                            | no       |

Cache hints are always `private`. `public` would mean every caller gets the same
result, not just that it holds no user data. An anonymous tool list leaves out the
tools that need a sign-in, so a signed-in caller sharing a cache would be served the
shorter list. (The TypeScript client also keys shared entries by server name, not
URL, so different bouquets would collide.)

`?anon` forces anonymous handling: the `Authorization` header is dropped before
authentication (and wins over `?login`/`?auth`/`?forceauth`). This is useful for
clients that send a token by default.

**Eligible** requests:

- `tools/list` adds `tag` covering the complete tool list.
- `server/discover` adds `tag` covering its payload without the envelope
  (`supportedVersions`, `capabilities`, `instructions`). It does not carry the
  tools tag; that comes from `tools/list`. Calls are checked against the same
  discovery handler, so the two agree by construction. Discovery uses the same
  selection as `tools/list` (cheap by eligibility).
- `tools/list` and `server/discover` carry cache hints (`ttlMs`, default 5 min;
  `cacheScope: private`). Hints only affect 2026-era
  responses.
- `tools/call` with known tags is checked before tool lookup, argument
  validation or execution: normally by string comparison in the transport (see
  [Checking calls](#checking-calls)).

**Ineligible** requests behave exactly as before: no tags, SDK-default cache
hints (`ttlMs: 0`, `private`), cheap discovery (`BOUQUET_FALLBACK`, no Gradio), the
direct-call shortcuts, and known tags are ignored.

## Skills

`skills/list` carries a `tag` on every page whenever tags are enabled and the
request is 2026-era (the same condition as its `ttlMs`/`cacheScope`). The catalog is
public and immutable per snapshot, so this does not depend on the eligibility rules
above, and the tag is memoized per snapshot. It covers the protocol-facing catalog
entries ordered by URI, not the page in hand, and not the skill files, which carry
their own content `digest`s. Known `skills/list` tags are not checked.

## Known tags

Clients may send `tools/call.params._meta["io.modelcontextprotocol/knownTags"]`, a map
from the method that produced each tag to the tag they hold:

```json
{ "tools/list": "sha256:<64 hex>", "server/discover": "sha256:<64 hex>" }
```

These are hints. Methods not checked here (e.g. `prompts/list`, `skills/list`) and
non-string values are ignored; a non-object value is treated as no hint. Superseded
keys (`io.modelcontextprotocol/knownDigests`, `huggingface.co/known-digests`,
`huggingface.co/expected-definition-versions`) are ignored like any other unknown
`_meta` key. Any string is compared for equality, so an unrecognized tag is simply
stale. The server never returns `-32602` for this field. Only the tags the client
sent are computed.

A mismatch is JSON-RPC error **`-32987`** (`TAG_MISMATCH`; outside JSON-RPC's
reserved range `-32768..-32000`; the SEP has not allocated a standard code) with
`data.staleTags` mapping each stale method to the tag the client sent:

```json
{ "staleTags": { "tools/list": "sha256:<the client's stale tag>" } }
```

Current tags are never returned. Echoing the client's own tag lets it ignore a
late response that refers to a tag it has already replaced. Refresh the
definitions (bypassing any client cache) and reconsider the call rather than
blindly retrying writes.

## Checking calls

For eligible requests the current tags depend only on the deployed code, the salt
and the request's selection, so they are remembered per process (`memo.ts`) and a
checked call is a string comparison in the transport:

- **Match:** the call keeps the per-request shortcuts (single-tool server, no
  Gradio setup) exactly like an unchecked call; the adapter does not re-check.
- **Remembered mismatch:** rejected with `-32987` before any server is built.
- **Nothing remembered** (cold process, expired entry, or a key the memo has not
  seen): the call takes the full path once; the adapter computes the tags it needs,
  checks, and remembers them. `tools/list` and `server/discover` also remember the
  tags they return.

The memo key covers every input to the tool list and discovery result: all
`x-mcp-*` selection headers, the identified user (requests with a token but no
identified user are never memoized), client name, user agent, protocol version,
`DISABLE_TOOLS` and the salt. Changing the salt therefore changes the key, and
every client mismatches on its next call. Entries expire with the Gradio metadata
and schema caches (`GRADIO_SCHEMA_CACHE_TTL`/`GRADIO_SPACE_CACHE_TTL`, default 5
min), the only definitions that can change without a deploy; at most 10,000
selections are kept (least recently written evicted). The dashboard's "Memo checks"
counts calls answered this way.

## Tag algorithm

1. Take the payload with the envelope removed (`resultType`, `_meta`, `ttlMs`,
   `cacheScope`, `tag`, `nextCursor`). For `tools/list` that is
   `{ tools }` from the SDK's actual enabled-tool listing (all fields, including
   tool `_meta`); for `skills/list`, `{ skills }` over the whole catalog.
2. Sort collections by identity (tool name, skill URI; JS ordinal comparison;
   duplicates are an error); keep array order inside definitions; normalize via
   JSON, sort object keys, emit compact JSON. Absent and empty instructions differ.
3. SHA-256 over `huggingface.co/definition-tags/v1/<method>\n`, then
   `salt:<salt>\n` when a salt is set, then the canonical JSON.

Cost is well under 1 ms per checked call for current lists.

## Configuration

| Variable                    | Effect                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| `DEFINITION_TAGS=off`       | Kill switch: no tags, checks or cache hints anywhere.                    |
| `DEFINITION_TAGS_TTL_MS`    | TTL for eligible list/discovery results (default `300000`; `0` allowed). |
| `DEFINITION_TAGS_SALT`      | Deploy-wide salt; changing it invalidates every client's tags.           |
| `DEFINITION_TAGS_TEST=true` | Enables the runtime test salt endpoint below.                            |

## Testing clients

With `DEFINITION_TAGS_TEST=true`, the runtime salt is mixed into every tag.
Changing it changes every advertised tag without changing definitions, so a
connected client sees `-32987` on its next checked call and must refresh:

```bash
# set a specific salt (or omit value= for a random one)
curl -X POST 'https://host/api/definition-tags/salt?value=v2' -H 'X-Metrics-Password: ...'
curl 'https://host/api/definition-tags' -H 'X-Metrics-Password: ...'          # read
curl -X DELETE 'https://host/api/definition-tags/salt' -H 'X-Metrics-Password: ...' # clear
```

The endpoint returns 404 unless test mode is on, and sits under `/api`, so the
metrics-page password applies when one is configured (without one, `/api` is open).
The salt is per process: with several replicas, set it on each or tags will flap.

## Integration and boundaries

The transport computes the policy once per request and passes it to the server
factory, which installs the adapter and cache hints only when it is present. The
adapter is installed before the first `registerTool`; its finalizer supports an
empty registry. It intercepts `setRequestHandler` registration and wraps the SDK
list, call and discovery handlers outside lookup, schema validation and callback
error conversion. Listings are unpaginated; a paginated registry would need a
collection-wide snapshot. Instructions must be the string passed to `McpServer`;
runtime instruction mutation is not supported. This protects definition identity,
not authorization or remote HF state.
