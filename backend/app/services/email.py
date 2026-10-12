"""Email service with three transactional templates.

Templates live in /backend/templates/email/ and are rendered with Jinja2
(HTML body + plain-text fallback). Every send is per-passenger: each function
iterates `booking.passengers` and sends one email per recipient.

Transport: an SMTP server when SMTP_HOST is configured, otherwise Resend (see
`_send_sync`). Both are synchronous, so each send is wrapped with
`asyncio.to_thread` (same pattern as `app/services/payment.py`) to keep the
FastAPI event loop free.

Error semantics — matches the approved design:
  - send_confirmation_email : raises EmailDeliveryError on the first failed
    send (logger.error). Called inline from the MercadoPago webhook handler,
    which catches the exception and only logs it at WARNING — the webhook
    still returns 200 OK, so MercadoPago does NOT retry. Passengers whose
    send failed keep `confirmation_sent = False` and are retried hourly by
    `retry_confirmation_emails_job` (tasks/reminders.py) for 48 hours.
  - send_reminder_email     : per-passenger failure is logged at WARNING and
    swallowed (never re-raised). Caller MUST NOT mark booking.reminder_sent
    when any passenger send was logged as failed.
  - send_feedback_email     : same swallow semantics as reminder.

NOTE on reminder/feedback success signalling: the function signature is
`-> None`, so the caller cannot distinguish all-passengers-succeeded from
some-failed by return value alone. This is a known limitation to be
resolved when `tasks/reminders.py` is implemented.
"""

import asyncio
import logging
import smtplib
from datetime import timedelta, timezone
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

import resend
from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from app.config import settings
from app.models.booking import Booking, BookingStatusEnum, Passenger

logger = logging.getLogger(__name__)

_TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "templates" / "email"

_env = Environment(
    loader=FileSystemLoader(_TEMPLATES_DIR),
    autoescape=select_autoescape(["html"]),
    undefined=StrictUndefined,
)

resend.api_key = settings.resend_api_key


def _render(template_name: str, context: dict) -> str:
    return _env.get_template(template_name).render(**context)


_SMTP_TIMEOUT_SECONDS = 15
# Argentina time. Fixed offset: no daylight saving since 2009.
_ART = timezone(timedelta(hours=-3))


def _send_smtp(*, to: str, subject: str, html: str, text: str) -> str:
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message["Message-ID"] = make_msgid(domain=settings.email_from.rpartition("@")[2] or None)
    message.set_content(text)
    message.add_alternative(html, subtype="html")

    smtp_class = smtplib.SMTP_SSL if settings.smtp_security == "ssl" else smtplib.SMTP
    with smtp_class(settings.smtp_host, settings.smtp_port, timeout=_SMTP_TIMEOUT_SECONDS) as server:
        if settings.smtp_security == "starttls":
            server.starttls()
        if settings.smtp_username:
            server.login(settings.smtp_username, settings.smtp_password)
        server.send_message(message)
    return message["Message-ID"]


def _send_sync(*, to: str, subject: str, html: str, text: str) -> str:
    """Synchronous send; returns the provider's message id. Wrapped by callers in asyncio.to_thread."""
    if settings.smtp_host:
        return _send_smtp(to=to, subject=subject, html=html, text=text)

    params = {
        "from": settings.email_from,
        "to": [to],
        "subject": subject,
        "html": html,
        "text": text,
    }
    result = resend.Emails.send(params)
    return result["id"]


def _context_for(booking: Booking, passenger: Passenger) -> dict:
    trip = booking.trip
    seat = passenger.seat
    return {
        "first_name": passenger.first_name,
        "booking_code": booking.booking_code,
        "seat_number": seat.seat_number,
        "seat_type": seat.seat_type.value,
        "origin": trip.route.origin_stop.name,
        "destination": trip.route.destination_stop.name,
        # Stored in UTC; the templates print it as-is, so hand them local time.
        "departure_at": trip.departure_at.astimezone(_ART),
        "total_amount": booking.total_amount,
        "frontend_url": settings.frontend_url,
    }


class EmailDeliveryError(Exception):
    """Raised when one or more confirmation emails could not be delivered."""

    def __init__(self, failed_emails: list[str]):
        self.failed_emails = failed_emails
        super().__init__(
            f"Failed to deliver confirmation to: {', '.join(failed_emails)}"
        )


