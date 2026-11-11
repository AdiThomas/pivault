"""Background work: media processing, trash purge and housekeeping.

The functions here are plain coroutines so they can run inside the ARQ worker or, with
PIVAULT_JOBS_INLINE=true, directly in the API process.
"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from . import media, storage
from .config import get_settings
from .db import get_sessionmaker
from .models import Asset

log = logging.getLogger("pivault.jobs")

_arq_pool = None

STUCK_AFTER = timedelta(minutes=30)
TMP_MAX_AGE_S = 24 * 3600


async def init_queue() -> None:
    """Connect to Redis for enqueueing. A no-op in inline mode."""
    global _arq_pool
    settings = get_settings()
    if settings.jobs_inline or _arq_pool is not None:
        return
    from arq import create_pool
    from arq.connections import RedisSettings

    _arq_pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))


async def close_queue() -> None:
    global _arq_pool
    if _arq_pool is not None:
        await _arq_pool.aclose()
        _arq_pool = None


async def queue_ping() -> bool:
    if get_settings().jobs_inline:
        return True
    if _arq_pool is None:
        return False
    try:
        return bool(await _arq_pool.ping())
    except Exception:
        return False


async def enqueue_process(asset_id: uuid.UUID, keep_taken_at: bool) -> None:
    if get_settings().jobs_inline:
        await process_asset(asset_id, keep_taken_at)
        return
    if _arq_pool is None:
        await init_queue()
    assert _arq_pool is not None
    # The job id makes a double enqueue of the same asset a no-op while one is queued.
    await _arq_pool.enqueue_job(
        "process_asset_job", str(asset_id), keep_taken_at, _job_id=f"process:{asset_id}"
    )


async def process_asset(asset_id: uuid.UUID, keep_taken_at: bool = True) -> str:
    """Read metadata and build the thumbnail and preview for one asset."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        asset = await session.get(Asset, asset_id)
        if asset is None:
            return "missing"
        if asset.kind == "file":
            asset.status = "ready"
            await session.commit()
            return "ready"
        src = storage.abs_path(asset.storage_path)
        thumb = storage.abs_path(storage.thumb_rel_path(asset.id, "thumb"))
        preview = storage.abs_path(storage.thumb_rel_path(asset.id, "preview"))
        kind = asset.kind

    try:
        func = media.process_photo if kind == "photo" else media.process_video
        info = await asyncio.to_thread(func, src, thumb, preview)
    except Exception as exc:
        log.warning("processing failed for %s: %s", asset_id, exc)
        async with sessionmaker() as session:
            asset = await session.get(Asset, asset_id)
            if asset is not None:
                asset.status = "failed"
                asset.error = str(exc)[:500]
                await session.commit()
        return "failed"

    async with sessionmaker() as session:
        asset = await session.get(Asset, asset_id)
        if asset is None:
            return "missing"
        asset.width = info.width
        asset.height = info.height
        asset.duration_s = info.duration_s
        asset.lat = info.lat
        asset.lon = info.lon
        if info.taken_at is not None and not keep_taken_at:
            asset.taken_at = info.taken_at
        asset.status = "ready"
        asset.error = None
        await session.commit()
    return "ready"


async def purge_asset(session, asset: Asset) -> None:
    """Delete an asset's files and its row. The caller commits."""
    await asyncio.to_thread(storage.remove_asset_files, asset.id, asset.storage_path)
    await session.delete(asset)


async def purge_trash() -> int:
    """Permanently delete assets that have been in the trash longer than the limit."""
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().trash_days)
    purged = 0
    async with get_sessionmaker()() as session:
        rows = await session.scalars(
            select(Asset).where(Asset.deleted_at.is_not(None), Asset.deleted_at < cutoff)
        )
        for asset in rows.all():
            await purge_asset(session, asset)
            purged += 1
        await session.commit()
    if purged:
        log.info("purged %d trashed assets", purged)
    return purged


async def requeue_stuck() -> int:
    """Re-queue assets left in 'processing' (for example after a power cut)."""
    cutoff = datetime.now(UTC) - STUCK_AFTER
    async with get_sessionmaker()() as session:
        rows = await session.scalars(
            select(Asset.id).where(Asset.status == "processing", Asset.created_at < cutoff)
        )
        ids = rows.all()
    for asset_id in ids:
        await enqueue_process(asset_id, keep_taken_at=True)
    return len(ids)


def _cleanup_tmp_sync() -> int:
    removed = 0
    now = time.time()
    for path in storage.tmp_dir().glob("*.part"):
        try:
            if now - path.stat().st_mtime > TMP_MAX_AGE_S:
                path.unlink(missing_ok=True)
                removed += 1
        except OSError:
            continue
    return removed


async def cleanup_tmp() -> int:
    """Remove temp files left behind by uploads that never finished."""
    return await asyncio.to_thread(_cleanup_tmp_sync)
