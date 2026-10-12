"""The integration tests replace the MercadoPago SDK with a MagicMock, which
answers to any attribute. These tests run against the real SDK classes, so a
call to a method that does not exist fails here instead of in production
(create_refund used to call `sdk.payment().refunds`, which never existed).
"""

from unittest.mock import patch

import mercadopago
from mercadopago.resources.refund import Refund

from app.services import payment


def test_sdk_exposes_every_method_the_service_calls():
    sdk = mercadopago.SDK("TEST-fake-access-token")
    assert callable(sdk.preference().create)
    assert callable(sdk.payment().get)
    assert callable(sdk.refund().create)


async def test_create_refund_asks_the_real_sdk_for_a_full_refund():
    real_sdk = mercadopago.SDK("TEST-fake-access-token")
    with (
        patch.object(payment, "_sdk", real_sdk),
        patch.object(Refund, "create", autospec=True, return_value={"status": 201, "response": {}}) as create,
    ):
        await payment.create_refund("123456")

    _, payment_id, refund_object, request_options = create.call_args.args
    assert payment_id == "123456"
    assert refund_object is None  # full refund
    assert request_options.custom_headers["X-Idempotency-Key"]
