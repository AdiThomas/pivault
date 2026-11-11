"""Upload, browse, download and trash assets."""

import asyncio
import base64
import os
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, extract, func, or_, select
from sqlalchemy.exc import IntegrityError

from .. import jobs, storage
from ..config import get_settings
from ..deps import CurrentUser, MediaUser, SessionDep
from ..metrics import UPLOAD_BYTES, UPLOADS
from ..models import Asset, Device, DeviceAsset, Folder
from ..schemas import (
    AssetOut,
    AssetPage,
    AssetPatch,
    CheckIn,
    CheckOut,
    MonthBucket,
    UploadOut,
)
from ..upload import UploadError, UploadTooLarge, receive_upload

router = APIRouter(prefix="/api/assets", tags=["assets"])

KINDS = {"photo", "video", "file"}


# -- helpers --------------------------------------------------------------


def _encode_cursor(asset: Asset) -> str:
    raw = f"{asset.taken_at.isoformat()}|{asset.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts, _, ident = raw.partition("|")
        return datetime.fromisoformat(ts), uuid.UUID(ident)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Invalid cursor") from exc


def _parse_taken_at(value: str | None) -> datetime | None:
    """Accept ISO 8601 or a Unix timestamp in milliseconds (what iOS reports)."""
    if not value:
        return None
    value = value.strip()
    try:
        number = float(value)
    except ValueError:
        number = None
    try:
        if number is not None:
            if number <= 0:
                return None
            seconds = number / 1000 if number > 1e11 else number
            parsed = datetime.fromtimestamp(seconds, UTC)
        else:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
    except (ValueError, OverflowError, OSError) as exc:
        raise HTTPException(status_code=422,
                            detail="taken_at is not a valid date") from exc
    return parsed.astimezone(UTC)


def _parse_uuid(value: str | None, name: str) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status_code=422,
                            detail=f"{name} is not a valid id") from exc


async def _get_owned(session, asset_id: uuid.UUID, user_id: uuid.UUID,
                     include_trashed: bool = False) -> Asset:
    asset = await session.get(Asset, asset_id)
    if asset is None or asset.owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    if asset.deleted_at is not None and not include_trashed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return asset


async def _link_device_asset(session, device_id: uuid.UUID, device_asset_id: str,
                             asset_id: uuid.UUID) -> None:
    existing = await session.get(DeviceAsset, (device_id, device_asset_id))
    if existing is None:
        session.add(DeviceAsset(device_id=device_id, device_asset_id=device_asset_id,
                                asset_id=asset_id))
    elif existing.asset_id != asset_id:
        existing.asset_id = asset_id


# -- backup check ---------------------------------------------------------


@router.post("/check", response_model=CheckOut)
async def check(body: CheckIn, user: CurrentUser, session: SessionDep) -> CheckOut:
    """Given camera-roll ids from a device, return the ones the server does not have."""
    device = await session.get(Device, body.device_id)
    if device is None or device.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    device.last_seen_at = datetime.now(UTC)

    wanted = list(dict.fromkeys(body.device_asset_ids))
    have: set[str] = set()
    for start in range(0, len(wanted), 500):
        chunk = wanted[start : start + 500]
        rows = await session.scalars(
            select(DeviceAsset.device_asset_id)
            .join(Asset, Asset.id == DeviceAsset.asset_id)
            .where(
                DeviceAsset.device_id == device.id,
                DeviceAsset.device_asset_id.in_(chunk),
                Asset.deleted_at.is_(None),
            )
        )
        have.update(rows.all())
    await session.commit()
    return CheckOut(missing=[item for item in wanted if item not in have])


# -- upload ---------------------------------------------------------------


