"""Devices that back up to the server."""

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from ..deps import CurrentUser, SessionDep
from ..models import Device
from ..schemas import DeviceIn, DeviceOut

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.post("", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
async def register_device(body: DeviceIn, user: CurrentUser, session: SessionDep) -> Device:
    device = Device(user_id=user.id, name=body.name.strip(), platform=body.platform)
    session.add(device)
    await session.commit()
    return device


@router.get("", response_model=list[DeviceOut])
async def list_devices(user: CurrentUser, session: SessionDep) -> list[Device]:
    rows = await session.scalars(
        select(Device).where(Device.user_id == user.id).order_by(Device.created_at)
    )
    return list(rows.all())


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(device_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> None:
    device = await session.get(Device, device_id)
    if device is None or device.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    # Stored photos stay; only this device's record of what it backed up goes.
    await session.delete(device)
    await session.commit()
