"""Integration tests for app/routers/bookings.py."""

import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.booking import expire_booking
from app.services.payment import generate_confirmation_token
from app.models.booking import Booking, BookingStatusEnum, Passenger
from app.schemas.bookings import PassengerCreate
from app.services.booking_code import generate_booking_code
from app.models.trip import (
    CountryEnum,
    PriceTranche,
    Route,
    Seat,
    SeatStatusEnum,
    SeatTypeEnum,
    Stop,
    Trip,
    TripStatusEnum,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _make_stop(
    db: AsyncSession, name: str, country: CountryEnum
) -> Stop:
    stop = Stop(name=name, country=country)
    db.add(stop)
    await db.flush()
    return stop


async def _make_scheduled_trip(
    db: AsyncSession,
    *,
    departure_offset_days: int = 1,
    status: TripStatusEnum = TripStatusEnum.scheduled,
) -> Trip:
    origin_stop = await _make_stop(db, "Retiro", CountryEnum.AR)
    destination_stop = await _make_stop(db, "Asunción", CountryEnum.PY)
    route = Route(origin_stop_id=origin_stop.id, destination_stop_id=destination_stop.id)
    db.add(route)
    await db.flush()

    now = datetime.now(timezone.utc)
    trip = Trip(
        route_id=route.id,
        departure_at=now + timedelta(days=departure_offset_days),
        arrival_at=now + timedelta(days=departure_offset_days, hours=4),
        status=status,
    )
    db.add(trip)
    await db.flush()
    return trip


async def _make_seat(
    db: AsyncSession,
    trip: Trip,
    seat_number: str = "1A",
    *,
    seat_type: SeatTypeEnum = SeatTypeEnum.cama,
    status: SeatStatusEnum = SeatStatusEnum.available,
) -> Seat:
    seat = Seat(
        trip_id=trip.id,
        seat_number=seat_number,
        seat_type=seat_type,
        status=status,
    )
    db.add(seat)
    await db.flush()
    return seat


async def _add_tranche(
    db: AsyncSession,
    trip: Trip,
    seat_type: SeatTypeEnum = SeatTypeEnum.cama,
    *,
    min_sold: int = 0,
    max_sold: int = 100,
    price: int = 24500,
) -> PriceTranche:
    tranche = PriceTranche(
        trip_id=trip.id,
        seat_type=seat_type,
        min_sold=min_sold,
        max_sold=max_sold,
        price=price,
    )
    db.add(tranche)
    await db.flush()
    return tranche


def _booking_payload(trip_id, seat_id, **passenger_overrides) -> dict:
    passenger = {
        "seat_id": str(seat_id),
        "first_name": "Ana",
        "last_name": "García",
        "dni": "12345678",
        "email": "ana@example.com",
        "phone": None,
        **passenger_overrides,
    }
    return {
        "trip_id": str(trip_id),
        "contact_email": "buyer@example.com",
        "seat_ids": [str(seat_id)],
        "passengers": [passenger],
    }


async def _make_booking_in_db(db: AsyncSession) -> Booking:
    """Insert a complete booking row with one passenger directly via the session."""
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip, "1A", status=SeatStatusEnum.reserved)

    now = datetime.now(timezone.utc)
    booking = Booking(
        trip_id=trip.id,
        booking_code=generate_booking_code(),
        status=BookingStatusEnum.pending_payment,
        contact_email="buyer@example.com",
        total_amount=24500,
        expires_at=now + timedelta(minutes=15),
    )
    db.add(booking)
    await db.flush()

    db.add(Passenger(
        booking_id=booking.id,
        seat_id=seat.id,
        first_name="Ana",
        last_name="García",
        dni="12345678",
        email="ana@example.com",
    ))
    await db.flush()
    return booking


# ---------------------------------------------------------------------------
# POST /bookings
# ---------------------------------------------------------------------------

