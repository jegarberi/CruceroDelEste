"""Developer tooling. Only mounted when ENVIRONMENT != "production" (see main.py)."""

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.errors import PaymentProcessingError
from app.limiter import limiter
from app.services.payment import create_test_preference

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dev", tags=["dev"])


class TestPaymentCreate(BaseModel):
    amount: int = Field(gt=0, le=10_000_000)  # ARS, integer pesos
    title: str = Field(default="Pago de prueba", min_length=1, max_length=120)


class TestPaymentResponse(BaseModel):
    redirect_url: str
    sandbox_redirect_url: str | None


@router.post("/payments", response_model=TestPaymentResponse, status_code=201)
@limiter.limit("10/minute")
async def create_test_payment(request: Request, payment_in: TestPaymentCreate) -> TestPaymentResponse:
    """Create a MercadoPago checkout for an arbitrary amount, with no booking."""
    try:
        preference = await create_test_preference(payment_in.amount, payment_in.title)
    except PaymentProcessingError as exc:
        logger.error("create_test_preference_failed status_code=%s", exc.status_code)
        raise HTTPException(status_code=502, detail="payment_gateway_error") from exc

    return TestPaymentResponse(
        redirect_url=preference.init_point,
        sandbox_redirect_url=preference.sandbox_init_point,
    )
