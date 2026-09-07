#!/usr/bin/env bash
set -euo pipefail

UV_VERSION="0.12.6"
HUGGINGFACE_HUB_VERSION="1.29.0"
JSONSCHEMA_VERSION="4.25.1"
AGENT_UID="${MONITOR_AGENT_UID:-10001}"
AGENT_GID="${MONITOR_AGENT_GID:-10001}"

if [[ "$(id -u)" != "0" ]]; then
	echo "space-monitor bootstrap must run as root." >&2
	exit 77
fi

export DEBIAN_FRONTEND=noninteractive
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1

apt-get --quiet=2 update
apt-get --quiet=2 install --yes --no-install-recommends bash ca-certificates curl git util-linux
rm -rf /var/lib/apt/lists/*

python -m pip install --quiet --no-cache-dir \
	"uv==${UV_VERSION}" \
	"huggingface_hub==${HUGGINGFACE_HUB_VERSION}" \
	"jsonschema==${JSONSCHEMA_VERSION}"

if ! getent group "$AGENT_GID" >/dev/null; then
	groupadd --gid "$AGENT_GID" monitoragent
fi
if ! getent passwd "$AGENT_UID" >/dev/null; then
	useradd \
		--uid "$AGENT_UID" \
		--gid "$AGENT_GID" \
		--no-create-home \
		--home-dir /nonexistent \
		--shell /usr/sbin/nologin \
		monitoragent
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/monitor.py"
