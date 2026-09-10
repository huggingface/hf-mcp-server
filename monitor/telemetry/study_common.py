"""Safe private aggregate I/O and provenance helpers for retirement studies.

This module deliberately keeps source rows, values, identifiers, timestamps, and
row digests in memory only.  Its persisted artifacts contain aggregate counts
and carefully scoped provenance metadata.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any, Callable, ParamSpec, TypeVar

from data_fill import (
	BoundedJsonlReader,
	FillError,
	HashingReader,
	absolute,
	assert_no_symlink_components,
	event_date,
	same_metadata,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
ALLOWED_LOCAL_ROOT = None  # Set explicitly by the mounted runner; no repository default.
MAX_FILES = 512
SOURCE_DIGEST_DESCRIPTION = (
	'Content-only SHA-256 multiset: sorted per-file content hashes are hashed; '
	'paths, filenames, and ordering are not bound into this digest.'
)
_SAFE_PUBLIC_REASONS = frozenset(
	(
		'dates must be YYYY-MM-DD',
		'--from-date must not be after --to-date',
		'--comparison-version must not be empty',
		'--server-version must not be empty',
		'--min-cell-count must be at least 1',
		'invalid command options',
		'invalid matrix',
		'matrix drift',
		'matrix rule drift',
		'ordered matrix/code drift',
		'no rule',
		'no principal population',
		'output has a symlinked component',
		'output could not be inspected safely',
		'output path is not a directory',
		'output must be strictly beneath data/local',
		'study output must be strictly beneath data/local/studies',
		'output exists; use --overwrite',
		'refusing unsafe output replacement',
		'source root has a symlinked component',
		'source root could not be inspected safely',
		'source root does not exist',
		'query folder has a symlinked component',
		'query folder could not be inspected safely',
		'query folder is unsafe',
		'too many query shards',
		'a requested query folder is missing',
		'no query shards selected',
		'query source is not a regular file',
		'query source changed before it was read',
		'query source changed while being read',
		'gzip source exceeds decompressed safety budget',
		'required provenance file is unavailable or unsafe',
		'unsafe generated output tree',
		'privacy scanner rejected generated output',
		'privacy scanner rejected source field',
		'study input or output could not be processed safely',
	)
)
_GZIP_BUDGET_ERROR = re.compile(
	r'gzip source exceeds the [0-9]+-byte decompressed safety budget: query source [1-9][0-9]*\Z'
)
P = ParamSpec('P')
T = TypeVar('T')


def public_error_message(error: BaseException) -> str:
	"""Return a fixed safe reason for a study failure, never exception-controlled text."""

	message = str(error)
	if isinstance(error, FillError) and message in _SAFE_PUBLIC_REASONS:
		return message
	if isinstance(error, FillError) and _GZIP_BUDGET_ERROR.fullmatch(message):
		return 'gzip source exceeds decompressed safety budget'
	return 'study input or output could not be processed safely'


def public_error_code(error: BaseException) -> str:
	"""Classify a safe public reason without incorporating an input value."""

	reason = public_error_message(error)
	if reason in {
		'dates must be YYYY-MM-DD',
		'--from-date must not be after --to-date',
		'--comparison-version must not be empty',
		'--server-version must not be empty',
		'--min-cell-count must be at least 1',
		'invalid command options',
	}:
		return 'invalid_request'
	if reason.startswith('output') or reason.startswith('study output') or reason.startswith('refusing unsafe output'):
		return 'unsafe_output'
	if reason.startswith('source') or reason.startswith('query') or reason.startswith('gzip'):
		return 'unsafe_input'
	return 'study_failure'


def public_failure_message(study_name: str, error: BaseException) -> str:
	"""Format a CLI failure using only a fixed study name, code, and safe reason."""

	return f'{study_name} failed [{public_error_code(error)}]: {public_error_message(error)}'


def redact_study_failures(function: Callable[P, T]) -> Callable[P, T]:
	"""Prevent study-boundary exceptions from carrying paths or source values onward."""

	@wraps(function)
	def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
		try:
			return function(*args, **kwargs)
		except Exception as exc:
			reason = public_error_message(exc)
			if isinstance(exc, FillError) and str(exc) == reason:
				raise
			raise FillError(reason) from exc

	return wrapped


def assert_study_no_symlink_components(path: Path, label: str) -> None:
	"""Check a fixed study boundary without exposing the linked component path."""

	try:
		assert_no_symlink_components(path, label)
	except FillError as exc:
		raise FillError(f'{label} has a symlinked component') from exc
	except OSError as exc:
		raise FillError(f'{label} could not be inspected safely') from exc


@dataclass(frozen=True)
class QuerySource:
	"""One safe query shard selected for an aggregate study."""

	path: Path
	relative: str
	folder_date: str
	ordinal: int


def parse_date(value: str) -> str:
	"""Validate and normalize an ISO calendar date."""

	try:
		return date.fromisoformat(value).isoformat()
	except ValueError as exc:
		raise FillError('dates must be YYYY-MM-DD') from exc


def date_range(start: str, end: str) -> tuple[str, str]:
	"""Validate a closed, increasing UTC event-date range."""

	first, last = parse_date(start), parse_date(end)
	if first > last:
		raise FillError('--from-date must not be after --to-date')
	return first, last


def private_dir(path: Path, parent: Path) -> None:
	"""Create an owner-only directory and verify it remains below its parent."""

	if path.is_symlink():
		raise FillError('output has a symlinked component')
	try:
		path.mkdir(mode=0o700, parents=True, exist_ok=True)
	except FileExistsError as exc:
		raise FillError('output path is not a directory') from exc
	os.chmod(path, 0o700)
	assert_study_no_symlink_components(path, 'output')
	try:
		path.relative_to(parent)
	except ValueError as exc:
		raise FillError('output must be strictly beneath data/local') from exc


@redact_study_failures
def checked_output(path: Path, *, overwrite: bool) -> Path:
	"""Prepare a private, flat study output directory without following links."""

	if ALLOWED_LOCAL_ROOT is None or overwrite:
		raise FillError('explicit output root required; overwrite forbidden')
	root = absolute(ALLOWED_LOCAL_ROOT)
	target = absolute(path)
	assert_study_no_symlink_components(root, 'output')
	assert_study_no_symlink_components(target, 'output')
	if root not in target.parents:
		raise FillError('output must be strictly beneath private root')
	if not root.is_dir():
		raise FillError('output root must exist')
	if target.exists():
		raise FillError('output exists; use a new run')
	target.mkdir(mode=0o700, parents=True)
	os.chmod(target, 0o700)
	return target


@redact_study_failures
def write_private(path: Path, value: object) -> None:
	"""Atomically create one owner-only aggregate artifact without following links."""

	data = value.encode() if isinstance(value, str) else (
		json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n'
	).encode()
	fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
	try:
		os.fchmod(fd, 0o600)
		with os.fdopen(os.dup(fd), 'wb') as stream:
			stream.write(data)
			stream.flush()
			os.fsync(stream.fileno())
	finally:
		os.close(fd)


@redact_study_failures
def select_query_sources(
	root: Path,
	start: str,
	end: str,
	*,
	allow_incomplete_end: bool,
) -> tuple[list[QuerySource], dict[str, object]]:
	"""Select requested date folders plus a following late-flush folder if present."""

	root = absolute(root)
	assert_study_no_symlink_components(root, 'source root')
	if not root.is_dir():
		raise FillError('source root does not exist')

	first, last = date.fromisoformat(start), date.fromisoformat(end)
	requested_dates = [(first + timedelta(days=offset)).isoformat() for offset in range((last - first).days + 1)]
	following_date = (last + timedelta(days=1)).isoformat()
	selected: list[QuerySource] = []
	missing: list[str] = []

	for folder_date in [*requested_dates, following_date]:
		folder = root / 'queries' / folder_date
		if not folder.exists():
			missing.append(folder_date)
			continue
		if folder.is_symlink() or not folder.is_dir():
			raise FillError('query folder is unsafe')
		assert_study_no_symlink_components(folder, 'query folder')
		for path in sorted(folder.iterdir()):
			is_jsonl = path.suffix == '.jsonl'
			is_jsonl_gzip = path.suffix == '.gz' and path.name.endswith('.jsonl.gz')
			if not path.is_file() or path.is_symlink() or not (is_jsonl or is_jsonl_gzip):
				continue
			if len(selected) >= MAX_FILES:
				raise FillError('too many query shards')
			selected.append(QuerySource(path, path.relative_to(root).as_posix(), folder_date, len(selected) + 1))

	if any(folder_date in missing for folder_date in requested_dates) and not (
		allow_incomplete_end and end in missing
	):
		raise FillError('a requested query folder is missing')
	if not selected:
		raise FillError('no query shards selected')

	file_counts: dict[str, int] = {}
	for source in selected:
		file_counts[source.folder_date] = file_counts.get(source.folder_date, 0) + 1
	return selected, {
		'requested_event_dates': [start, end],
		'selected_folder_dates': [
			folder_date for folder_date in [*requested_dates, following_date] if folder_date not in missing
		],
		'missing_folder_dates': missing,
		'following_folder_requested': following_date,
		'following_folder_available': following_date not in missing,
		'date_shard_completeness': 'unknown',
		'end_date_partial_allowed': allow_incomplete_end,
		'selected_file_count': len(selected),
		# Filenames can contain identifiers; persist only folder-level counts.
		'selected_files': [
			{'folder_date': folder_date, 'file_count': count} for folder_date, count in sorted(file_counts.items())
		],
	}


@redact_study_failures
def iter_query_rows(
	sources: list[QuerySource],
	start: str,
	end: str,
	callback: Callable[[dict[str, object], QuerySource, int], None],
) -> dict[str, object]:
	"""Stream selected files, deduplicate exact rows in memory, and check each file's read."""

	counts: dict[str, object] = {
		'source_nonempty_lines': 0,
		'malformed_json': 0,
		'raw_rows': 0,
		'deduped_rows': 0,
		'out_of_range_rows': 0,
	}
	seen_rows: set[bytes] = set()
	source_digests: list[tuple[str, str]] = []

	for source in sources:
		before = os.stat(source.path, follow_symlinks=False)
		if not stat.S_ISREG(before.st_mode):
			raise FillError('query source is not a regular file')
		fd = os.open(source.path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
		try:
			initial = os.fstat(fd)
			if not same_metadata(before, initial):
				raise FillError('query source changed before it was read')
			with os.fdopen(fd, 'rb', closefd=False) as raw_stream:
				stored_digest = hashlib.sha256()
				reader: Any = HashingReader(raw_stream, stored_digest)
				stream: Any = gzip.GzipFile(fileobj=reader, mode='rb') if source.path.suffix == '.gz' else reader
				try:
					for line_number, line in enumerate(
						BoundedJsonlReader(
							stream,
							gzip_source=source.path.suffix == '.gz',
							source_name=f'query source {source.ordinal}',
						),
						1,
					):
						if line is None or not line.strip():
							if line is None:
								counts['malformed_json'] = int(counts['malformed_json']) + 1
							continue
						counts['source_nonempty_lines'] = int(counts['source_nonempty_lines']) + 1
						try:
							row = json.loads(line)
						except (UnicodeDecodeError, json.JSONDecodeError):
							counts['malformed_json'] = int(counts['malformed_json']) + 1
							continue
						if not isinstance(row, dict):
							counts['malformed_json'] = int(counts['malformed_json']) + 1
							continue
						observed_date = event_date(row.get('time'))
						if observed_date is None or not start <= observed_date <= end:
							counts['out_of_range_rows'] = int(counts['out_of_range_rows']) + 1
							continue
						counts['raw_rows'] = int(counts['raw_rows']) + 1
						row_digest = hashlib.sha256(line).digest()
						if row_digest in seen_rows:
							continue
						seen_rows.add(row_digest)
						counts['deduped_rows'] = int(counts['deduped_rows']) + 1
						callback(row, source, line_number)
				finally:
					if stream is not reader:
						stream.close()
					source_digests.append((source.folder_date, stored_digest.hexdigest()))
		finally:
			os.close(fd)
		after = os.stat(source.path, follow_symlinks=False)
		if not same_metadata(initial, after):
			raise FillError('source changed while being read')

	folder_multisets: list[dict[str, str]] = []
	for folder_date in sorted({folder for folder, _ in source_digests}):
		file_digests = sorted(digest for folder, digest in source_digests if folder == folder_date)
		folder_multisets.append(
			{
				'folder_date': folder_date,
				'source_content_multiset_sha256': hashlib.sha256('\n'.join(file_digests).encode()).hexdigest(),
			}
		)
	counts['source_integrity'] = {
		'digest_description': SOURCE_DIGEST_DESCRIPTION,
		'files_metadata_checked_across_own_read': len(source_digests),
		'files_unchanged_across_own_read': len(source_digests),
		'folder_source_content_multiset_sha256': folder_multisets,
		'selected_source_content_multiset_sha256': hashlib.sha256(
			'\n'.join(sorted(digest for _, digest in source_digests)).encode()
		).hexdigest(),
	}
	return counts


def params(row: dict[str, object]) -> dict[str, object] | None:
	"""Return a logger parameter object, accepting only object JSON strings."""

	value = row.get('parameters')
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except json.JSONDecodeError:
			return None
	return value if isinstance(value, dict) else None


def _digest_file(path: Path) -> str:
	if not path.is_file() or path.is_symlink():
		raise FillError('required provenance file is unavailable or unsafe')
	return hashlib.sha256(path.read_bytes()).hexdigest()


def _git_dirty(repository: Path, relative_path: str) -> bool:
	return bool(
		subprocess.check_output(
			['git', '-C', str(repository), 'status', '--porcelain', '--', relative_path], text=True
		).strip()
	)


@redact_study_failures
def source_provenance(server_repo: Path, *, matrix: Path, scripts: list[Path]) -> dict[str, object]:
	"""Persist a selected direct-dependency snapshot, not a transitive closure."""

	server_relative_files = (
		'packages/mcp/src/hf-fs-contract.ts',
		'packages/mcp/src/hf-fs.ts',
		'packages/mcp/src/repo-search.ts',
		'packages/mcp/src/hub-inspect.ts',
		'packages/app/src/server/mcp-server.ts',
		'packages/app/src/server/utils/query-logger.ts',
	)
	server_files = [
		{
			'path': relative_path,
			'sha256': _digest_file(server_repo / relative_path),
			'dirty': _git_dirty(server_repo, relative_path),
		}
		for relative_path in server_relative_files
	]

	study_paths = [matrix, *scripts, REPO_ROOT / 'scripts/data_fill.py', REPO_ROOT / 'scripts/snapshot_names.py']
	seen_paths: set[Path] = set()
	study_files: list[dict[str, object]] = []
	for path in study_paths:
		resolved = path.resolve()
		if resolved in seen_paths:
			continue
		seen_paths.add(resolved)
		relative_path = path.relative_to(REPO_ROOT).as_posix()
		study_files.append(
			{'path': relative_path, 'sha256': _digest_file(path), 'dirty': _git_dirty(REPO_ROOT, relative_path)}
		)

	return {
		'provenance_scope': 'selected direct-dependency snapshot; not a full transitive closure',
		'source_head': subprocess.check_output(['git', '-C', str(server_repo), 'rev-parse', 'HEAD'], text=True).strip(),
		'source_tag_or_describe': subprocess.check_output(
			['git', '-C', str(server_repo), 'describe', '--tags', '--always'], text=True
		).strip(),
		'source_dirty': bool(
			subprocess.check_output(['git', '-C', str(server_repo), 'status', '--porcelain'], text=True).strip()
		),
		'relevant_source_files': server_files,
		'study_code_and_config_files': study_files,
	}


def csv_text(headers: list[str], rows: list[dict[str, object]]) -> str:
	"""Serialize fixed aggregate columns with a stable newline convention."""

	import csv
	import io

	stream = io.StringIO(newline='')
	writer = csv.DictWriter(stream, fieldnames=headers, lineterminator='\n')
	writer.writeheader()
	for row in rows:
		writer.writerow({key: row.get(key, '') for key in headers})
	return stream.getvalue()


@redact_study_failures
def scan_private_output(root: Path) -> None:
	"""Reject identifiers, timestamps, source fields, paths, and unsafe output entries."""

	uuid = re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I)
	timestamp = re.compile(r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
	for path in root.iterdir():
		if not path.is_file() or path.is_symlink():
			raise FillError('unsafe generated output tree')
		text = path.read_text(encoding='utf-8')
		if uuid.search(text) or timestamp.search(text) or '/home/' in text or '\\\\' in text:
			raise FillError('privacy scanner rejected generated output')
		if any(
			marker in text
			for marker in ('"requestId"', '"mcpServerSessionId"', '"clientSessionId"', '"parameters"', '"errorMessage"', '"query"')
		):
			raise FillError('privacy scanner rejected source field')
