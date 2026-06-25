#!/bin/bash
# Start server with environment variables from specified file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Get env file from parameter, default to .env.test
ENV_FILE=${1:-.env.test}
SKILLS_BUCKET_URI=${HF_SKILLS_BUCKET_URI:-hf://buckets/huggingface/skills}
SKILLS_CACHE_DIR=${HF_SKILLS_CACHE_DIR:-"$REPO_ROOT/.cache/hf-skills"}
SKILLS_DISTRIBUTION_DIR="$SKILLS_CACHE_DIR/distribution/latest"

set_env_var() {
    local key=$1
    local value=$2
    local file=$3

    touch "$file"
    if grep -qE "^${key}=" "$file"; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
        rm -f "${file}.bak"
    else
        printf '\n%s=%s\n' "$key" "$value" >> "$file"
    fi
}

if ! command -v hf >/dev/null 2>&1; then
    echo "Error: hf CLI is required to sync skills from $SKILLS_BUCKET_URI." >&2
    echo "Install it with: curl -LsSf https://hf.co/cli/install.sh | bash -s" >&2
    exit 1
fi

echo "Syncing skills from $SKILLS_BUCKET_URI to $SKILLS_CACHE_DIR..."
mkdir -p "$SKILLS_CACHE_DIR"
hf buckets sync "$SKILLS_BUCKET_URI" "$SKILLS_CACHE_DIR" --delete

if [ ! -f "$SKILLS_DISTRIBUTION_DIR/index.json" ]; then
    echo "Error: synced skills distribution is missing $SKILLS_DISTRIBUTION_DIR/index.json" >&2
    exit 1
fi

echo "Setting HF_SKILLS_DIR=$SKILLS_DISTRIBUTION_DIR in $ENV_FILE..."
set_env_var "HF_SKILLS_DIR" "$SKILLS_DISTRIBUTION_DIR" "$ENV_FILE"

# Load variables from specified env file if it exists
if [ -f "$ENV_FILE" ]; then
    echo "Loading environment from $ENV_FILE..."
    set -a
    set +e
    source "$ENV_FILE"
    source_status=$?
    set -e
    set +a
    if [ "$source_status" -ne 0 ]; then
        echo "Warning: $ENV_FILE returned a non-zero status while loading; continuing with variables that were set." >&2
    fi
else
    echo "No $ENV_FILE found, using defaults..."
fi

echo "Starting server with configuration from $ENV_FILE..."
pnpm dev:watch