async def test_post_bookings_happy_path_201(client: AsyncClient, db: AsyncSession):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama, price=24500)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 201
    data = resp.json()

    assert data["trip_id"] == str(trip.id)
    assert data["status"] == "pending_payment"
    assert data["contact_email"] == "buyer@example.com"
    assert data["total_amount"] == 24500
    assert "id" in data
    assert "expires_at" in data
    assert isinstance(data["booking_code"], str) and data["booking_code"]
    # Creating a booking no longer talks to MercadoPago; the buyer gets the
    # token needed to pay it from the payment page.
    assert "init_point" not in data
    assert data["confirmation_token"] == generate_confirmation_token(uuid.UUID(data["id"]))

    assert len(data["passengers"]) == 1
    pax = data["passengers"][0]
    assert pax["first_name"] == "Ana"
    assert pax["last_name"] == "García"
    assert pax["dni"] == "12345678"
    assert pax["email"] == "ana@example.com"
    assert pax["phone"] is None
    assert pax["seat_id"] == str(seat.id)
    assert "id" in pax


async def test_post_bookings_luggage_count_persists_to_db(client: AsyncClient, db: AsyncSession):
    # LLE-340: luggage_count was validated by the schema but dropped by the
    # router/service before ever reaching the Passenger row. Assert on the
    # DB row itself — a 201 alone would have let this bug through.
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama, price=24500)

    resp = await client.post(
        "/bookings",
        json=_booking_payload(trip.id, seat.id, luggage_count=3),
    )

    assert resp.status_code == 201
    data = resp.json()
    passenger_id = uuid.UUID(data["passengers"][0]["id"])

    db.expire_all()
    passenger = await db.get(Passenger, passenger_id)
    assert passenger.luggage_count == 3


async def test_post_bookings_luggage_count_omitted_defaults_to_zero_in_db(
    client: AsyncClient, db: AsyncSession
):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama, price=24500)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 201
    data = resp.json()
    passenger_id = uuid.UUID(data["passengers"][0]["id"])

    db.expire_all()
    passenger = await db.get(Passenger, passenger_id)
    assert passenger.luggage_count == 0


async def test_post_bookings_all_declared_passenger_fields_persist_to_db(
    client: AsyncClient, db: AsyncSession
):
    # LLE-379: los campos de un pasajero se declaran 4 veces y se
    # sincronizan a mano (PassengerCreate, routers/bookings.py, PassengerData,
    # y la construcción de Passenger(...)). Omitir cualquiera de los
    # últimos tres pierde el campo en silencio — 201, sin excepción, sin
    # warning (LLE-340: exactamente esto le pasó a luggage_count).
    #
    # test_passenger_field_declarations_stay_in_sync (tests/unit/test_schemas.py)
    # cubre que los TRES lugares declaren el mismo conjunto de campos, pero
    # no puede ver si el valor efectivamente se propaga en runtime: un campo
    # puede seguir declarado en todos lados y aun así perderse porque nadie
    # lo asigna al construir. Este test ejecuta el flujo real end-to-end con
    # un valor centinela distinguible por campo y confirma que cada uno
    # llegó igual a la fila persistida.
    sentinel_values = {
        "first_name": "Sentinel-FirstName-LLE379",
        "last_name": "Sentinel-LastName-LLE379",
        "dni": "99988877",
        "email": "sentinel-lle379@example.com",
        "phone": "+549111234LLE379",
        "luggage_count": 7,
    }

    # Guard: si PassengerCreate gana o pierde un campo (además de seat_id,
    # que no es un valor arbitrario sino la referencia a un seat real) y
    # sentinel_values no se actualizó, el test se niega a correr en vez de
    # ignorar el campo nuevo. Sin este guard, un campo agregado sin
    # propagar pasaría inadvertido para este test.
    fields_to_check = set(PassengerCreate.model_fields) - {"seat_id"}
    assert fields_to_check == set(sentinel_values), (
        "PassengerCreate tiene un campo que este test no conoce todavía: "
        f"{fields_to_check ^ set(sentinel_values)}. Agregá (o quitá) un valor "
        "centinela para ese campo en sentinel_values dentro de "
        "test_post_bookings_all_declared_passenger_fields_persist_to_db antes "
        "de continuar — si no, este test no puede confirmar que el campo se "
        "propaga hasta la DB (LLE-379)."
    )

    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama, price=24500)

    resp = await client.post(
        "/bookings",
        json=_booking_payload(trip.id, seat.id, **sentinel_values),
    )

    assert resp.status_code == 201
    data = resp.json()
    passenger_id = uuid.UUID(data["passengers"][0]["id"])

    db.expire_all()
    passenger = await db.get(Passenger, passenger_id)
    assert passenger is not None

    for field, expected in sentinel_values.items():
        actual = getattr(passenger, field)
        assert actual == expected, (
            f"Passenger.{field} no coincide con lo enviado en PassengerCreate "
            f"(se esperaba {expected!r}, se persistió {actual!r}). El campo se "
            "perdió en algún salto entre routers/bookings.py::"
            "create_booking_endpoint y services/booking.py (PassengerData o "
            "la construcción de Passenger(...)). Ver LLE-379 / LLE-340."
        )


