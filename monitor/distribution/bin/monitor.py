#!/usr/bin/env python3
"""Scheduled Space monitor: check a CSV catalog, repair broken Spaces, avoid rework.

One pass per scheduled run:

1. Read the CSV catalog and check Hub runtime state plus the MCP schema.
2. For each UNHEALTHY Space, apply at most one treatment step per run,
   escalating across runs: restart (PAUSED / RUNTIME_ERROR) -> Space Doctor
   diagnosis and a repair PR -> hold.
3. A per-Space ledger keyed by the failing revision prevents re-processing
   until the treatment has been applied (the revision changed) or the ledger
   file is deleted by an operator.
4. Publish one sanitized, immutable report per run.

The Doctor (fast-agent) runs under an isolated UID with a minimal environment
and never holds the parent Hub credential; this parent process performs the
only two mutations (a normal non-factory restart, a PR from the Doctor's
verified candidate files).
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DISTRIBUTION = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = "https://huggingface.co/datasets/mcp-tools/discover-tools/resolve/main/mcp-tools.csv"

SPACE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
CANDIDATE_PATH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
RESTARTABLE_STAGES = {"PAUSED", "RUNTIME_ERROR"}
MAX_CANDIDATE_FILES = 20
MAX_CANDIDATE_BYTES = 2_000_000

# Source validation intentionally excludes assignment and generic auth patterns:
# token=variable and max_new_tokens=256 are ordinary code, not credentials.
SOURCE_SECRET_PATTERNS = (
	re.compile(r"\bhf_[A-Za-z0-9]{16,}\b"),
	re.compile(r"\bsk[-_][A-Za-z0-9_-]{16,}\b"),
	re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"),
	re.compile(r"\bgithub_pat_[A-Za-z0-9_]{16,}\b"),
	re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}\b"),
	re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{16,}\b"),
	re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
	re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
	re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
)

# Reports remain conservatively redacted, independently of source validation.
SECRET_PATTERNS = SOURCE_SECRET_PATTERNS + (
	re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"),
	re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=]{8,}"),
	re.compile(
		r"""(?ix)
		["']?
		(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|
		   password|passwd|secret|token|authorization|cookie|api[_-]?key)
		["']?
		\s*[:=]\s*
		["']?[^\s,"'}]{8,}["']?
		"""
	),
	re.compile(r"(?i)\b(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)\s*[:=]\s*\S+"),
	re.compile(r"(?i)([?&](?:token|access_token|api_key|key)=)[^&#\s]+"),
)
LOCAL_PATH_PATTERN = re.compile(r"/(?:tmp|root|home)/[^\s\"']+")
SECRET_ENV_NAMES = (
	"HF_TOKEN",
	"DEFAULT_HF_TOKEN",
	"MONITOR_HF_TOKEN",
	"OPENAI_API_KEY",
	"RESPONSES_API_KEY",
)

DOCTOR_FAILURE_CLASSES = (
	("doctor-output-schema-unsupported", ("invalid schema for response_format", "invalid_json_schema", "schema is not supported", "unsupported schema")),
	("provider-rate-limited", ("rate limit", "rate_limit", "status code: 429", "http 429")),
	("provider-auth-failed", ("incorrect api key", "invalid api key", "authentication failed", "status code: 401", "http 401")),
	("doctor-timeout", ("timed out", "timeout expired", "deadline exceeded")),
)


class Fatal(Exception):
	pass


def utc_now() -> str:
	return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_bytes(value: Any) -> bytes:
	return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def space_key(space_id: str) -> str:
	return hashlib.sha256(space_id.encode()).hexdigest()[:24]


# ---------------------------------------------------------------- sanitization

def redact(value: str, limit: int = 512) -> str:
	sanitized = value.replace("\r", " ")
	for pattern in SECRET_PATTERNS:
		sanitized = pattern.sub("[REDACTED]", sanitized)
	for env_name in SECRET_ENV_NAMES:
		secret = os.environ.get(env_name)
		if secret and len(secret) >= 8 and secret in sanitized:
			sanitized = sanitized.replace(secret, "[REDACTED]")
	sanitized = LOCAL_PATH_PATTERN.sub("[EPHEMERAL_PATH]", sanitized)
	if len(sanitized) > limit:
		sanitized = sanitized[:limit] + "…"
	return sanitized


def assert_safe(value: Any, what: str) -> None:
	serialized = canonical_bytes(value).decode()
	if any(pattern.search(serialized) for pattern in SECRET_PATTERNS) or LOCAL_PATH_PATTERN.search(serialized):
		raise Fatal(f"{what} failed the final sensitive-data scan; nothing was published.")


# --------------------------------------------------------------- health check

def request_json(url: str, headers: dict[str, str], timeout: int, attempts: int, retry_delay: int) -> object:
	"""Fetch JSON, retrying only transient HTTP and transport failures."""
	for attempt in range(1, attempts + 1):
		try:
			request = urllib.request.Request(url, headers=headers)
			with urllib.request.urlopen(request, timeout=timeout) as response:
				return json.load(response)
		except urllib.error.HTTPError as error:
			retryable = error.code in {408, 429} or 500 <= error.code < 600
			if not retryable or attempt == attempts:
				raise
		except (OSError, ValueError, urllib.error.URLError):
			if attempt == attempts:
				raise
		if retry_delay:
			time.sleep(retry_delay)
	raise AssertionError("unreachable")


def load_catalog(source: str, config: dict[str, Any]) -> list[str]:
	"""Load real CSV rather than splitting lines, so quoted commas are safe."""
	try:
		if source.startswith("https://"):
			headers = {"User-Agent": "space-monitor/1"}
			for attempt in range(1, config["health_attempts"] + 1):
				try:
					request = urllib.request.Request(source, headers=headers)
					with urllib.request.urlopen(request, timeout=config["health_timeout_seconds"]) as response:
						text = response.read().decode("utf-8-sig")
					break
				except urllib.error.HTTPError as error:
					if (error.code not in {408, 429} and not 500 <= error.code < 600) or attempt == config["health_attempts"]:
						raise
				except OSError:
					if attempt == config["health_attempts"]:
						raise
				if config["health_retry_seconds"]:
					time.sleep(config["health_retry_seconds"])
			else:
				raise AssertionError("unreachable")
		else:
			if "://" in source:
				raise Fatal("DYNAMIC_SPACE_DATA must be an HTTPS URL or local file path.")
			text = Path(source).read_text(encoding="utf-8-sig")
	except (OSError, urllib.error.URLError) as error:
		raise Fatal(f"Could not read catalog: {safe_error_code(error)}.") from None

	try:
		rows = csv.reader(io.StringIO(text))
		spaces: list[str] = []
		seen: set[str] = set()
		for number, row in enumerate(rows, 1):
			if not row:
				continue
			space_id = row[0].strip()
			if number == 1 and space_id == "space_id":
				continue
			if not SPACE_ID_PATTERN.fullmatch(space_id):
				raise ValueError(f"row {number} has an invalid space_id")
			if space_id in seen:
				raise ValueError(f"row {number} duplicates {space_id}")
			seen.add(space_id)
			spaces.append(space_id)
		if not spaces:
			raise ValueError("CSV contains no Spaces")
		return spaces
	except (csv.Error, ValueError) as error:
		raise Fatal(f"Invalid catalog: {error}.") from None


def has_tools(value: object) -> bool:
	if isinstance(value, list):
		return any(
			isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"] and isinstance(item.get("inputSchema"), dict)
			for item in value
		)
	if isinstance(value, dict):
		return any(key != "error" and isinstance(item, dict) and isinstance(item.get("properties"), dict) for key, item in value.items())
	return False


def observe_space(config: dict[str, Any], space_id: str) -> dict[str, Any]:
	headers = {"User-Agent": "space-monitor/1"}
	if config["hub_token"]:
		headers["Authorization"] = f"Bearer {config['hub_token']}"
	try:
		metadata = request_json(
			f"https://huggingface.co/api/spaces/{space_id}",
			headers,
			config["health_timeout_seconds"],
			config["health_attempts"],
			config["health_retry_seconds"],
		)
	except (OSError, ValueError, urllib.error.URLError):
		return {"space_id": space_id, "status": "UNHEALTHY", "stage": "UNKNOWN", "revision": None, "detail": "metadata-unavailable"}
	if not isinstance(metadata, dict):
		return {"space_id": space_id, "status": "UNHEALTHY", "stage": "UNKNOWN", "revision": None, "detail": "metadata-invalid"}

	runtime = metadata.get("runtime") if isinstance(metadata.get("runtime"), dict) else {}
	stage = str(runtime.get("stage") or "UNKNOWN").upper()
	if not re.fullmatch(r"[A-Z][A-Z0-9_-]{0,63}", stage):
		stage = "UNKNOWN"
	revision = metadata.get("sha")
	revision = revision if isinstance(revision, str) and REVISION_PATTERN.fullmatch(revision) else None
	base = {"space_id": space_id, "stage": stage, "revision": revision}
	if bool(metadata.get("disabled")) or bool(runtime.get("disabled")):
		return base | {"status": "UNHEALTHY", "detail": "runtime-disabled"}
	if stage in {"NO_APP_FILE", "CONFIG_ERROR", "BUILD_ERROR", "RUNTIME_ERROR", "DELETING", "PAUSED"}:
		return base | {"status": "UNHEALTHY", "detail": "runtime-error"}
	if stage == "SLEEPING" and not config["probe_sleeping"]:
		return base | {"status": "HEALTHY", "detail": "schema-skipped"}

	subdomain = metadata.get("subdomain")
	if not isinstance(subdomain, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", subdomain):
		status = "DEGRADED" if stage in {"BUILDING", "RUNNING_BUILDING"} else "UNHEALTHY"
		return base | {"status": status, "detail": "missing-subdomain"}
	schema_headers = {"User-Agent": "space-monitor/1"}
	if bool(metadata.get("private")) and config["hub_token"]:
		schema_headers["X-HF-Authorization"] = f"Bearer {config['hub_token']}"
	try:
		schema = request_json(
			f"https://{subdomain}.hf.space/gradio_api/mcp/schema",
			schema_headers,
			config["health_timeout_seconds"],
			config["health_attempts"],
			config["health_retry_seconds"],
		)
	except (OSError, ValueError, urllib.error.URLError):
		return base | {"status": "UNHEALTHY", "detail": "schema-unavailable"}
	if not has_tools(schema):
		return base | {"status": "UNHEALTHY", "detail": "schema-empty"}
	status = "HEALTHY" if stage in {"RUNNING", "SLEEPING"} else "DEGRADED"
	return base | {"status": status, "detail": "schema-ok"}


# --------------------------------------------------------------------- ledger

def ledger_path(state_root: Path, space_id: str) -> Path:
	return state_root / "ledger" / f"{space_key(space_id)}.json"


def read_ledger(state_root: Path, space_id: str) -> dict[str, Any] | None:
	path = ledger_path(state_root, space_id)
	if not path.is_file():
		return None
	try:
		value = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, ValueError):
		return None
	return value if isinstance(value, dict) else None


def write_ledger(
	state_root: Path,
	space_id: str,
	revision: str,
	treatment: str,
	run_id: str,
	pr_url: str | None = None,
	restart_outcome: str | None = None,
) -> None:
	path = ledger_path(state_root, space_id)
	path.parent.mkdir(parents=True, exist_ok=True)
	if restart_outcome is None:
		existing = read_ledger(state_root, space_id)
		previous_outcome = existing.get("restart_outcome") if existing and existing.get("revision") == revision else None
		restart_outcome = previous_outcome if isinstance(previous_outcome, str) else None
	payload = canonical_bytes(
		{
			"schema_version": "space-monitor-ledger/v1",
			"space_id": space_id,
			"revision": revision,
			"treatment": treatment,
			"pr_url": pr_url,
			"restart_outcome": restart_outcome,
			"run_id": run_id,
			"updated_at": utc_now(),
		}
	)
	temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
	try:
		with temporary.open("xb") as handle:
			handle.write(payload)
			handle.flush()
			os.fsync(handle.fileno())
		os.replace(temporary, path)
		directory_fd = os.open(path.parent, os.O_DIRECTORY)
		try:
			os.fsync(directory_fd)
		finally:
			os.close(directory_fd)
	finally:
		temporary.unlink(missing_ok=True)


def decide_step(ledger: dict[str, Any] | None, revision: str, stage: str, restart_enabled: bool) -> str:
	"""One treatment step per run: restart -> doctor -> hold, per failing revision."""
	if ledger and ledger.get("revision") == revision:
		if ledger.get("treatment") in {"pr-opened", "pr-failed", "needs-human"}:
			return "held"
		return "doctor"
	if restart_enabled and stage in RESTARTABLE_STAGES:
		return "restart"
	return "doctor"


# -------------------------------------------------------------------- restart

def stage_name(value: object) -> str | None:
	if value is None:
		return None
	stage = str(value).rsplit(".", 1)[-1].upper()
	return stage if re.fullmatch(r"[A-Z][A-Z0-9_-]{0,63}", stage) else None


def schema_healthy(subdomain: str | None, token: str, private: bool, timeout: int, attempts: int = 2, retry_delay: int = 2) -> bool:
	if not subdomain:
		return False
	headers = {"User-Agent": "space-monitor/v2"}
	if private:
		headers["X-HF-Authorization"] = f"Bearer {token}"
	try:
		value = request_json(f"https://{subdomain}.hf.space/gradio_api/mcp/schema", headers, timeout, attempts, retry_delay)
	except (OSError, ValueError, urllib.error.URLError):
		return False
	return has_tools(value)


def safe_error_code(error: Exception) -> str:
	from huggingface_hub.errors import BadRequestError, HfHubHTTPError, RepositoryNotFoundError

	if isinstance(error, RepositoryNotFoundError):
		return "not-found"
	if isinstance(error, BadRequestError):
		return "unsupported-space"
	if isinstance(error, HfHubHTTPError):
		status = error.response.status_code if error.response is not None else None
		return "not-authorized" if status in {401, 403} else "api-rejected"
	if isinstance(error, (TimeoutError, urllib.error.URLError, OSError)):
		return "transport-error"
	return "internal-error"


def attempt_restart(api: Any, token: str, config: dict[str, Any], space_id: str, revision: str, state_root: Path, run_id: str) -> str:
	"""Re-verify identity, mark the revision treated, restart, and poll for health."""
	restart_claimed = False
	try:
		info = api.space_info(repo_id=space_id, token=token)
		stage = stage_name(api.get_space_runtime(repo_id=space_id, token=token).stage)
		if info.sha != revision:
			return "revision-changed"
		if stage not in RESTARTABLE_STAGES:
			return "stage-changed"
		# The ledger entry is written before the mutation so a crash can never
		# lead to a second restart of the same revision. A crash in the gap before
		# the API call leaves the outcome honestly unknown.
		write_ledger(state_root, space_id, revision, "restarted", run_id, restart_outcome="unknown")
		restart_claimed = True
		api.restart_space(repo_id=space_id, token=token, factory_reboot=False)
		deadline = time.monotonic() + config["restart_wait_seconds"]
		while time.monotonic() < deadline:
			time.sleep(config["restart_poll_seconds"])
			info = api.space_info(repo_id=space_id, token=token)
			stage = stage_name(api.get_space_runtime(repo_id=space_id, token=token).stage)
			if info.sha != revision:
				outcome = "revision-changed"
				break
			if stage == "RUNNING" and schema_healthy(
				info.subdomain,
				token,
				bool(getattr(info, "private", False)),
				config["health_timeout_seconds"],
				config["health_attempts"],
				config["health_retry_seconds"],
			):
				outcome = "restarted-healthy"
				break
		else:
			outcome = "restarted-unhealthy"
	except Exception as error:  # noqa: BLE001 - one Space's failure must not stop the run
		outcome = safe_error_code(error)
	if restart_claimed:
		write_ledger(state_root, space_id, revision, "restarted", run_id, restart_outcome=outcome)
	return outcome


# --------------------------------------------------------------------- doctor

def child_environment(config: dict[str, Any]) -> dict[str, str]:
	"""Minimal Doctor environment: never the parent Hub credential."""
	env = {
		"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
		"HOME": str(config["agent_root"] / "home"),
		"XDG_CACHE_HOME": str(config["agent_root"] / "cache"),
		"UV_CACHE_DIR": str(config["agent_root"] / "cache" / "uv"),
		"HF_HOME": str(config["agent_root"] / "cache" / "huggingface"),
		"TMPDIR": str(config["agent_root"] / "tmp"),
		"OPENAI_API_KEY": config["provider_key"],
	}
	if config["doctor_hf_token"]:
		env["HF_TOKEN"] = config["doctor_hf_token"]
	return env


def classify_doctor_failure(stderr_path: Path) -> str:
	try:
		text = stderr_path.read_bytes()[:262_144].decode("utf-8", errors="replace").lower()
	except OSError:
		text = ""
	for code, needles in DOCTOR_FAILURE_CLASSES:
		if any(needle in text for needle in needles):
			return code
	return "doctor-exit"


def doctor_prompt(
	space_id: str,
	revision: str,
	run_id: str,
	workspace: Path,
	observed_status: str,
	observed_stage: str,
	observed_detail: str,
	previous_restart_outcome: str | None,
) -> str:
	restart_context = previous_restart_outcome or "not-recorded"
	return (
		f"Use the space-doctor skill to diagnose the broken Hugging Face Space {space_id}.\n"
		f"Run ID: {run_id}\n"
		f"Diagnose exactly revision {revision}; if the Space has moved to a different\n"
		f"revision, report status needs-human with reason revision-changed.\n"
		f"Observed failure: status={redact(observed_status, 64)} stage={redact(observed_stage, 64)} "
		f"detail={redact(observed_detail, 256)}.\n"
		f"Previous restart outcome for this revision: {redact(restart_context, 128)}.\n"
		f"Use those observations as context, then reason from the actual Hub logs and source.\n"
		f"Workspace: {workspace}\n"
		f"If a minimal, reversible source fix is appropriate, write the complete fixed\n"
		f"files into {workspace}/candidate/ (paths relative to the Space repository\n"
		f"root) and list them in changed_files. You have no Hub write access: never\n"
		f"attempt an upload, PR, or restart yourself - the parent process opens the PR\n"
		f"from your candidate files. An unauthenticated model probe returning 401/403\n"
		f"does not establish an access failure in the actual Space runtime. A verified\n"
		f"independent code repair may be fix-proposed with a warning finding about unverified access.\n"
		f"For access issues, report needs-human only when actual Space runtime evidence\n"
		f"establishes access failure and no independent fix is available. Never add secrets.\n"
		f"For anything otherwise needing billing,\n"
		f"hardware, product decisions, or an unclear root cause, report needs-human.\n"
		f"Never place credentials in any output. Emit exactly one final structured\n"
		f"result matching the configured JSON schema, only after all work is complete."
	)


def extract_final_result(raw_output: Path, run_id: str) -> dict[str, Any] | None:
	text = raw_output.read_text(encoding="utf-8", errors="replace")
	decoder = json.JSONDecoder()
	result = None
	for index, character in enumerate(text):
		if character != "{":
			continue
		try:
			value, _ = decoder.raw_decode(text, index)
		except json.JSONDecodeError:
			continue
		if isinstance(value, dict) and value.get("run_id") == run_id and value.get("result_state") == "final":
			result = value
	return result


def validate_doctor_result(result: dict[str, Any], space_id: str, revision: str, run_id: str, candidate_dir: Path, credential_values: tuple[str, ...] = ()) -> str | None:
	"""Return a rejection reason, or None when the result is acceptable."""
	from jsonschema import Draft202012Validator, FormatChecker

	schema_path = DISTRIBUTION / "skills" / "space-doctor" / "assets" / "doctor-result.schema.json"
	schema = json.loads(schema_path.read_text(encoding="utf-8"))
	errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(result))
	if errors:
		return f"schema: {errors[0].message[:200]}"
	if result["space_id"] != space_id or result["run_id"] != run_id:
		return "identity mismatch"
	if result["revision"] != revision:
		return "revision mismatch"
	if result["status"] == "needs-human":
		return None
	if not result["changed_files"]:
		return "fix-proposed without changed files"
	if len(result["changed_files"]) > MAX_CANDIDATE_FILES:
		return "too many changed files"
	total = 0
	if candidate_dir.is_symlink() or not candidate_dir.is_dir():
		return "candidate directory is unsafe"
	try:
		candidate_root = candidate_dir.resolve(strict=True)
	except OSError:
		return "candidate directory is unavailable"
	for relative in result["changed_files"]:
		if not CANDIDATE_PATH_PATTERN.fullmatch(relative) or ".." in relative.split("/") or relative.startswith("/"):
			return f"unsafe candidate path: {relative[:80]}"
		path = candidate_dir / relative
		current = candidate_dir
		for component in relative.split("/"):
			current /= component
			if current.is_symlink():
				return f"candidate path contains a symlink: {relative[:80]}"
		try:
			resolved = path.resolve(strict=True)
			resolved.relative_to(candidate_root)
		except (OSError, ValueError):
			return f"candidate path escapes its directory: {relative[:80]}"
		if not resolved.is_file():
			return f"missing candidate file: {relative[:80]}"
		data = resolved.read_bytes()
		total += len(data)
		if total > MAX_CANDIDATE_BYTES:
			return "candidate exceeds size limit"
		text = data.decode("utf-8", errors="replace")
		known_credentials = credential_values + tuple(os.environ.get(name, "") for name in SECRET_ENV_NAMES)
		if any(value and value in text for value in known_credentials):
			return "candidate file contains a runtime credential"
		if any(pattern.search(text) for pattern in SOURCE_SECRET_PATTERNS):
			return "candidate file contains a high-confidence credential signature"
	return None


def run_doctor(
	config: dict[str, Any],
	space_id: str,
	revision: str,
	run_id: str,
	observation: dict[str, Any],
	previous_restart_outcome: str | None,
) -> tuple[dict[str, Any] | None, Path, str]:
	"""Returns (validated result | None, candidate dir, failure/rejection code)."""
	workspace = config["agent_root"] / "workspace" / space_key(space_id) / run_id
	candidate_dir = workspace / "candidate"
	fast_agent_home = workspace / "fast-agent-home"
	raw_output = workspace / "agent-output.log"
	stderr_path = workspace / "agent-stderr.log"
	for path in (workspace, candidate_dir, fast_agent_home):
		path.mkdir(parents=True, exist_ok=True)
	if config["agent_prefix"]:
		subprocess.run(["chown", "-R", f"{config['agent_uid']}:{config['agent_gid']}", str(workspace)], check=True)

	command = [
		*config["agent_prefix"],
		"env", "-i",
		*[f"{key}={value}" for key, value in child_environment(config).items()],
		"uvx", config["fast_agent_package"], "go",
		"--home", str(fast_agent_home),
		"--shell",
		"--skills-dir", str(DISTRIBUTION / "skills"),
		"--workspace", str(workspace),
		"--message",
		doctor_prompt(
			space_id,
			revision,
			run_id,
			workspace,
			str(observation["status"]),
			str(observation["stage"]),
			str(observation["detail"]),
			previous_restart_outcome,
		),
		"--json-schema", str(DISTRIBUTION / "skills" / "space-doctor" / "assets" / "doctor-result.schema.json"),
		"--timeout", str(config["doctor_timeout_seconds"]),
		"--quiet",
		"--model", config["model"],
	]
	try:
		with raw_output.open("w") as out, stderr_path.open("w") as err:
			completed = subprocess.run(command, stdout=out, stderr=err, timeout=config["doctor_timeout_seconds"] + 120)
	except subprocess.TimeoutExpired:
		return None, candidate_dir, "doctor-timeout"
	if completed.returncode != 0:
		return None, candidate_dir, classify_doctor_failure(stderr_path)

	result = extract_final_result(raw_output, run_id)
	if result is None:
		return None, candidate_dir, "doctor-no-result"
	try:
		candidate_dir.resolve(strict=True).relative_to(config["agent_root"].resolve(strict=True))
	except (OSError, ValueError):
		print(f"monitor: doctor candidate directory escaped its workspace for {space_id}", file=sys.stderr)
		return None, candidate_dir, "doctor-result-rejected"
	rejection = validate_doctor_result(
		result, space_id, revision, run_id, candidate_dir,
		tuple(config.get(key, "") for key in ("hub_token", "provider_key", "doctor_hf_token")),
	)
	if rejection is not None:
		print(f"monitor: doctor result rejected for {space_id}: {redact(rejection, 200)}", file=sys.stderr)
		if rejection in {
			"candidate file contains a runtime credential",
			"candidate file contains a high-confidence credential signature",
		}:
			return None, candidate_dir, "doctor-result-rejected: " + rejection
		return None, candidate_dir, "doctor-result-rejected"
	return result, candidate_dir, ""


# ------------------------------------------------------------------------- PR

def open_pr(api: Any, token: str, space_id: str, revision: str, candidate_dir: Path, result: dict[str, Any]) -> str:
	from huggingface_hub import CommitOperationAdd

	operations = [
		CommitOperationAdd(path_in_repo=relative, path_or_fileobj=str(candidate_dir / relative))
		for relative in result["changed_files"]
	]
	description = (
		f"{redact(result['fix_summary'], 2000)}\n\n"
		f"Automated repair proposed by the scheduled Space monitor for revision {revision}.\n"
		f"Findings: "
		+ "; ".join(redact(finding["summary"], 200) for finding in result["findings"][:5])
	)
	commit = api.create_commit(
		repo_id=space_id,
		repo_type="space",
		operations=operations,
		commit_message=redact(result["pr_title"], 100) or "Automated Space health repair",
		commit_description=description,
		create_pr=True,
		parent_commit=revision,
		token=token,
	)
	pr_url = getattr(commit, "pr_url", None)
	if not pr_url:
		raise Fatal("PR creation returned no PR URL.")
	return pr_url


# -------------------------------------------------------------------- reports

def safe_catalog_source(source: str) -> str:
	if source.startswith("https://"):
		return source.split("?", 1)[0].split("#", 1)[0]
	return "local-catalog"


def publish_report(report_root: Path, run_id: str, report: dict[str, Any]) -> None:
	if not SAFE_COMPONENT.fullmatch(run_id):
		raise Fatal("Run ID is not a safe path component.")
	assert_safe(report, "Run report")
	started = datetime.fromisoformat(report["started_at"].replace("Z", "+00:00"))
	directory = report_root / started.strftime("%Y/%m/%d") / run_id
	directory.mkdir(parents=True)
	with (directory / "report.json").open("xb") as handle:
		handle.write(canonical_bytes(report))
	with (directory / "COMPLETE").open("xb") as handle:
		handle.write(canonical_bytes({"schema_version": "space-monitor-complete/v2", "completed_at": utc_now()}))
	for path in directory.iterdir():
		path.chmod(0o444)
	directory.chmod(0o555)


# ----------------------------------------------------------------------- main

def configured_int(name: str, default: int, minimum: int = 0) -> int:
	try:
		value = int(os.environ.get(name, str(default)))
	except ValueError:
		raise Fatal(f"{name} must be an integer.") from None
	if value < minimum:
		raise Fatal(f"{name} must be at least {minimum}.")
	return value


def load_config() -> dict[str, Any]:
	monitor_root = Path(os.environ.get("MONITOR_ROOT", "/monitor"))
	local_root = Path(os.environ.get("LOCAL_ROOT", "/tmp/space-monitor"))
	run_id = os.environ.get("MONITOR_RUN_ID") or f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(4)}"
	if not SAFE_COMPONENT.fullmatch(run_id):
		raise Fatal("MONITOR_RUN_ID is not a safe path component.")
	config: dict[str, Any] = {
		"run_id": run_id,
		"run_root": local_root / run_id,
		"catalog_source": os.environ.get("DYNAMIC_SPACE_DATA", DEFAULT_CATALOG),
		"report_root": Path(os.environ.get("MONITOR_REPORT_ROOT", monitor_root / "reports")),
		"state_root": Path(os.environ.get("MONITOR_STATE_ROOT", monitor_root / "state")),
		"max_doctor_runs": configured_int("MAX_DOCTOR_RUNS", 16),
		"restart_wait_seconds": configured_int("MONITOR_RESTART_WAIT_SECONDS", 300, 1),
		"restart_poll_seconds": configured_int("MONITOR_RESTART_POLL_SECONDS", 5, 1),
		"health_timeout_seconds": configured_int("HEALTH_TIMEOUT_SECONDS", 15, 1),
		"health_attempts": configured_int("HEALTH_ATTEMPTS", 3, 1),
		"health_retry_seconds": configured_int("HEALTH_RETRY_DELAY_SECONDS", 2),
		"probe_sleeping": os.environ.get("HEALTH_PROBE_SLEEPING", "false") == "true",
		"doctor_timeout_seconds": configured_int("RUN_TIMEOUT", 900, 1),
		"hub_token": os.environ.get("HF_TOKEN") or os.environ.get("DEFAULT_HF_TOKEN", ""),
		"provider_key": os.environ.get("RESPONSES_API_KEY") or os.environ.get("OPENAI_API_KEY", ""),
		"doctor_hf_token": os.environ.get("MONITOR_HF_TOKEN", ""),
		"fast_agent_package": os.environ.get("FAST_AGENT_PACKAGE", "fast-agent-mcp@0.10.16"),
		"model": os.environ.get("DOCTOR_MODEL", "responses.gpt-6-astra?reasoning=medium&service_tier=flex"),
		"agent_uid": configured_int("MONITOR_AGENT_UID", 10001, 1),
		"agent_gid": configured_int("MONITOR_AGENT_GID", 10001, 1),
	}
	config["agent_root"] = config["run_root"] / "agent"
	if os.environ.get("HEALTH_PROBE_SLEEPING", "false") not in {"true", "false"}:
		raise Fatal("HEALTH_PROBE_SLEEPING must be true or false.")
	if not re.fullmatch(r"fast-agent-mcp@\d+\.\d+\.\d+([._+-][A-Za-z0-9.-]+)?", config["fast_agent_package"]):
		raise Fatal("FAST_AGENT_PACKAGE must be pinned as fast-agent-mcp@X.Y.Z.")
	if not config["model"].startswith("responses."):
		raise Fatal("DOCTOR_MODEL must use the responses provider.")

	if config["hub_token"] and sys.argv[1:] != ["--check"] and os.geteuid() != 0:
		raise Fatal("The parent Hub credential requires root for repair execution so Doctor can run under a different UID.")

	config["agent_prefix"] = []
	if os.geteuid() == 0 and config["provider_key"]:
		if not shutil.which("setpriv"):
			raise Fatal("setpriv is required to run the Doctor as an isolated user.")
		config["agent_prefix"] = ["setpriv", f"--reuid={config['agent_uid']}", f"--regid={config['agent_gid']}", "--clear-groups"]
	return config


NEEDS_HUMAN_DOCTOR_FAILURES = {
	"doctor-output-schema-unsupported",
	"provider-auth-failed",
	"doctor-no-result",
	"doctor-result-rejected",
}


def treat_space(config: dict[str, Any], observation: dict[str, Any], doctor_budget: list[int]) -> dict[str, Any]:
	"""Apply at most one treatment step to one unhealthy Space."""
	space_id = observation["space_id"]
	revision = observation["revision"]
	record: dict[str, Any] = {
		"space_id": space_id,
		"status": observation["status"],
		"stage": observation["stage"],
		"revision": revision,
		"detail": redact(observation["detail"]),
	}
	if revision is None:
		record["outcome"] = "unreachable"
		return record

	ledger = read_ledger(config["state_root"], space_id)
	step = decide_step(ledger, revision, observation["stage"], bool(config["hub_token"]))
	if step == "held":
		record["outcome"] = "held"
		record["pr_url"] = ledger.get("pr_url")
		return record

	from huggingface_hub import HfApi

	api = HfApi()
	space_run_id = f"{config['run_id']}-{space_key(space_id)}"

	if step == "restart":
		print(f"monitor: restarting {space_id} ({observation['stage']} at {revision[:12]})")
		record["outcome"] = attempt_restart(
			api, config["hub_token"], config, space_id, revision, config["state_root"], config["run_id"]
		)
		return record

	# step == "doctor"
	if not config["provider_key"]:
		record["outcome"] = "doctor-skipped"
		return record
	if doctor_budget[0] >= config["max_doctor_runs"]:
		record["outcome"] = "doctor-limit-reached"
		return record
	doctor_budget[0] += 1
	print(f"monitor: diagnosing {space_id} ({observation['stage']} at {revision[:12]})")
	previous_outcome = ledger.get("restart_outcome") if ledger and ledger.get("revision") == revision else None
	previous_restart_outcome = previous_outcome if isinstance(previous_outcome, str) else None
	result, candidate_dir, failure = run_doctor(config, space_id, revision, space_run_id, observation, previous_restart_outcome)
	if result is None:
		if failure.split(":", 1)[0] in NEEDS_HUMAN_DOCTOR_FAILURES:
			write_ledger(config["state_root"], space_id, revision, "needs-human", config["run_id"])
			record["outcome"] = "needs-human"
			record["reason"] = failure
			return record
		record["outcome"] = failure
		return record

	record["findings"] = [
		{"severity": finding["severity"], "rule_id": finding["rule_id"], "summary": redact(finding["summary"])}
		for finding in result["findings"][:20]
	]
	if result["status"] == "needs-human":
		write_ledger(config["state_root"], space_id, revision, "needs-human", config["run_id"])
		record["outcome"] = "needs-human"
		record["reason"] = redact(result["needs_human_reason"])
		return record

	if not config["hub_token"]:
		write_ledger(config["state_root"], space_id, revision, "needs-human", config["run_id"])
		record["outcome"] = "needs-human"
		record["reason"] = "fix prepared but no HF_TOKEN is configured"
		return record

	# Claim the treatment before the mutation so a crash cannot open duplicate PRs.
	write_ledger(config["state_root"], space_id, revision, "pr-opened", config["run_id"])
	try:
		pr_url = open_pr(api, config["hub_token"], space_id, revision, candidate_dir, result)
	except Exception as error:  # noqa: BLE001
		write_ledger(config["state_root"], space_id, revision, "pr-failed", config["run_id"])
		record["outcome"] = "pr-failed"
		record["reason"] = safe_error_code(error) if not isinstance(error, Fatal) else "no-pr-url"
		return record
	write_ledger(config["state_root"], space_id, revision, "pr-opened", config["run_id"], pr_url=pr_url)
	record["outcome"] = "pr-opened"
	record["pr_url"] = pr_url
	return record


def main() -> int:
	config = load_config()
	if sys.argv[1:] == ["--check"]:
		observations = [observe_space(config, space_id) for space_id in load_catalog(config["catalog_source"], config)]
		for observation in observations:
			print(
				f"{observation['status']} {observation['space_id']} "
				f"stage={observation['stage']} detail={observation['detail']}"
				+ (f" revision={observation['revision']}" if observation["revision"] else "")
			)
		print(
			"SUMMARY "
			+ " ".join(f"{status.lower()}={sum(item['status'] == status for item in observations)}" for status in ("HEALTHY", "DEGRADED", "UNHEALTHY"))
		)
		return 1 if any(item["status"] != "HEALTHY" for item in observations) else 0
	if len(sys.argv) != 1:
		raise Fatal("Usage: monitor.py [--check]")

	started_at = utc_now()
	run_root: Path = config["run_root"]
	config["report_root"].mkdir(parents=True, exist_ok=True)
	config["agent_root"].mkdir(parents=True, exist_ok=True)
	run_root.chmod(0o711)
	if config["agent_prefix"]:
		subprocess.run(["chown", "-R", f"{config['agent_uid']}:{config['agent_gid']}", str(config["agent_root"])], check=True)

	try:
		try:
			observations = [observe_space(config, space_id) for space_id in load_catalog(config["catalog_source"], config)]
			catalog_error = None
		except Fatal as error:
			observations = []
			catalog_error = str(error)
			print(f"monitor: {catalog_error}", file=sys.stderr)

		records: list[dict[str, Any]] = []
		doctor_budget = [0]
		for observation in observations:
			print(
				f"{observation['status']} {observation['space_id']} "
				f"stage={observation['stage']} detail={observation['detail']}"
				+ (f" revision={observation['revision']}" if observation["revision"] else "")
			)
			if observation["status"] == "UNHEALTHY":
				record = treat_space(config, observation, doctor_budget)
			else:
				record = dict(observation)
				record["outcome"] = "observed"
			records.append(record)

		counts = {status.lower(): sum(1 for item in observations if item["status"] == status) for status in ("HEALTHY", "DEGRADED", "UNHEALTHY")}
		counts["total"] = len(observations)
		report = {
			"schema_version": "space-monitor/v1",
			"run_id": config["run_id"],
			"started_at": started_at,
			"completed_at": utc_now(),
			"catalog": {"source": safe_catalog_source(config["catalog_source"]), "error": catalog_error},
			"counts": counts,
			"spaces": records,
			"doctor": {"package": config["fast_agent_package"], "model": config["model"]},
		}
		publish_report(config["report_root"], config["run_id"], report)
		print(f"monitor: completed run {config['run_id']}; spaces={counts['total']} treatments={sum(item['status'] == 'UNHEALTHY' for item in records)}")
		if catalog_error:
			return 2
		return 1 if counts["degraded"] or counts["unhealthy"] else 0
	finally:
		shutil.rmtree(run_root, ignore_errors=True)


if __name__ == "__main__":
	try:
		raise SystemExit(main())
	except Fatal as error:
		print(f"monitor: {error}", file=sys.stderr)
		raise SystemExit(2) from None
