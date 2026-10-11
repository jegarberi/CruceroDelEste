from contextlib import asynccontextmanager

from fastapi import FastAPI
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.middleware.cors import CORSMiddleware

from app.config import settings
from app.csrf import CSRFMiddleware, make_csrf_router
from app.errors import register_exception_handlers
from app.limiter import limiter
from app.routers import admin, admin_catalog, bookings, dev, payments, trips
from app.routers.trips import stops_router
from tasks.reminders import register_jobs, scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.start()
    register_jobs()
    yield
    scheduler.shutdown()


app = FastAPI(title="Expreso Río Paraná API", lifespan=lifespan)

# Added before CORS so CORS ends up outermost: a 403 from the CSRF check still
# carries CORS headers and the browser can read why it failed.
app.add_middleware(
    CSRFMiddleware,
    secure=settings.cookie_secure,
    # MercadoPago calls these server-to-server; they are authenticated by the
    # x-signature HMAC, not by cookies.
    exempt_prefixes=("/webhooks/",),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

register_exception_handlers(app)

app.include_router(make_csrf_router(secure=settings.cookie_secure))
app.include_router(payments.router)
app.include_router(bookings.router)
app.include_router(trips.router)
app.include_router(stops_router)
app.include_router(admin_catalog.router)
app.include_router(admin.router)
if settings.environment != "production":
    app.include_router(dev.router)
