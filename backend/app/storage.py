"""Where files live on disk.

Every path is generated here from server-side values (ids and dates). Client-supplied
filenames are only ever stored as display names in the database, so a crafted filename
cannot escape the storage folder.
"""

import mimetypes
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from .config import get_settings

# Types Python's table does not know on every platform.
for _mime, _ext in [
    ("image/heic", ".heic"),
    ("image/heif", ".heif"),
    ("image/webp", ".webp"),
    ("image/avif", ".avif"),
    ("image/x-adobe-dng", ".dng"),
    ("video/quicktime", ".mov"),
    ("video/mp4", ".mp4"),
    ("video/x-m4v", ".m4v"),
    ("video/webm", ".webm"),
]:
    mimetypes.add_type(_mime, _ext)

_EXT_RE = re.compile(r"^[a-z0-9]{1,10}$")
THUMB_SIZES = ("thumb", "preview")


def root() -> Path:
    return Path(get_settings().storage_root).resolve()


def ensure_dirs() -> None:
    for sub in ("originals", "files", "thumbs", "tmp"):
        (root() / sub).mkdir(parents=True, exist_ok=True)


def tmp_dir() -> Path:
    path = root() / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_ext(filename: str | None, mime: str | None = None) -> str:
    """A short, lowercase, alphanumeric extension (without the dot), or 'bin'."""
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[1].lower()
        if _EXT_RE.match(ext):
            return ext
    if mime:
        guessed = mimetypes.guess_extension(mime)
        if guessed and _EXT_RE.match(guessed[1:]):
            return guessed[1:]
    return "bin"


def clean_display_name(name: str | None) -> str:
    """Strip directories and control characters from a client filename."""
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:255] or "upload"


def guess_mime(filename: str, declared: str | None) -> str:
    if declared and declared not in ("application/octet-stream", "binary/octet-stream"):
        return declared.split(";")[0].strip().lower()[:127]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def kind_for_mime(mime: str) -> str:
    if mime.startswith("image/"):
        return "photo"
    if mime.startswith("video/"):
        return "video"
    return "file"


def original_rel_path(kind: str, asset_id: uuid.UUID, ext: str, when: datetime) -> str:
    top = "files" if kind == "file" else "originals"
    return f"{top}/{when:%Y}/{when:%m}/{asset_id}.{ext}"


def thumb_rel_path(asset_id: uuid.UUID, size: str) -> str:
    if size not in THUMB_SIZES:
        raise ValueError(f"unknown thumbnail size: {size}")
    hexid = asset_id.hex
    return f"thumbs/{hexid[:2]}/{hexid}_{size}.webp"


def abs_path(rel: str) -> Path:
    """Resolve a stored relative path and refuse anything outside the storage root."""
    base = root()
    path = (base / rel).resolve()
    if base != path and base not in path.parents:
        raise ValueError("path escapes the storage root")
    return path


def move_into_place(tmp: Path, rel: str) -> Path:
    dest = abs_path(rel)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # shutil.move falls back to copy + delete when a rename crosses filesystems,
    # which can happen between branches of a mergerfs pool.
    shutil.move(str(tmp), str(dest))
    return dest


def remove_file(rel_or_path: str | Path) -> None:
    path = abs_path(rel_or_path) if isinstance(rel_or_path, str) else rel_or_path
    path.unlink(missing_ok=True)


def remove_asset_files(asset_id: uuid.UUID, storage_path: str) -> None:
    remove_file(storage_path)
    for size in THUMB_SIZES:
        remove_file(thumb_rel_path(asset_id, size))


def disk_usage() -> tuple[int, int]:
    """(total, free) bytes for the filesystem that holds the storage root."""
    usage = shutil.disk_usage(root())
    return usage.total, usage.free
