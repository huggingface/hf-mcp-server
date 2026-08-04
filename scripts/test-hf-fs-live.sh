#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-.env.test}"
BASE_URL="${HF_FS_LIVE_BASE_URL:-http://localhost:3000}"
MCP_URL="$BASE_URL/mcp"
TMP="$(mktemp -d)"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]]; then
		kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for command in curl jq pnpm; do
	command -v "$command" >/dev/null || {
		echo "Missing required command: $command" >&2
		exit 1
	}
done

if ! curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null 2>&1; then
	echo "Building MCP package..."
	cd "$ROOT"
	pnpm -C packages/mcp build >"$TMP/build.log" 2>&1 || {
		cat "$TMP/build.log" >&2
		exit 1
	}
	echo "Starting test server..."
	setsid ./start-test-server.sh "$ENV_FILE" >"$TMP/server.log" 2>&1 &
	SERVER_PID=$!

	for _ in $(seq 1 120); do
		curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null 2>&1 && break
		kill -0 "$SERVER_PID" 2>/dev/null || {
			cat "$TMP/server.log" >&2
			exit 1
		}
		sleep 1
	done
	curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null || {
		cat "$TMP/server.log" >&2
		exit 1
	}
	# dev:watch may restart the server once after its initial TypeScript/Vite build settles.
	sleep 3
	curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null || {
		cat "$TMP/server.log" >&2
		exit 1
	}
else
	echo "Using existing server at $BASE_URL"
fi

curl -fsS --max-time 60 -D "$TMP/init.headers" \
	-H 'Content-Type: application/json' \
	-H 'Accept: application/json, text/event-stream' \
	--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hf-fs-live","version":"1.0.0"}}}' \
	"$MCP_URL" >"$TMP/init.json"

SESSION="$(awk 'BEGIN { IGNORECASE=1 } /^Mcp-Session-Id:/ { gsub("\r", ""); print $2 }' "$TMP/init.headers")"
[[ -n "$SESSION" ]] || {
	echo "Server did not return Mcp-Session-Id" >&2
	exit 1
}

ID=1
call_hf_fs() {
	local name=$1
	local cmd=$2
	local args=$3
	ID=$((ID + 1))
	jq -nc --argjson id "$ID" --arg cmd "$cmd" --argjson args "$args" \
		'{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:"hf_fs",arguments:{cmd:$cmd,args:$args}}}' \
		>"$TMP/request.json"
	curl -fsS --max-time 60 \
		-H 'Content-Type: application/json' \
		-H 'Accept: application/json, text/event-stream' \
		-H "Mcp-Session-Id: $SESSION" \
		--data-binary @"$TMP/request.json" \
		"$MCP_URL" >"$TMP/$name.json"
	jq -e '.result.isError != true and .result.structuredContent != null' "$TMP/$name.json" >/dev/null || {
		jq . "$TMP/$name.json" >&2
		exit 1
	}
}

call_hf_fs_error() {
	local name=$1
	local cmd=$2
	local args=$3
	ID=$((ID + 1))
	jq -nc --argjson id "$ID" --arg cmd "$cmd" --argjson args "$args" \
		'{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:"hf_fs",arguments:{cmd:$cmd,args:$args}}}' \
		>"$TMP/request.json"
	curl -fsS --max-time 60 \
		-H 'Content-Type: application/json' \
		-H 'Accept: application/json, text/event-stream' \
		-H "Mcp-Session-Id: $SESSION" \
		--data-binary @"$TMP/request.json" \
		"$MCP_URL" >"$TMP/$name.json"
	jq -e '.result.isError == true' "$TMP/$name.json" >/dev/null || {
		jq . "$TMP/$name.json" >&2
		exit 1
	}
}

pass() {
	echo "✓ $1"
}

ID=$((ID + 1))
jq -nc --argjson id "$ID" \
	'{jsonrpc:"2.0",id:$id,method:"tools/list",params:{}}' >"$TMP/request.json"
curl -fsS --max-time 60 \
	-H 'Content-Type: application/json' \
	-H 'Accept: application/json, text/event-stream' \
	-H "Mcp-Session-Id: $SESSION" \
	--data-binary @"$TMP/request.json" \
	"$MCP_URL" >"$TMP/tools.json"
