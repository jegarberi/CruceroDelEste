import { Page } from "@playwright/test";
import { test, expect, adminLogin, seatsUrl, seat } from "../support/fixtures";
import { Booking, createBooking, PASSENGER } from "../support/api";
import { bookingStatus, confirmBooking, seatStatus, sql } from "../support/db";
import { ADMIN, WEB } from "../support/env";

async function requestRefund(page: Page, code: string, email: string) {
  await page.goto(`${WEB}/arrepentimiento`);
  await page.getByLabel("Número de reserva").fill(code);
  await page.getByLabel("Email de la compra").fill(email);
  await page.getByRole("button", { name: "Solicitar cancelación" }).click();
}

/** Reserva confirmada cuya compra tiene `daysAgo` días (para salir de la ventana de 10 días). */
async function confirmedBooking(tripId: string, seatNumber: string, daysAgo = 0): Promise<Booking> {
  const booking = await createBooking(tripId, [seatNumber]);
  confirmBooking(booking.id);
  if (daysAgo) {
    sql(`UPDATE bookings SET confirmed_at = now() - interval '${daysAgo} days' WHERE id = '${booking.id}';`);
  }
  return booking;
}

test.describe("Devolución — botón de arrepentimiento y reembolsos", () => {
  test("la página explica el plazo legal y se llega desde el pie del sitio", async ({ page }) => {
    await page.goto(WEB);
    await page.getByRole("link", { name: "Botón de arrepentimiento" }).last().click();
    await expect(page).toHaveURL(/\/arrepentimiento/);
    await expect(page.getByRole("heading", { name: "Botón de arrepentimiento" })).toBeVisible();
    await expect(page.getByText(/Resolución 424\/2020/)).toBeVisible();
    await expect(page.getByText(/Plazo legal aplicable/)).toBeVisible();
  });

  test("número de reserva con formato inválido se rechaza sin llamar a la API", async ({ page }) => {
    let called = false;
    await page.route("**/refund-request", () => { called = true; });
    await requestRefund(page, "ABC-123", "ana.e2e@example.com");
    await expect(page.getByText(/no tiene un formato válido/)).toBeVisible();
    expect(called).toBe(false);
  });

  test("reserva inexistente o sin confirmar: mismo mensaje (no revela cuáles existen)", async ({ page, api }) => {
    const message = "No pudimos procesar la solicitud";
    await requestRefund(page, "ERP-2222-3333", PASSENGER.email);
    await expect(page.getByText(message)).toBeVisible();

    const trip = await api.createTrip();
    const pending = await createBooking(trip.id, ["1"]);
    await requestRefund(page, pending.booking_code, PASSENGER.email);
    await expect(page.getByText(message)).toBeVisible();
    expect(sql(`SELECT count(*) FROM refund_requests WHERE booking_id = '${pending.id}';`)[0]).toBe("0");
  });

  test("email que no pertenece a la reserva", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await confirmedBooking(trip.id, "2");
    await requestRefund(page, booking.booking_code, "intruso.e2e@example.com");
    await expect(page.getByText("El email no coincide")).toBeVisible();
    expect(bookingStatus(booking.id)).toBe("confirmed");
    expect(sql(`SELECT count(*) FROM refund_requests WHERE booking_id = '${booking.id}';`)[0]).toBe("0");
  });

  test("fuera de los 10 días: queda registrada con número de trámite y no se reembolsa", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await confirmedBooking(trip.id, "3", 11);

    // Código en minúsculas y email en mayúsculas: se normalizan.
    await requestRefund(page, booking.booking_code.toLowerCase(), PASSENGER.email.toUpperCase());
    await expect(page.getByText("Fuera del plazo legal")).toBeVisible();
    await expect(page.getByText(/Número de trámite: [0-9a-f-]{36}/)).toBeVisible();

    expect(bookingStatus(booking.id)).toBe("confirmed");
    expect(seatStatus(trip.id, "3")).toBe("sold");
    expect(sql(`SELECT window_valid FROM refund_requests WHERE booking_id = '${booking.id}';`)).toEqual(["f"]);
  });

  test("a menos de 24 hs de la salida: fuera de plazo aunque la compra sea reciente", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await confirmedBooking(trip.id, "4");
    sql(`UPDATE trips SET departure_at = now() + interval '12 hours', arrival_at = now() + interval '29 hours'
         WHERE id = '${trip.id}';`);

    await requestRefund(page, booking.booking_code, PASSENGER.email);
    await expect(page.getByText("Fuera del plazo legal")).toBeVisible();
    expect(bookingStatus(booking.id)).toBe("confirmed");
  });

  test("dentro del plazo pero MercadoPago rechaza el reembolso: la reserva NO queda reembolsada", async ({ page, api }) => {
    // El pago de esta reserva es ficticio, así que MercadoPago no puede devolverlo.
    // Lo que importa: sin devolución real, ni la reserva ni el asiento cambian.
    const trip = await api.createTrip();
    const booking = await confirmedBooking(trip.id, "5");

    // 424 = MercadoPago rechazó el reembolso. Un 500 sería un error nuestro: esta
    // prueba antes aceptaba cualquier error y tapó una llamada mal hecha al SDK.
    const response = page.waitForResponse((r) => r.url().includes("/refund-request") && r.request().method() === "POST");
    await requestRefund(page, booking.booking_code, PASSENGER.email);
    expect((await response).status()).toBe(424);
    await expect(page.getByText("No pudimos procesar el reembolso")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Solicitud de cancelación confirmada")).toHaveCount(0);

    expect(bookingStatus(booking.id)).toBe("confirmed");
    expect(seatStatus(trip.id, "5")).toBe("sold");
    expect(sql(`SELECT window_valid FROM refund_requests WHERE booking_id = '${booking.id}';`)).toEqual(["t"]);
  });

  test("una reserva ya reembolsada libera el asiento y no admite otra solicitud", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await confirmedBooking(trip.id, "6");
    // Estado en que la deja mark_booking_refunded tras un reembolso real.
    sql(`UPDATE bookings SET status = 'refunded' WHERE id = '${booking.id}';
         UPDATE seats SET status = 'available', reserved_at = NULL
           WHERE id IN (SELECT seat_id FROM passengers WHERE booking_id = '${booking.id}');`);

    await page.goto(seatsUrl(trip));
    await expect(seat(page, "6")).toBeEnabled();

    await requestRefund(page, booking.booking_code, PASSENGER.email);
    await expect(page.getByText("No pudimos procesar la solicitud")).toBeVisible();

    // Y el asiento se puede volver a vender (el pasajero anterior queda como historial).
    const again = await createBooking(trip.id, ["6"], { ...PASSENGER, email: "nuevo.e2e@example.com" });
    expect(bookingStatus(again.id)).toBe("pending_payment");
  });

  test("el admin ve las solicitudes, filtra las que están en plazo y llega a la reserva", async ({ page, api }) => {
    const trip = await api.createTrip();
    const late = await confirmedBooking(trip.id, "7", 11);
    await requestRefund(page, late.booking_code, PASSENGER.email);
    await expect(page.getByText("Fuera del plazo legal")).toBeVisible();

    await adminLogin(page);
    await page.waitForURL("**/dashboard");
    await page.goto(`${ADMIN}/reembolsos`);
    const row = page.getByRole("row").filter({ hasText: PASSENGER.email }).first();
    await expect(row).toBeVisible();

    await page.getByRole("button", { name: "Dentro del plazo" }).click();
    const lateId = sql(`SELECT id FROM refund_requests WHERE booking_id = '${late.id}';`)[0];
    await expect(page.getByRole("row").filter({ hasText: lateId.slice(0, 8) })).toHaveCount(0);

    await page.getByRole("button", { name: "Todas" }).click();
    await page.getByRole("row").filter({ hasText: lateId.slice(0, 8) }).getByRole("button").click();
    await expect(page).toHaveURL(new RegExp(`/reservas/${late.id}`));
  });
});
