"""Folder tree for the Files tab."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, func, select, update

from ..deps import CurrentUser, SessionDep
from ..models import Asset, Folder
from ..schemas import FolderIn, FolderOut, FolderPatch

router = APIRouter(prefix="/api/folders", tags=["folders"])


def _clean_name(name: str) -> str:
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(status_code=422,
                            detail="Folder names cannot be empty or contain slashes")
    return name[:255]


async def _get_owned(session, folder_id: uuid.UUID, user_id: uuid.UUID) -> Folder:
    folder = await session.get(Folder, folder_id)
    if folder is None or folder.owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return folder


async def _ensure_unique(session, owner_id: uuid.UUID, parent_id: uuid.UUID | None, name: str,
                         ignore_id: uuid.UUID | None = None) -> None:
    stmt = select(Folder.id).where(
        Folder.owner_id == owner_id, func.lower(Folder.name) == name.lower()
    )
    stmt = stmt.where(
        Folder.parent_id.is_(None) if parent_id is None else Folder.parent_id == parent_id
    )
    if ignore_id is not None:
        stmt = stmt.where(Folder.id != ignore_id)
    if await session.scalar(stmt) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A folder with that name already exists here")


async def _descendant_ids(session, owner_id: uuid.UUID, root_id: uuid.UUID) -> list[uuid.UUID]:
    """The folder and everything below it."""
    found = [root_id]
    frontier = [root_id]
    while frontier:
        rows = await session.scalars(
            select(Folder.id).where(Folder.owner_id == owner_id, Folder.parent_id.in_(frontier))
        )
        frontier = list(rows.all())
        found.extend(frontier)
    return found


@router.get("", response_model=list[FolderOut])
async def list_folders(
    user: CurrentUser,
    session: SessionDep,
    parent_id: Annotated[
        str | None, Query(description="A folder id, 'root', or leave out for every folder")
    ] = None,
) -> list[Folder]:
    stmt = select(Folder).where(Folder.owner_id == user.id)
    if parent_id == "root":
        stmt = stmt.where(Folder.parent_id.is_(None))
    elif parent_id is not None:
        try:
            stmt = stmt.where(Folder.parent_id == uuid.UUID(parent_id))
        except ValueError as exc:
            raise HTTPException(status_code=422,
                                detail="parent_id is not a valid id") from exc
    rows = await session.scalars(stmt.order_by(func.lower(Folder.name)))
    return list(rows.all())


@router.post("", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(body: FolderIn, user: CurrentUser, session: SessionDep) -> Folder:
    name = _clean_name(body.name)
    if body.parent_id is not None:
        await _get_owned(session, body.parent_id, user.id)
    await _ensure_unique(session, user.id, body.parent_id, name)
    folder = Folder(owner_id=user.id, parent_id=body.parent_id, name=name)
    session.add(folder)
    await session.commit()
    return folder


@router.get("/{folder_id}", response_model=FolderOut)
async def get_folder(folder_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Folder:
    return await _get_owned(session, folder_id, user.id)


@router.patch("/{folder_id}", response_model=FolderOut)
async def patch_folder(folder_id: uuid.UUID, body: FolderPatch, user: CurrentUser,
                       session: SessionDep) -> Folder:
    """Rename a folder, or move it by sending parent_id (null moves it to the top)."""
    folder = await _get_owned(session, folder_id, user.id)
    name = _clean_name(body.name) if body.name is not None else folder.name
    parent_id = folder.parent_id
    if "parent_id" in body.model_fields_set:
        parent_id = body.parent_id
        if parent_id is not None:
            await _get_owned(session, parent_id, user.id)
            if parent_id in await _descendant_ids(session, user.id, folder.id):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail="A folder cannot be moved inside itself")
    await _ensure_unique(session, user.id, parent_id, name, ignore_id=folder.id)
    folder.name = name
    folder.parent_id = parent_id
    await session.commit()
    return folder


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: uuid.UUID, user: CurrentUser, session: SessionDep,
                        recursive: bool = False) -> None:
    """Delete an empty folder. With ?recursive=true, its files go to the trash first."""
    folder = await _get_owned(session, folder_id, user.id)
    ids = await _descendant_ids(session, user.id, folder.id)
    file_count = await session.scalar(
        select(func.count()).select_from(Asset).where(
            Asset.owner_id == user.id, Asset.folder_id.in_(ids), Asset.deleted_at.is_(None)
        )
    )
    if (file_count or len(ids) > 1) and not recursive:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Folder is not empty")
    now = datetime.now(UTC)
    # Live files go to the trash; anything already trashed just loses its folder.
    await session.execute(
        update(Asset)
        .where(Asset.owner_id == user.id, Asset.folder_id.in_(ids), Asset.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    await session.execute(
        update(Asset).where(Asset.owner_id == user.id, Asset.folder_id.in_(ids))
        .values(folder_id=None)
    )
    await session.execute(delete(Folder).where(Folder.owner_id == user.id, Folder.id.in_(ids)))
    await session.commit()
