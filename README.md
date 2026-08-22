# Hugging Face Official MCP Server 

<img src='https://github.com/evalstate/hf-mcp-server/blob/main/hf-logo.svg' width='100'>

Welcome to the official Hugging Face MCP Server 🤗. Connect your LLM to the Hugging Face Hub and thousands of Gradio AI Applications.

## Installing the MCP Server

Follow the instructions below to get started:

<details>
<summary>Install in <b>Claude Desktop</b> or <b>claude.ai</b></summary>
<br />

Click [here](https://claude.ai/redirect/website.v1.67274164-23df-4883-8166-3c93ced276be/directory/37ed56d5-9d61-4fd4-ad00-b9134c694296) to add the Hugging Face connector to your account. 

Alternatively, navigate to [https://claude.ai/settings/connectors](https://claude.ai/settings/connectors), and add "Hugging Face" from the gallery.

<img src='docs/claude-badge.png' width='50%' align='center' />

</details>

<details>
<summary>Install in <b>Claude Code</b></summary>
<br />

Enter the command below to install in <b>Claude Code</b>:

```bash
claude mcp add hf-mcp-server -t http https://huggingface.co/mcp?login
```

Then start `claude` and follow the instructions to complete authentication.

```bash
claude mcp add hf-mcp-server \
  -t http https://huggingface.co/mcp \
  -H "Authorization: Bearer <YOUR_HF_TOKEN>"
```


</details>

<details>
<summary>Install in <b>Gemini CLI</b></summary>
<br />

Enter the command below to install in <b>Gemini CLI</b>:

```bash
gemini mcp add -t http huggingface https://huggingface.co/mcp?login
```

Then start `gemini` and follow the instructions to complete authentication.

</details>

<details>

<summary>Install in <b>VSCode</b></summary>
<br />

Click <a href="vscode:mcp/install?%7B%22name%22%3A%22huggingface%22%2C%22gallery%22%3Atrue%2C%22url%22%3A%22https%3A%2F%2Fhuggingface.co%2Fmcp%3Flogin%22%7D">here</a> to add the Hugging Face connector directly to VSCode. Alternatively, install from the gallery at [https://code.visualstudio.com/mcp](https://code.visualstudio.com/mcp): 

<img src='docs/vscode-badge.png' width='50%' align='center' />

If you prefer to configure manually or use an auth token, add the snippet below to your `mcp.json` configuration:


```JSON
"huggingface": {
    "url": "https://huggingface.co/mcp",
    "headers": {
        "Authorization": "Bearer <YOUR_HF_TOKEN>"
    }
```

</details>

<details>
<summary>Install in <b>Cursor</b></summary>
<br />

Click <a href="https://cursor.com/en/install-mcp?name=Hugging%20Face&config=eyJ1cmwiOiJodHRwczovL2h1Z2dpbmdmYWNlLmNvL21jcD9sb2dpbiJ9">here</a> to install the Hugging Face MCP Server directly in <b>Cursor</b>. 

If you prefer to use configure manually or specify an Authorization Token, use the snippet below:

```JSON
"huggingface": {
    "url": "https://huggingface.co/mcp",
    "headers": {
        "Authorization": "Bearer <YOUR_HF_TOKEN>"
    }
```
</details>

Once installed, navigate to https://huggingface.co/settings/mcp to configure your Tools and Spaces.

> [!TIP]
> Add ?no_image_content=true to the URL to remove ImageContent blocks from Gradio Servers.


![hf_mcp_server_small](https://github.com/user-attachments/assets/d30f9f56-b08c-4dfc-a68f-a164a93db564)


## Quick Guide (Repository Packages)

This repo contains:

 - (`/mcp`) MCP Implementations of Hub API and Search endpoints for integration with MCP Servers. 
 - (`/app`) An MCP Server and Web Application for deploying endpoints.

### MCP Server

The following transports are supported:

- STDIO 
- StreamableHTTP in Stateless JSON Mode (**StreamableHTTPJson**)

The Web Application and HTTP Transports start by default on Port 3000.

The StreamableHTTP service is available at `/mcp`. Although not strictly enforced by the specification, this is a common convention.

The public Streamable HTTP deployment serves its MCP Server Card at `/mcp/server-card`. The public card advertises the canonical `https://huggingface.co/mcp` endpoint without authentication-specific query parameters; loopback deployments and explicit non-Hugging Face hosts in `MCP_ALLOWED_HOSTS` advertise their own `/mcp` endpoint. Card responses support cache revalidation with an `ETag`.

The Web Application at `/metrics` reports server status and MCP method metrics. It can be placed behind an optional lightweight shared-password gate using `METRICS_PAGE_PASSWORD`. Browser visits to `/` redirect to the MCP welcome page at `/mcp`. Tool selection is resolved independently for each request from the optional Hugging Face user configuration API and the `bouquet`/`mix` query parameters. Note to security researches and bots, this is intentionally lightweight and not considered sensitive or protected data.

### Running Locally

You can run the MCP Server locally with either `npx` or `docker`. 

```bash
npx @llmindset/hf-mcp-server       # Start in STDIO mode
npx @llmindset/hf-mcp-server-http  # Start in stateless Streamable HTTP JSON mode
```

To run with docker: 

```bash
docker pull ghcr.io/evalstate/hf-mcp-server:latest
docker run --rm -p 3000:3000 ghcr.io/evalstate/hf-mcp-server:latest
```
![image](https://github.com/user-attachments/assets/2fc0ef58-2c7a-4fae-82b5-e6442bfcbd99)

All commands above start the Management Web interface on http://localhost:3000/metrics. Browser visits to http://localhost:3000/ redirect to the MCP welcome page at http://localhost:3000/mcp. See [Environment Variables](#Environment Variables) for configuration options. Docker defaults to Streamable HTTP (JSON RPC) mode.

## Development

This project uses `pnpm` for build and development. Corepack is used to ensure everyone uses the same pnpm version (10.12.3).

Benchmark harnesses, historical results, and optimization plans are maintained
in the separate [`hf-mcp-optimise`](docs/benchmarking.md) workspace.

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Build Commands

`pnpm run clean` -> clean build artifacts

`pnpm run build` -> build packages

`pnpm run start` -> start the mcp server application

`pnpm run buildrun` -> clean, build and start

`pnpm run dev` -> concurrently watch `mcp` and start dev server with HMR


## Docker Build

Build the image:
```bash
docker build -t hf-mcp-server .
```

Run with default settings (Streaming HTTP JSON Mode), with the dashboard at `/metrics` on Port 3000.
HTTP clients must send a Hugging Face token in the `Authorization: Bearer` header:
```bash
docker run --rm -p 3000:3000 hf-mcp-server
```

Run STDIO MCP Server:
```bash
docker run -i --rm -e TRANSPORT=stdio -p 3000:3000 -e DEFAULT_HF_TOKEN=hf_xxx hf-mcp-server
```

`TRANSPORT` can be `stdio` or `streamableHttpJson` (default).

### Transport Endpoints

The different transport types use the following endpoints:
- Stateless Streamable HTTP JSON: `/mcp`
- MCP Server Card for Streamable HTTP JSON: `/mcp/server-card`
- STDIO: Uses stdin/stdout directly, no HTTP endpoint

### Environment Variables

The server respects the following environment variables:
- `TRANSPORT`: The transport type to use (`stdio` or `streamableHttpJson`)
- `DEFAULT_HF_TOKEN`: Default token for local STDIO deployments. HTTP transports do not use this as a fallback for requests without an `Authorization: Bearer` header.
- If running with `stdio` transport, `HF_TOKEN` is used if `DEFAULT_HF_TOKEN` is not set.
- `MCP_ALLOWED_HOSTS`: Additional comma-separated Host allowlist for MCP and API routes. Loopback hosts `localhost,127.0.0.1,::1` are always allowed. Use exact hostnames or leading wildcard entries such as `*.example.com`.
- `HF_API_TIMEOUT`: Timeout for Hugging Face API requests in milliseconds (default: 12500ms / 12.5 seconds)
- `USER_CONFIG_API`: Optional URL for the per-user discovery projection returned by `tools/list`, including configured
  Spaces. These settings control which deployed tools are advertised, not whether a direct `tools/call` to a known tool
  may execute. Generated Gradio aliases still use the configured Space mapping. When unset, immutable built-in defaults
  are used.
- `ALLOW_INTERNAL_ADDRESS_HOSTS`: Optional comma-separated host allowlist to permit internal/reserved DNS resolutions for trusted domains during outbound checks (supports exact hosts and `*.` wildcards, for example: `huggingface.co,*.hf.space`).
- `MCP_STRICT_COMPLIANCE`: set to True for GET 405 rejects in JSON Mode (default serves a welcome page).
- `DISABLE_TOOLS`: Optional comma-separated tool names to hide from `tools/list` and reject if called, for example `hub_repo_search,hf_fs`. Rejected calls remain visible as errors in the MCP dashboard tool-call statistics.
- `PROXY_TOOLS_CSV`: Optional CSV that defines Streamable HTTP proxy tool sources (see below).
- `PROXY_TOKEN`: Optional token used only for startup authentication while discovering `PROXY_TOOLS_CSV` schemas.
- `GRADIO_SKIP_INITIALIZE`: When set to `true`, Gradio MCP calls skip the `initialize` handshake and issue `tools/call` directly.
- `METRICS_PAGE_PASSWORD`: Optional shared password for the Management Web interface at `/metrics` and its `/api/*` endpoints. When unset or empty, the interface remains public. This does not protect `/mcp` or `/mcp/server-card`.
- `HF_SKILLS_DIR`: Local directory containing a prebuilt [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) skills snapshot: `skills.json` carries each skill's `uri`, complete `frontmatter`, and per-file `{uri,digest}` resource manifest, alongside the expanded skill directories. On HTTP transports, the server verifies every raw SHA-256 digest and checks the actual `SKILL.md` frontmatter before atomically retaining all files in memory. Snapshots have a three-hour freshness TTL; stale requests keep using the last valid snapshot while one background refresh is loaded and verified, and refresh failures retain that verified snapshot with a five-minute retry delay. The HTTP server implements `skills/list`, `skills/get`, `resources/read`, and optional `resources/directory/read`, and advertises `io.modelcontextprotocol/skills` with `directoryRead: true` only when a valid snapshot is available. Skills are not exposed over the long-lived STDIO transport. Defaults to `/mnt/hf-skills/distribution/latest`, intended for a Hugging Face Space volume mounted from `hf://buckets/huggingface/skills`.
- `LOG_SKILL_EVENTS`: Enables historical product-usage logging for SEP-2640 Skills probes when `LOGGING_DATASET_ID` and a logging token are configured (default: `true`). Events are written under `skills/YYYY-MM-DD/`, separately from tool queries, and contain client/protocol correlation, success, duration, cursor presence, aggregate result counts, and the requested `skill://` URI for targeted get/read operations. Cursor values, frontmatter, resource content, response bodies, and error messages are not recorded.

#### Optional Management Interface Password

Set `METRICS_PAGE_PASSWORD` to a non-empty value to enable a lightweight shared-password gate for the Management Web interface and its API endpoints:

- Browser visits to `/` redirect to `/mcp`. Visits to `/metrics` are redirected to `/metrics/login` until the password is accepted.
- A successful login redirects back to `/metrics`.
- A successful login stores a signed, 30-day `HttpOnly`, `SameSite=Lax` cookie. HTTPS requests also receive the `Secure` cookie attribute.
- `/api/transport`, `/api/sessions`, and `/api/transport-metrics` require the cookie or a valid scraper credential.
- `/mcp` and the public `/mcp/server-card` are not affected.

This is intended only to discourage casual browsing. It has no users, roles, rate limiting, or audit trail and is **not a substitute for real authentication, HTTPS, or access control at the platform/reverse-proxy layer**.
When HTTPS terminates at a reverse proxy, the proxy must overwrite `X-Forwarded-Proto` with the actual client protocol so the application can apply the cookie's `Secure` attribute correctly.

For a Hugging Face Space, configure this as a **Space secret** in the Space settings. A GitHub Actions secret is not automatically passed to a running Space by this repository's workflows. With the Hugging Face CLI, the equivalent command is:

```bash
hf spaces secrets add <org>/<space> -s METRICS_PAGE_PASSWORD='<shared-password>'
```

Automated scrapers can send the password in a header:

```bash
curl --fail-with-body --silent --show-error \
  -H "X-Metrics-Password: ${METRICS_PAGE_PASSWORD}" \
  https://your-space.hf.space/api/transport-metrics
```

For simple URL-based jobs, a URL-encoded query parameter is also accepted:

```bash
curl --fail-with-body --silent --show-error --get \
  --data-urlencode "metrics_password=${METRICS_PAGE_PASSWORD}" \
  https://your-space.hf.space/api/transport-metrics
```

Prefer the header where possible. Query-string passwords can be retained in reverse-proxy or access logs, monitoring systems, shell process listings, and browser history even though the application does not log the credential itself.


To expose the shared Hugging Face skills catalog from a Space, mount the bucket and keep `HF_SKILLS_DIR` pointed at its latest distribution directory:

```bash
hf spaces volumes set <org>/<space> -v hf://buckets/huggingface/skills:/mnt/hf-skills:ro
hf spaces variables add <org>/<space> -e HF_SKILLS_DIR=/mnt/hf-skills/distribution/latest
```

### Proxy tools (Streamable HTTP via CSV)

You can load proxy tool definitions at startup by setting `PROXY_TOOLS_CSV` to a **HTTPS URL** or a **local file path**.
If those proxy servers require authentication, set `PROXY_TOKEN`. User, default, and logging tokens are never used
for startup proxy schema discovery.
The server fetches each MCP endpoint once on startup, runs `initialize` + `tools/list` (10s timeout), and registers any tools returned.
If a source fails or returns no tools, it is skipped (no startup failure).

**CSV format**

```
tool_name,url,response_type
papers,https://evalstate-hf-papers.hf.space/mcp,SSE
news,https://example.com/mcp,JSON
```

- `tool_name`: local tool name for single-tool upstreams; identifier for the proxy source when the upstream exposes
  multiple tools.
- `url`: Streamable HTTP MCP endpoint.
- `response_type`: legacy compatibility field; `SSE` and `JSON` are both accepted. Proxy calls can still consume
  upstream Streamable HTTP responses, while this server always returns direct JSON-RPC responses to its clients.

**Tool naming**

Tool naming depends on how many tools the upstream MCP endpoint returns:

- Single upstream tool: the exposed tool name is the first CSV column.
- Multiple upstream tools: the exposed tool names are the upstream tool names.

If an exposed proxy tool name collides with an already-registered tool, the proxy tool is skipped and a warning is
logged.

You can include these tool names in bouquets or mixes to advertise them through `tools/list`.
Use `bouquet=proxy` or `mix=proxy` to advertise all proxy tools loaded from `PROXY_TOOLS_CSV` (in addition to the base
built-in tools). Direct calls to a known startup-configured proxy tool do not depend on that discovery selection.
