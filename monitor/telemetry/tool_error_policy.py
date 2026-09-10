"""Versioned, conservative per-tool error taxonomy. Never return source values.

Changing classification/adapter semantics requires a policy-version bump and
recomputing BOTH comparison windows. Billing/infrastructure/tool-quality are
attribution classes, not proof of blame or user task failure.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import re

POLICY_VERSION = 'tool-errors-v1'
BUCKETS = ('billing', 'infrastructure', 'tool_quality', 'access_or_target', 'mixed', 'unknown')
JOBS_OPS = ('run', 'uv', 'ps', 'logs', 'inspect', 'cancel', 'scheduled run', 'scheduled uv',
            'scheduled ps', 'scheduled inspect', 'scheduled delete', 'scheduled suspend', 'scheduled resume')
# Public names only. Unknown/dynamic names are counted but never retained.
TOOL_OPERATIONS = {
    'hf_fs': ('batch', 'ls', 'cat', 'attach', 'stat', 'find', 'search'),
    'hf_fs_write': ('put', 'rm'),
    'hf_jobs': JOBS_OPS,
    'hf_sandbox': ('create', 'status', 'terminate', 'ps', 'kill'),
    'hf_sandbox_exec': ('exec',),
    'hf_sandbox_fs': ('ls', 'cat', 'stat', 'write', 'rm', 'mkdir'),
    'hub_repo_search': ('request',),
    'hub_repo_details': ('request',),
    'create_repo': ('request',),
    'dynamic_space': ('search', 'view_parameters', 'invoke', 'add', 'remove', 'list'),
}
FS_CODE_BUCKET = {
    'HF_FS_' + suffix: bucket
    for bucket, suffixes in {
        'tool_quality': ('INVALID_ARGUMENT', 'NOT_A_DIRECTORY', 'NOT_A_FILE',
                         'UNSUPPORTED_OPERATION', 'TEXT_ONLY', 'IMAGE_ONLY', 'UNSUPPORTED_MEDIA'),
        'access_or_target': ('NOT_FOUND', 'ACCESS_DENIED', 'IMAGE_TOO_LARGE',
                             'ATTACHMENT_BUDGET_EXCEEDED', 'IMAGE_CONTENT_DISABLED'),
        'infrastructure': ('ATTACHMENT_INTEGRITY',),
    }.items() for suffix in suffixes
}

@dataclass(frozen=True)
class Classification:
    bucket: str
    reason: str

@dataclass(frozen=True)
class Batch:
    requested: int
    completed: int
    succeeded: int
    codes: tuple[str, ...]


def batch_evidence(row: dict) -> Batch | None:
    """Use structured operation evidence only if counts and error entries reconcile."""
    if row.get('hfFsReportingSchema') != 'hf_fs_batch_v1':
        return None
    values = [row.get('hfFsOperations' + key) for key in ('Requested', 'Completed', 'Succeeded')]
    if not all(type(v) is int for v in values):
        return None
    requested, completed, succeeded = values
    if not 0 <= succeeded <= completed <= requested <= 30 or requested == 0:
        return None
    raw = row.get('hfFsOperationErrorsJson')
    try:
        errors = json.loads(raw) if isinstance(raw, str) else None
    except (ValueError, TypeError):
        return None
    if not isinstance(errors, list) or len(errors) != completed - succeeded:
        return None
    codes, indexes = [], set()
    for item in errors:
        if not isinstance(item, dict):
            return None
        index, code = item.get('index'), item.get('code')
        if type(index) is not int or not 0 <= index < completed or index in indexes:
            return None
        if not isinstance(code, str) or code not in FS_CODE_BUCKET:
            return None
        indexes.add(index)
        codes.append(code)
    expected = ('complete' if succeeded == requested else
                'none_succeeded' if succeeded == 0 else 'partial')
    if completed != requested or row.get('hfFsBatchOutcome') != expected:
        return None  # interrupted batches are reported separately, not fabricated operations
    return Batch(requested, completed, succeeded, tuple(codes))


def operation(tool: str, row: dict) -> str:
    """Adapters reflect how EACH production handler logs its inputs."""
    allowed = TOOL_OPERATIONS[tool]
    if allowed == ('request',):
        return 'request'
    value = row.get('parameters')
    try:
        params = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        params = None
    params = params if isinstance(params, dict) else {}
    if tool == 'hf_jobs':
        op = row.get('query')  # jobs logs inner args, not operation
    elif tool == 'hf_fs' and ('operations' in params or row.get('hfFsReportingSchema') == 'hf_fs_batch_v1'):
        return 'batch'
    else:
        op = params.get('cmd', params.get('operation', params.get('op')))
    return op if isinstance(op, str) and op in allowed else 'unknown'


def error_text(value: object, tool: str) -> str:
    if not isinstance(value, str):
        return ''
    text = value[:16384].strip()
    for _ in range(3):
        text = re.sub(r'^(?:Error|HfApiError|TypeError|ZodError):\s*', '', text)
    if tool == 'hf_jobs':
        for op in JOBS_OPS:
            prefix = f'Error executing {op}: '
            if text.startswith(prefix):
                text = text[len(prefix):]
                break
    return text


# Anchored provider templates, NOT bare numbers or broad keyword searches.
HTTP = re.compile(r'^(?:API request failed: |Sandbox RPC /[^\s]{1,120} failed with |Failed to fetch logs: )(\d{3})\b')
HTTP_BUCKETS = {
    402: ('billing', 'http_402_payment_required'),
    401: ('access_or_target', 'http_401_authentication'),
    403: ('access_or_target', 'http_403_authorization'),
    404: ('access_or_target', 'http_404_missing_resource'),
    429: ('infrastructure', 'http_429_throttled'),
    500: ('infrastructure', 'http_500'),
    502: ('infrastructure', 'http_502'),
    503: ('infrastructure', 'http_503_not_ready_or_unavailable'),
    504: ('infrastructure', 'http_504'),
    400: ('unknown', 'http_400_unresolved'),
    409: ('unknown', 'http_409_unresolved'),
    422: ('unknown', 'http_422_unresolved'),
}


def classify(tool: str, row: dict) -> Classification:
    """Classify a failed CALL once. Success and unknown outcomes are not failures."""
    if row.get('success') is not False:
        raise ValueError('classify requires an explicit failed call')
    if tool not in TOOL_OPERATIONS:
        return Classification('unknown', 'unregistered_tool')
    if tool == 'hf_fs':
        batch = batch_evidence(row)
        if batch and batch.codes and batch.succeeded == 0:
            buckets = {FS_CODE_BUCKET[code] for code in batch.codes}
            return Classification(next(iter(buckets)) if len(buckets) == 1 else 'mixed',
                                  'structured_batch_errors')
        if batch and batch.succeeded:
            return Classification('unknown', 'inconsistent_batch_call_outcome')
    text = error_text(row.get('errorMessage'), tool)
    # Tool-specific contracts precede HTTP: command payloads can contain fake status messages.
    if tool == 'hf_jobs':
        prefixes = {
            'Unsupported shell syntax in command:': 'unsupported_shell_syntax',
            'Invalid timeout format:': 'invalid_timeout_format',
            'Invalid parameters for ': 'argument_validation',
            'Error: Invalid parameters for ': 'argument_validation',
            'Invalid command:': 'invalid_command',
        }
        for prefix, reason in prefixes.items():
            if text.startswith(prefix):
                return Classification('tool_quality', reason)
    if tool.startswith('hf_sandbox'):
        prefixes = {
            'job id in handle contains unsupported characters.': 'handle_characters',
            'Invalid sandbox handle.': 'invalid_handle',
            'Bare job id needs a namespace.': 'missing_handle_namespace',
            'foreground exec timeout must be <=': 'foreground_timeout_limit',
            'EINVAL:': 'argument_validation',
        }
        for prefix, reason in prefixes.items():
            if text.startswith(prefix):
                return Classification('tool_quality', reason)
        if text.startswith('Hugging Face sandboxes require authentication'):
            return Classification('access_or_target', 'authentication_required')
        if text.startswith('no such file:'):
            return Classification('access_or_target', 'missing_path')
    if tool in ('hf_fs', 'hf_fs_write') and text.startswith('EINVAL:'):
        return Classification('tool_quality', 'argument_validation')
    if tool == 'dynamic_space' and text.startswith('Unknown operation:'):
        return Classification('tool_quality', 'unknown_operation')
    match = HTTP.match(text)
    if match:
        return Classification(*HTTP_BUCKETS.get(int(match[1]), ('unknown', 'unmapped_http_status')))
    if re.match(r'^API request timed out after \d+ms\b', text):
        return Classification('infrastructure', 'api_timeout')
    if text in ('fetch failed', 'API request failed: fetch failed', 'connection lost while running command'):
        return Classification('infrastructure', 'connection_failure')
    return Classification('unknown', 'unrecognized_error' if text else 'missing_error_evidence')
