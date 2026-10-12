"""CSRF middleware + token endpoint, on a throwaway app (no DB, no settings)."""

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from app.csrf import CSRFMiddleware, csrf_cookie_name, make_csrf_router


def _app(secure: bool) -> FastAPI:
    app = FastAPI()
    app.add_middleware(CSRFMiddleware, secure=secure, exempt_prefixes=("/webhooks/",))
    app.include_router(make_csrf_router(secure=secure))

    @app.get("/thing")
    @app.post("/thing")
    @app.patch("/thing")
    @app.put("/thing")
    @app.delete("/thing")
    async def thing() -> dict:
        return {"ok": True}

    @app.post("/webhooks/mercadopago")
    async def webhook() -> dict:
        return {"ok": True}

    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app(secure=False))


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
def test_unsafe_methods_without_token_are_rejected(client: TestClient, method: str):
    resp = getattr(client, method)("/thing")

    assert resp.status_code == 403
    assert resp.json() == {"detail": "csrf_failed"}


def test_safe_method_needs_no_token(client: TestClient):
    assert client.get("/thing").status_code == 200


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
def test_unsafe_methods_with_issued_token_pass(client: TestClient, method: str):
    token = client.get("/csrf-token").json()["csrf_token"]

    resp = getattr(client, method)("/thing", headers={"X-CSRF-Token": token})

    assert resp.status_code == 200


def test_cookie_alone_is_not_enough(client: TestClient):
    # What a forged cross-site request looks like: the browser attaches the
    # cookie, but the attacker cannot produce the header.
    client.get("/csrf-token")

    assert client.post("/thing").status_code == 403


def test_header_must_match_cookie(client: TestClient):
    client.get("/csrf-token")

    assert client.post("/thing", headers={"X-CSRF-Token": "guess"}).status_code == 403


def test_header_alone_is_not_enough(client: TestClient):
    assert client.post("/thing", headers={"X-CSRF-Token": "anything"}).status_code == 403


def test_webhooks_are_exempt(client: TestClient):
    assert client.post("/webhooks/mercadopago").status_code == 200


def test_token_is_stable_across_calls(client: TestClient):
    first = client.get("/csrf-token").json()["csrf_token"]
    second = client.get("/csrf-token").json()["csrf_token"]

    assert first == second and len(first) >= 32


def test_cookie_attributes_plain_http(client: TestClient):
    set_cookie = client.get("/csrf-token").headers["set-cookie"]

    assert set_cookie.startswith("csrf=")
    assert "HttpOnly" in set_cookie
    assert "SameSite=strict" in set_cookie
    assert "Path=/" in set_cookie
    assert "Domain" not in set_cookie  # host-only
    assert "Secure" not in set_cookie


def test_cookie_attributes_https():
    client = TestClient(_app(secure=True), base_url="https://api.example.com")

    resp = client.get("/csrf-token")
    set_cookie = resp.headers["set-cookie"]

    assert csrf_cookie_name(True) == "__Host-csrf"
    assert set_cookie.startswith("__Host-csrf=")
    assert "Secure" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=strict" in set_cookie
    assert "Domain" not in set_cookie
    assert client.post("/thing", headers={"X-CSRF-Token": resp.json()["csrf_token"]}).status_code == 200