async def test_post_bookings_nonexistent_trip_returns_404(client: AsyncClient):
    fake_trip_id = uuid.uuid4()
    fake_seat_id = uuid.uuid4()

    resp = await client.post(
        "/bookings",
        json=_booking_payload(fake_trip_id, fake_seat_id),
    )

    assert resp.status_code == 404
    assert resp.json()["detail"] == "not_found"


async def test_post_bookings_cancelled_trip_returns_409(client: AsyncClient, db: AsyncSession):
    trip = await _make_scheduled_trip(db, status=TripStatusEnum.cancelled)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 409
    assert resp.json()["detail"] == "trip_not_available"


async def test_post_bookings_past_trip_returns_409(client: AsyncClient, db: AsyncSession):
    now = datetime.now(timezone.utc)
    origin_stop = await _make_stop(db, "Retiro", CountryEnum.AR)
    destination_stop = await _make_stop(db, "Asunción", CountryEnum.PY)
    route = Route(origin_stop_id=origin_stop.id, destination_stop_id=destination_stop.id)
    db.add(route)
    await db.flush()

    past_trip = Trip(
        route_id=route.id,
        departure_at=now - timedelta(hours=2),
        arrival_at=now + timedelta(hours=2),
        status=TripStatusEnum.scheduled,
    )
    db.add(past_trip)
    await db.flush()

    seat = await _make_seat(db, past_trip)
    await _add_tranche(db, past_trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(past_trip.id, seat.id))

    assert resp.status_code == 409
    assert resp.json()["detail"] == "trip_not_available"