@router.post("", response_model=UploadOut, status_code=status.HTTP_201_CREATED)
async def upload(
    request: Request,
    response: Response,
    user: CurrentUser,
    session: SessionDep,
    device_id: Annotated[str | None, Query()] = None,
    device_asset_id: Annotated[str | None, Query(max_length=255)] = None,
    folder_id: Annotated[str | None, Query()] = None,
    taken_at: Annotated[str | None, Query()] = None,
    filename: Annotated[str | None, Query(max_length=255)] = None,
) -> UploadOut:
    """Upload one file. Identical content is stored once per account.

    Send multipart/form-data with a `file` part, or the raw file as the request body.
    The optional values (device_id, device_asset_id, folder_id, taken_at, filename) can
    be query parameters or multipart form fields. folder_id is a folder id, or "root"
    for the top level of Files; leave it out for a photo that only belongs in the timeline.
    """
    settings = get_settings()
    try:
        received = await receive_upload(request, storage.tmp_dir(), settings.max_upload_bytes)
    except UploadTooLarge as exc:
        raise HTTPException(status_code=413,
                            detail=str(exc)) from exc
    except UploadError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    tmp_path = received.tmp_path
    try:
        fields = received.fields
        device_uuid = _parse_uuid(fields.get("device_id") or device_id, "device_id")
        # "root" means the top level of the Files tab; no folder_id at all means "not in Files".
        folder_param = fields.get("folder_id") or folder_id
        folder_uuid = None if folder_param == "root" else _parse_uuid(folder_param, "folder_id")
        dev_asset_id = (fields.get("device_asset_id") or device_asset_id or "")[:255] or None
        client_taken_at = _parse_taken_at(fields.get("taken_at") or taken_at)
        name = storage.clean_display_name(
            fields.get("filename") or filename or received.filename
        )

        if received.size == 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
        if device_uuid is not None:
            device = await session.get(Device, device_uuid)
            if device is None or device.user_id != user.id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail="Device not found")
            device.last_seen_at = datetime.now(UTC)
        if dev_asset_id and device_uuid is None:
            raise HTTPException(status_code=422,
                                detail="device_asset_id needs a device_id")
        if folder_uuid is not None:
            folder = await session.get(Folder, folder_uuid)
            if folder is None or folder.owner_id != user.id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail="Folder not found")

        mime = storage.guess_mime(name, received.content_type)
        kind = storage.kind_for_mime(mime)

        existing = await session.scalar(
            select(Asset).where(Asset.owner_id == user.id, Asset.sha256 == received.sha256)
        )
        if existing is None:
            now = datetime.now(UTC)
            asset_id = uuid.uuid4()
            rel_path = storage.original_rel_path(
                kind, asset_id, storage.safe_ext(name, mime), client_taken_at or now
            )
            await asyncio.to_thread(storage.move_into_place, tmp_path, rel_path)
            asset = Asset(
                id=asset_id,
                owner_id=user.id,
                kind=kind,
                origin="backup" if dev_asset_id else "upload",
                in_files=bool(folder_param) or kind == "file",
                original_name=name,
                mime=mime,
                size_bytes=received.size,
                sha256=received.sha256,
                storage_path=rel_path,
                taken_at=client_taken_at or now,
                created_at=now,
                status="ready" if kind == "file" else "processing",
                folder_id=folder_uuid,
                device_id=device_uuid,
                device_asset_id=dev_asset_id,
            )
            session.add(asset)
            if dev_asset_id and device_uuid:
                await _link_device_asset(session, device_uuid, dev_asset_id, asset_id)
            try:
                await session.commit()
            except IntegrityError:
                # The same content finished uploading on another request first.
                await session.rollback()
                await asyncio.to_thread(storage.remove_file, rel_path)
                existing = await session.scalar(
                    select(Asset).where(Asset.owner_id == user.id,
                                        Asset.sha256 == received.sha256)
                )
                if existing is None:
                    raise
            else:
                UPLOADS.labels(kind, "new").inc()
                UPLOAD_BYTES.inc(received.size)
                if kind != "file":
                    await jobs.enqueue_process(asset_id, keep_taken_at=client_taken_at is not None)
                    await session.refresh(asset)
                return UploadOut(asset=AssetOut.model_validate(asset), duplicate=False)

        # Duplicate content: keep the stored copy, drop the new one.
        if existing.deleted_at is not None:
            existing.deleted_at = None
        if folder_param and not existing.in_files:
            # Uploading known content into Files files the existing copy there.
            existing.in_files = True
            existing.folder_id = folder_uuid
        if dev_asset_id and device_uuid:
            await _link_device_asset(session, device_uuid, dev_asset_id, existing.id)
        await session.commit()
        UPLOADS.labels(existing.kind, "duplicate").inc()
        response.status_code = status.HTTP_200_OK
        return UploadOut(asset=AssetOut.model_validate(existing), duplicate=True)
    finally:
        tmp_path.unlink(missing_ok=True)


# -- browse ---------------------------------------------------------------


