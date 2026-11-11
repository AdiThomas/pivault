import hashlib
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image
from sqlalchemy import select

from app import db, jobs, storage
from app.models import Asset
from tests.conftest import make_heic, make_jpeg, make_mp4, make_png, upload


async def test_upload_photo_creates_thumbnails_and_metadata(client, auth):
    data = make_jpeg(exif=True, gps=True)
    resp = await upload(client, auth, data, "IMG_0001.JPG")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    asset = body["asset"]
    assert body["duplicate"] is False
    assert asset["kind"] == "photo"
    assert asset["status"] == "ready"
    assert asset["sha256"] == hashlib.sha256(data).hexdigest()
    assert asset["size_bytes"] == len(data)
    assert (asset["width"], asset["height"]) == (800, 600)
    # EXIF 2024:06:15 14:30:00 at -04:00 is 18:30 UTC.
    assert asset["taken_at"].startswith("2024-06-15T18:30:00")
    assert asset["lat"] == pytest.approx(43.5448, abs=1e-3)
    assert asset["lon"] == pytest.approx(-80.2482, abs=1e-3)

    thumb = await client.get(f"/api/assets/{asset['id']}/thumbnail", headers=auth)
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/webp"
    assert "immutable" in thumb.headers["cache-control"]
    with Image.open(io.BytesIO(thumb.content)) as img:
        assert img.format == "WEBP"
        assert min(img.size) == 320

    preview = await client.get(f"/api/assets/{asset['id']}/thumbnail?size=preview", headers=auth)
    assert preview.status_code == 200
    with Image.open(io.BytesIO(preview.content)) as img:
        assert max(img.size) == 800  # never upscaled past the original

    bad = await client.get(f"/api/assets/{asset['id']}/thumbnail?size=huge", headers=auth)
    assert bad.status_code == 422


async def test_client_taken_at_wins_over_exif(client, auth):
    resp = await upload(client, auth, make_jpeg(exif=True), taken_at="2021-01-02T03:04:05Z")
    assert resp.json()["asset"]["taken_at"].startswith("2021-01-02T03:04:05")

    # iOS reports creation time as Unix milliseconds.
    millis = int(datetime(2022, 5, 6, 7, 8, 9, tzinfo=UTC).timestamp() * 1000)
    resp = await upload(client, auth, make_jpeg(color=(1, 2, 3)), taken_at=millis)
    assert resp.json()["asset"]["taken_at"].startswith("2022-05-06T07:08:09")


async def test_rotated_photo_reports_upright_size(client, auth):
    resp = await upload(client, auth, make_jpeg(size=(800, 600), orientation=6))
    asset = resp.json()["asset"]
    assert (asset["width"], asset["height"]) == (600, 800)
    thumb = await client.get(f"/api/assets/{asset['id']}/thumbnail", headers=auth)
    with Image.open(io.BytesIO(thumb.content)) as img:
        assert img.height > img.width


async def test_heic_photo(client, auth):
    data = make_heic()
    if data is None:
        pytest.skip("pillow-heif cannot encode HEIC in this environment")
    resp = await upload(client, auth, data, "IMG_0002.HEIC", "image/heic")
    assert resp.status_code == 201, resp.text
    asset = resp.json()["asset"]
    assert asset["kind"] == "photo"
    assert asset["status"] == "ready"
    assert (asset["width"], asset["height"]) == (640, 480)
    thumb = await client.get(f"/api/assets/{asset['id']}/thumbnail", headers=auth)
    assert thumb.status_code == 200


