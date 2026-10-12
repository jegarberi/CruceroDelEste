"""Unit tests for app/services/email.py — payload construction and error semantics."""

import datetime
import uuid
from unittest.mock import MagicMock, patch

import pytest

from app.models.booking import BookingStatusEnum
from app.services.email import (
    EmailDeliveryError,
    send_confirmation_email,
    send_feedback_email,
    send_reminder_email,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_booking(*, status: BookingStatusEnum = BookingStatusEnum.confirmed) -> tuple:
    """Return (booking_mock, passenger_mock) with all attributes _context_for needs."""
    now = datetime.datetime.now(datetime.UTC)

    seat = MagicMock()
    seat.seat_number = "1A"
    seat.seat_type.value = "cama"

    passenger = MagicMock()
    passenger.first_name = "Ana"
    passenger.last_name = "García"
    passenger.email = "ana@example.com"
    passenger.seat = seat
    passenger.confirmation_sent = False

    origin_stop = MagicMock()
    origin_stop.name = "Retiro"
    destination_stop = MagicMock()
    destination_stop.name = "Asunción"

    route = MagicMock()
    route.origin_stop = origin_stop
    route.destination_stop = destination_stop

    trip = MagicMock()
    trip.route = route
    trip.departure_at = now + datetime.timedelta(hours=72)
    trip.arrival_at = now + datetime.timedelta(hours=89)

    booking = MagicMock()
    booking.id = uuid.uuid4()
    booking.booking_code = "ERP-7K3M-9QX2"
    booking.status = status
    booking.passengers = [passenger]
    booking.trip = trip
    booking.total_amount = 24500

    return booking, passenger


# ---------------------------------------------------------------------------
# send_confirmation_email
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_confirmation_payload():
    booking, passenger = _make_booking()

    with patch("resend.Emails.send", return_value={"id": "test-id"}) as mock_send:
        await send_confirmation_email(booking)

    mock_send.assert_called_once()
    payload = mock_send.call_args[0][0]

    assert payload["from"] == "no-reply@expresorioparana.com"
    assert payload["to"] == [passenger.email]
    assert booking.booking_code in payload["subject"]
    assert isinstance(payload["html"], str) and payload["html"]
    assert isinstance(payload["text"], str) and payload["text"]

    # LLE-332: total_amount (24500, in pesos) must render as-is, not divided
    # by 100. No thousands separator — that's the template's actual output.
    assert "$ 24500.00 ARS" in payload["html"]
    assert "$ 24500.00 ARS" in payload["text"]


@pytest.mark.asyncio
async def test_send_confirmation_skips_non_confirmed_booking():
    booking, _ = _make_booking(status=BookingStatusEnum.pending_payment)

    with patch("resend.Emails.send", return_value={"id": "test-id"}) as mock_send:
        await send_confirmation_email(booking)

    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_confirmation_raises_email_delivery_error_on_failure():
    booking, passenger = _make_booking()

    with patch("resend.Emails.send", side_effect=Exception("resend down")):
        with pytest.raises(EmailDeliveryError) as exc_info:
            await send_confirmation_email(booking)

    assert passenger.email in exc_info.value.failed_emails


# ---------------------------------------------------------------------------
# send_reminder_email
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_reminder_payload():
    booking, passenger = _make_booking()

    with patch("resend.Emails.send", return_value={"id": "test-id"}) as mock_send:
        result = await send_reminder_email(booking)

    mock_send.assert_called_once()
    payload = mock_send.call_args[0][0]

    assert payload["subject"] == "Recordatorio de viaje — Expreso Río Paraná"
    assert payload["to"] == [passenger.email]
    assert isinstance(payload["html"], str) and payload["html"]
    assert isinstance(payload["text"], str) and payload["text"]
    assert result is True


@pytest.mark.asyncio
async def test_send_reminder_returns_false_on_failure():
    booking, _ = _make_booking()

    with patch("resend.Emails.send", side_effect=Exception("resend down")):
        result = await send_reminder_email(booking)

    assert result is False


# ---------------------------------------------------------------------------
# send_feedback_email
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_send_feedback_payload():
    booking, passenger = _make_booking()

    with patch("resend.Emails.send", return_value={"id": "test-id"}) as mock_send:
        result = await send_feedback_email(booking)

    mock_send.assert_called_once()
    payload = mock_send.call_args[0][0]

    assert payload["subject"] == "¿Cómo fue tu viaje? — Expreso Río Paraná"
    assert payload["to"] == [passenger.email]
    assert isinstance(payload["html"], str) and payload["html"]
    assert isinstance(payload["text"], str) and payload["text"]
    assert result is True


@pytest.mark.asyncio
async def test_send_feedback_returns_false_on_failure():
    booking, _ = _make_booking()

    with patch("resend.Emails.send", side_effect=Exception("resend down")):
        result = await send_feedback_email(booking)

    assert result is False


# ---------------------------------------------------------------------------
# SMTP transport
# ---------------------------------------------------------------------------

async def test_send_confirmation_goes_through_smtp_when_host_is_configured():
    booking, passenger = _make_booking()
    smtp = MagicMock()
    with (
        patch("app.services.email.settings.smtp_host", "mail.example.com"),
        patch("app.services.email.settings.smtp_username", "mailer"),
        patch("app.services.email.settings.smtp_password", "secret"),
        patch("app.services.email.smtplib.SMTP", return_value=smtp) as smtp_class,
        patch("resend.Emails.send") as resend_send,
    ):
        await send_confirmation_email(booking)

    server = smtp.__enter__.return_value
    smtp_class.assert_called_once_with("mail.example.com", 587, timeout=15)
    server.starttls.assert_called_once()
    server.login.assert_called_once_with("mailer", "secret")
    message = server.send_message.call_args.args[0]
    assert message["To"] == passenger.email
    assert message["From"] == "no-reply@expresorioparana.com"
    assert "ERP-7K3M-9QX2" in message["Subject"]
    # Plain text and HTML, both carrying the booking code.
    assert [part.get_content_type() for part in message.iter_parts()] == ["text/plain", "text/html"]
    assert all("ERP-7K3M-9QX2" in part.get_content() for part in message.iter_parts())
    resend_send.assert_not_called()


async def test_smtp_failure_raises_email_delivery_error_after_retries():
    booking, passenger = _make_booking()
    with (
        patch("app.services.email.settings.smtp_host", "mail.example.com"),
        patch("app.services.email.smtplib.SMTP", side_effect=OSError("connection refused")) as smtp_class,
    ):
        with pytest.raises(EmailDeliveryError) as exc_info:
            await send_confirmation_email(booking)

    assert exc_info.value.failed_emails == [passenger.email]
    assert smtp_class.call_count == 3


# ---------------------------------------------------------------------------
# confirmation_sent flag
# ---------------------------------------------------------------------------

async def test_send_confirmation_marks_passenger_only_when_sent():
    booking, passenger = _make_booking()
    with patch("resend.Emails.send", side_effect=RuntimeError("boom")):
        with pytest.raises(EmailDeliveryError):
            await send_confirmation_email(booking)
    assert passenger.confirmation_sent is False

    with patch("resend.Emails.send", return_value={"id": "ok"}):
        await send_confirmation_email(booking)
    assert passenger.confirmation_sent is True


async def test_send_confirmation_skips_passengers_already_sent():
    booking, passenger = _make_booking()
    passenger.confirmation_sent = True
    with patch("resend.Emails.send") as send:
        await send_confirmation_email(booking)
    send.assert_not_called()


async def test_emails_show_departure_in_argentina_time_not_utc():
    booking, _ = _make_booking()
    # 00:30 UTC del 2 de noviembre = 21:30 del 1 de noviembre en Buenos Aires.
    booking.trip.departure_at = datetime.datetime(2026, 11, 2, 0, 30, tzinfo=datetime.UTC)
    with patch("resend.Emails.send", return_value={"id": "ok"}) as send:
        await send_confirmation_email(booking)

    for body in (send.call_args.args[0]["html"], send.call_args.args[0]["text"]):
        assert "21:30" in body and "01/11/2026" in body
        assert "00:30" not in body and "02/11/2026" not in body
