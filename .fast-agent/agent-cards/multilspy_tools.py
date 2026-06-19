"""Function tools for typescript-language-server-backed MultiLSPy queries."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack, ExitStack, asynccontextmanager
from pathlib import Path
from shutil import which
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar
from urllib.parse import urlparse

from multilspy.language_server import LanguageServer
from multilspy.lsp_protocol_handler.server import ProcessLaunchInfo
from multilspy.multilspy_config import Language, MultilspyConfig
from multilspy.multilspy_exceptions import MultilspyException
from multilspy.multilspy_logger import MultilspyLogger

# REQUIRED: Adjust parents[] if the card is not stored at .fast-agent/agent-cards/.
_REPO_ROOT = Path(__file__).resolve().parents[2]

# RECOMMENDED: Narrow LSP access to the parts of the repo you actually want queried.
# Use {"."} to allow the entire repo.
_ALLOWED_DIRS = {"packages", "scripts", "spec", "docs", "docs-internal"}
_ALLOWED_FILES: set[str] = {"package.json", "tsconfig.json", "pnpm-workspace.yaml"}

# Keep at least one source file open while issuing workspace-level requests.
# typescript-language-server delegates workspace/symbol to tsserver's `navto`,
# which needs an active project; root workspaces with only project references can
# otherwise fail with "No Project".
_WORKSPACE_SYMBOL_SEED_FILES = (
    "packages/mcp/src/model-detail.ts",
    "packages/app/src/server/application.ts",
)

_server_lock = asyncio.Lock()
_server_stack: AsyncExitStack | None = None
_server: "TypeScriptServer" | None = None

_CONTENT_MODIFIED_RETRY_ATTEMPTS = 2
_CONTENT_MODIFIED_BASE_DELAY_SECONDS = 0.05

_ReturnT = TypeVar("_ReturnT")


class TypeScriptServer(LanguageServer):
    """Language server wrapper for typescript-language-server."""

    def __init__(self, config: MultilspyConfig, logger: MultilspyLogger, repository_root_path: str):
        ts_cmd = _resolve_typescript_server_cmd()
        super().__init__(
            config,
            logger,
            repository_root_path,
            ProcessLaunchInfo(cmd=ts_cmd, cwd=repository_root_path),
            "typescript",
        )
        self.diagnostics: dict[str, list[dict[str, Any]]] = {}

    def _get_initialize_params(self, repository_absolute_path: str) -> dict[str, Any]:
        root_uri = Path(repository_absolute_path).as_uri()
        return {
            "processId": os.getpid(),
            "rootPath": repository_absolute_path,
            "rootUri": root_uri,
            "workspaceFolders": [
                {
                    "uri": root_uri,
                    "name": Path(repository_absolute_path).name,
                }
            ],
            "capabilities": {
                "workspace": {"workspaceFolders": True},
                "textDocument": {"hover": {"contentFormat": ["markdown", "plaintext"]}},
            },
        }

    @asynccontextmanager
    async def start_server(self) -> "AsyncIterator[TypeScriptServer]":
        async def do_nothing(params: Any) -> None:
            return None

        async def window_log_message(msg: Any) -> None:
            self.logger.log(f"LSP: window/logMessage: {msg}", logging.INFO)

        async def publish_diagnostics(params: dict[str, Any]) -> None:
            uri = params.get("uri")
            if not uri:
                return
            self.diagnostics[uri] = params.get("diagnostics", [])

        self.server.on_notification("window/logMessage", window_log_message)
        self.server.on_request("workspace/executeClientCommand", do_nothing)
        self.server.on_notification("$/progress", do_nothing)
        self.server.on_notification("textDocument/publishDiagnostics", publish_diagnostics)

        async with super().start_server():
            self.logger.log("Starting typescript-language-server process", logging.INFO)
            await self.server.start()
            initialize_params = self._get_initialize_params(self.repository_root_path)
            self.logger.log(
                "Sending initialize request from LSP client to typescript-language-server",
                logging.INFO,
            )
            await self.server.send.initialize(initialize_params)
            self.server.notify.initialized({})
            yield self
            await self.server.shutdown()
            await self.server.stop()


def _resolve_typescript_server_cmd() -> str:
    executable = which("typescript-language-server")
    if executable is None:
        raise MultilspyException(
            "typescript-language-server is not available on PATH. Install it via npm."
        )
    return f"{executable} --stdio"


def _allow_all_paths() -> bool:
    return "." in _ALLOWED_DIRS


def _allowed_path_error() -> str:
    if _allow_all_paths():
        return ""
    if _ALLOWED_DIRS and _ALLOWED_FILES:
        allowed_dirs = ", ".join(sorted(_ALLOWED_DIRS))
        allowed_files = ", ".join(sorted(_ALLOWED_FILES))
        return f"Path must live under one of: {allowed_dirs}; or be one of: {allowed_files}."
    if _ALLOWED_DIRS:
        allowed_dirs = ", ".join(sorted(_ALLOWED_DIRS))
        return f"Path must live under {allowed_dirs}."
    if _ALLOWED_FILES:
        allowed_files = ", ".join(sorted(_ALLOWED_FILES))
        return f"Path must be one of: {allowed_files}."
    return "Path is not allowed. Configure _ALLOWED_DIRS or _ALLOWED_FILES."


def _path_is_allowed(relative_path: Path) -> bool:
    if _allow_all_paths():
        return True
    if len(relative_path.parts) == 1:
        return relative_path.name in _ALLOWED_FILES
    return relative_path.parts[0] in _ALLOWED_DIRS


def _resolve_relative_path(file_path: str) -> str:
    path = Path(file_path)
    path = (_REPO_ROOT / path).resolve() if not path.is_absolute() else path.resolve()

    try:
        relative_path = path.relative_to(_REPO_ROOT)
    except ValueError as exc:  # pragma: no cover - defensive guard
        raise ValueError("Path is outside the repository root.") from exc

    if not relative_path.parts:
        raise ValueError("Path must point to a file within the repository.")

    if not _path_is_allowed(relative_path):
        raise ValueError(_allowed_path_error())

    if not path.exists():
        raise ValueError(f"File not found: {path}")

    return str(relative_path)


async def _ensure_server() -> TypeScriptServer:
    global _server_stack, _server
    if _server is not None and _server.server_started:
        return _server

    async with _server_lock:
        if _server is not None and _server.server_started:
            return _server

        config = MultilspyConfig(code_language=Language.TYPESCRIPT)
        logger = MultilspyLogger()
        server = TypeScriptServer(config, logger, str(_REPO_ROOT))
        stack = AsyncExitStack()
        await stack.enter_async_context(server.start_server())
        _server = server
        _server_stack = stack
        return server


def _format_range(range_data: dict[str, Any] | None) -> str:
    if not range_data:
        return ""
    start = range_data.get("start", {})
    line = start.get("line")
    character = start.get("character")
    if line is None or character is None:
        return ""
    return f"{line + 1}:{character + 1}"


def _uri_to_relative(uri: str | None) -> str:
    if not uri:
        return ""
    if uri.startswith("file:"):
        parsed = urlparse(uri)
        path = Path(parsed.path)
        try:
            return str(path.relative_to(_REPO_ROOT))
        except ValueError:
            return str(path)
    return uri


def _format_locations(locations: list[dict[str, Any]]) -> str:
    if not locations:
        return "No locations returned."

    lines = ["| path | line |", "| --- | --- |"]
    for location in locations:
        path = location.get("relativePath") or location.get("absolutePath") or _uri_to_relative(
            location.get("uri")
        )
        line = _format_range(location.get("range"))
        lines.append(f"| {path} | {line} |")
    return "\n".join(lines)


def _format_hover_contents(contents: Any) -> str:
    if contents is None:
        return "No hover contents returned."
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list):
        return "\n\n".join(_format_hover_contents(item) for item in contents)
    if isinstance(contents, dict):
        value = contents.get("value")
        if isinstance(value, str):
            return value
        return json.dumps(contents, indent=2)
    return str(contents)


def _format_symbol_kind(kind: Any) -> str:
    if not isinstance(kind, int):
        return str(kind or "")
    return {
        1: "File",
        2: "Module",
        3: "Namespace",
        4: "Package",
        5: "Class",
        6: "Method",
        7: "Property",
        8: "Field",
        9: "Constructor",
        10: "Enum",
        11: "Interface",
        12: "Function",
        13: "Variable",
        14: "Constant",
        15: "String",
        16: "Number",
        17: "Boolean",
        18: "Array",
        19: "Object",
        20: "Key",
        21: "Null",
        22: "EnumMember",
        23: "Struct",
        24: "Event",
        25: "Operator",
        26: "TypeParameter",
    }.get(kind, str(kind))


def _format_symbols(symbols: list[dict[str, Any]], default_path: str | None = None) -> str:
    if not symbols:
        return "No symbols returned."
    lines = ["| name | kind | location | detail |", "| --- | --- | --- | --- |"]
    for symbol in symbols:
        location = symbol.get("location") or {}
        path = (
            location.get("relativePath")
            or location.get("absolutePath")
            or _uri_to_relative(location.get("uri"))
            or ""
        )
        if not path and default_path:
            path = default_path
        range_data = location.get("range") or symbol.get("range") or symbol.get("selectionRange")
        line = _format_range(range_data)
        location_display = f"{path} ({line})" if path and line else path
        lines.append(
            "| {name} | {kind} | {location} | {detail} |".format(
                name=symbol.get("name", ""),
                kind=_format_symbol_kind(symbol.get("kind")),
                location=location_display,
                detail=symbol.get("detail", "") or "",
            )
        )
    return "\n".join(lines)


def _is_content_modified_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "content modified" in message or "-32801" in message


def _workspace_symbol_seed_files() -> list[str]:
    seed_files: list[str] = []
    for file_path in _WORKSPACE_SYMBOL_SEED_FILES:
        path = _REPO_ROOT / file_path
        if path.exists() and _path_is_allowed(path.relative_to(_REPO_ROOT)):
            seed_files.append(file_path)
    return seed_files


async def _retry_on_content_modified(operation: Callable[[], Awaitable[_ReturnT]]) -> _ReturnT:
    for attempt in range(_CONTENT_MODIFIED_RETRY_ATTEMPTS + 1):
        try:
            return await operation()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if attempt == _CONTENT_MODIFIED_RETRY_ATTEMPTS or not _is_content_modified_error(exc):
                raise
            await asyncio.sleep(_CONTENT_MODIFIED_BASE_DELAY_SECONDS * (2**attempt))
    raise RuntimeError("Retry loop exhausted unexpectedly.")


async def lsp_hover(file_path: str, line: int, character: int) -> str:
    """Return hover information for a symbol at the given location."""
    try:
        relative_path = _resolve_relative_path(file_path)
        server = await _ensure_server()
        hover = await _retry_on_content_modified(
            lambda: server.request_hover(relative_path, line, character)
        )
        if not hover:
            return "No hover information returned."
        return _format_hover_contents(hover.get("contents"))
    except (ValueError, MultilspyException) as exc:
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        return f"Error: {exc}"


async def lsp_definition(file_path: str, line: int, character: int) -> str:
    """Return definition locations for a symbol at the given location."""
    try:
        relative_path = _resolve_relative_path(file_path)
        server = await _ensure_server()
        locations = await _retry_on_content_modified(
            lambda: server.request_definition(relative_path, line, character)
        )
        if not locations:
            return "No locations returned."
        return _format_locations([dict(location) for location in locations])
    except (ValueError, MultilspyException) as exc:
        message = str(exc)
        if "Unexpected response from Language Server" in message:
            return "No locations returned."
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        message = str(exc)
        if "Unexpected response from Language Server" in message:
            return "No locations returned."
        return f"Error: {exc}"


async def lsp_references(file_path: str, line: int, character: int) -> str:
    """Return reference locations for a symbol at the given location."""
    try:
        relative_path = _resolve_relative_path(file_path)
        server = await _ensure_server()
        locations = await _retry_on_content_modified(
            lambda: server.request_references(relative_path, line, character)
        )
        if not locations:
            return "No locations returned."
        return _format_locations([dict(location) for location in locations])
    except (ValueError, MultilspyException) as exc:
        message = str(exc)
        if "Unexpected response from Language Server" in message:
            return "No locations returned."
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        message = str(exc)
        if "Unexpected response from Language Server" in message:
            return "No locations returned."
        return f"Error: {exc}"


async def lsp_document_symbols(file_path: str) -> str:
    """Return document symbols for a file."""
    try:
        relative_path = _resolve_relative_path(file_path)
        server = await _ensure_server()
        symbols, _ = await _retry_on_content_modified(
            lambda: server.request_document_symbols(relative_path)
        )
        return _format_symbols([dict(symbol) for symbol in symbols], default_path=relative_path)
    except (ValueError, MultilspyException) as exc:
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        return f"Error: {exc}"


async def lsp_workspace_symbols(query: str) -> str:
    """Return workspace symbols matching a query string."""
    try:
        server = await _ensure_server()
        seed_files = _workspace_symbol_seed_files()
        if not seed_files:
            symbols = await _retry_on_content_modified(lambda: server.request_workspace_symbol(query))
        else:
            with ExitStack() as stack:
                for seed_file in seed_files:
                    stack.enter_context(server.open_file(seed_file))
                symbols = await _retry_on_content_modified(lambda: server.request_workspace_symbol(query))
        if symbols is None:
            return "No symbols returned."
        return _format_symbols([dict(symbol) for symbol in symbols])
    except (ValueError, MultilspyException) as exc:
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        return f"Error: {exc}"


async def lsp_diagnostics(file_path: str | None = None) -> str:
    """Return cached diagnostics from typescript-language-server."""
    try:
        server = await _ensure_server()
        if file_path is None:
            diagnostics = server.diagnostics
        else:
            relative_path = _resolve_relative_path(file_path)
            uri = Path(_REPO_ROOT / relative_path).as_uri()
            diagnostics = {uri: server.diagnostics.get(uri, [])}
        if not diagnostics:
            return "No diagnostics cached."
        return json.dumps(diagnostics, indent=2)
    except (ValueError, MultilspyException) as exc:
        return f"Error: {exc}"
    except Exception as exc:  # pragma: no cover - defensive guard
        return f"Error: {exc}"
