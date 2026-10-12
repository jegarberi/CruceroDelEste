import logging
import hmac as hmac_lib
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.deps import get_db, trip_load_options
from app.limiter import limiter
from app.errors import NotFoundError, PaymentProcessingError, RefundWindowExpiredError, SeatAlreadyReleasedError
from app.models.booking import Booking, BookingStatusEnum, Passenger
from app.models.trip import Route, Trip, TripStatusEnum
from app.schemas.bookings import (
    BookingCreate,
    BookingCreateResponse,
    BookingRead,
    PassengerRead,
    PaymentCreate,
    PaymentCreateResponse,
    RefundRequestCreate,
    RefundRequestRead,
)
from app.services.booking import (
    BookingNotFound,
    InternationalRouteRequiredError,
    PassengerData,
    confirm_booking,
    create_booking,
    create_refund_request,
    expire_booking,
    mark_booking_refunded,
)
from app.services.email import send_confirmation_email
from app.services.payment import (
    PreferenceItem,
    create_preference,
    get_payment,
    create_refund,
    generate_confirmation_token,
    _CONFIRMATION_TOKEN_WINDOW_MINUTES,
)
from app.services.pricing import NoPriceTranche, NoPriceTranchesConfigured

_REFUND_WINDOW_DAYS = 10

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bookings", tags=["bookings"])



@router.post("", response_model=BookingCreateResponse, status_code=201)
@limiter.limit("10/minute")
async def create_booking_endpoint(
    request: Request,
    booking_in: BookingCreate,
    db: AsyncSession = Depends(get_db),
) -> BookingCreateResponse:
    result = await db.execute(
        select(Trip)
        .options(trip_load_options())
        .where(Trip.id == booking_in.trip_id)
    )
    trip = result.scalar_one_or_none()
    if trip is None:
        raise NotFoundError()

    if (
        trip.status != TripStatusEnum.scheduled
        or trip.departure_at < datetime.now(timezone.utc)
    ):
        raise HTTPException(status_code=409, detail="trip_not_available")

    passengers_data = [
        PassengerData(
            seat_id=p.seat_id,
            first_name=p.first_name,
            last_name=p.last_name,
            dni=p.dni,
            email=p.email,
            phone=p.phone,
            luggage_count=p.luggage_count,
        )
        for p in booking_in.passengers
    ]

    try:
        booking, _ = await create_booking(
            db,
            booking_in.trip_id,
            booking_in.seat_ids,
            passengers_data,
            trip.route.origin_stop.country,
            trip.route.destination_stop.country,
            contact_email=booking_in.contact_email,
        )
    except InternationalRouteRequiredError:
        raise HTTPException(status_code=422, detail="international_route_required")
    except NoPriceTranchesConfigured:
        logger.error(
            "no_price_tranches_configured_on_booking trip_id=%s seat_ids=%s",
            booking_in.trip_id,
            booking_in.seat_ids,
        )
        raise
    except NoPriceTranche:
        logger.error(
            "no_price_tranche_on_booking trip_id=%s seat_ids=%s",
            booking_in.trip_id,
            booking_in.seat_ids,
        )
        raise

    await db.commit()

    await db.refresh(booking, attribute_names=["passengers"])

    return BookingCreateResponse(
        id=booking.id,
        booking_code=booking.booking_code,
        trip_id=booking.trip_id,
        status=booking.status,
        contact_email=booking.contact_email,
        total_amount=booking.total_amount,
        expires_at=booking.expires_at,
        passengers=[PassengerRead.model_validate(p) for p in booking.passengers],
        confirmation_token=generate_confirmation_token(booking.id),
    )


