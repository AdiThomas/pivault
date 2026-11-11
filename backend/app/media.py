"""Thumbnails and metadata. Plain blocking functions; the worker runs them in a thread."""

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()

THUMB_SHORT_SIDE = 320
THUMB_LONG_CAP = 960
PREVIEW_LONG_SIDE = 1440
FFMPEG_TIMEOUT_S = 300

_ISO6709 = re.compile(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)")


@dataclass
class MediaInfo:
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    taken_at: datetime | None = None
    lat: float | None = None
    lon: float | None = None


# -- photos ---------------------------------------------------------------


def _exif_datetime(exif_ifd: dict) -> datetime | None:
    raw = exif_ifd.get(0x9003) or exif_ifd.get(0x9004)  # DateTimeOriginal / Digitized
    if not raw or not isinstance(raw, str):
        return None
    try:
        naive = datetime.strptime(raw.strip()[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    offset = exif_ifd.get(0x9011) or exif_ifd.get(0x9012)  # OffsetTimeOriginal / Digitized
    tz = UTC
    if isinstance(offset, str):
        match = re.match(r"^([+-])(\d{2}):(\d{2})$", offset.strip())
        if match:
            sign = 1 if match.group(1) == "+" else -1
            tz = timezone(sign * timedelta(hours=int(match.group(2)), minutes=int(match.group(3))))
    return naive.replace(tzinfo=tz).astimezone(UTC)


def _dms_to_degrees(dms, ref) -> float | None:
    try:
        degrees = float(dms[0]) + float(dms[1]) / 60 + float(dms[2]) / 3600
    except (TypeError, ValueError, IndexError, ZeroDivisionError):
        return None
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", "ignore")
    if ref in ("S", "W"):
        degrees = -degrees
    return degrees


def _valid_coords(lat: float | None, lon: float | None) -> tuple[float | None, float | None]:
    if lat is None or lon is None:
        return None, None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, None
    return round(lat, 6), round(lon, 6)


def _save_webp(img: Image.Image, dest: Path, quality: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or img.mode == "P" else "RGB")
    tmp = dest.with_suffix(".tmp")
    img.save(tmp, "WEBP", quality=quality, method=4)
    tmp.replace(dest)


def _write_sizes(img: Image.Image, thumb: Path, preview: Path) -> None:
    width, height = img.size

    prev = img.copy()
    prev.thumbnail((PREVIEW_LONG_SIDE, PREVIEW_LONG_SIDE), Image.Resampling.LANCZOS)
    _save_webp(prev, preview, quality=80)

    # Thumbnail: short side 320 so a square grid cell is always covered.
    scale = THUMB_SHORT_SIDE / max(1, min(width, height))
    if scale < 1:
        tw, th = max(1, round(width * scale)), max(1, round(height * scale))
        longest = max(tw, th)
        if longest > THUMB_LONG_CAP:
            shrink = THUMB_LONG_CAP / longest
            tw, th = max(1, round(tw * shrink)), max(1, round(th * shrink))
        small = prev.resize((tw, th), Image.Resampling.LANCZOS)
    else:
        small = prev
    _save_webp(small, thumb, quality=72)


def process_photo(src: Path, thumb: Path, preview: Path) -> MediaInfo:
    info = MediaInfo()
    with Image.open(src) as opened:
        exif = opened.getexif()
        try:
            info.taken_at = _exif_datetime(exif.get_ifd(0x8769))
        except Exception:
            info.taken_at = None
        try:
            gps = exif.get_ifd(0x8825)
            lat = _dms_to_degrees(gps.get(2), gps.get(1)) if gps else None
            lon = _dms_to_degrees(gps.get(4), gps.get(3)) if gps else None
            info.lat, info.lon = _valid_coords(lat, lon)
        except Exception:
            info.lat = info.lon = None

        # Record the real pixel size before draft() shrinks the decode.
        real_w, real_h = opened.size
        if exif.get(0x0112, 1) in (5, 6, 7, 8):  # orientations that rotate by 90 degrees
            real_w, real_h = real_h, real_w
        info.width, info.height = real_w, real_h

        if opened.format == "JPEG":
            # Decode at reduced size when the source is far larger than the preview.
            opened.draft("RGB", (PREVIEW_LONG_SIDE * 2, PREVIEW_LONG_SIDE * 2))
        img = ImageOps.exif_transpose(opened)
        _write_sizes(img, thumb, preview)
    return info


# -- videos ---------------------------------------------------------------


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - arguments are built here, never from user text
        cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False
    )


def _parse_video_time(tags: dict) -> datetime | None:
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        raw = tags.get(key)
        if not raw:
            continue
        try:
            text = raw.strip().replace("Z", "+00:00")
            # "+0000" style offsets are not accepted by fromisoformat on every version.
            text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)
            parsed = datetime.fromisoformat(text)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        if parsed.year < 1971:  # cameras with an unset clock report the epoch
            continue
        return parsed.astimezone(UTC)
    return None


def probe_video(src: Path) -> MediaInfo:
    info = MediaInfo()
    result = _run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
         str(src)]
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.decode('utf-8', 'replace')[:300]}")
    data = json.loads(result.stdout or b"{}")
    fmt = data.get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}

    try:
        info.duration_s = round(float(fmt.get("duration")), 3)
    except (TypeError, ValueError):
        info.duration_s = None

    for stream in data.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        width, height = stream.get("width"), stream.get("height")
        rotation = 0
        for side in stream.get("side_data_list") or []:
            if "rotation" in side:
                try:
                    rotation = int(float(side["rotation"]))
                except (TypeError, ValueError):
                    rotation = 0
        stream_tags = {k.lower(): v for k, v in (stream.get("tags") or {}).items()}
        if not rotation and "rotate" in stream_tags:
            try:
                rotation = int(stream_tags["rotate"])
            except ValueError:
                rotation = 0
        if abs(rotation) % 180 == 90:
            width, height = height, width
        info.width, info.height = width, height
        if info.duration_s is None:
            try:
                info.duration_s = round(float(stream.get("duration")), 3)
            except (TypeError, ValueError):
                pass
        break

    info.taken_at = _parse_video_time(tags)
    location = tags.get("com.apple.quicktime.location.iso6709") or tags.get("location")
    if location:
        match = _ISO6709.match(location.strip())
        if match:
            info.lat, info.lon = _valid_coords(float(match.group(1)), float(match.group(2)))
    return info


def process_video(src: Path, thumb: Path, preview: Path) -> MediaInfo:
    info = probe_video(src)
    seek = 0.0
    if info.duration_s and info.duration_s > 0.2:
        seek = min(1.0, info.duration_s / 2)
    with tempfile.TemporaryDirectory(prefix="pivault-poster-") as tmp:
        poster = Path(tmp) / "poster.jpg"
        for attempt_seek in (seek, 0.0):
            result = _run(
                ["ffmpeg", "-nostdin", "-y", "-ss", f"{attempt_seek:.3f}", "-i", str(src),
                 "-frames:v", "1", "-q:v", "3", str(poster)]
            )
            if result.returncode == 0 and poster.exists() and poster.stat().st_size > 0:
                break
        else:
            raise RuntimeError(
                f"ffmpeg could not extract a frame: "
                f"{result.stderr.decode('utf-8', 'replace')[-300:]}"
            )
        with Image.open(poster) as img:
            img.load()
            _write_sizes(img, thumb, preview)
    return info
