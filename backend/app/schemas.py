"""Request and response shapes."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=512)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=8, max_length=1024)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    created_at: datetime


class DeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    platform: str | None = Field(default=None, max_length=32)


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    platform: str | None
    created_at: datetime
    last_seen_at: datetime


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    origin: str
    in_files: bool
    original_name: str
    mime: str
    size_bytes: int
    sha256: str
    taken_at: datetime
    created_at: datetime
    width: int | None
    height: int | None
    duration_s: float | None
    lat: float | None
    lon: float | None
    status: str
    folder_id: uuid.UUID | None
    device_id: uuid.UUID | None
    deleted_at: datetime | None


class AssetPage(BaseModel):
    items: list[AssetOut]
    next_cursor: str | None


class UploadOut(BaseModel):
    asset: AssetOut
    duplicate: bool


class AssetPatch(BaseModel):
    original_name: str | None = Field(default=None, min_length=1, max_length=255)
    # Send null to move to the top level; leave the key out to keep the folder.
    folder_id: uuid.UUID | None = None


class CheckIn(BaseModel):
    device_id: uuid.UUID
    device_asset_ids: list[str] = Field(max_length=5000)


class CheckOut(BaseModel):
    missing: list[str]


class MonthBucket(BaseModel):
    year: int
    month: int
    count: int


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None


class FolderPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    created_at: datetime


class StatsOut(BaseModel):
    photos: int
    videos: int
    files: int
    trashed: int
    processing: int
    failed: int
    bytes_used: int
    disk_total: int
    disk_free: int


class HealthOut(BaseModel):
    status: str
    version: str
    checks: dict[str, str]