async def send_confirmation_email(booking: Booking) -> None:
    """Send the purchase-confirmation email to every passenger of the booking.

    Passengers already marked `confirmation_sent` are skipped, and the flag is
    set on each successful send; the caller must commit to persist it (also
    when this raises: the passengers that did succeed are already flagged).

    Each passenger gets up to 3 attempts (1 original + 2 immediate retries, no
    sleep between attempts). All passengers are processed even if some fail;
    a per-passenger ERROR is logged after exhausting attempts and the address
    is collected into a `failed` list. If `failed` is non-empty at the end of
    the loop, an EmailDeliveryError is raised carrying every failed email.

    Caller contract: booking.passengers, booking.trip, booking.trip.route, and
    passenger.seat MUST be eagerly loaded (e.g. via `selectinload`) before
    invoking this function. Async SQLAlchemy raises MissingGreenlet on lazy
    attribute access outside the original session context.
    """
    if booking.status != BookingStatusEnum.confirmed:
        logger.warning(
            "send_confirmation_email_skipped_non_confirmed "
            "booking_id=%s status=%s",
            booking.id,
            booking.status.value,
        )
        return
    failed: list[str] = []
    for passenger in booking.passengers:
        if passenger.confirmation_sent:
            continue
        ctx = _context_for(booking, passenger)
        subject = f"Confirmación de compra — Expreso Río Paraná #{ctx['booking_code']}"
        html = _render("confirmation.html", ctx)
        text = _render("confirmation.txt", ctx)

        resend_id: str | None = None
        last_exc: Exception | None = None
        for _ in range(3):
            try:
                resend_id = await asyncio.to_thread(
                    _send_sync, to=passenger.email, subject=subject, html=html, text=text,
                )
                break
            except Exception as exc:
                last_exc = exc

        if resend_id is None:
            logger.error(
                "confirmation_email_failed booking_id=%s passenger_email=%s",
                booking.id, passenger.email, exc_info=last_exc,
            )
            failed.append(passenger.email)
        else:
            passenger.confirmation_sent = True
            logger.info(
                "confirmation_email_sent booking_id=%s passenger_email=%s resend_id=%s",
                booking.id, passenger.email, resend_id,
            )

    if failed:
        raise EmailDeliveryError(failed)


async def send_reminder_email(booking: Booking) -> bool:
    """Send the pre-trip reminder email to every passenger.

    Per-passenger failures are logged at WARNING and swallowed.
    Returns True if all passengers were notified successfully, False otherwise.
    """
    had_failure = False
    for passenger in booking.passengers:
        ctx = _context_for(booking, passenger)
        subject = "Recordatorio de viaje — Expreso Río Paraná"
        try:
            html = _render("reminder.html", ctx)
            text = _render("reminder.txt", ctx)
            resend_id = await asyncio.to_thread(
                _send_sync, to=passenger.email, subject=subject, html=html, text=text,
            )
        except Exception:
            logger.warning(
                "reminder_email_failed booking_id=%s passenger_email=%s",
                booking.id, passenger.email, exc_info=True,
            )
            had_failure = True
            continue
        logger.info(
            "reminder_email_sent booking_id=%s passenger_email=%s resend_id=%s",
            booking.id, passenger.email, resend_id,
        )
    return not had_failure


async def send_feedback_email(booking: Booking) -> bool:
    """Send the post-trip feedback email to every passenger.

    Same swallow-and-log semantics as send_reminder_email.
    Returns True if all passengers were notified successfully, False otherwise.
    """
    had_failure = False
    for passenger in booking.passengers:
        ctx = _context_for(booking, passenger)
        subject = "¿Cómo fue tu viaje? — Expreso Río Paraná"
        try:
            html = _render("feedback.html", ctx)
            text = _render("feedback.txt", ctx)
            resend_id = await asyncio.to_thread(
                _send_sync, to=passenger.email, subject=subject, html=html, text=text,
            )
        except Exception:
            logger.warning(
                "feedback_email_failed booking_id=%s passenger_email=%s",
                booking.id, passenger.email, exc_info=True,
            )
            had_failure = True
            continue
        logger.info(
            "feedback_email_sent booking_id=%s passenger_email=%s resend_id=%s",
            booking.id, passenger.email, resend_id,
        )
    return not had_failure