jq -e '
	(.result.tools[] | select(.name == "hf_fs")
		| (.inputSchema.required | sort) == ["args","cmd"]
			and (.inputSchema.properties | has("op") | not)
			and (.inputSchema.properties | has("uri") | not)
			and (.description | contains("Grammar; each token below is one args array element"))
			and (.description | contains("ls hf://papers/trending")))
' "$TMP/tools.json" >/dev/null || {
	echo "hf_fs tools/list contract check failed:" >&2
	jq '.result.tools[] | select(.name == "hf_fs")' "$TMP/tools.json" >&2
	exit 1
}
pass 'tools/list exposes the hf_fs grammar'

call_hf_fs root ls '["ls","hf://"]'
jq -e '.result.structuredContent.entries | map(.path) | (index("README.md") != null and index("papers") != null and index("docs") != null)' \
	"$TMP/root.json" >/dev/null
pass 'root lists README.md, papers, and docs while tolerating a duplicated command token'

call_hf_fs readme cat '["hf://README.md","--max-bytes","4000"]'
jq -e '.result.structuredContent.content | contains("## Limits") and contains("hf://models/trending")' \
	"$TMP/readme.json" >/dev/null
pass 'virtual README documents contextual limits and trending directories'

call_hf_fs papers ls '["hf://papers","--limit","10"]'
jq -e '.result.structuredContent as $r | ($r.entries[0:3] | map(.path)) == ["README.md","daily","trending"] and ($r.entries[0].description | contains("hf://papers/2502.16161/paper.md")) and ($r.entries[3:] | length == 10 and all(.[]; .type == "paper" and (.uri | startswith("hf://papers/")))) and $r.truncated == true and $r.truncation_reason == "provider_limit"' \
	"$TMP/papers.json" >/dev/null
pass 'Papers root lists bounded views and 10 recent canonical paper samples'

call_hf_fs daily_root ls '["hf://papers/daily","--limit","10"]'
jq -e '.result.structuredContent.entries[0] | .path == "latest" and .uri == "hf://papers/daily/latest" and (.target_uri | startswith("hf://papers/daily/")) and .daily_papers_date != null' \
	"$TMP/daily_root.json" >/dev/null
pass 'Daily Papers root exposes the latest alias'

call_hf_fs daily_latest ls '["hf://papers/daily/latest","--limit","3"]'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "paper" and .daily_papers_date != null and (.daily_papers_uri | startswith("hf://papers/daily/")))' \
	"$TMP/daily_latest.json" >/dev/null
PAPER_URI="$(jq -r '.result.structuredContent.entries[0].uri' "$TMP/daily_latest.json")"
pass 'daily/latest resolves a dated Daily Papers batch'

call_hf_fs trending ls '["hf://papers/trending","--recursive","--limit","3"]'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "paper" and .observed_at != null)' \
	"$TMP/trending.json" >/dev/null
pass 'trending is a bounded index and recursive ls does not follow paper edges'

call_hf_fs paper_stat stat "$(jq -nc --arg uri "$PAPER_URI" '[$uri]')"
jq -e '.result.structuredContent | .exists == true and .type == "paper" and .url != null and .arxiv_url != null' \
	"$TMP/paper_stat.json" >/dev/null
pass 'Daily Paper stat resolves canonical web metadata'

for resource in models datasets spaces; do
	call_hf_fs "${resource}_root" ls "$(jq -nc --arg uri "hf://$resource" '[$uri]')"
	jq -e --arg uri "hf://$resource/trending" \
		'.result.structuredContent.entries == [{"type":"dir","path":"trending","name":"trending","uri":$uri,"description":("Browse the 20 currently trending " + ($uri | split("/")[2]) + ".")}]' \
		"$TMP/${resource}_root.json" >/dev/null
	pass "$resource root exposes its virtual trending directory"
done

call_hf_fs models_trending ls \
	'["hf://models/trending","--sort","trendingScore","--type","model","--limit","2"]'
