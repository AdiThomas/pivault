from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD


async def test_login_and_me(client):
    resp = await client.post("/api/auth/login",
                             json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 15 * 60

    me = await client.get("/api/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200
    assert me.json()["email"] == ADMIN_EMAIL


async def test_login_email_is_case_insensitive(client):
    resp = await client.post("/api/auth/login",
                             json={"email": ADMIN_EMAIL.upper(), "password": ADMIN_PASSWORD})
    assert resp.status_code == 200


async def test_login_rejects_wrong_password_and_unknown_email(client):
    wrong = await client.post("/api/auth/login",
                              json={"email": ADMIN_EMAIL, "password": "nope"})
    unknown = await client.post("/api/auth/login",
                                json={"email": "ghost@example.com", "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    # Same message for both, so the API does not reveal which emails exist.
    assert wrong.json() == unknown.json()


async def test_endpoints_require_a_token(client):
    for method, path in [("GET", "/api/me"), ("GET", "/api/assets"), ("GET", "/api/folders"),
                         ("GET", "/api/stats"), ("POST", "/api/assets/check")]:
        resp = await client.request(method, path)
        assert resp.status_code == 401, path
    bad = await client.get("/api/me", headers={"Authorization": "Bearer not-a-token"})
    assert bad.status_code == 401


async def test_refresh_token_cannot_be_used_as_access_token(client):
    tokens = (await client.post("/api/auth/login",
                                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})).json()
    resp = await client.get("/api/me",
                            headers={"Authorization": f"Bearer {tokens['refresh_token']}"})
    assert resp.status_code == 401


async def test_refresh_rotates_and_detects_reuse(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "refresh_reuse_grace_s", 0)
    first = (await client.post("/api/auth/login",
                               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})).json()

    second = await client.post("/api/auth/refresh",
                               json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    second = second.json()
    assert second["refresh_token"] != first["refresh_token"]

    # Presenting the old token again is treated as theft: every session is revoked.
    replay = await client.post("/api/auth/refresh",
                               json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401
    after = await client.post("/api/auth/refresh",
                              json={"refresh_token": second["refresh_token"]})
    assert after.status_code == 401


async def test_refresh_retry_within_grace_window_is_allowed(client):
    first = (await client.post("/api/auth/login",
                               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})).json()
    second = await client.post("/api/auth/refresh",
                               json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    # The phone never saw that response and tries again with the same token.
    retry = await client.post("/api/auth/refresh",
                              json={"refresh_token": first["refresh_token"]})
    assert retry.status_code == 200
    # Neither new session was revoked.
    for tokens in (second.json(), retry.json()):
        me = await client.get("/api/me",
                              headers={"Authorization": f"Bearer {tokens['access_token']}"})
        assert me.status_code == 200


async def test_logout_revokes_refresh_token(client):
    tokens = (await client.post("/api/auth/login",
                                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})).json()
    out = await client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    assert out.status_code == 204
    resp = await client.post("/api/auth/refresh",
                             json={"refresh_token": tokens["refresh_token"]})
    assert resp.status_code == 401


async def test_login_is_rate_limited(client):
    for _ in range(5):
        resp = await client.post("/api/auth/login",
                                 json={"email": ADMIN_EMAIL, "password": "wrong"})
        assert resp.status_code == 401
    blocked = await client.post("/api/auth/login",
                                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) >= 1


async def test_change_password(client, auth):
    bad = await client.post("/api/me/password", headers=auth,
                            json={"current_password": "wrong", "new_password": "new password 123"})
    assert bad.status_code == 400

    ok = await client.post(
        "/api/me/password", headers=auth,
        json={"current_password": ADMIN_PASSWORD, "new_password": "new password 123"},
    )
    assert ok.status_code == 204
    old = await client.post("/api/auth/login",
                            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert old.status_code == 401
    new = await client.post("/api/auth/login",
                            json={"email": ADMIN_EMAIL, "password": "new password 123"})
    assert new.status_code == 200
