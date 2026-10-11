import { request } from "@playwright/test";
import { test, expect, seatsUrl, seat, confirmationUrl } from "../support/fixtures";
import { createBooking, PASSENGER } from "../support/api";
import { bookingStatus, confirmBooking, makeBookingOverdue, seatStatus } from "../support/db";
import { API, WEB } from "../support/env";

// "Cancelación" cubre todo lo que deja una compra sin concretar: abandonar el
// pago, liberar los asientos para elegir otros, el rechazo del medio de pago y
// el vencimiento de la reserva.
test.describe("Cancelación — pago abandonado, rechazado o vencido", () => {
  test("volver de MercadoPago sin pagar no se muestra como error y permite reintentar", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["1"]);
    const ref = { id: booking.id, token: booking.confirmation_token };

    // MercadoPago vuelve con status=null y payment_id=null (literales).
    await page.goto(confirmationUrl(ref, "null", "null"));
    await expect(page.getByRole("heading", { name: "No completaste el pago" })).toBeVisible();
    await expect(page.getByText("Hubo un problema con tu pago")).toHaveCount(0);
    await expect(page.getByText("ID de pago")).toHaveCount(0);

    await page.getByRole("link", { name: /Volver a pagar/ }).click();
    await expect(page).toHaveURL(new RegExp(`/pago\\?booking_id=${booking.id}`));
    await expect(page.getByRole("button", { name: "Continuar al pago" })).toBeEnabled();
    expect(bookingStatus(booking.id)).toBe("pending_payment");
    expect(seatStatus(trip.id, "1")).toBe("reserved");
  });

  test("'Elegir otros asientos' libera los asientos de la reserva abandonada", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["2", "3"]);
    await page.goto(confirmationUrl({ id: booking.id, token: booking.confirmation_token }, "null", "null"));

    await page.getByRole("button", { name: /Elegir otros asientos/ }).click();
    await expect(page).toHaveURL(new RegExp(`/asientos/${trip.id}\\?passengers=2`));
    // Los mismos asientos vuelven a estar disponibles, sin esperar el vencimiento.
    await expect(seat(page, "2")).toBeEnabled();
    await expect(seat(page, "3")).toBeEnabled();
    expect(bookingStatus(booking.id)).toBe("expired");
    expect(seatStatus(trip.id, "2")).toBe("available");
  });

  test("liberar una reserva exige el token y no toca una reserva ya pagada", async ({ api }) => {
    const trip = await api.createTrip();
    const pending = await createBooking(trip.id, ["4"]);
    const paid = await createBooking(trip.id, ["5"], { ...PASSENGER, email: "paga.e2e@example.com" });
    confirmBooking(paid.id);

    const ctx = await request.newContext({ baseURL: API });
    const headers = { "X-CSRF-Token": (await (await ctx.get("/csrf-token")).json()).csrf_token };

    const forged = await ctx.post(`/bookings/${pending.id}/release?token=token-falso`, { headers });
    expect(forged.status()).toBe(403);
    expect(seatStatus(trip.id, "4")).toBe("reserved");

    const onPaid = await ctx.post(
      `/bookings/${paid.id}/release?token=${encodeURIComponent(paid.confirmation_token)}`,
      { headers },
    );
    expect(onPaid.status()).toBe(200);
    expect((await onPaid.json()).status).toBe("confirmed");
    expect(seatStatus(trip.id, "5")).toBe("sold");
    await ctx.dispose();
  });

  test("pago rechazado: muestra el error con el ID de pago", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["6"]);
    await page.goto(confirmationUrl({ id: booking.id, token: booking.confirmation_token }, "rejected", "987654"));
    await expect(page.getByRole("heading", { name: "Hubo un problema con tu pago" })).toBeVisible();
    await expect(page.getByText("ID de pago: 987654")).toBeVisible();
    expect(bookingStatus(booking.id)).toBe("pending_payment");
  });

  test("pago pendiente: muestra 'Pago en proceso'", async ({ page }) => {
    await page.goto(`${WEB}/confirmacion?status=pending&payment_id=123`);
    await expect(page.getByText("Pago en proceso")).toBeVisible();
  });

  test("/confirmacion sin datos no se muestra como pago rechazado", async ({ page }) => {
    await page.goto(`${WEB}/confirmacion`);
    await expect(page.getByText("No hay un pago para mostrar acá")).toBeVisible();
    await expect(page.getByText("Hubo un problema con tu pago")).toHaveCount(0);
  });

  test("retorno 'aprobado' con token falso no muestra datos de la reserva", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["7"]);
    confirmBooking(booking.id);
    await page.goto(confirmationUrl({ id: booking.id, token: "token-falso" }, "approved"));
    await expect(page.getByText("¡Compra registrada!")).toBeVisible();
    await expect(page.getByText(booking.booking_code)).toHaveCount(0);
    await expect(page.getByText(PASSENGER.email)).toHaveCount(0);
  });

  test("un retorno 'aprobado' falsificado no confirma la reserva", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["8"]);
    // El comprador arma la URL a mano con un payment_id inventado.
    await page.goto(confirmationUrl({ id: booking.id, token: booking.confirmation_token }, "approved", "111111"));
    await expect(page.getByText("Estamos confirmando tu pago…")).toBeVisible();
    await page.waitForTimeout(4_000);
    expect(bookingStatus(booking.id)).toBe("pending_payment");
    expect(seatStatus(trip.id, "8")).toBe("reserved");
  });

  test("reserva vencida: se expira sola, libera el asiento y ya no se puede pagar", async ({ page, api }) => {
    test.setTimeout(150_000);
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["9"]);
    const ref = { id: booking.id, token: booking.confirmation_token };

    makeBookingOverdue(booking.id);
    // Vencida pero todavía no procesada por el job: /pago ya no deja pagar.
    await page.goto(`${WEB}/pago?booking_id=${ref.id}&token=${encodeURIComponent(ref.token)}`);
    await expect(page.getByText("Esta reserva ya no se puede pagar: venció o ya fue pagada.")).toBeVisible();

    await expect.poll(() => bookingStatus(booking.id), { timeout: 100_000, intervals: [3_000] }).toBe("expired");
    expect(seatStatus(trip.id, "9")).toBe("available");

    await page.goto(seatsUrl(trip));
    await expect(seat(page, "9")).toBeEnabled();

    // Si igual vuelve de MercadoPago como aprobado, se le avisa que venció.
    await page.goto(confirmationUrl(ref, "approved"));
    await expect(page.getByText(/Los asientos fueron liberados/)).toBeVisible();
  });

  test("pagar una reserva vencida es rechazado por la API", async ({ api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["10"]);
    makeBookingOverdue(booking.id);
    const ctx = await request.newContext({ baseURL: API });
    const headers = { "X-CSRF-Token": (await (await ctx.get("/csrf-token")).json()).csrf_token };
    const res = await ctx.post(
      `/bookings/${booking.id}/payments?token=${encodeURIComponent(booking.confirmation_token)}`,
      { data: { method: "mercadopago" }, headers },
    );
    expect(res.status()).toBe(409);
    await ctx.dispose();
  });
});