async def test_post_bookings_reserved_seat_returns_409(client: AsyncClient, db: AsyncSession):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip, status=SeatStatusEnum.reserved)
    await _add_tranche(db, trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"] == "seat_unavailable"
    assert body["seat_id"] == str(seat.id)


async def test_post_bookings_sold_seat_returns_409(client: AsyncClient, db: AsyncSession):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip, status=SeatStatusEnum.sold)
    await _add_tranche(db, trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"] == "seat_unavailable"
    assert body["seat_id"] == str(seat.id)


async def test_post_bookings_seat_not_in_trip_returns_409(client: AsyncClient, db: AsyncSession):
    trip = await _make_scheduled_trip(db)
    # seat_id is a random UUID — not in DB, certainly not in this trip.
    fake_seat_id = uuid.uuid4()

    resp = await client.post("/bookings", json=_booking_payload(trip.id, fake_seat_id))

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"] == "seat_unavailable"
    assert body["seat_id"] == str(fake_seat_id)


async def test_post_bookings_no_price_tranche_returns_500(
    client: AsyncClient, db: AsyncSession
):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    # No price tranche configured at all → NoPriceTranchesConfigured re-raised from router → 500.

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 500
    assert resp.json()["detail"] == "no_price_tranches_configured"


async def test_post_bookings_gap_between_existing_tranches_returns_500_no_price_tranche(
    client: AsyncClient, db: AsyncSession
):
    """Reproduces the original LLE-331 bug against a real booking request.

    Tranches [0,3) and [4,6) are inserted directly via the model, bypassing
    add_price_tranche's (now-fixed) gap validation — simulating rows that were
    already sitting in a dev database before the fix existed. Three cama seats
    are already sold, so the 4th booking prices at sold_count=3, which falls
    in the gap. This must raise NoPriceTranche (a tranche-configuration gap),
    not NoPriceTranchesConfigured (total absence) — the two are distinguished
    by whether any tranche exists for the seat_type at all.
    """
    trip = await _make_scheduled_trip(db)
    await _add_tranche(db, trip, SeatTypeEnum.cama, min_sold=0, max_sold=3, price=24500)
    await _add_tranche(db, trip, SeatTypeEnum.cama, min_sold=4, max_sold=6, price=26000)
    for i in range(3):
        await _make_seat(db, trip, f"S0{i}", status=SeatStatusEnum.sold)
    seat = await _make_seat(db, trip, "S04")

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 500
    assert resp.json()["detail"] == "no_price_tranche_available"


async def test_post_bookings_same_country_returns_422(client: AsyncClient, db: AsyncSession):
    origin_stop = await _make_stop(db, "Retiro", CountryEnum.AR)
    destination_stop = await _make_stop(db, "Liniers", CountryEnum.AR)
    route = Route(origin_stop_id=origin_stop.id, destination_stop_id=destination_stop.id)
    db.add(route)
    await db.flush()

    now = datetime.now(timezone.utc)
    trip = Trip(
        route_id=route.id,
        departure_at=now + timedelta(days=1),
        arrival_at=now + timedelta(days=1, hours=4),
        status=TripStatusEnum.scheduled,
    )
    db.add(trip)
    await db.flush()

    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 422
    assert resp.json()["detail"] == "international_route_required"


async def test_post_bookings_py_ar_route_accepted(client: AsyncClient, db: AsyncSession):
    origin_stop = await _make_stop(db, "Asunción", CountryEnum.PY)
    destination_stop = await _make_stop(db, "Retiro", CountryEnum.AR)
    route = Route(origin_stop_id=origin_stop.id, destination_stop_id=destination_stop.id)
    db.add(route)
    await db.flush()

    now = datetime.now(timezone.utc)
    trip = Trip(
        route_id=route.id,
        departure_at=now + timedelta(days=1),
        arrival_at=now + timedelta(days=1, hours=17),
        status=TripStatusEnum.scheduled,
    )
    db.add(trip)
    await db.flush()

    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama, price=24500)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 201
    assert resp.json()["status"] == "pending_payment"


# ---------------------------------------------------------------------------
# POST /bookings/{id}/payments
# ---------------------------------------------------------------------------

def _pay_url(booking_id, token=None) -> str:
    return f"/bookings/{booking_id}/payments?token={token or generate_confirmation_token(booking_id)}"


async def test_post_bookings_does_not_create_mp_preference(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    trip = await _make_scheduled_trip(db)
    seat = await _make_seat(db, trip)
    await _add_tranche(db, trip, SeatTypeEnum.cama)

    resp = await client.post("/bookings", json=_booking_payload(trip.id, seat.id))

    assert resp.status_code == 201
    mock_mp_sdk.preference.return_value.create.assert_not_called()


async def test_post_booking_payment_returns_redirect_and_stores_preference(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_pay_url(booking.id), json={"method": "mercadopago"})

    assert resp.status_code == 201
    assert resp.json() == {
        "method": "mercadopago",
        "redirect_url": "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=fake",
    }
    await db.refresh(booking)
    assert booking.mp_preference_id == "fake-preference-id"

    # Charged amount is the stored total, and every return path lands on /confirmacion.
    body = mock_mp_sdk.preference.return_value.create.call_args.args[0]
    assert sum(i["unit_price"] * i["quantity"] for i in body["items"]) == 24500
    assert body["external_reference"] == str(booking.id)
    assert len(set(body["back_urls"].values())) == 1
    assert "/confirmacion?booking_id=" in body["back_urls"]["failure"]
    # The test FRONTEND_URL is plain http, and MP rejects auto_return for those.
    assert "auto_return" not in body
    # No deferred payments: cash vouchers, ATM and transfers are excluded.
    excluded = {t["id"] for t in body["payment_methods"]["excluded_payment_types"]}
    assert excluded == {"ticket", "atm", "bank_transfer"}
    assert body["binary_mode"] is True


async def test_post_booking_payment_wrong_token_returns_403(
    client: AsyncClient, db: AsyncSession
):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_pay_url(booking.id, "nope"), json={"method": "mercadopago"})

    assert resp.status_code == 403