@router.post("/{booking_id}/payments", response_model=PaymentCreateResponse, status_code=201)
@limiter.limit("10/minute")
async def create_booking_payment(
    request: Request,
    booking_id: UUID,
    payment_in: PaymentCreate,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> PaymentCreateResponse:
    """Start a payment for a pending booking with the chosen method.

    `method` is validated by the schema; a new method is a new Literal value
    plus a branch here.
    """
    _FORBIDDEN = HTTPException(status_code=403, detail="Forbidden")

    expected = generate_confirmation_token(booking_id)
    if not hmac_lib.compare_digest(expected, token):
        raise _FORBIDDEN

    result = await db.execute(select(Booking).where(Booking.id == booking_id))
    booking = result.scalar_one_or_none()
    if booking is None:
        raise _FORBIDDEN

    if (
        booking.status != BookingStatusEnum.pending_payment
        or booking.expires_at <= datetime.now(timezone.utc)
    ):
        raise HTTPException(status_code=409, detail="booking_not_payable")

    # One line item for the stored total: prices move with sales, so the amount
    # charged must be what the booking recorded, not a recalculation.
    items = [
        PreferenceItem(
            title=f"Pasajes Expreso Río Paraná — reserva {booking.booking_code}",
            quantity=1,
            unit_price=booking.total_amount,
        )
    ]

    try:
        preference = await create_preference(booking.id, items, booking.contact_email)
    except PaymentProcessingError as exc:
        # The booking stays pending so the buyer can retry until it expires.
        logger.error(
            "create_preference_failed booking_id=%s status_code=%s",
            booking.id,
            exc.status_code,
        )
        raise HTTPException(status_code=502, detail="payment_gateway_error") from exc

    booking.mp_preference_id = preference.preference_id
    await db.commit()

    return PaymentCreateResponse(method=payment_in.method, redirect_url=preference.init_point)


_BOOKING_CODE_RE = re.compile(r"^ERP-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$")


@router.post("/{booking_code}/refund-request", response_model=RefundRequestRead, status_code=201)
@limiter.limit("5/minute")
async def create_refund_request_endpoint(
    request: Request,
    booking_code: str,
    body: RefundRequestCreate,
    db: AsyncSession = Depends(get_db),
) -> RefundRequestRead:
    # Normalize before validating/looking up — this endpoint is public and
    # not every caller goes through the frontend's own trim/uppercase.
    booking_code = booking_code.strip().upper()

    if not _BOOKING_CODE_RE.match(booking_code):
        # Same 403/"forbidden" as not-found/not-confirmed below — a distinct
        # response for "malformed" would leak which codes are well-formed
        # vs. which exist, breaking the anti-enumeration property.
        raise HTTPException(status_code=403, detail="forbidden")

    result = await db.execute(
        select(Booking)
        .options(selectinload(Booking.passengers), selectinload(Booking.trip))
        .where(Booking.booking_code == booking_code)
    )
    booking = result.scalar_one_or_none()
    if booking is None or booking.status != BookingStatusEnum.confirmed:
        raise HTTPException(
            status_code=403,
            detail="forbidden",
        )

    # Accept the booking's contact_email (buyer) in addition to any passenger email.
    # The buyer may not be a passenger themselves but must be able to request a refund.
    valid_emails = {p.email.lower() for p in booking.passengers} | {booking.contact_email.lower()}
    if body.email.lower() not in valid_emails:
        raise HTTPException(status_code=422, detail="email_not_found")

    now = datetime.now(timezone.utc)
    # Resolución 424/2020: window is valid only when BOTH conditions hold:
    #   1. within 10 calendar days of purchase (confirmed_at)
    #   2. more than 24 hours before departure
    window_valid = (
        booking.confirmed_at is not None
        and now <= booking.confirmed_at + timedelta(days=_REFUND_WINDOW_DAYS)
        and now <= booking.trip.departure_at - timedelta(hours=24)
    )

    # Always persist — even when window_valid=False — so every request has a tracking id.
    refund_req = await create_refund_request(db, booking.id, body.email, window_valid)
    await db.commit()

    if not window_valid:
        raise RefundWindowExpiredError(refund_req.id)

    if not booking.mp_payment_id:
        logger.error("refund_no_mp_payment_id booking_id=%s", booking.id)
        raise HTTPException(status_code=500, detail="internal_server_error")

    try:
        await create_refund(booking.mp_payment_id)
    except PaymentProcessingError as exc:
        logger.error(
            "create_refund_failed booking_id=%s mp_payment_id=%s status_code=%s",
            booking.id,
            booking.mp_payment_id,
            exc.status_code,
        )
        # 424, not 502: the reverse proxy replaces a 502 with its own error page
        # (no CORS headers), so the browser could not read why the refund failed.
        raise HTTPException(status_code=424, detail="payment_gateway_error") from exc

    await mark_booking_refunded(db, booking.id)
    await db.commit()

    return RefundRequestRead.model_validate(refund_req)


@router.get("/{booking_id}", response_model=BookingRead)
@limiter.limit("10/minute")
async def get_booking(
    request: Request,
    booking_id: UUID,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> BookingRead:
    _FORBIDDEN = HTTPException(status_code=403, detail="Forbidden")

    expected = generate_confirmation_token(booking_id)
    if not hmac_lib.compare_digest(expected, token):
        raise _FORBIDDEN

    return await _read_booking(db, booking_id)


async def _read_booking(db: AsyncSession, booking_id: UUID) -> BookingRead:
    """Load a booking for its buyer. The caller has already checked the token."""
    _FORBIDDEN = HTTPException(status_code=403, detail="Forbidden")

    result = await db.execute(
        select(Booking)
        .options(
            selectinload(Booking.trip)
            .selectinload(Trip.route)
            .options(
                selectinload(Route.origin_stop),
                selectinload(Route.destination_stop),
            ),
            selectinload(Booking.passengers),
        )
        .where(Booking.id == booking_id)
        # This session may already hold the row from before a confirmation.
        .execution_options(populate_existing=True)
    )
    booking = result.scalar_one_or_none()
    if booking is None:
        raise _FORBIDDEN

    if booking.confirmed_at is not None:
        window = timedelta(minutes=_CONFIRMATION_TOKEN_WINDOW_MINUTES)
        if datetime.now(timezone.utc) - booking.confirmed_at >= window:
            raise _FORBIDDEN

    return BookingRead.model_validate(booking)


@router.post("/{booking_id}/payments/{payment_id}/verify", response_model=BookingRead)
@limiter.limit("10/minute")
async def verify_booking_payment(
    request: Request,
    booking_id: UUID,
    payment_id: str = Path(pattern=r"^\d{1,20}$"),
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> BookingRead:
    """Confirm a booking by asking MercadoPago about the payment the buyer came back with.

    Same outcome as the payment webhook, without waiting for it: the buyer
    returns from checkout with a payment id, and we check it ourselves using
    the access token. The id comes from the browser, so nothing about it is
    trusted; only what MercadoPago reports for it (approved, and created for
    this very booking) confirms anything. Always returns the booking as it is
    after the check.
    """
    expected = generate_confirmation_token(booking_id)
    if not hmac_lib.compare_digest(expected, token):
        raise HTTPException(status_code=403, detail="Forbidden")

    result = await db.execute(select(Booking).where(Booking.id == booking_id))
    booking = result.scalar_one_or_none()
    if booking is None:
        raise HTTPException(status_code=403, detail="Forbidden")

    if booking.status == BookingStatusEnum.pending_payment:
        # Ask MercadoPago before taking any lock: this is a network call.
        try:
            payment = await get_payment(payment_id)
        except PaymentProcessingError as exc:
            logger.error(
                "verify_get_payment_failed booking_id=%s payment_id=%s status_code=%s",
                booking_id, payment_id, exc.status_code,
            )
            raise HTTPException(status_code=502, detail="payment_gateway_error") from exc

        if payment.status == "approved" and payment.external_reference == str(booking_id):
            await _confirm_once(db, booking_id, payment.payment_id)
        else:
            logger.warning(
                "verify_payment_not_applicable booking_id=%s payment_id=%s status=%s reference_matches=%s",
                booking_id, payment_id, payment.status, payment.external_reference == str(booking_id),
            )

    return await _read_booking(db, booking_id)


@router.post("/{booking_id}/release", response_model=BookingRead)
@limiter.limit("10/minute")
async def release_booking(
    request: Request,
    booking_id: UUID,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> BookingRead:
    """Let the buyer give up an unpaid booking so its seats go back on sale now.

    Same effect as the booking timing out (expire_booking): a no-op unless it is
    still pending payment. Always returns the booking as it is afterwards.
    """
    expected = generate_confirmation_token(booking_id)
    if not hmac_lib.compare_digest(expected, token):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        await expire_booking(db, booking_id)
    except BookingNotFound:
        raise HTTPException(status_code=403, detail="Forbidden")
    await db.commit()

    return await _read_booking(db, booking_id)


async def _confirm_once(db: AsyncSession, booking_id: UUID, mp_payment_id: str) -> None:
    """Confirm the booking and email the passengers, unless someone already did.

    The webhook locks the same row with FOR UPDATE, so whichever of the two
    gets there first confirms and sends the email; the other finds it confirmed.
    """
    result = await db.execute(
        select(Booking)
        .where(Booking.id == booking_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if result.scalar_one().status != BookingStatusEnum.pending_payment:
        return

    try:
        await confirm_booking(db, booking_id, mp_payment_id)
        await db.commit()
    except SeatAlreadyReleasedError as exc:
        # Paid after the booking expired and the seats went back on sale; same
        # handling as the webhook: log it for manual follow-up.
        logger.error(
            "verify_seat_already_released booking_id=%s payment_id=%s seat_id=%s",
            booking_id, mp_payment_id, exc.seat_id,
        )
        return

    await _send_confirmation_email(db, booking_id)


async def _send_confirmation_email(db: AsyncSession, booking_id: UUID) -> None:
    result = await db.execute(
        select(Booking)
        .where(Booking.id == booking_id)
        .options(
            selectinload(Booking.passengers).selectinload(Passenger.seat),
            selectinload(Booking.trip).options(trip_load_options()),
        )
        .execution_options(populate_existing=True)
    )
    try:
        await send_confirmation_email(result.scalar_one())
    except Exception as exc:  # the booking is confirmed either way
        logger.warning("verify_confirmation_email_failed booking_id=%s error=%s", booking_id, exc)
    # Persist passengers.confirmation_sent, also after a partial failure.
    await db.commit()
