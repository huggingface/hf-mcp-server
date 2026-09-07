#!/usr/bin/env bash
set -euo pipefail

monitor_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
distribution="$monitor_root/distribution"

bash -n "$distribution/bin/bootstrap-monitor.sh"
python3 - "$distribution/bin/monitor.py" <<'PY'
import pathlib
import sys
for filename in sys.argv[1:]:
    compile(pathlib.Path(filename).read_text(encoding="utf-8"), filename, "exec")
PY

test_root="$monitor_root/tests/.tmp.$$"
rm -rf "$test_root"
mkdir -p "$test_root"
trap 'chmod -R u+w "$test_root" 2>/dev/null || true; rm -rf "$test_root"' EXIT

PYTHONDONTWRITEBYTECODE=1 python3 - "$distribution/bin/monitor.py" "$test_root" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

monitor_path, root = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("monitor_test", monitor_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN, REVISION, SPACE = "hub-sentinel-must-never-persist-1234567890", "1" * 40, "example/fixture"
state_root = root / "state"
skill = (monitor_path.parent.parent / "skills/space-doctor/SKILL.md").read_text()
scripts = monitor_path.parent.parent / "skills/space-doctor/scripts"
assert not scripts.exists() or not any(scripts.iterdir())
assert "copy_and_fix" not in skill and "known rewrites" not in skill

# Responses structured output requires explicit types even for const/enum fields.
schema = json.loads((monitor_path.parent.parent / "skills/space-doctor/assets/doctor-result.schema.json").read_text())
assert schema["properties"]["result_state"]["type"] == "string"
assert schema["properties"]["status"]["type"] == "string"
assert schema["properties"]["findings"]["items"]["properties"]["severity"]["type"] == "string"

# Quoted fields and empty fields are parsed as CSV, not with shell delimiters.
catalog = root / "catalog.csv"
catalog.write_text('space_id,category,description\nexample/fixture,,"comma, and ""quote"""\n')
assert module.load_catalog(str(catalog), {"health_timeout_seconds": 1, "health_attempts": 1, "health_retry_seconds": 0}) == [SPACE]
catalog.write_text('example/fixture,Image Generation,"comma, and ""quote"""\n')
assert module.load_catalog(str(catalog), {"health_timeout_seconds": 1, "health_attempts": 1, "health_retry_seconds": 0}) == [SPACE]

module.write_ledger(state_root, SPACE, REVISION, "restarted", "fixture")
assert module.read_ledger(state_root, SPACE)["treatment"] == "restarted"
assert module.read_ledger(state_root, SPACE)["restart_outcome"] is None
assert not list((state_root / "ledger").glob("*.tmp"))
assert module.decide_step(
    {"revision": REVISION, "treatment": "pr-failed"}, REVISION, "BUILD_ERROR", False
) == "held"

config = {
    "run_id": "fixture-job", "state_root": state_root, "hub_token": TOKEN,
    "provider_key": "sk-fixtureproviderkey123456", "doctor_hf_token": "", "agent_root": root / "agent",
    "agent_prefix": [], "agent_uid": 10001, "agent_gid": 10001, "max_doctor_runs": 16,
    "restart_wait_seconds": 1, "restart_poll_seconds": 1, "health_timeout_seconds": 1,
    "health_attempts": 1, "health_retry_seconds": 0, "doctor_timeout_seconds": 900,
    "fast_agent_package": "fast-agent-mcp@0.10.16", "model": "responses.fixture",
}
doctor_token = "doctor-read-only-sentinel-1234567890"
doctor_config = config | {"doctor_hf_token": doctor_token}
doctor_env = module.child_environment(doctor_config)
assert doctor_env["HF_TOKEN"] == doctor_token
assert TOKEN not in json.dumps(doctor_env)

# A read-only check may use the parent Hub token without root. Repair execution
# with that token remains privileged so the Doctor can be isolated under its UID.
from unittest.mock import patch

with patch.dict(os.environ, {}, clear=True):
    default_model = "responses.gpt-6-astra?reasoning=medium&service_tier=flex"
    assert module.load_config()["model"] == default_model
    env_example = (monitor_path.parents[2] / "job/scheduled.env.example").read_text()
    assert f'DOCTOR_MODEL="{default_model}"' in env_example
    assert default_model in (monitor_path.parents[2] / "README.md").read_text()
    os.environ["DOCTOR_MODEL"] = "responses.fixture?reasoning=low&service_tier=flex"
    assert module.load_config()["model"] == os.environ["DOCTOR_MODEL"]
    os.environ["DOCTOR_MODEL"] = "astra?reasoning=medium&service_tier=flex"
    try:
        module.load_config()
        raise AssertionError("unprefixed model unexpectedly accepted")
    except module.Fatal as error:
        assert "must use the responses provider" in str(error)

saved_tokens = {name: os.environ.get(name) for name in ("HF_TOKEN", "DEFAULT_HF_TOKEN")}
original_argv, original_geteuid = module.sys.argv, module.os.geteuid
try:
    os.environ["HF_TOKEN"] = TOKEN
    os.environ.pop("DEFAULT_HF_TOKEN", None)
    module.sys.argv = [str(monitor_path), "--check"]
    module.os.geteuid = lambda: 10001
    assert module.load_config()["hub_token"] == TOKEN

    module.sys.argv = [str(monitor_path)]
    try:
        module.load_config()
        raise AssertionError("repair execution unexpectedly allowed a non-root parent token")
    except module.Fatal as error:
        assert "requires root for repair execution" in str(error)

    os.environ.pop("HF_TOKEN", None)
    os.environ["DEFAULT_HF_TOKEN"] = TOKEN
    module.sys.argv = [str(monitor_path), "--check"]
    assert module.load_config()["hub_token"] == TOKEN
finally:
    module.sys.argv, module.os.geteuid = original_argv, original_geteuid
    for name, value in saved_tokens.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value

prompt = module.doctor_prompt(
    SPACE, REVISION, "fixture-run", root / "workspace", "UNHEALTHY", "RUNTIME_ERROR", "runtime-error", "restarted-unhealthy"
)
assert "Observed failure: status=UNHEALTHY stage=RUNTIME_ERROR detail=runtime-error." in prompt
assert "Previous restart outcome for this revision: restarted-unhealthy." in prompt

candidate = root / "candidate"
(candidate / "nested").mkdir(parents=True)
(candidate / "app.py").write_text("import gradio\n")
good = {
    "run_id": "fixture-run", "result_state": "final", "space_id": SPACE, "status": "fix-proposed",
    "revision": REVISION, "checked_at": "2026-09-01T12:00:00Z", "completed_at": "2026-09-01T12:01:00Z",
    "findings": [{"severity": "error", "rule_id": "fixture-error", "summary": "broken import"}],
    "changed_files": ["app.py"], "fix_summary": "Fix the import", "pr_title": "Fix broken import", "needs_human_reason": "",
}
assert module.validate_doctor_result(good, SPACE, REVISION, "fixture-run", candidate) is None
# Pinned public mcp-tools/wan-2-2-first-last-frame app.py at
# d28717db438f408a425464f4369e96954bce02fe triggered token env-lookup and
# variable-reference false positives (lines 86 and 104). No network needed here.
# Normal kwargs are not credentials; report redaction stays conservative.
for text in (
    "client(token=runtime_token, max_new_tokens=256, authorization=authorization)\n",
    "token = os.environ.get('HF_TOKEN')\n",
    "client(token=os.getenv('HF_TOKEN'))\n",
    "headers = {'Authorization': authorization}\n",
):
    (candidate / "app.py").write_text(text)
    assert module.validate_doctor_result(good, SPACE, REVISION, "fixture-run", candidate) is None
assert module.redact("token=runtime_token") != "token=runtime_token"
for text in (
    "token = 'hf_" + "a" * 32 + "'",
    "key = 'sk_" + "b" * 32 + "'",
    "key = 'sk-" + "c" * 32 + "'",
    "-----BEGIN RSA PRIVATE KEY-----",
):
    (candidate / "app.py").write_text(text)
    assert module.validate_doctor_result(good, SPACE, REVISION, "fixture-run", candidate) == "candidate file contains a high-confidence credential signature"
for name in module.SECRET_ENV_NAMES:
    saved = os.environ.get(name)
    try:
        os.environ[name] = TOKEN
        (candidate / "app.py").write_text("credential = " + repr(TOKEN))
        assert module.validate_doctor_result(good, SPACE, REVISION, "fixture-run", candidate) == "candidate file contains a runtime credential"
    finally:
        if saved is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = saved
# Config-injected credentials are checked even when absent from parent env.
(candidate / "app.py").write_text("credential = " + repr(doctor_token))
assert module.validate_doctor_result(good, SPACE, REVISION, "fixture-run", candidate, (doctor_token,)) == "candidate file contains a runtime credential"
(candidate / "app.py").write_text("import gradio\n")
for contract in (skill, prompt):
    assert "unauthenticated model probe returning 401/403" in contract
    assert "actual Space runtime" in contract
    assert "independent code repair may be" in contract
    assert "warning finding" in contract
assert "report `needs-human` on 401/403" not in skill

outside = root / "outside"
outside.mkdir()
(outside / "escape.py").write_text("x = 1\n")
(candidate / "nested").rmdir()
(candidate / "nested").symlink_to(outside, target_is_directory=True)
assert module.validate_doctor_result({**good, "changed_files": ["nested/escape.py"]}, SPACE, REVISION, "fixture-run", candidate)

module.time.sleep = lambda _: None
module.schema_healthy = lambda *args: True
class FakeApi:
    def __init__(self):
        self.restarted, self.commits = False, []
    def space_info(self, **kwargs):
        return SimpleNamespace(sha=REVISION, subdomain="fixture", private=False)
    def get_space_runtime(self, **kwargs):
        return SimpleNamespace(stage="RUNNING" if self.restarted else "RUNTIME_ERROR")
    def restart_space(self, **kwargs):
        assert kwargs["factory_reboot"] is False
        assert kwargs["token"] == TOKEN
        self.restarted = True
    def create_commit(self, **kwargs):
        assert kwargs["token"] == TOKEN
        self.commits.append(kwargs)
        return SimpleNamespace(pr_url="https://huggingface.co/spaces/example/fixture/discussions/1")

assert module.attempt_restart(FakeApi(), TOKEN, config, SPACE, REVISION, state_root, "fixture-job") == "restarted-healthy"
assert module.read_ledger(state_root, SPACE)["treatment"] == "restarted"
assert module.read_ledger(state_root, SPACE)["restart_outcome"] == "restarted-healthy"

class FakeUnhealthyRestartApi(FakeApi):
    def get_space_runtime(self, **kwargs):
        return SimpleNamespace(stage="RUNNING" if self.restarted else "RUNTIME_ERROR")

original_monotonic = module.time.monotonic
ticks = iter((0, 0, 2))
module.time.monotonic = lambda: next(ticks)
module.schema_healthy = lambda *args: False
unhealthy_space = "example/restart-unhealthy"
try:
    assert module.attempt_restart(FakeUnhealthyRestartApi(), TOKEN, config, unhealthy_space, REVISION, state_root, "fixture-job") == "restarted-unhealthy"
finally:
    module.time.monotonic = original_monotonic
assert module.read_ledger(state_root, unhealthy_space)["treatment"] == "restarted"
assert module.read_ledger(state_root, unhealthy_space)["restart_outcome"] == "restarted-unhealthy"

class FakeFailedRestartApi(FakeApi):
    def restart_space(self, **kwargs):
        assert module.read_ledger(state_root, "example/restart-failed")["restart_outcome"] == "unknown"
        raise OSError("network unavailable")

failed_restart_space = "example/restart-failed"
assert module.attempt_restart(FakeFailedRestartApi(), TOKEN, config, failed_restart_space, REVISION, state_root, "fixture-job") == "transport-error"
assert module.read_ledger(state_root, failed_restart_space)["treatment"] == "restarted"
assert module.read_ledger(state_root, failed_restart_space)["restart_outcome"] == "transport-error"

import huggingface_hub
original_hf_api, api = huggingface_hub.HfApi, FakeApi()
huggingface_hub.HfApi = lambda: api
doctor_calls = []
def fake_run_doctor(*args):
    doctor_calls.append(args)
    return good | {"run_id": args[3]}, candidate, ""
module.run_doctor = fake_run_doctor
observation = {"status": "UNHEALTHY", "space_id": SPACE, "stage": "RUNTIME_ERROR", "revision": REVISION, "detail": "runtime-error"}
try:
    assert module.treat_space(config, observation, [0])["outcome"] == "pr-opened"
    assert api.commits[0]["parent_commit"] == REVISION and api.commits[0]["create_pr"] is True
    assert api.commits[0]["token"] == TOKEN
    assert doctor_calls[0][4] == observation
    assert doctor_calls[0][5] == "restarted-healthy"
    assert module.read_ledger(state_root, SPACE)["restart_outcome"] == "restarted-healthy"
    assert module.treat_space(config, observation, [0])["outcome"] == "held"

    for suffix, failure in enumerate((
        "provider-auth-failed", "doctor-output-schema-unsupported", "doctor-no-result", "doctor-result-rejected",
        "doctor-result-rejected: candidate file contains a runtime credential"
    )):
        failure_space = f"example/permanent-{suffix}"
        module.run_doctor = lambda *args, failure=failure: (None, candidate, failure)
        failed_doctor = module.treat_space(
            config, {**observation, "space_id": failure_space, "stage": "BUILD_ERROR"}, [0]
        )
        assert failed_doctor["outcome"] == "needs-human" and failed_doctor["reason"] == failure
        assert module.read_ledger(state_root, failure_space)["treatment"] == "needs-human"

    for suffix, failure in enumerate(("provider-rate-limited", "doctor-timeout")):
        retry_space = f"example/retry-{suffix}"
        module.run_doctor = lambda *args, failure=failure: (None, candidate, failure)
        assert module.treat_space(
            config, {**observation, "space_id": retry_space, "stage": "BUILD_ERROR"}, [0]
        )["outcome"] == failure
        assert module.read_ledger(state_root, retry_space) is None

    failed_pr_space = "example/pr-failure"
    module.run_doctor = lambda *args: (good | {"run_id": args[3]}, candidate, "")
    api.create_commit = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("connection failed"))
    assert module.treat_space(config, {**observation, "space_id": failed_pr_space, "stage": "BUILD_ERROR"}, [0])["outcome"] == "pr-failed"
    assert module.read_ledger(state_root, failed_pr_space)["treatment"] == "pr-failed"
    assert module.treat_space(config, {**observation, "space_id": failed_pr_space, "stage": "BUILD_ERROR"}, [0])["outcome"] == "held"