@router.get("", response_model=AssetPage)
async def list_assets(
    user: CurrentUser,
    session: SessionDep,
    kind: Annotated[str | None, Query(description="Comma-separated: photo,video,file")] = None,
    folder_id: Annotated[
        str | None, Query(description="A folder id, or 'root' for the top level of Files")
    ] = None,
    trashed: bool = False,
    q: Annotated[str | None, Query(max_length=100, description="Filename contains")] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> AssetPage:
    """Newest first. With no filters this is the photo timeline (photos and videos)."""
    stmt = select(Asset).where(Asset.owner_id == user.id)
    stmt = stmt.where(Asset.deleted_at.is_not(None) if trashed else Asset.deleted_at.is_(None))

    kinds: set[str] | None = None
    if kind:
        kinds = {part.strip() for part in kind.split(",") if part.strip()}
        if not kinds <= KINDS:
            raise HTTPException(status_code=422,
                                detail="kind must be photo, video or file")

    if folder_id is not None:
        # The Files view: things put there on purpose, organised in folders.
        stmt = stmt.where(Asset.in_files.is_(True))
        if folder_id == "root":
            stmt = stmt.where(Asset.folder_id.is_(None))
        else:
            stmt = stmt.where(Asset.folder_id == _parse_uuid(folder_id, "folder_id"))
    elif kinds is None and not trashed and not q:
        kinds = {"photo", "video"}

    if kinds is not None:
        stmt = stmt.where(Asset.kind.in_(kinds))
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Asset.original_name.ilike(f"%{escaped}%", escape="\\"))

    if cursor:
        ts, ident = _decode_cursor(cursor)
        stmt = stmt.where(
            or_(Asset.taken_at < ts, and_(Asset.taken_at == ts, Asset.id < ident))
        )

    stmt = stmt.order_by(Asset.taken_at.desc(), Asset.id.desc()).limit(limit + 1)
    rows = list((await session.scalars(stmt)).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return AssetPage(
        items=[AssetOut.model_validate(row) for row in rows],
        next_cursor=_encode_cursor(rows[-1]) if has_more and rows else None,
    )


@router.get("/months", response_model=list[MonthBucket])
async def months(user: CurrentUser, session: SessionDep) -> list[MonthBucket]:
    """Photo and video counts per month, newest first (for the timeline scrubber)."""
    year = extract("year", Asset.taken_at)
    month = extract("month", Asset.taken_at)
    rows = await session.execute(
        select(year, month, func.count())
        .where(
            Asset.owner_id == user.id,
            Asset.deleted_at.is_(None),
            Asset.kind.in_(("photo", "video")),
        )
        .group_by(year, month)
        .order_by(year.desc(), month.desc())
    )
    return [MonthBucket(year=int(y), month=int(m), count=c) for y, m, c in rows.all()]


@router.get("/{asset_id}", response_model=AssetOut)
async def get_asset(asset_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Asset:
    return await _get_owned(session, asset_id, user.id, include_trashed=True)


@router.patch("/{asset_id}", response_model=AssetOut)
async def patch_asset(asset_id: uuid.UUID, body: AssetPatch, user: CurrentUser,
                      session: SessionDep) -> Asset:
    """Rename an asset or move it to another folder."""
    asset = await _get_owned(session, asset_id, user.id)
    if body.original_name is not None:
        asset.original_name = storage.clean_display_name(body.original_name)
    if "folder_id" in body.model_fields_set:
        if body.folder_id is not None:
            folder = await session.get(Folder, body.folder_id)
            if folder is None or folder.owner_id != user.id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail="Folder not found")
        asset.folder_id = body.folder_id
        # Moving something makes it show up in Files, even if it came from a backup.
        asset.in_files = True
    await session.commit()
    return asset


@router.get("/{asset_id}/thumbnail")
async def thumbnail(
    asset_id: uuid.UUID,
    user: MediaUser,
    session: SessionDep,
    size: Annotated[str, Query(pattern="^(thumb|preview)$")] = "thumb",
) -> FileResponse:
    asset = await _get_owned(session, asset_id, user.id, include_trashed=True)
    path = storage.abs_path(storage.thumb_rel_path(asset.id, size))
    if asset.status != "ready" or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Thumbnail not available")
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.get("/{asset_id}/original")
async def original(
    asset_id: uuid.UUID,
    user: MediaUser,
    session: SessionDep,
    download: bool = False,
) -> FileResponse:
    """The original bytes. Supports HTTP Range, so players can seek inside a video."""
    asset = await _get_owned(session, asset_id, user.id, include_trashed=True)
    path = storage.abs_path(asset.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="File is missing from storage")
    if not os.access(path, os.R_OK):
        # Typically a file restored by SnapRAID or restic as root.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The file is on disk but the server is not allowed to read it "
                   "(check its owner; see docs/OPERATIONS.md)",
        )
    return FileResponse(
        path,
        media_type=asset.mime,
        filename=asset.original_name,
        content_disposition_type="attachment" if download else "inline",
        headers={"Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes"},
    )


# -- trash ----------------------------------------------------------------


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(asset_id: uuid.UUID, user: CurrentUser, session: SessionDep,
                       permanent: bool = False) -> None:
    """Move to the trash, or delete for good with ?permanent=true."""
    asset = await _get_owned(session, asset_id, user.id, include_trashed=True)
    if permanent:
        await jobs.purge_asset(session, asset)
    elif asset.deleted_at is None:
        asset.deleted_at = datetime.now(UTC)
    await session.commit()


@router.post("/{asset_id}/restore", response_model=AssetOut)
async def restore_asset(asset_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Asset:
    asset = await _get_owned(session, asset_id, user.id, include_trashed=True)
    asset.deleted_at = None
    await session.commit()
    return asset
