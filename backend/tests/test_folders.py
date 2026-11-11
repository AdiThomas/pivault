from tests.conftest import upload


async def _mk(client, auth, name, parent_id=None):
    resp = await client.post("/api/folders", json={"name": name, "parent_id": parent_id},
                             headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_create_list_and_nest(client, auth):
    docs = await _mk(client, auth, "Docs")
    await _mk(client, auth, "archive")
    taxes = await _mk(client, auth, "Taxes", docs["id"])

    top = (await client.get("/api/folders?parent_id=root", headers=auth)).json()
    assert [f["name"] for f in top] == ["archive", "Docs"]  # case-insensitive order
    children = (await client.get(f"/api/folders?parent_id={docs['id']}", headers=auth)).json()
    assert [f["id"] for f in children] == [taxes["id"]]
    everything = (await client.get("/api/folders", headers=auth)).json()
    assert len(everything) == 3


async def test_names_are_unique_within_a_parent(client, auth):
    docs = await _mk(client, auth, "Docs")
    clash = await client.post("/api/folders", json={"name": "docs"}, headers=auth)
    assert clash.status_code == 409
    # The same name is fine in a different parent.
    await _mk(client, auth, "Docs", docs["id"])


async def test_invalid_names_are_rejected(client, auth):
    for name in ("a/b", "..", "   ", "x\\y"):
        resp = await client.post("/api/folders", json={"name": name}, headers=auth)
        assert resp.status_code == 422, name


async def test_rename_and_move(client, auth):
    a = await _mk(client, auth, "A")
    b = await _mk(client, auth, "B")
    child = await _mk(client, auth, "Child", a["id"])

    renamed = await client.patch(f"/api/folders/{a['id']}", json={"name": "Alpha"}, headers=auth)
    assert renamed.json()["name"] == "Alpha"

    moved = await client.patch(f"/api/folders/{child['id']}", json={"parent_id": b["id"]},
                               headers=auth)
    assert moved.json()["parent_id"] == b["id"]

    to_top = await client.patch(f"/api/folders/{child['id']}", json={"parent_id": None},
                                headers=auth)
    assert to_top.json()["parent_id"] is None

    clash = await client.patch(f"/api/folders/{b['id']}", json={"name": "alpha"}, headers=auth)
    assert clash.status_code == 409


async def test_folder_cannot_move_into_itself(client, auth):
    a = await _mk(client, auth, "A")
    child = await _mk(client, auth, "Child", a["id"])
    grandchild = await _mk(client, auth, "Grandchild", child["id"])

    for target in (a["id"], child["id"], grandchild["id"]):
        resp = await client.patch(f"/api/folders/{a['id']}", json={"parent_id": target},
                                  headers=auth)
        assert resp.status_code == 409


async def test_delete_folder(client, auth):
    a = await _mk(client, auth, "A")
    child = await _mk(client, auth, "Child", a["id"])
    asset = (await upload(client, auth, b"contents", "f.txt", "text/plain",
                          folder_id=child["id"])).json()["asset"]
    assert asset["folder_id"] == child["id"]

    refused = await client.delete(f"/api/folders/{a['id']}", headers=auth)
    assert refused.status_code == 409

    done = await client.delete(f"/api/folders/{a['id']}?recursive=true", headers=auth)
    assert done.status_code == 204
    assert (await client.get("/api/folders", headers=auth)).json() == []

    # The file went to the trash rather than disappearing.
    trash = (await client.get("/api/assets?trashed=true", headers=auth)).json()["items"]
    assert [t["id"] for t in trash] == [asset["id"]]
    assert trash[0]["folder_id"] is None

    empty = await _mk(client, auth, "Empty")
    assert (await client.delete(f"/api/folders/{empty['id']}", headers=auth)).status_code == 204


async def test_upload_to_missing_folder_is_rejected(client, auth):
    resp = await upload(client, auth, b"x", "f.txt", "text/plain",
                        folder_id="00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
