"""Test fixtures.

By default the suite runs against a throwaway SQLite file, so plain `pytest` works
anywhere. Set PIVAULT_TEST_DATABASE_URL to a PostgreSQL URL to run against the real
database (this is what CI and `docker compose run tests` do).
"""

import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

_STORAGE = Path(tempfile.mkdtemp(prefix="pivault-test-"))
_PG_URL = os.environ.get("PIVAULT_TEST_DATABASE_URL")

os.environ["PIVAULT_ENV"] = "test"
os.environ["PIVAULT_DATABASE_URL"] = _PG_URL or f"sqlite+aiosqlite:///{_STORAGE / 'test.db'}"
os.environ["PIVAULT_STORAGE_ROOT"] = str(_STORAGE / "storage")
os.environ["PIVAULT_SECRET_KEY"] = "test-secret-key-that-is-long-enough-for-hs256"
os.environ["PIVAULT_JOBS_INLINE"] = "true"
os.environ["PIVAULT_AUTO_CREATE_TABLES"] = "true"
os.environ["PIVAULT_ADMIN_EMAIL"] = "admin@example.com"
os.environ["PIVAULT_ADMIN_PASSWORD"] = "correct horse battery"
os.environ["PIVAULT_LOGIN_RATE_LIMIT"] = "5"

import httpx  # noqa: E402
from PIL import Image  # noqa: E402

from app import db, storage  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Base  # noqa: E402
from app.routers.auth import login_limiter  # noqa: E402

ADMIN_EMAIL = "admin@example.com"
ADMIN_PASSWORD = "correct horse battery"


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_STORAGE, ignore_errors=True)


@pytest.fixture
async def app():
    """A fresh app with an empty database and empty storage for every test."""
    await db.dispose_engine()
    engine = db.init_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    shutil.rmtree(storage.root(), ignore_errors=True)
    login_limiter.clear()

    application = create_app()
    async with application.router.lifespan_context(application):
        yield application
    await db.dispose_engine()


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def auth(client):
    """Authorization headers for the admin account."""
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
async def device_id(client, auth):
    resp = await client.post("/api/devices", json={"name": "Test iPhone", "platform": "ios"},
                             headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# -- sample media ---------------------------------------------------------


def make_jpeg(color=(200, 30, 30), size=(800, 600), exif: bool = False, orientation: int = 1,
              gps: bool = False) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    if exif or gps or orientation != 1:
        data = Image.Exif()
        data[0x0112] = orientation
        ifd = data.get_ifd(0x8769)
        ifd[0x9003] = "2024:06:15 14:30:00"
        ifd[0x9011] = "-04:00"
        if gps:
            gps_ifd = data.get_ifd(0x8825)
            gps_ifd[1] = "N"
            gps_ifd[2] = (43.0, 32.0, 41.28)
            gps_ifd[3] = "W"
            gps_ifd[4] = (80.0, 14.0, 53.52)
        img.save(buf, "JPEG", quality=85, exif=data)
    else:
        img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def make_png(color=(10, 120, 200), size=(400, 300)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (*color, 255)).save(buf, "PNG")
    return buf.getvalue()


def make_heic(color=(20, 160, 90), size=(640, 480)) -> bytes | None:
    """HEIC bytes, or None when this build of pillow-heif cannot encode."""
    try:
        buf = io.BytesIO()
        Image.new("RGB", size, color).save(buf, "HEIF", quality=80)
        return buf.getvalue()
    except Exception:
        return None


def make_mp4(seconds: int = 2) -> bytes | None:
    """A tiny H.264 clip made with ffmpeg, or None when ffmpeg is not installed."""
    if shutil.which("ffmpeg") is None:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "clip.mp4"
        result = subprocess.run(
            ["ffmpeg", "-nostdin", "-y", "-f", "lavfi", "-i",
             f"testsrc=duration={seconds}:size=320x240:rate=10",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             "-metadata", "creation_time=2023-03-04T05:06:07Z", str(out)],
            capture_output=True, check=False,
        )
        if result.returncode != 0 or not out.exists():
            return None
        return out.read_bytes()


async def upload(client, auth, data: bytes, name: str = "photo.jpg",
                 mime: str = "image/jpeg", **fields) -> httpx.Response:
    return await client.post(
        "/api/assets",
        files={"file": (name, data, mime)},
        data={k: str(v) for k, v in fields.items()},
        headers=auth,
    )
