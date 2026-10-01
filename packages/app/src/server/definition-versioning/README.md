# Definition digests (application extension, v2)

Prototype of the MCP "Definition Versions" SEP. No SDK or client changes are
required, and no capability is advertised: digests are advisory.

Results carry a single top-level `digest` field beside `ttlMs` and `cacheScope`,
as proposed for `CacheableResult`. What it covers is fixed by the result type, so
the key is not on the wire in responses. Clients hold one digest per result type
and send them back as a keyed map in request `_meta`. (v1 put a keyed map in
result `_meta`; the hash inputs are unchanged, so digest values are the same.)

The SDK's result schemas are loose objects, so an extra top-level field passes
validation on both sides without any schema change.

## When digests are offered

Digests (and digest checks) are only offered where the **complete tool list is
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

- `tools/list` adds `digest` covering the complete tool list.
- `server/discover` adds `digest` covering the instructions text, and only when
  the handler returns the configured instructions. It does not carry the tools
  digest; that comes from `tools/list`. Discovery uses the same selection as
  `tools/list` (cheap by eligibility).
- `tools/list` and `server/discover` carry cache hints (`ttlMs`, default 5 min;
  `cacheScope: private`). Hints only affect 2026-era
  responses.
- `tools/call` with known digests is checked before tool lookup, argument
  validation or execution.

**Ineligible** requests behave exactly as before: no digests, SDK-default cache
hints (`ttlMs: 0`, `private`), cheap discovery (`BOUQUET_FALLBACK`, no Gradio), the
direct-call shortcuts, and known digests are ignored.

## Known digests

Clients may send `tools/call.params._meta["huggingface.co/known-digests"]`, a map
from collection key to the digest they hold:

```json
{ "tools": "sha256:<64 hex>", "instructions": "sha256:<64 hex>" }
```

These are hints. Unknown keys (e.g. `prompts`) and non-string values are
ignored; a non-object value is treated as no hint. Any string is compared for
equality, so an unrecognized digest is simply stale. The server never returns
`-32602` for this field.

A mismatch is JSON-RPC error **`-32987`** (`DIGEST_MISMATCH`; outside
JSON-RPC's reserved range `-32768..-32000`) with
`data: { stale: ["tools" | "instructions", ...] }`. Current digests are not
returned: refresh the definitions (bypassing any client cache) and reconsider the
call rather than blindly retrying writes.

## Digest algorithm

1. Take the SDK's actual enabled-tool listing (all fields, including tool `_meta`).
2. Sort tools by name (JS ordinal comparison); keep array order inside definitions;
   normalize via JSON, sort object keys, emit compact JSON.
3. Instructions are `{present:false}` when absent, else `{present:true,value}`.
4. SHA-256 over `huggingface.co/definition-versioning/v1/<target>\n`, then
   `salt:<salt>\n` when a salt is set, then the canonical JSON.

Result-envelope metadata (TTL, cursors, server info) is not covered. Discovery only
advertises an instructions digest when its instructions match the string used for
checks. Cost is well under 1 ms per checked call for current lists.

## Configuration

| Variable                        | Effect                                                                   |
| ------------------------------- | ------------------------------------------------------------------------ |
| `DEFINITION_VERSIONING=off`     | Kill switch: no digests, checks or cache hints anywhere.                 |
| `DEFINITION_VERSIONS_TTL_MS`    | TTL for eligible list/discovery results (default `300000`; `0` allowed). |
| `DEFINITION_VERSIONS_SALT`      | Deploy-wide salt; changing it invalidates every client's versions.       |
| `DEFINITION_VERSIONS_TEST=true` | Enables the runtime test salt endpoint below.                            |

## Testing clients

With `DEFINITION_VERSIONS_TEST=true`, the runtime salt is mixed into every version.
Changing it changes all advertised digests without changing definitions, so a
connected client sees `-32987` on its next checked call and must refresh:

```bash
# set a specific salt (or omit value= for a random one)
curl -X POST 'https://host/api/definition-versions/salt?value=v2' -H 'X-Metrics-Password: ...'
curl 'https://host/api/definition-versions' -H 'X-Metrics-Password: ...'          # read
curl -X DELETE 'https://host/api/definition-versions/salt' -H 'X-Metrics-Password: ...' # clear
```

The endpoint returns 404 unless test mode is on, and sits under `/api`, so the
metrics-page password applies when one is configured (without one, `/api` is open).
The salt is per process: with several replicas, set it on each or digests will flap.

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
