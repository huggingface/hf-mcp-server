#!/usr/bin/env python3
"""Create private, sanitized local hf_fs review candidates from a log mirror.

The parser is a small observed-format adapter, not an import of or equivalence
claim about any current or historical server implementation.  Unknown shapes
fail closed.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterable
from urllib.parse import unquote_to_bytes, urlsplit

from snapshot_names import approved_snapshot

SCHEMA_VERSION = "data-fill-v2"
POLICY_VERSION = "hf-fs-local-review-v2"
REPO_ROOT = Path(__file__).resolve().parents[1]
# Tests may patch this module-local value to an isolated local boundary.  There
# is no production CLI/environment bypass.
ALLOWED_LOCAL_ROOT = REPO_ROOT / "data" / "local"
DEFAULT_OUTPUT_ROOT = ALLOWED_LOCAL_ROOT / "fills"
ROOTS = frozenset(("models", "datasets", "spaces", "collections", "papers", "docs"))
OPS = frozenset(("ls", "cat", "stat", "find", "search"))
ENTRY_TYPES = frozenset(("file", "dir", "repo", "bucket", "collection", "paper", "link"))
TYPE_ALIASES = {"f": "file", "d": "dir", "l": "link", "model": "repo", "dataset": "repo", "space": "repo"}
SORTS = frozenset(("createdAt", "downloads", "likes", "lastModified", "likes30d", "trendingScore", "mainSize", "id", "trending", "upvotes"))
VERSION_RE = re.compile(r"^[0-9][0-9A-Za-z.+-]{0,63}$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._%+@-]{0,127}$")
SAFE_TEXT_RE = re.compile(r"^[\x20-\x7e]{1,240}$")
# These limits deliberately apply before a record reaches json.loads.  The
# record limit excludes its terminating LF; an over-limit record is rejected
# and drained in fixed-size reads so later records and the stored-byte digest
# remain usable.  The gzip limit is a per-source decompressed-byte budget:
# exceeding it aborts the fill rather than allowing a compressed bomb to grow.
MAX_DECOMPRESSED_RECORD_BYTES = 1024 * 1024
MAX_GZIP_DECOMPRESSED_BYTES = 64 * 1024 * 1024
RECORD_READ_CHUNK_BYTES = 64 * 1024
MAX_URI_PERCENT_DECODE_DEPTH = 3
URI_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
CREDENTIAL_MARKER_RE = re.compile(
	r"(?:api[-_ ]?key|authorization|auth|bearer|cookie|credential|password|secret|token)(?:\s+|[:=])",
	re.I,
)
CREDENTIAL_URI_MARKER_RE = re.compile(
	r"\b(?:api[-_ ]?key|authorization|auth|bearer|cookie|credential|password|secret|token)\b",
	re.I,
)
CREDENTIAL_TOKEN_RE = re.compile(
	r"(?:hf_[a-z0-9]{8,}|(?:gh[pousr]|github_pat)_[a-z0-9_]{12,}|sk-[a-z0-9]{16,}|"
	r"xox[baprs]-[a-z0-9-]{10,}|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})",
	re.I,
)


class FillError(ValueError):
	"""A safe, user-actionable selection or input error."""


@dataclass(frozen=True)
class SourceFile:
	path: Path
	relative: str
	format: str
	shard_date: str | None


class HashingReader:
	def __init__(self, stream: BinaryIO, digest: Any) -> None:
		self.stream, self.digest = stream, digest
	def read(self, size: int = -1) -> bytes:
		value = self.stream.read(size); self.digest.update(value); return value
	def readinto(self, buffer: bytearray) -> int:
		count = self.stream.readinto(buffer)
		if count: self.digest.update(memoryview(buffer)[:count])
		return count
	def readable(self) -> bool: return True
	def readline(self, size: int = -1) -> bytes:
		value = self.stream.readline(size); self.digest.update(value); return value
	def __iter__(self) -> "HashingReader": return self
	def __next__(self) -> bytes:
		value = self.readline()
		if not value: raise StopIteration
		return value
	def close(self) -> None: self.stream.close()


class BoundedJsonlReader:
	"""Yield bounded JSONL records, using ``None`` for a drained large record."""

	def __init__(self, stream: BinaryIO, *, gzip_source: bool, source_name: str) -> None:
		self.stream = stream
		self.gzip_source = gzip_source
		self.source_name = source_name

	def __iter__(self) -> Iterable[bytes | None]:
		record = bytearray()
		oversized = False
		decompressed_bytes = 0
		while chunk := self.stream.read(RECORD_READ_CHUNK_BYTES):
			if self.gzip_source:
				decompressed_bytes += len(chunk)
				if decompressed_bytes > MAX_GZIP_DECOMPRESSED_BYTES:
					raise FillError(
						f"gzip source exceeds the {MAX_GZIP_DECOMPRESSED_BYTES}-byte decompressed safety budget: "
						f"{self.source_name}"
					)
			start = 0
			while start < len(chunk):
				newline = chunk.find(b"\n", start)
				end = len(chunk) if newline < 0 else newline
				piece = chunk[start:end]
				if not oversized:
					remaining = MAX_DECOMPRESSED_RECORD_BYTES - len(record)
					if len(piece) > remaining:
						record.extend(piece[:remaining])
						oversized = True
					else:
						record.extend(piece)
				if newline < 0:
					break
				yield None if oversized else bytes(record)
				record.clear()
				oversized = False
				start = newline + 1
		if oversized:
			yield None
		elif record:
			yield bytes(record)


def parse_iso_date(value: str) -> str:
	try: return date.fromisoformat(value).isoformat()
	except ValueError as exc: raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {value!r}") from exc


def selected_dates(values: Iterable[str], start: str | None, end: str | None) -> list[str]:
	dates = set(values)
	if (start is None) != (end is None): raise FillError("--from-date and --to-date must be supplied together")
	if start and end:
		first, last = date.fromisoformat(start), date.fromisoformat(end)
		if first > last: raise FillError("--from-date must not be after --to-date")
		while first <= last: dates.add(first.isoformat()); first += timedelta(days=1)
	return sorted(dates)


def absolute(path: Path) -> Path: return Path(os.path.abspath(os.fspath(path.expanduser())))


def assert_no_symlink_components(path: Path, label: str) -> None:
	current = Path(path.anchor)
	for part in path.parts[1:]:
		current /= part
		try: info = os.lstat(current)
		except FileNotFoundError: break
		if stat.S_ISLNK(info.st_mode): raise FillError(f"{label} has a symlinked component: {current}")


def assert_safe_below(root: Path, path: Path, label: str) -> None:
	try: path.relative_to(root)
	except ValueError as exc: raise FillError(f"{label} is outside its approved root") from exc
	assert_no_symlink_components(path, label)


def check_source_root(root: Path) -> Path:
	root = absolute(root); assert_no_symlink_components(root, "source root")
	if not root.is_dir(): raise FillError("source root does not exist or is not a directory")
	return root


def snapshot_date(path: Path) -> str | None: return approved_snapshot(path, "hf-fs")


def is_root_snapshot(path: Path, root: Path) -> bool:
	return path.parent == root and path.is_file() and not path.is_symlink() and snapshot_date(path) is not None


def root_snapshots(root: Path) -> list[Path]:
	return sorted((item for item in root.iterdir() if is_root_snapshot(item, root)), key=lambda item: (snapshot_date(item) or "", item.name))


def select_sources(root: Path, source: str, requested_dates: list[str], snapshot: str | None) -> tuple[list[SourceFile], str]:
	if snapshot:
		if source == "shards": raise FillError("--snapshot cannot be used with --source shards")
		candidate = absolute(Path(snapshot)) if Path(snapshot).is_absolute() else root / snapshot
		assert_safe_below(root, candidate, "snapshot")
		if candidate.parent != root or not is_root_snapshot(candidate, root): raise FillError("--snapshot must name an explicitly dated root-level hf_fs JSONL snapshot")
		return [SourceFile(candidate, candidate.relative_to(root).as_posix(), "snapshot", snapshot_date(candidate))], "snapshot"
	if source == "auto": source = "shards" if requested_dates else "snapshot"
	if source == "snapshot":
		snapshots = root_snapshots(root)
		if not snapshots: raise FillError("no explicitly dated root-level hf_fs snapshot exists")
		item = snapshots[-1]; assert_safe_below(root, item, "snapshot")
		return [SourceFile(item, item.relative_to(root).as_posix(), "snapshot", snapshot_date(item))], "snapshot"
	if source != "shards" or not requested_dates:
		raise FillError("--source shards requires --date or an inclusive date range")
	queries = root / "queries"; assert_safe_below(root, queries, "queries source root")
	results: list[SourceFile] = []; missing: list[str] = []
	for day in requested_dates:
		folder = queries / day; assert_safe_below(root, folder, "date shard")
		if not folder.is_dir(): missing.append(day); continue
		files = []
		for item in sorted(folder.iterdir()):
			assert_safe_below(root, item, "source file")
			if item.name.casefold().endswith((".jsonl", ".jsonl.gz")) and item.is_file() and not item.is_symlink(): files.append(item)
		if not files: missing.append(day)
		results.extend(SourceFile(item, item.relative_to(root).as_posix(), "shard", day) for item in files)
	if missing: raise FillError(f"requested date shard(s) missing: {', '.join(missing)}")
	return results, "shards"


def contains_credential(value: str) -> bool:
	"""Recognize secret labels and common opaque credential values."""

	return CREDENTIAL_MARKER_RE.search(value) is not None or CREDENTIAL_TOKEN_RE.search(value) is not None


def safe_string(value: object, *, max_length: int = 240) -> str | None:
	if (
		not isinstance(value, str)
		or len(value) > max_length
		or not SAFE_TEXT_RE.fullmatch(value)
		or contains_credential(value)
		or not safe_percent_encoded_text(value)
	):
		return None
	return value


def parse_parameters(value: object) -> tuple[dict[str, object] | None, str | None]:
	if isinstance(value, dict): return value, "object"
	if not isinstance(value, str) or len(value) > 20_000: return None, None
	try: parsed = json.loads(value)
	except (TypeError, json.JSONDecodeError): return None, None
	return (parsed, "encoded") if isinstance(parsed, dict) else (None, None)


def normalize_input_uri(value: object) -> str | None:
	if not isinstance(value, str) or len(value) > 512 or contains_credential(value): return None
	if re.match(r"^(?:models|datasets|spaces|collections|papers|docs)(?:/|$)", value): return "hf://" + value.rstrip("/")
	if value.startswith("hf://"): return value.rstrip("/") if value != "hf://" else value
	try: parsed = urlsplit(value)
	except ValueError: return None
	if parsed.scheme != "https" or parsed.hostname not in {"huggingface.co", "www.huggingface.co"} or parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment: return None
	parts = [part for part in parsed.path.split("/") if part]
	if not parts: return "hf://"
	if parts[0] in {"collections", "papers", "docs"}: return "hf://" + "/".join(parts)
	if parts[0] in {"models", "datasets", "spaces"} and len(parts) >= 3: kind, rest = parts[0], parts[1:]
	elif len(parts) >= 2 and parts[0] not in {"api", "login", "settings", "search", "new", "organizations"}: kind, rest = "models", parts
	else: return None
	if len(rest) >= 4 and rest[2] in {"blob", "resolve", "tree"}:
		owner, repo, _, revision, *tail = rest; return "hf://" + "/".join((kind, owner, repo if revision == "main" else f"{repo}@{revision}", *tail))
	return "hf://" + "/".join((kind, *rest))


def safe_uri_segment(value: str) -> bool:
	"""Screen percent-decoded segment views without changing canonical output."""

	if re.search(r"%(?![0-9A-Fa-f]{2})", value):
		return False
	decoded = value
	decoded_from_escape = False
	for _ in range(MAX_URI_PERCENT_DECODE_DEPTH):
		if URI_CONTROL_RE.search(decoded) or any(delimiter in decoded for delimiter in ("/", "?", "#", "\\")):
			return False
		if decoded_from_escape and "@" in decoded:
			return False
		if contains_credential(decoded) or (decoded_from_escape and CREDENTIAL_URI_MARKER_RE.search(decoded)):
			return False
		if "%" not in decoded:
			return True
		try:
			next_decoded = unquote_to_bytes(decoded).decode("utf-8", "strict")
		except UnicodeDecodeError:
			return False
		if next_decoded == decoded:
			return True
		decoded = next_decoded
		decoded_from_escape = True
	# A remaining escape might hide a delimiter or credential beyond our
	# bounded inspection depth, so reject it instead of recursively decoding.
	return (
		re.search(r"%[0-9A-Fa-f]{2}", decoded) is None
		and URI_CONTROL_RE.search(decoded) is None
		and not any(delimiter in decoded for delimiter in ("/", "?", "#", "\\", "@"))
		and not contains_credential(decoded)
		and not CREDENTIAL_URI_MARKER_RE.search(decoded)
	)


def safe_percent_encoded_text(value: str) -> bool:
	"""Screen encoded views of retained free text without changing its output."""

	if "%" not in value:
		return True
	if re.search(r"%(?![0-9A-Fa-f]{2})", value):
		return False
	decoded = value
	for _ in range(MAX_URI_PERCENT_DECODE_DEPTH):
		if URI_CONTROL_RE.search(decoded) or contains_credential(decoded):
			return False
		if "%" not in decoded:
			return True
		try:
			next_decoded = unquote_to_bytes(decoded).decode("utf-8", "strict")
		except UnicodeDecodeError:
			return False
		if next_decoded == decoded:
			return True
		decoded = next_decoded
	# A remaining escape may hide a credential beyond the inspection bound.
	return re.search(r"%[0-9A-Fa-f]{2}", decoded) is None and not contains_credential(decoded)


def canonical_uri(value: object) -> tuple[str, str, str] | None:
	value = normalize_input_uri(value)
	if value is None or not value.startswith("hf://") or "?" in value or "#" in value: return None
	tail = value[5:]
	if not tail: return value, "root", "root"
	if "//" in tail: return None
	parts = tail.split("/")
	if any(not SEGMENT_RE.fullmatch(part) or not safe_uri_segment(part) for part in parts): return None
	resource = parts[0]
	if resource not in ROOTS: return None  # Buckets can be private.
	if any("@" in part for part in parts) and (resource not in {"models", "datasets", "spaces"} or len(parts) < 3 or any("@" in part for part in parts[3:])): return None
	kind = "root" if len(parts) == 1 else "namespace" if resource in {"models", "datasets", "spaces"} and len(parts) == 2 else "entity" if resource in {"models", "datasets", "spaces", "collections", "papers"} and len(parts) == 3 else "path"
	return value, resource, kind


def bounded_value(value: object, *, max_length: int = 240) -> str | None: return safe_string(value, max_length=max_length)


def normalise_legacy(params: dict[str, object]) -> dict[str, object] | None:
	allowed = {"op", "uri", "recursive", "recursive_compat", "glob", "entry_type", "name", "path", "query", "sort", "tags", "space_kind", "max_bytes", "offset", "limit"}
	return validate_operation(dict(params)) if isinstance(params.get("op"), str) and not (set(params) - allowed) else None


def parse_argv(params: dict[str, object]) -> dict[str, object] | None:
	"""Dependency-free adapter for documented argv semantics; options may precede URI."""
	if set(params) != {"cmd", "args"} or not isinstance(params["cmd"], str) or not isinstance(params["args"], list): return None
	op, args = params["cmd"], list(params["args"])
	if op not in OPS or any(not isinstance(item, str) or len(item) > 240 for item in args): return None
	if args and args[0] == op: args = args[1:]  # telemetry duplication
	flags = {
		"-R": ("recursive", True), "-r": ("recursive", True), "-lR": ("recursive", True), "-laR": ("recursive", True), "--recursive": ("recursive", True),
		"-l": ("long", True), "-a": ("all", True), "-la": ("long_all", True), "-al": ("long_all", True), "--long": ("long", True),
		"--glob": ("glob", False), "-type": ("entry_type", False), "--type": ("entry_type", False), "--entry-type": ("entry_type", False), "--sort": ("sort", False),
		"-limit": ("limit", False), "--limit": ("limit", False), "-max-bytes": ("max_bytes", False), "--max-bytes": ("max_bytes", False), "-offset": ("offset", False), "--offset": ("offset", False),
		"-name": ("name", False), "--name": ("name", False), "-path": ("path", False), "--path": ("path", False), "--query": ("query", False), "--tag": ("tags", False), "--kind": ("space_kind", False),
	}
	allowed = {"ls": {"recursive", "long", "all", "long_all", "glob", "entry_type", "sort", "limit"}, "cat": {"max_bytes", "offset"}, "stat": set(), "find": {"recursive", "recursive_compat", "glob", "name", "path", "entry_type", "limit"}, "search": {"query", "entry_type", "sort", "tags", "space_kind", "limit"}}[op]
	result: dict[str, object] = {"op": op}; positional: list[str] = []; index = 0
	while index < len(args):
		token = args[index]
		if token in flags:
			key, boolean = flags[token]
			if op == "find" and key == "glob":
				key = "name"  # hf_fs documents find --glob as the name filter.
			if op == "find" and key == "recursive":
				key = "recursive_compat"  # find is already recursive.
			if key not in allowed or (boolean and key in result): return None
			if boolean: result[key] = True
			else:
				index += 1
				if index >= len(args) or args[index].startswith("-"): return None
				item: object = args[index]
				if key in {"limit", "max_bytes", "offset"}:
					if not re.fullmatch(r"[0-9]{1,9}", str(item)): return None
					item = int(str(item))
				if key == "tags": result.setdefault("tags", []).append(item)  # type: ignore[union-attr]
				elif key in result: return None
				else: result[key] = item
		elif token.startswith("-"): return None
		else: positional.append(token)
		index += 1
	uri_index = next((i for i, item in enumerate(positional) if canonical_uri(item) is not None), None)
	if uri_index is None: return None
	uri = canonical_uri(positional.pop(uri_index))
	if uri is None: return None
	result["uri"] = uri[0]
	if op in {"cat", "stat"}:
		if len(positional) > 1: return None
		if positional:
			part = bounded_value(positional[0])
			if part is None or ".." in part.split("/"): return None
			result["uri"] = uri[0].rstrip("/") + "/" + part.lstrip("/")
	elif op == "search":
		if positional and "query" in result: return None
		if positional:
			query = bounded_value(" ".join(positional))
			if query is None: return None
			result["query"] = query
	elif positional: return None
	return validate_operation(result)


def validate_operation(params: dict[str, object]) -> dict[str, object] | None:
	op = params.get("op"); uri = canonical_uri(params.get("uri"))
	if not isinstance(op, str) or op not in OPS or uri is None: return None
	allowed = {"ls": {"op", "uri", "recursive", "long", "all", "long_all", "glob", "entry_type", "sort", "limit"}, "cat": {"op", "uri", "max_bytes", "offset"}, "stat": {"op", "uri"}, "find": {"op", "uri", "recursive", "recursive_compat", "name", "path", "entry_type", "limit"}, "search": {"op", "uri", "query", "entry_type", "sort", "tags", "space_kind", "limit"}}
	if set(params) - allowed[op]: return None
	result: dict[str, object] = {"op": op, "uri": uri[0]}
	if params.get("recursive") is True and op != "find": result["recursive"] = True
	elif "recursive" in params and not isinstance(params["recursive"], bool): return None
	for key in ("long", "all", "long_all", "recursive_compat"):
		if key in params and not isinstance(params[key], bool): return None
	for key in ("glob", "name", "path", "query"):
		if key in params:
			value = bounded_value(params[key])
			if value is None: return None
			result[key] = value
	if "entry_type" in params:
		value = TYPE_ALIASES.get(params["entry_type"], params["entry_type"]) if isinstance(params["entry_type"], str) else None
		if value not in ENTRY_TYPES: return None
		result["entry_type"] = value
	if "sort" in params:
		if params["sort"] not in SORTS: return None
		result["sort"] = params["sort"]
	for key, maximum in (("max_bytes", 80_000), ("offset", 10_000_000), ("limit", 10_000)):
		if key in params:
			value = params[key]
			if isinstance(value, bool) or not isinstance(value, int) or value < (1 if key == "limit" else 0) or value > maximum or (key == "limit" and op == "search" and value > 1000): return None
			if key == "limit" and op == "ls" and uri[0] in {"hf://models/trending", "hf://datasets/trending", "hf://spaces/trending"} and value > 20: return None
			result[key] = value
	if "tags" in params:
		if not isinstance(params["tags"], list) or not 1 <= len(params["tags"]) <= 20: return None
		tags = [bounded_value(item, max_length=100) for item in params["tags"]]
		if any(item is None for item in tags): return None
		result["tags"] = tags
	if "space_kind" in params:
		if params["space_kind"] != "mcp": return None
		result["space_kind"] = "mcp"
	if op == "search":
		scope = str(result["uri"]); empty_ok = re.fullmatch(r"hf://(?:models|datasets|spaces|collections)(?:/[A-Za-z0-9][A-Za-z0-9._%+-]{0,127})?", scope)
		if not (scope == "hf://papers" or scope == "hf://docs" or scope.startswith("hf://docs/") or empty_ok) or ("query" not in result and not empty_ok): return None
		if ("tags" in result or "space_kind" in result) and scope != "hf://spaces": return None
	if op == "ls" and result.get("sort") == "trending" and result["uri"] in {"hf://models", "hf://datasets", "hf://spaces", "hf://papers"}:
		if "recursive" in result or "glob" in result: return None
		result["uri"] = str(result["uri"]) + "/trending"; result.pop("sort")
	if op == "ls" and result["uri"] in {"hf://models/trending", "hf://datasets/trending", "hf://spaces/trending"}:
		if result.get("sort") in {"trending", "trendingScore"}: result.pop("sort")
		if result.get("entry_type") == "repo": result.pop("entry_type")
	return {key: result[key] for key in sorted(result)}


def normalise(params: dict[str, object]) -> tuple[dict[str, object] | None, str | None]:
	if "op" in params: return normalise_legacy(params), "legacy"
	if "cmd" in params: return parse_argv(params), "argv"
	return None, None


def event_date(value: object) -> str | None:
	if not isinstance(value, str) or len(value) > 40: return None
	try: parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
	except ValueError: return None
	return parsed.astimezone(UTC).date().isoformat() if parsed.tzinfo is not None else None


def event_version(row: dict[str, object]) -> str:
	for key in ("serverVersion", "server_version", "version"):
		value = row.get(key)
		if isinstance(value, str) and VERSION_RE.fullmatch(value): return value
	return "unknown"


def outcome(row: dict[str, object]) -> str: return "success" if row.get("success") is True else "failure" if row.get("success") is False else "unknown"


def attributes(operation: dict[str, object]) -> tuple[str, str, str, str]:
	_, resource, uri_kind = canonical_uri(operation["uri"]) or ("", "unknown", "invalid"); op = str(operation["op"])
	if op == "search": return resource, uri_kind, "global_discovery" if uri_kind == "root" else "scoped_discovery", "difficult"
	if op == "find": return resource, uri_kind, "find", "difficult"
	if op == "cat": return resource, uri_kind, "partial_text_read" if "max_bytes" in operation or "offset" in operation else "content_read", "optional" if len(operation) > 2 else "simple"
	if op == "stat": return resource, uri_kind, "entity_stat", "simple"
	return resource, uri_kind, "recursive_listing" if operation.get("recursive") else "navigation", "optional" if len(operation) > 2 else "simple"


def json_bytes(value: object) -> bytes: return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def write_private(path: Path, data: bytes) -> str:
	flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
	fd = os.open(path, flags, 0o600)
	try:
		os.fchmod(fd, 0o600)
		with os.fdopen(fd, "wb", closefd=False) as stream: stream.write(data)
	finally: os.close(fd)
	return hashlib.sha256(data).hexdigest()


def candidate_record(operation: dict[str, object], version: str, result: str, formats: set[str], count: int) -> dict[str, object]:
	resource, uri_kind, specialization, complexity = attributes(operation)
	record: dict[str, object] = {"resource": resource, "operation": operation["op"], "complexity": complexity, "specialization": specialization, "uri_kind": uri_kind, "provenance": {"source": "hf_fs_local_data_fill", "source_tool": "hf_fs", "source_server_version": version, "source_outcome": result, "sanitized": True, "policy_version": POLICY_VERSION, **({"error_category": "unclassified_failure"} if result == "failure" else {})}, "observation_count": count, "source_formats": sorted(formats)}
	record["observed_shape" if result == "success" else "observed_failed_shape"] = operation
	return record


def make_name(mode: str, files: list[SourceFile], versions: list[str], dates: list[str]) -> str:
	period = dates[0] if len(dates) == 1 else f"{dates[0]}_to_{dates[-1]}" if dates else (files[0].shard_date or "dated")
	return f"{mode}-{period}-{'all' if not versions else '-'.join(versions)}".lower().replace("+", "-")


def build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--log-root", type=Path, default=Path(os.environ.get("HF_MCP_LOG_ROOT", "~/data/hf-mcp-logs")).expanduser())
	parser.add_argument("--server-version", action="append", default=[])
	parser.add_argument("--date", action="append", type=parse_iso_date, default=[]); parser.add_argument("--from-date", type=parse_iso_date); parser.add_argument("--to-date", type=parse_iso_date)
	parser.add_argument("--source", choices=("auto", "snapshot", "shards"), default="auto"); parser.add_argument("--snapshot"); parser.add_argument("--name")
	parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT, help="Private root beneath data/local."); parser.add_argument("--overwrite", action="store_true")
	return parser


def ensure_private_directory(path: Path, parent: Path, label: str) -> None:
	assert_safe_below(parent, path, label); current = parent
	for part in path.relative_to(parent).parts:
		current /= part
		try: info = os.lstat(current)
		except FileNotFoundError: os.mkdir(current, 0o700); os.chmod(current, 0o700); continue
		if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode): raise FillError(f"{label} must contain only real directories")


def output_root_for(value: Path) -> Path:
	allowed, output = absolute(ALLOWED_LOCAL_ROOT), absolute(value)
	assert_no_symlink_components(REPO_ROOT, "repository root")
	# Always make data/local born-private before creating its children.
	try:
		allowed.parent.relative_to(REPO_ROOT)
	except ValueError:
		# This branch is reachable only when a test patches the module-local
		# boundary; production has no user-controlled alternative boundary.
		assert_no_symlink_components(allowed.parent, "allowed local root")
		if not allowed.parent.is_dir():
			raise FillError("patched allowed local root parent does not exist")
	else:
		ensure_private_directory(allowed.parent, REPO_ROOT, "allowed local root")
	ensure_private_directory(allowed, allowed.parent, "allowed local root")
	os.chmod(allowed, 0o700)
	try: output.relative_to(allowed)
	except ValueError as exc: raise FillError("--output-root must be strictly beneath the real non-symlinked data/local root") from exc
	if output == allowed: raise FillError("--output-root must be strictly beneath the real non-symlinked data/local root")
	ensure_private_directory(output, allowed, "output root"); os.chmod(output, 0o700); return output


def reject_tracked_output(path: Path) -> None:
	try: relative = path.relative_to(REPO_ROOT)
	except ValueError: return
	result = subprocess.run(["git", "-C", os.fspath(REPO_ROOT), "ls-files", "-z", "--", relative.as_posix()], check=False, capture_output=True)
	if result.returncode == 0 and result.stdout: raise FillError("output root or target is tracked")


def same_metadata(left: os.stat_result, right: os.stat_result) -> bool:
	return (left.st_dev, left.st_ino, left.st_size, left.st_mtime_ns) == (right.st_dev, right.st_ino, right.st_size, right.st_mtime_ns)


def consume_source(source: SourceFile, callback: Callable[[bytes], None]) -> tuple[str, os.stat_result]:
	assert_no_symlink_components(source.path, "source file")
	before = os.stat(source.path, follow_symlinks=False); fd = os.open(source.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
	try:
		initial = os.fstat(fd)
		if not stat.S_ISREG(initial.st_mode) or not same_metadata(before, initial): raise FillError(f"source file changed or is not regular: {source.relative}")
		raw = HashingReader(os.fdopen(fd, "rb", closefd=False), hashlib.sha256())
		gzip_source = source.path.name.casefold().endswith(".gz")
		stream: BinaryIO = gzip.GzipFile(fileobj=raw, mode="rb") if gzip_source else raw
		try:
			for line in BoundedJsonlReader(stream, gzip_source=gzip_source, source_name=source.relative):
				callback(line)
		finally: stream.close(); raw.close()
		if not same_metadata(initial, os.fstat(fd)): raise FillError(f"source file changed while being read: {source.relative}")
		return raw.digest.hexdigest(), initial
	finally: os.close(fd)


def run(args: argparse.Namespace) -> tuple[Path, dict[str, object]]:
	requested_dates = selected_dates(args.date, args.from_date, args.to_date); versions = sorted(set(args.server_version))
	if any(not VERSION_RE.fullmatch(item) for item in versions): raise FillError("--server-version must be a bounded version token")
	root = check_source_root(args.log_root); files, mode = select_sources(root, args.source, requested_dates, args.snapshot)
	name = args.name or make_name(mode, files, versions, requested_dates)
	if not NAME_RE.fullmatch(name): raise FillError("--name must use lowercase letters, digits, dots, underscores, or hyphens")
	output_root = output_root_for(args.output_root)
	if root == output_root or root in output_root.parents or output_root in root.parents: raise FillError("source and output roots must not overlap")
	target = output_root / name; assert_safe_below(output_root, target, "output target")
	if target.exists() and target.is_symlink(): raise FillError("output target must not be a symlink")
	reject_tracked_output(output_root); reject_tracked_output(target)
	if target.exists() and not args.overwrite: raise FillError(f"output already exists: {target}; use --overwrite to replace it")
	summaries: Counter[tuple[str, str, str]] = Counter(); rejections: Counter[str] = Counter(); groups: dict[tuple[str, str, str], tuple[dict[str, object], set[str], int]] = {}
	source_metadata: list[dict[str, object]] = []; observed_dates: set[str] = set(); matched_dates: set[str] = set(); counts: Counter[str] = Counter()
	for source in files:
		file_counts: Counter[str] = Counter()
		def process(raw: bytes | None) -> None:
			if raw is None:
				file_counts["nonempty_lines"] += 1; counts["source_nonempty_lines"] += 1
				rejections["oversized_record"] += 1
				return
			if not raw.strip(): return
			file_counts["nonempty_lines"] += 1; counts["source_nonempty_lines"] += 1
			try: row = json.loads(raw)
			except (UnicodeDecodeError, json.JSONDecodeError): rejections["invalid_json"] += 1; return
			if not isinstance(row, dict): rejections["non_object_row"] += 1; return
			file_counts["valid_rows"] += 1; counts["valid_rows"] += 1; day = event_date(row.get("time"))
			if day is None: rejections["invalid_event_date"] += 1; return
			observed_dates.add(day); version = event_version(row)
			if versions and version not in versions: rejections["version_filter"] += 1; return
			if requested_dates and day not in requested_dates: rejections["date_filter"] += 1; return
			file_counts["date_version_filter_matched_observations"] += 1; counts["date_version_filter_matched_observations"] += 1; matched_dates.add(day)
			if row.get("methodName") != "hf_fs": rejections["other_method"] += 1; return
			file_counts["hf_fs_observations"] += 1; counts["hf_fs_observations"] += 1; result = outcome(row); summaries[(day, version, result)] += 1
			params, _ = parse_parameters(row.get("parameters"))
			if params is None: rejections["invalid_parameters"] += 1; return
			operation, source_format = normalise(params)
			if operation is None or source_format is None: rejections["invalid_operation"] += 1; return
			if result not in {"success", "failure"}: rejections["unknown_outcome"] += 1; return
			counts[f"normalized_{result}_observations"] += 1; key = (json.dumps(operation, sort_keys=True, separators=(",", ":")), version, result)
			if key in groups:
				existing, formats, number = groups[key]; formats.add(source_format); groups[key] = (existing, formats, number + 1)
			else: groups[key] = (operation, {source_format}, 1)
		digest, info = consume_source(source, process)
		source_metadata.append({"path": source.relative, "format": source.format, "shard_date": source.shard_date, "size_bytes": info.st_size, "mtime_ns": info.st_mtime_ns, "sha256": digest, "nonempty_lines": file_counts["nonempty_lines"], "valid_rows": file_counts["valid_rows"], "date_version_filter_matched_observations": file_counts["date_version_filter_matched_observations"], "hf_fs_observations": file_counts["hf_fs_observations"]})
	if counts["date_version_filter_matched_observations"] == 0:
		raise FillError("no observations matched the requested date and server-version filters")
	if counts["hf_fs_observations"] == 0:
		raise FillError("the selected observations contain no hf_fs calls")
	positive = [candidate_record(op, version, result, formats, number) for (_, version, result), (op, formats, number) in groups.items() if result == "success"]; errors = [candidate_record(op, version, result, formats, number) for (_, version, result), (op, formats, number) in groups.items() if result == "failure"]
	positive.sort(key=lambda item: json.dumps(item, sort_keys=True)); errors.sort(key=lambda item: json.dumps(item, sort_keys=True))
	summary = {"schema_version": SCHEMA_VERSION, "policy_version": POLICY_VERSION, "hf_fs_events": [{"event_date": day, "server_version": version, "outcome": result, "count": number} for (day, version, result), number in sorted(summaries.items())], "rejection_counts": dict(sorted(rejections.items()))}
	staging = Path(tempfile.mkdtemp(prefix=f".{name}.", dir=output_root)); os.chmod(staging, 0o700)
	try:
		hashes = {"positive-candidates.jsonl": write_private(staging / "positive-candidates.jsonl", b"".join(json_bytes(item) for item in positive)), "error-candidates.jsonl": write_private(staging / "error-candidates.jsonl", b"".join(json_bytes(item) for item in errors)), "summary.json": write_private(staging / "summary.json", json_bytes(summary))}
		manifest = {"schema_version": SCHEMA_VERSION, "policy_version": POLICY_VERSION, "review_status": "local_sanitized_unreviewed", "review_status_policy": "Private local review material only; URI syntax does not establish publicness. Independent public-resource review and explicit conversion are mandatory before any freeze.", "source_mode": mode, "source_files": source_metadata, "requested_dates": requested_dates, "source_observed_date_range": [min(observed_dates), max(observed_dates)] if observed_dates else [], "date_version_filter_matched_date_range": [min(matched_dates), max(matched_dates)] if matched_dates else [], "requested_server_versions": versions, "date_shard_completeness": "unknown" if mode == "shards" else "not_applicable", "selected_file_count": len(files), "counts": {"source_files": len(files), "source_nonempty_lines": counts["source_nonempty_lines"], "valid_rows": counts["valid_rows"], "date_version_filter_matched_observations": counts["date_version_filter_matched_observations"], "hf_fs_observations": counts["hf_fs_observations"], "normalized_success_observations": counts["normalized_success_observations"], "normalized_failure_observations": counts["normalized_failure_observations"], "positive_candidate_distinct_count": len(positive), "error_candidate_distinct_count": len(errors), "candidate_distinct_count": len(positive) + len(errors)}, "rejection_counts": dict(sorted(rejections.items())), "output_sha256": hashes}
		write_private(staging / "manifest.json", json_bytes(manifest)); backup = output_root / f".{name}.previous"
		if backup.exists(): shutil.rmtree(backup)
		if target.exists(): os.replace(target, backup)
		try: os.replace(staging, target)
		except BaseException:
			if backup.exists(): os.replace(backup, target)
			raise
		if backup.exists(): shutil.rmtree(backup)
	except BaseException: shutil.rmtree(staging, ignore_errors=True); raise
	return target, manifest


def main() -> int:
	try: target, manifest = run(build_parser().parse_args())
	except (FillError, OSError, gzip.BadGzipFile) as exc: print(f"data fill: {exc}", file=sys.stderr); return 2
	print(json.dumps({"output": target.as_posix(), "counts": manifest["counts"]}, sort_keys=True)); return 0


if __name__ == "__main__":
	raise SystemExit(main())