jq -e '
	.result.structuredContent as $r
	| ($r.entries | length > 0 and length <= 2 and all(.[]; .type == "repo" and .repo_type == "model"))
		and ($r.warnings | length == 2)
' "$TMP/models_trending.json" >/dev/null
pass 'model trending uses argv aliases and reports redundant arguments'

for resource in datasets spaces; do
	call_hf_fs "${resource}_trending" ls "$(jq -nc --arg uri "hf://$resource/trending" '[$uri,"--limit","2"]')"
	jq -e --arg type "${resource%s}" \
		'.result.structuredContent.entries | length > 0 and length <= 2 and all(.[]; .type == "repo" and .repo_type == $type)' \
		"$TMP/${resource}_trending.json" >/dev/null
	pass "$resource trending returns typed repository entries"
done

call_hf_fs namespace_sort ls '["hf://models/openai","--sort","downloads","--limit","2"]'
jq -e '.result.structuredContent.entries | length == 2 and all(.[]; .type == "repo" and .repo_type == "model")' \
	"$TMP/namespace_sort.json" >/dev/null
pass 'owner namespace listing honors explicit sort and limit'

call_hf_fs_error trending_limit ls '["hf://models/trending","--limit","21"]'
jq -e '.result.content | map(.text // "") | join("\n") | contains("limit must be between 1 and 20")' \
	"$TMP/trending_limit.json" >/dev/null
pass 'contextual trending limit errors are returned through MCP'

REPO='hf://models/openai/gpt-oss-20b'
call_hf_fs find_json find "$(jq -nc --arg uri "$REPO" \
	'[$uri,"-type","f","-name","*.json","-path","**/*.json","--limit","5"]')"
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "file" and (.path | endswith(".json")))' \
	"$TMP/find_json.json" >/dev/null
pass 'recursive find accepts short aliases and works with expand=false'

call_hf_fs find_exact find "$(jq -nc --arg uri "$REPO/config.json" \
	'[$uri,"--type","file","--name","config.json","--path","config.json"]')"
jq -e '.result.structuredContent.entries | length == 1 and .[0].path == "config.json"' \
	"$TMP/find_exact.json" >/dev/null
pass 'exact-file find uses stat behavior'

call_hf_fs find_nested find "$(jq -nc --arg uri "$REPO/original" \
	'[$uri,"--entry-type","file","--name","*.json","--path","*.json","--limit","10"]')"
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .path | startswith("original/"))' \
	"$TMP/find_nested.json" >/dev/null
pass 'nested find filters relative paths and emits repo-root paths'

call_hf_fs docs_root ls '["hf://docs"]'
jq -e '
	.result.structuredContent.entries as $entries
	| all(["hub","transformers","diffusers","peft","huggingface_hub","inference-providers","tgi","tei"][];
		. as $product | any($entries[]; .path == $product and .type == "dir"))
' "$TMP/docs_root.json" >/dev/null
pass 'docs root lists manifest-backed production products, including catalog aliases'

call_hf_fs docs_recursive_glob ls '["hf://docs","--recursive","--glob","transformers/**/*.md","--limit","5"]'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "file" and (.path | startswith("transformers/")) and (.path | endswith(".md")))' \
	"$TMP/docs_recursive_glob.json" >/dev/null
pass 'recursive docs root preserves path-oriented globs'

call_hf_fs tgi_root ls '["hf://docs/tgi"]'
jq -e '.result.structuredContent.entries | any(.[]; .type == "file" and .path == "quicktour.md" and .uri == "hf://docs/tgi/quicktour.md" and (.url | contains("/docs/text-generation-inference/")))' \
	"$TMP/tgi_root.json" >/dev/null
pass 'canonical TGI product resolves its text-generation-inference manifest slug'

call_hf_fs diffusers_root ls '["hf://docs/diffusers"]'
DIFFUSERS_VERSION="$(jq -r '.result.structuredContent.entries[] | select(.type == "dir" and (.path | test("^v[0-9]"))) | .path' \
	"$TMP/diffusers_root.json" | head -1)"
[[ -n "$DIFFUSERS_VERSION" ]]
pass 'versioned Diffusers manifest is exposed without a latest alias'