async def test_video_poster_and_range_requests(client, auth):
    data = make_mp4()
    if data is None:
        pytest.skip("ffmpeg is not installed")
    resp = await upload(client, auth, data, "clip.mp4", "video/mp4")
    assert resp.status_code == 201, resp.text
    asset = resp.json()["asset"]
    assert asset["kind"] == "video"
    assert asset["status"] == "ready"
    assert (asset["width"], asset["height"]) == (320, 240)
    assert asset["duration_s"] == pytest.approx(2.0, abs=0.3)
    assert asset["taken_at"].startswith("2023-03-04T05:06:07")

    thumb = await client.get(f"/api/assets/{asset['id']}/thumbnail", headers=auth)
    assert thumb.status_code == 200

    url = f"/api/assets/{asset['id']}/original"
    full = await client.get(url, headers=auth)
    assert full.status_code == 200
    assert full.content == data
    assert full.headers["accept-ranges"] == "bytes"

    part = await client.get(url, headers={**auth, "Range": "bytes=100-199"})
    assert part.status_code == 206
    assert part.content == data[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{len(data)}"

    tail = await client.get(url, headers={**auth, "Range": "bytes=-50"})
    assert tail.status_code == 206
    assert tail.content == data[-50:]

    beyond = await client.get(url, headers={**auth, "Range": f"bytes={len(data) + 10}-"})
    assert beyond.status_code == 416


async def test_duplicate_content_is_stored_once(client, auth):
    data = make_jpeg()
    first = await upload(client, auth, data, "a.jpg")
    second = await upload(client, auth, data, "b.jpg")
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["asset"]["id"] == first.json()["asset"]["id"]

    listing = await client.get("/api/assets", headers=auth)
    assert len(listing.json()["items"]) == 1
    originals = [p for p in (storage.root() / "originals").rglob("*") if p.is_file()]
    assert len(originals) == 1
    assert not list(storage.tmp_dir().glob("*.part"))


async def test_backup_check_is_idempotent(client, auth, device_id):
    ids = ["ph://AAA/L0/001", "ph://BBB/L0/001", "ph://CCC/L0/001"]
    check = await client.post("/api/assets/check", headers=auth,
                              json={"device_id": device_id, "device_asset_ids": ids})
    assert check.json()["missing"] == ids

    await upload(client, auth, make_jpeg(color=(1, 1, 1)), device_id=device_id,
                 device_asset_id=ids[0])
    # Two camera-roll items with identical bytes: stored once, both marked as backed up.
    same = make_jpeg(color=(2, 2, 2))
    await upload(client, auth, same, device_id=device_id, device_asset_id=ids[1])
    dup = await upload(client, auth, same, device_id=device_id, device_asset_id=ids[2])
    assert dup.json()["duplicate"] is True

    check = await client.post("/api/assets/check", headers=auth,
                              json={"device_id": device_id, "device_asset_ids": ids + ["new"]})
    assert check.json()["missing"] == ["new"]

    listing = await client.get("/api/assets", headers=auth)
    assert len(listing.json()["items"]) == 2
    assert {a["origin"] for a in listing.json()["items"]} == {"backup"}


async def test_check_rejects_unknown_device(client, auth):
    resp = await client.post("/api/assets/check", headers=auth,
                             json={"device_id": str(uuid.uuid4()), "device_asset_ids": ["x"]})
    assert resp.status_code == 404


async def test_raw_body_upload(client, auth):
    data = make_png()
    resp = await client.post(
        "/api/assets", content=data, params={"filename": "diagram.png"},
        headers={**auth, "Content-Type": "image/png"},
    )
    assert resp.status_code == 201, resp.text
    asset = resp.json()["asset"]
    assert asset["original_name"] == "diagram.png"
    assert asset["kind"] == "photo"
    assert asset["status"] == "ready"


async def test_plain_file_upload_and_download(client, auth):
    data = b"%PDF-1.4 not really a pdf" * 100
    resp = await upload(client, auth, data, "notes.pdf", "application/pdf")
    asset = resp.json()["asset"]
    assert asset["kind"] == "file"
    assert asset["status"] == "ready"
    assert asset["mime"] == "application/pdf"

    thumb = await client.get(f"/api/assets/{asset['id']}/thumbnail", headers=auth)
    assert thumb.status_code == 404

    inline = await client.get(f"/api/assets/{asset['id']}/original", headers=auth)
    assert inline.content == data
    assert inline.headers["content-disposition"].startswith("inline")
    dl = await client.get(f"/api/assets/{asset['id']}/original?download=true", headers=auth)
    assert dl.headers["content-disposition"].startswith("attachment")
    assert "notes.pdf" in dl.headers["content-disposition"]

    # Plain files stay out of the photo timeline but show at the top level of Files.
    timeline = await client.get("/api/assets", headers=auth)
    assert timeline.json()["items"] == []
    files = await client.get("/api/assets?folder_id=root", headers=auth)
    assert [a["id"] for a in files.json()["items"]] == [asset["id"]]


async def test_files_tab_only_lists_what_was_put_there(client, auth):
    timeline_only = (await upload(client, auth, make_jpeg(color=(11, 11, 11)))).json()["asset"]
    in_files = (await upload(client, auth, make_jpeg(color=(12, 12, 12)), "scan.jpg",
                             folder_id="root")).json()["asset"]
    assert timeline_only["in_files"] is False
    assert in_files["in_files"] is True

    files = (await client.get("/api/assets?folder_id=root", headers=auth)).json()["items"]
    assert [a["id"] for a in files] == [in_files["id"]]
    # A photo in Files is still a photo, so it is in the timeline as well.
    timeline = (await client.get("/api/assets", headers=auth)).json()["items"]
    assert {a["id"] for a in timeline} == {timeline_only["id"], in_files["id"]}

    # Uploading known content into Files files the existing copy there.
    again = await upload(client, auth, make_jpeg(color=(11, 11, 11)), folder_id="root")
    assert again.json()["duplicate"] is True
    files = (await client.get("/api/assets?folder_id=root", headers=auth)).json()["items"]
    assert len(files) == 2


async def test_crafted_filename_cannot_escape_storage(client, auth):
    resp = await upload(client, auth, b"harmless", "../../../../etc/passwd", "text/plain")
    assert resp.status_code == 201
    asset = resp.json()["asset"]
    assert asset["original_name"] == "passwd"
    async with db.get_sessionmaker()() as session:
        row = await session.get(Asset, uuid.UUID(asset["id"]))
    assert row.storage_path.startswith("files/")
    assert ".." not in row.storage_path
    assert storage.abs_path(row.storage_path).is_file()
    with pytest.raises(ValueError):
        storage.abs_path("../outside.txt")


async def test_upload_size_limit(client, auth, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "max_upload_bytes", 1024)
    resp = await upload(client, auth, b"x" * 4096, "big.bin", "application/octet-stream")
    assert resp.status_code == 413
    assert not list(storage.tmp_dir().glob("*.part"))


async def test_upload_without_file_is_rejected(client, auth):
    resp = await client.post("/api/assets", data={"filename": "x"}, headers=auth)
    assert resp.status_code == 400
    empty = await client.post("/api/assets", content=b"",
                              headers={**auth, "Content-Type": "image/png"})
    assert empty.status_code == 400


async def test_unreadable_image_is_marked_failed(client, auth):
    resp = await upload(client, auth, b"this is not a jpeg", "broken.jpg", "image/jpeg")
    assert resp.status_code == 201
    asset = resp.json()["asset"]
    assert asset["status"] == "failed"
    # The original is still kept and downloadable.
    orig = await client.get(f"/api/assets/{asset['id']}/original", headers=auth)
    assert orig.content == b"this is not a jpeg"


async def test_timeline_pagination_is_newest_first_and_complete(client, auth):
    base = datetime(2024, 1, 1, tzinfo=UTC)
    expected = []
    for i in range(7):
        # Two pairs share a timestamp to exercise the id tie-breaker.
        when = base + timedelta(days=i // 2)
        resp = await upload(client, auth, make_jpeg(color=(i * 30, 0, 0), size=(64, 64)),
                            f"{i}.jpg", taken_at=when.isoformat())
        expected.append(resp.json()["asset"])
    expected.sort(key=lambda a: (a["taken_at"], a["id"]), reverse=True)

    seen = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get("/api/assets", params=params, headers=auth)).json()
        seen.extend(page["items"])
        pages += 1
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert pages == 3
    assert [a["id"] for a in seen] == [a["id"] for a in expected]

    bad = await client.get("/api/assets?cursor=garbage", headers=auth)
    assert bad.status_code == 400


async def test_filters_search_and_months(client, auth):
    await upload(client, auth, make_jpeg(color=(9, 9, 9)), "beach.jpg",
                 taken_at="2024-07-10T10:00:00Z")
    await upload(client, auth, make_jpeg(color=(8, 8, 8)), "city.jpg",
                 taken_at="2024-07-11T10:00:00Z")
    await upload(client, auth, make_jpeg(color=(7, 7, 7)), "snow.jpg",
                 taken_at="2023-12-25T10:00:00Z")
    await upload(client, auth, b"hello", "readme.txt", "text/plain")

    files = await client.get("/api/assets?kind=file", headers=auth)
    assert [a["original_name"] for a in files.json()["items"]] == ["readme.txt"]
    search = await client.get("/api/assets?q=BEACH", headers=auth)
    assert [a["original_name"] for a in search.json()["items"]] == ["beach.jpg"]
    invalid = await client.get("/api/assets?kind=music", headers=auth)
    assert invalid.status_code == 422

    months = (await client.get("/api/assets/months", headers=auth)).json()
    assert months == [{"year": 2024, "month": 7, "count": 2},
                      {"year": 2023, "month": 12, "count": 1}]


async def test_trash_restore_and_permanent_delete(client, auth, device_id):
    data = make_jpeg()
    asset = (await upload(client, auth, data, device_id=device_id,
                          device_asset_id="ph://1")).json()["asset"]
    url = f"/api/assets/{asset['id']}"

    assert (await client.delete(url, headers=auth)).status_code == 204
    assert (await client.get("/api/assets", headers=auth)).json()["items"] == []
    trash = (await client.get("/api/assets?trashed=true", headers=auth)).json()["items"]
    assert [a["id"] for a in trash] == [asset["id"]]
    assert trash[0]["deleted_at"] is not None
    # A trashed photo counts as missing, so the phone would back it up again.
    check = await client.post("/api/assets/check", headers=auth,
                              json={"device_id": device_id, "device_asset_ids": ["ph://1"]})
    assert check.json()["missing"] == ["ph://1"]

    restored = await client.post(f"{url}/restore", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["deleted_at"] is None
    assert len((await client.get("/api/assets", headers=auth)).json()["items"]) == 1

    # Uploading the same bytes again brings a trashed asset back instead of duplicating it.
    await client.delete(url, headers=auth)
    again = await upload(client, auth, data)
    assert again.json()["duplicate"] is True
    assert again.json()["asset"]["deleted_at"] is None

    async with db.get_sessionmaker()() as session:
        row = await session.get(Asset, uuid.UUID(asset["id"]))
    original_path = storage.abs_path(row.storage_path)
    thumb_path = storage.abs_path(storage.thumb_rel_path(row.id, "thumb"))
    assert original_path.is_file() and thumb_path.is_file()

    gone = await client.delete(f"{url}?permanent=true", headers=auth)
    assert gone.status_code == 204
    assert (await client.get(url, headers=auth)).status_code == 404
    assert not original_path.exists() and not thumb_path.exists()


async def test_trash_purge_removes_only_old_items(client, auth):
    old = (await upload(client, auth, make_jpeg(color=(5, 5, 5)))).json()["asset"]
    recent = (await upload(client, auth, make_jpeg(color=(6, 6, 6)))).json()["asset"]
    kept = (await upload(client, auth, make_jpeg(color=(4, 4, 4)))).json()["asset"]
    await client.delete(f"/api/assets/{old['id']}", headers=auth)
    await client.delete(f"/api/assets/{recent['id']}", headers=auth)

    async with db.get_sessionmaker()() as session:
        row = await session.get(Asset, uuid.UUID(old["id"]))
        row.deleted_at = datetime.now(UTC) - timedelta(days=31)
        old_path = storage.abs_path(row.storage_path)
        await session.commit()

    assert await jobs.purge_trash() == 1
    assert not old_path.exists()
    async with db.get_sessionmaker()() as session:
        remaining = set((await session.scalars(select(Asset.id))).all())
    assert remaining == {uuid.UUID(recent["id"]), uuid.UUID(kept["id"])}


async def test_rename_and_move_asset(client, auth):
    asset = (await upload(client, auth, b"abc", "old.txt", "text/plain")).json()["asset"]
    folder = (await client.post("/api/folders", json={"name": "Docs"}, headers=auth)).json()

    moved = await client.patch(f"/api/assets/{asset['id']}", headers=auth,
                               json={"original_name": "new.txt", "folder_id": folder["id"]})
    assert moved.status_code == 200
    assert moved.json()["original_name"] == "new.txt"
    assert moved.json()["folder_id"] == folder["id"]

    in_folder = await client.get(f"/api/assets?folder_id={folder['id']}", headers=auth)
    assert len(in_folder.json()["items"]) == 1
    assert (await client.get("/api/assets?folder_id=root", headers=auth)).json()["items"] == []

    # Renaming alone leaves the folder untouched; an explicit null moves to the top level.
    renamed = await client.patch(f"/api/assets/{asset['id']}", headers=auth,
                                 json={"original_name": "newer.txt"})
    assert renamed.json()["folder_id"] == folder["id"]
    top = await client.patch(f"/api/assets/{asset['id']}", headers=auth, json={"folder_id": None})
    assert top.json()["folder_id"] is None

    missing = await client.patch(f"/api/assets/{asset['id']}", headers=auth,
                                 json={"folder_id": str(uuid.uuid4())})
    assert missing.status_code == 404


async def test_media_urls_accept_query_token(client, auth):
    asset = (await upload(client, auth, make_jpeg())).json()["asset"]
    token = auth["Authorization"].split()[1]
    ok = await client.get(f"/api/assets/{asset['id']}/thumbnail?access_token={token}")
    assert ok.status_code == 200
    denied = await client.get(f"/api/assets/{asset['id']}/thumbnail?access_token=bogus")
    assert denied.status_code == 401
    # The query token only works on media URLs.
    assert (await client.get(f"/api/assets?access_token={token}")).status_code == 401


async def test_users_cannot_see_each_others_assets(client, auth):
    from app.models import User
    from app.security import hash_password

    async with db.get_sessionmaker()() as session:
        session.add(User(email="other@example.com", password_hash=hash_password("other pass 1")))
        await session.commit()
    other = (await client.post("/api/auth/login",
                               json={"email": "other@example.com",
                                     "password": "other pass 1"})).json()
    other_auth = {"Authorization": f"Bearer {other['access_token']}"}

    asset = (await upload(client, auth, make_jpeg())).json()["asset"]
    for path in ("", "/thumbnail", "/original"):
        resp = await client.get(f"/api/assets/{asset['id']}{path}", headers=other_auth)
        assert resp.status_code == 404
    assert (await client.delete(f"/api/assets/{asset['id']}",
                                headers=other_auth)).status_code == 404
    assert (await client.get("/api/assets", headers=other_auth)).json()["items"] == []

    # The same bytes uploaded by another user are a separate asset.
    theirs = await upload(client, other_auth, make_jpeg())
    assert theirs.status_code == 201
    assert theirs.json()["asset"]["id"] != asset["id"]
