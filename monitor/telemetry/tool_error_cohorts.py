"""Privacy-safe, fixed public client families and validated fs operation shapes."""
import json
import re

from tool_error_policy import FS_CODE_BUCKET, Classification, batch_evidence

CLIENT_POLICY_VERSION = 'client-cohorts-v2'
HF_CLIENT_FAMILIES = ('chat-ui-intern', 'chat-ui-mcp')
CLIENT_NAMES = {
    'chat-ui-intern': 'chat-ui-intern', 'chat-ui-mcp': 'chat-ui-mcp',
    'claude-code': 'Claude Code', 'Anthropic/ClaudeAI': 'Claude.ai', 'claude-ai': 'Claude.ai',
    'claude-desktop': 'Claude Desktop', 'openai-mcp': 'OpenAI MCP',
    'codex-mcp-client': 'Codex', 'opencode': 'OpenCode', 'Cursor': 'Cursor',
    'cursor-vscode': 'Cursor', 'fast-agent': 'fast-agent', 'fast-agent-mcp': 'fast-agent',
    'cline': 'Cline', 'roo-code': 'Roo Code', 'Visual Studio Code': 'VS Code',
}
CLIENT_FAMILIES = frozenset((*CLIENT_NAMES.values(), 'Other'))
NUMERIC_VERSION = re.compile(r'v?(\d{1,4}(?:\.\d{1,4}){1,3})\Z')
FS_OPERATIONS = frozenset(('ls', 'cat', 'attach', 'stat', 'find', 'search'))
FS_ROOTS = frozenset(('models', 'datasets', 'spaces', 'buckets', 'papers', 'collections', 'docs', 'root', 'other'))


def client_cohort(row):
    name = row.get('name')
    if not isinstance(name, str) or len(name) > 200:
        return 'Other', 'unreported'
    # Drop wrapper/context completely; never return raw names or wrapper text.
    name = re.sub(r' \(via mcp-remote [^\r\n)]{1,80}\)$', '', name)
    if re.fullmatch(r'openai-mcp \([^\r\n)]{1,120}\)', name):
        name = 'openai-mcp'
    family = CLIENT_NAMES.get(name, 'Other')
    if family == 'Other':
        return family, 'unreported'
    version = row.get('version')  # client version, deliberately NOT serverVersion
    match = NUMERIC_VERSION.fullmatch(version) if isinstance(version, str) else None
    return family, match[1] if match else 'unreported'


def fs_operation_outcomes(row):
    """Map validated error indexes onto bounded public commands/root categories.

    All URIs, paths, queries and arguments remain in memory and are discarded.
    Return no operations when shape alignment is uncertain.
    """
    batch = batch_evidence(row)
    if batch is None:
        return []
    value = row.get('parameters')
    try:
        params = json.loads(value) if isinstance(value, str) else value
        errors = json.loads(row['hfFsOperationErrorsJson'])
    except (ValueError, TypeError, KeyError):
        return []
    operations = params.get('operations') if isinstance(params, dict) else None
    if not isinstance(operations, list) or len(operations) != batch.completed:
        return []
    codes = {item['index']: item['code'] for item in errors}
    results = []
    for index, item in enumerate(operations):
        if not isinstance(item, dict):
            return []
        command = item.get('cmd')
        if not isinstance(command, str) or command not in FS_OPERATIONS:
            command = 'unknown'
        args = item.get('args')
        uri = args[0] if isinstance(args, list) and args and isinstance(args[0], str) else ''
        root = 'root' if uri in ('hf://', 'hf:') else 'other'
        match = re.match(r'^hf://(models|datasets|spaces|buckets|papers|collections|docs)(?:/|$)', uri)
        if match:
            root = match[1]
        code = codes.get(index)
        failure = Classification(FS_CODE_BUCKET[code], code) if code else None
        results.append((command, root, 'failure' if failure else 'success', failure))
    return results