async def test_post_booking_payment_unknown_method_returns_422(
    client: AsyncClient, db: AsyncSession
):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_pay_url(booking.id), json={"method": "bitcoin"})

    assert resp.status_code == 422


async def test_post_booking_payment_expired_booking_returns_409(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    booking.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db.commit()

    resp = await client.post(_pay_url(booking.id), json={"method": "mercadopago"})

    assert resp.status_code == 409
    assert resp.json()["detail"] == "booking_not_payable"
    mock_mp_sdk.preference.return_value.create.assert_not_called()


async def test_post_booking_payment_mp_failure_returns_502_and_keeps_booking_pending(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    await db.commit()

    mock_mp_sdk.preference.return_value.create.return_value = {
        "status": 500,
        "response": {},
    }

    resp = await client.post(_pay_url(booking.id), json={"method": "mercadopago"})

    assert resp.status_code == 502
    assert resp.json()["detail"] == "payment_gateway_error"
    await db.refresh(booking)
    assert booking.status == BookingStatusEnum.pending_payment


# ---------------------------------------------------------------------------
# POST /bookings/{id}/payments/{payment_id}/verify
# ---------------------------------------------------------------------------

def _verify_url(booking_id, payment_id="123456", token=None) -> str:
    token = token or generate_confirmation_token(booking_id)
    return f"/bookings/{booking_id}/payments/{payment_id}/verify?token={token}"


def _mp_payment(mock_mp_sdk, *, status: str, external_reference: str) -> None:
    mock_mp_sdk.payment.return_value.get.return_value = {
        "status": 200,
        "response": {
            "id": 123456,
            "status": status,
            "status_detail": "accredited",
            "external_reference": external_reference,
        },
    }


async def test_verify_confirms_booking_when_mp_reports_approved(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    await db.commit()
    _mp_payment(mock_mp_sdk, status="approved", external_reference=str(booking.id))

    resp = await client.post(_verify_url(booking.id))

    assert resp.status_code == 200
    assert resp.json()["status"] == "confirmed"
    await db.refresh(booking)
    assert booking.status == BookingStatusEnum.confirmed
    assert booking.mp_payment_id == "123456"


async def test_verify_does_not_confirm_unapproved_payment(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    await db.commit()
    _mp_payment(mock_mp_sdk, status="rejected", external_reference=str(booking.id))

    resp = await client.post(_verify_url(booking.id))

    assert resp.status_code == 200
    assert resp.json()["status"] == "pending_payment"


async def test_verify_does_not_confirm_with_another_bookings_payment(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    # An approved payment that was made for a different booking must not
    # confirm this one, whatever payment id the browser sends.
    booking = await _make_booking_in_db(db)
    await db.commit()
    _mp_payment(mock_mp_sdk, status="approved", external_reference=str(uuid.uuid4()))

    resp = await client.post(_verify_url(booking.id))

    assert resp.status_code == 200
    assert resp.json()["status"] == "pending_payment"


async def test_verify_wrong_token_returns_403_without_calling_mp(
    client: AsyncClient, db: AsyncSession, mock_mp_sdk
):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_verify_url(booking.id, token="nope"))

    assert resp.status_code == 403
    mock_mp_sdk.payment.return_value.get.assert_not_called()


# ---------------------------------------------------------------------------
# POST /bookings/{id}/release
# ---------------------------------------------------------------------------

def _release_url(booking_id, token=None) -> str:
    return f"/bookings/{booking_id}/release?token={token or generate_confirmation_token(booking_id)}"


async def _seat_status(db: AsyncSession, booking: Booking) -> SeatStatusEnum:
    result = await db.execute(
        select(Seat.status)
        .join(Passenger, Passenger.seat_id == Seat.id)
        .where(Passenger.booking_id == booking.id)
        .execution_options(populate_existing=True)
    )
    return result.scalar_one()


async def test_release_expires_pending_booking_and_frees_its_seat(client: AsyncClient, db: AsyncSession):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_release_url(booking.id))

    assert resp.status_code == 200
    assert resp.json()["status"] == "expired"
    assert await _seat_status(db, booking) == SeatStatusEnum.available


async def test_release_wrong_token_returns_403_and_keeps_the_seat(client: AsyncClient, db: AsyncSession):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_release_url(booking.id, token="nope"))

    assert resp.status_code == 403
    assert await _seat_status(db, booking) == SeatStatusEnum.reserved


async def test_release_does_not_touch_a_confirmed_booking(client: AsyncClient, db: AsyncSession):
    booking = await _make_booking_in_db(db)
    booking.status = BookingStatusEnum.confirmed
    await db.commit()

    resp = await client.post(_release_url(booking.id))

    assert resp.status_code == 200
    assert resp.json()["status"] == "confirmed"
    assert await _seat_status(db, booking) == SeatStatusEnum.reserved


async def test_verify_rejects_non_numeric_payment_id(client: AsyncClient, db: AsyncSession):
    booking = await _make_booking_in_db(db)
    await db.commit()

    resp = await client.post(_verify_url(booking.id, payment_id="abc"))

    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# POST /dev/payments  (mounted because the test env is not production)
# ---------------------------------------------------------------------------

async def test_post_dev_payment_creates_preference_without_booking(
    client: AsyncClient, mock_mp_sdk
):
    resp = await client.post("/dev/payments", json={"amount": 1500, "title": "Prueba"})

    assert resp.status_code == 201
    assert resp.json()["redirect_url"].startswith("https://")
    body = mock_mp_sdk.preference.return_value.create.call_args.args[0]
    assert body["items"][0]["unit_price"] == 1500
    assert body["external_reference"].startswith("dev-test-")
    assert "notification_url" not in body


async def test_post_dev_payment_rejects_non_positive_amount(client: AsyncClient):
    resp = await client.post("/dev/payments", json={"amount": 0})

    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /bookings/{id}
# ---------------------------------------------------------------------------

async def test_get_booking_returns_200_with_correct_shape(
    client: AsyncClient, db: AsyncSession
):
    booking = await _make_booking_in_db(db)
    booking.confirmed_at = datetime.now(timezone.utc)
    await db.commit()

    token = generate_confirmation_token(booking.id)
    resp = await client.get(f"/bookings/{booking.id}?token={token}")

    assert resp.status_code == 200
    data = resp.json()

    assert data["id"] == str(booking.id)
    assert data["trip_id"] == str(booking.trip_id)
    assert data["status"] == "pending_payment"
    assert data["contact_email"] == "buyer@example.com"
    assert data["total_amount"] == 24500
    assert "expires_at" in data
    assert data["confirmed_at"] is not None

    assert len(data["passengers"]) == 1
    pax = data["passengers"][0]
    assert set(pax.keys()) == {"id", "seat_id", "first_name", "last_name", "dni", "email", "phone", "luggage_count"}
    assert pax["first_name"] == "Ana"
    assert pax["email"] == "ana@example.com"


async def test_get_booking_pending_payment_returns_200_with_status(
    client: AsyncClient, db: AsyncSession
):
    # LLE-333: a valid token for a booking still awaiting MP confirmation
    # must return the real state, not a 403 the frontend can't distinguish
    # from "unauthorized".
    booking = await _make_booking_in_db(db)
    await db.commit()

    token = generate_confirmation_token(booking.id)
    resp = await client.get(f"/bookings/{booking.id}?token={token}")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "pending_payment"
    assert data["confirmed_at"] is None


async def test_get_booking_expired_returns_200_with_status(
    client: AsyncClient, db: AsyncSession
):
    # Real state transition via expire_booking() — the same function
    # expire_bookings_job calls — no time mocking needed since it doesn't
    # check expires_at itself, only booking.status.
    booking = await _make_booking_in_db(db)
    await expire_booking(db, booking.id)
    await db.commit()

    token = generate_confirmation_token(booking.id)
    resp = await client.get(f"/bookings/{booking.id}?token={token}")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "expired"
    assert data["confirmed_at"] is None


async def test_get_booking_nonexistent_returns_403(client: AsyncClient):
    missing_id = uuid.uuid4()
    token = generate_confirmation_token(missing_id)

    resp = await client.get(f"/bookings/{missing_id}?token={token}")

    assert resp.status_code == 403
