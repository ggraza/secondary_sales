"""Path guard for files served by the PWA renderer."""

from __future__ import annotations

import os


def resolve_asset(base_dir: str, rel: str, allowed_ext) -> str | None:
	"""Return the absolute path of ``rel`` inside ``base_dir``, or None when the
	request is unsafe (traversal, symlink escape, odd characters, wrong type)."""
	if not rel or not isinstance(rel, str):
		return None
	if "\x00" in rel or "\\" in rel or rel.startswith("/") or "%" in rel:
		return None
	if any(part in ("", ".", "..") or part.startswith(".") for part in rel.split("/")):
		return None
	ext = os.path.splitext(rel)[1].lower()
	if ext not in allowed_ext or os.path.basename(rel) == "sw.js":
		return None
	base = os.path.realpath(base_dir)
	full = os.path.realpath(os.path.join(base, rel))
	if not full.startswith(base + os.sep) or not os.path.isfile(full):
		return None
	return full
