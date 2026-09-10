"""Strict names for the cumulative exports accepted by local utilities.

This deliberately recognizes names, not merely interesting substrings.  Both
the inventory and fill tools use it so a decoy cannot be inventoried but then
selected (or vice versa).
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path


_DATE = r"(?P<date>\d{4}-\d{2}-\d{2})"
_TAIL = r"(?:[-_.][A-Za-z0-9][A-Za-z0-9._-]{0,80})?"
_JSONL = r"\.jsonl(?:\.gz)?"
_PATTERNS: dict[str, re.Pattern[str]] = {
	"hf-fs": re.compile(rf"^hf_fs-operations-to-{_DATE}{_TAIL}{_JSONL}$", re.IGNORECASE),
	"all-queries": re.compile(rf"^all-queries-to-{_DATE}{_TAIL}{_JSONL}$", re.IGNORECASE),
}


def approved_snapshot(path: Path, kind: str) -> str | None:
	"""Return the valid calendar date for one exactly named root snapshot."""

	match = _PATTERNS.get(kind, re.compile(r"$^")).fullmatch(path.name)
	if match is None:
		return None
	try:
		return date.fromisoformat(match.group("date")).isoformat()
	except ValueError:
		return None
