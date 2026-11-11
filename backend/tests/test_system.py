import os
import time

import pytest

from app import jobs, storage
from app.config import Settings
from tests.conftest import make_jpeg, upload


async def test_health_needs_no_login(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"] == {"database": "ok", "storage": "ok", "queue": "ok"}


async def test_stats(client, auth):
    photo = make_jpeg()
    await upload(client, auth, photo)
    await upload(client, auth, b"12345", "a.txt", "text/plain")
    trashed = (await upload(client, auth, b"123456789", "b.txt", "text/plain")).json()["asset"]
    await client.delete(f"/api/assets/{trashed['id']}", headers=auth)

    stats = (await client.get("/api/stats", headers=auth)).json()
    assert stats["photos"] == 1
    assert stats["videos"] == 0
    assert stats["files"] == 1
    assert stats["trashed"] == 1
    assert stats["bytes_used"] == len(photo) + 5 + 9
    assert stats["disk_total"] > stats["disk_free"] > 0


async def test_metrics(client, auth):
    await upload(client, auth, make_jpeg())
    resp = await client.get("/metrics")
    assert resp.status_code == 200
    text = resp.text
    assert 'pivault_assets{kind="photo"} 1.0' in text
    assert 'pivault_uploads_total{kind="photo",result="new"}' in text
    assert "pivault_disk_free_bytes" in text
    # Routes are labelled by template, not by raw path.
    assert 'route="/api/assets"' in text


async def test_openapi_docs_are_served(client):
    spec = (await client.get("/openapi.json")).json()
    for path in ("/api/auth/login", "/api/assets", "/api/assets/{asset_id}/original",
                 "/api/folders/{folder_id}", "/api/stats"):
        assert path in spec["paths"], path


async def test_cleanup_tmp_removes_only_stale_parts(app):
    fresh = storage.tmp_dir() / "fresh.part"
    stale = storage.tmp_dir() / "stale.part"
    fresh.write_bytes(b"x")
    stale.write_bytes(b"x")
    old = time.time() - 2 * 24 * 3600
    os.utime(stale, (old, old))
    assert await jobs.cleanup_tmp() == 1
    assert fresh.exists() and not stale.exists()


def test_production_refuses_a_weak_secret():
    with pytest.raises(RuntimeError):
        Settings(env="prod", secret_key="change-me").validate_for_runtime()
    with pytest.raises(RuntimeError):
        Settings(env="prod", secret_key="short").validate_for_runtime()
    Settings(env="prod", secret_key="x" * 48).validate_for_runtime()