DIFFUSERS_QUICKTOUR="hf://docs/diffusers/$DIFFUSERS_VERSION/quicktour.md"
call_hf_fs diffusers_quicktour cat "$(jq -nc --arg uri "$DIFFUSERS_QUICKTOUR" '[$uri,"--max-bytes","4000"]')"
jq -e '.result.structuredContent | .type? == null and .content_type == "text/markdown" and (.content | contains("Quickstart"))' \
	"$TMP/diffusers_quicktour.json" >/dev/null
pass 'manifest-backed Diffusers quickstart reads as Markdown'

call_hf_fs transformers_find find \
	'["hf://docs/transformers","--type","file","--path","*/main_classes/pipelines.md"]'
jq -e '.result.structuredContent.entries | (length == 1 and (.[0].uri | startswith("hf://docs/transformers/v")))' \
	"$TMP/transformers_find.json" >/dev/null
pass 'Transformers nested API page is discoverable through the manifest'

call_hf_fs diffusers_find_exact find \
	"$(jq -nc --arg uri "$DIFFUSERS_QUICKTOUR" '[$uri,"--type","file","--name","quicktour.md","--path","quicktour.md"]')"
jq -e --arg uri "$DIFFUSERS_QUICKTOUR" \
	'.result.structuredContent.entries | length == 1 and .[0].uri == $uri' \
	"$TMP/diffusers_find_exact.json" >/dev/null
pass 'exact documentation file find uses file semantics'

call_hf_fs hub_doc_stat stat '["hf://docs/hub/jobs-serving.md"]'
jq -e '.result.structuredContent | .exists == true and .type == "file" and .content_type == "text/markdown"' \
	"$TMP/hub_doc_stat.json" >/dev/null
pass 'non-versioned Hub documentation remains directly addressable'

call_hf_fs peft_search search '["hf://docs/peft","adapter injection","--limit","5"]'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "file" and (.path | startswith("v")) and (.uri | startswith("hf://docs/peft/v")))' \
	"$TMP/peft_search.json" >/dev/null
pass 'product-scoped documentation search returns relative paths and canonical URIs'

call_hf_fs chroma_search search '["hf://docs/diffusers","ChromaPipeline","--limit","5"]'
jq -e '.result.structuredContent.entries | length > 0 and any(.[]; .uri | contains("/api/pipelines/chroma.md#"))' \
	"$TMP/chroma_search.json" >/dev/null
pass 'full-text search runs when semantic hits do not resolve to the manifest'

CHROMA_URI="$(jq -r '.result.structuredContent.entries[] | select(.uri | contains("/api/pipelines/chroma.md#")) | .uri' \
	"$TMP/chroma_search.json" | head -1)"
CHROMA_DOCUMENT="${CHROMA_URI%%#*}"
call_hf_fs chroma_document_search search "$(jq -nc --arg uri "$CHROMA_DOCUMENT" '[$uri,"ChromaPipeline"]')"
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .path == "chroma.md")' \
	"$TMP/chroma_document_search.json" >/dev/null
call_hf_fs chroma_section cat "$(jq -nc --arg uri "$CHROMA_URI" '[$uri,"--max-bytes","6000"]')"
jq -e '.result.structuredContent | .section == "ChromaPipeline" and (.content | contains("ChromaPipeline"))' \
	"$TMP/chroma_section.json" >/dev/null
pass 'document-scoped search and anchored cat return the matched section'

call_hf_fs_error docs_versionless cat '["hf://docs/diffusers/quicktour.md"]'
call_hf_fs_error docs_deep_search search '["hf://docs/diffusers/not-a-version","guide"]'
call_hf_fs_error docs_traversal stat '["hf://docs/diffusers/%2e%2e/quicktour.md"]'
call_hf_fs_error docs_empty_search search '["hf://docs/diffusers","--query",""]'
LONG_DOCS_QUERY="$(printf 'x%.0s' $(seq 1 251))"
call_hf_fs_error docs_long_search search "$(jq -nc --arg query "$LONG_DOCS_QUERY" '["hf://docs/diffusers",$query]')"
pass 'docs rejects versionless reads, missing search scopes, traversal, and pathological queries'

echo "hf_fs live smoke tests passed"