finally:
    huggingface_hub.HfApi = original_hf_api

report = {
    "schema_version": "space-monitor/v1", "run_id": "fixture-job",
    "started_at": "2026-09-01T12:00:00Z", "completed_at": "2026-09-01T12:05:00Z",
    "catalog": {"source": "local-catalog", "error": None}, "counts": {"total": 2, "healthy": 1, "degraded": 1, "unhealthy": 0},
    "spaces": [{"space_id": SPACE, "status": "HEALTHY", "outcome": "observed"}, {"space_id": "example/other", "status": "DEGRADED", "outcome": "observed"}],
    "doctor": {"package": "fast-agent-mcp@0.10.16", "model": "responses.fixture"},
}
module.publish_report(root / "reports", "fixture-job", report)
assert len(json.loads((root / "reports/2026/09/01/fixture-job/report.json").read_text())["spaces"]) == 2

# The real loop writes all observations, not just the Space it treats.
import os
os.environ.update({
    "MONITOR_ROOT": str(root / "main-monitor"),
    "LOCAL_ROOT": str(root / "main-local"),
    "DYNAMIC_SPACE_DATA": str(catalog),
    "MONITOR_RUN_ID": "main-loop",
})
catalog.write_text('space_id,category,description\nexample/fixture,,first\nexample/other,,second\n')
module.observe_space = lambda cfg, space_id: (
    {"space_id": space_id, "status": "UNHEALTHY", "stage": "BUILD_ERROR", "revision": REVISION, "detail": "runtime-error"}
)
module.sys.argv = [str(monitor_path)]
assert module.main() == 1
main_report = next((root / "main-monitor/reports").rglob("report.json"))
main_spaces = json.loads(main_report.read_text())["spaces"]
assert len(main_spaces) == 2 and all(space["outcome"] == "doctor-skipped" for space in main_spaces)
print("monitor unit checks passed")
PY

if grep -R -E 'hub-sentinel-must-never-persist|sk-fixtureproviderkey' \
	"$test_root/reports" "$test_root/state" "$test_root/main-monitor" >/dev/null 2>&1; then
	echo "A credential persisted in reports or state." >&2
	exit 1
fi

echo "test-distribution: all checks passed"
