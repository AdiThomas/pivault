"""Stats, health and metrics."""

import asyncio

from fastapi import APIRouter, Response, status
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import func, select, text

from .. import __version__, jobs, metrics, storage
from ..db import get_sessionmaker
from ..deps import CurrentUser, SessionDep
from ..models import Asset
from ..schemas import HealthOut, StatsOut

router = APIRouter(tags=["system"])


@router.get("/api/stats", response_model=StatsOut)
async def stats(user: CurrentUser, session: SessionDep) -> StatsOut:
    live = (Asset.owner_id == user.id, Asset.deleted_at.is_(None))
    by_kind = dict(
        (await session.execute(select(Asset.kind, func.count()).where(*live).group_by(Asset.kind)))
        .all()
    )
    by_status = dict(
        (await session.execute(
            select(Asset.status, func.count()).where(*live).group_by(Asset.status)
        )).all()
    )
    trashed = await session.scalar(
        select(func.count()).select_from(Asset).where(
            Asset.owner_id == user.id, Asset.deleted_at.is_not(None)
        )
    )
    # Trashed files still take up space until they are purged, so count them.
    bytes_used = await session.scalar(
        select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(Asset.owner_id == user.id)
    )
    total, free = await asyncio.to_thread(storage.disk_usage)
    return StatsOut(
        photos=by_kind.get("photo", 0),
        videos=by_kind.get("video", 0),
        files=by_kind.get("file", 0),
        trashed=trashed or 0,
        processing=by_status.get("processing", 0),
        failed=by_status.get("failed", 0),
        bytes_used=int(bytes_used or 0),
        disk_total=total,
        disk_free=free,
    )


@router.get("/api/health", response_model=HealthOut)
async def health(response: Response) -> HealthOut:
    """Liveness for Docker and monitoring. No login needed."""
    checks: dict[str, str] = {}
    try:
        async with get_sessionmaker()() as session:
            await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {type(exc).__name__}"
    try:
        await asyncio.to_thread(storage.disk_usage)
        checks["storage"] = "ok" if storage.root().is_dir() else "error: missing"
    except Exception as exc:
        checks["storage"] = f"error: {type(exc).__name__}"
    checks["queue"] = "ok" if await jobs.queue_ping() else "error: unreachable"

    healthy = all(value == "ok" for value in checks.values())
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthOut(status="ok" if healthy else "degraded", version=__version__, checks=checks)


@router.get("/metrics", include_in_schema=False)
async def prometheus_metrics() -> Response:
    """Prometheus scrape target. Caddy does not expose this path outside Docker."""
    try:
        async with get_sessionmaker()() as session:
            live = Asset.deleted_at.is_(None)
            for kind in ("photo", "video", "file"):
                metrics.ASSETS.labels(kind).set(0)
            for kind, count in (await session.execute(
                select(Asset.kind, func.count()).where(live).group_by(Asset.kind)
            )).all():
                metrics.ASSETS.labels(kind).set(count)
            for state in ("processing", "ready", "failed"):
                metrics.ASSETS_BY_STATUS.labels(state).set(0)
            for state, count in (await session.execute(
                select(Asset.status, func.count()).where(live).group_by(Asset.status)
            )).all():
                metrics.ASSETS_BY_STATUS.labels(state).set(count)
            metrics.ASSETS_TRASHED.set(
                await session.scalar(
                    select(func.count()).select_from(Asset).where(Asset.deleted_at.is_not(None))
                ) or 0
            )
            metrics.STORAGE_USED.set(
                await session.scalar(select(func.coalesce(func.sum(Asset.size_bytes), 0))) or 0
            )
        total, free = await asyncio.to_thread(storage.disk_usage)
        metrics.DISK_TOTAL.set(total)
        metrics.DISK_FREE.set(free)
    except Exception:  # still serve the request counters if the database is down
        pass
    return Response(generate_latest(metrics.REGISTRY), media_type=CONTENT_TYPE_LATEST)
