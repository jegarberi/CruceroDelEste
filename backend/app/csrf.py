"""CSRF protection (double-submit cookie).

GET /csrf-token hands the browser a random token twice: in the JSON body and in
an HttpOnly cookie. Every state-changing request must echo the token in the
X-CSRF-Token header, and the middleware checks it against the cookie.

Why this stops CSRF: a foreign site can make the browser send the cookie, but it
cannot read the token (CORS only lets the configured origins read the response)
and so cannot set the header.

Cookie attributes: HttpOnly, SameSite=Strict, Path=/, and no Domain attribute,
which makes it host-only (sent to this API host and nothing else). Over https it
is also Secure and uses the `__Host-` name prefix, which browsers only accept
for Secure, host-only cookies, so a sibling subdomain cannot plant its own.

This module takes `secure` as an argument instead of importing settings so it
can be tested without the app's environment.
"""

import hmac
import secrets

from fastapi import APIRouter, Request, Response
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

CSRF_HEADER = "x-csrf-token"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_MAX_TOKEN_LEN = 128


def csrf_cookie_name(secure: bool) -> str:
    return "__Host-csrf" if secure else "csrf"


class CSRFMiddleware:
    """Reject unsafe requests whose X-CSRF-Token header does not match the cookie.

    `exempt_prefixes` is for server-to-server endpoints that authenticate some
    other way and never carry browser cookies (the signed MercadoPago webhooks).
    """

    def __init__(self, app: ASGIApp, *, secure: bool, exempt_prefixes: tuple[str, ...] = ()) -> None:
        self.app = app
        self.cookie_name = csrf_cookie_name(secure)
        self.exempt_prefixes = exempt_prefixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] in _SAFE_METHODS
            or scope["path"].startswith(self.exempt_prefixes)
        ):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        cookie = request.cookies.get(self.cookie_name, "")
        header = request.headers.get(CSRF_HEADER, "")
        if not cookie or not hmac.compare_digest(cookie.encode(), header.encode()):
            response = JSONResponse({"detail": "csrf_failed"}, status_code=403)
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


def make_csrf_router(*, secure: bool) -> APIRouter:
    router = APIRouter(tags=["csrf"])
    cookie_name = csrf_cookie_name(secure)

    @router.get("/csrf-token")
    async def issue_csrf_token(request: Request, response: Response) -> dict:
        # Reuse the browser's current token so a second tab does not invalidate
        # the one the first tab is holding.
        token = request.cookies.get(cookie_name, "")
        if not token or len(token) > _MAX_TOKEN_LEN:
            token = secrets.token_urlsafe(32)
        response.set_cookie(
            key=cookie_name,
            value=token,
            httponly=True,
            secure=secure,
            samesite="strict",
            path="/",
        )
        response.headers["Cache-Control"] = "no-store"
        return {"csrf_token": token}

    return router
