import { request } from "@playwright/test";
import {
  test,
  expect,
  resultsUrl,
  seatsUrl,
  seat,
  pickSeats,
  fillPassenger,
  bookingFromUrl,
  confirmationUrl,
} from "../support/fixtures";
import { createBooking, PASSENGER } from "../support/api";
import { bookingStatus, confirmBooking, makeBookingOverdue, seatStatus, sql } from "../support/db";
import { API, WEB } from "../support/env";

test.describe("Compra — asientos, datos del pasajero y pago", () => {
  test("flujo completo: resultados → asientos → datos → pago", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(resultsUrl(trip));
    await page.getByRole("button", { name: /Ver asientos/ }).click();

    await seat(page, "1").click();
    await expect(page.getByText("1 de 1 asientos seleccionados")).toBeVisible();
    await expect(page.getByText(/\$\s?50\.000/).first()).toBeVisible();
    await page.getByRole("button", { name: "Continuar" }).click();

    await expect(page.getByText("Asientos seleccionados: 1")).toBeVisible();
    await fillPassenger(page, 0);
    await page.getByRole("button", { name: "Continuar al pago" }).click();

    await page.waitForURL(/\/pago\?booking_id=/);
    await expect(page.getByRole("heading", { name: "Pagá tu reserva" })).toBeVisible();
    await expect(page.getByText("Total a pagar")).toBeVisible();
    await expect(page.getByText(/\$\s?50\.000/).first()).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Medio de pago" })).toBeVisible();

    const booking = bookingFromUrl(page);
    expect(bookingStatus(booking.id)).toBe("pending_payment");
    expect(seatStatus(trip.id, "1")).toBe("reserved");
  });

  test("el pago redirige al checkout de MercadoPago", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["2"]);
    await page.goto(`${WEB}/pago?booking_id=${booking.id}&token=${encodeURIComponent(booking.confirmation_token)}`);
    await page.getByRole("button", { name: "Continuar al pago" }).click();
    // El pago en sí ocurre en el sitio de MercadoPago: la prueba llega hasta la redirección.
    await page.waitForURL(/mercadopago\.com/, { timeout: 30_000, waitUntil: "commit" });
    expect(sql(`SELECT mp_preference_id FROM bookings WHERE id = '${booking.id}';`)[0]).not.toBe("");
  });

  test("pago aprobado: la confirmación muestra el código de reserva y el asiento queda vendido", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["4"]);
    confirmBooking(booking.id);

    await page.goto(confirmationUrl({ id: booking.id, token: booking.confirmation_token }, "approved"));
    await expect(page.getByText(booking.booking_code)).toBeVisible();
    await expect(page.getByText("Hubo un problema con tu pago")).toHaveCount(0);
    // La URL se limpia tras la primera consulta (no deja el token a la vista).
    await expect(page).toHaveURL(`${WEB}/confirmacion`);

    expect(seatStatus(trip.id, "4")).toBe("sold");
    await page.goto(seatsUrl(trip));
    await expect(seat(page, "4")).toBeDisabled();
  });

  test("pago aprobado que todavía no se acreditó: espera y confirma solo cuando llega", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["5"]);
    await page.goto(confirmationUrl({ id: booking.id, token: booking.confirmation_token }, "approved"));
    await expect(page.getByText("Estamos confirmando tu pago…")).toBeVisible();

    confirmBooking(booking.id);
    await expect(page.getByText(booking.booking_code)).toBeVisible({ timeout: 40_000 });
  });

  test("el mapa limita la selección a la cantidad de pasajeros y suma el total", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(seatsUrl(trip, 2));
    await expect(page.getByRole("button", { name: "Continuar" })).toBeDisabled();

    await seat(page, "1").click();
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Seleccioná exactamente 2 asientos para continuar.")).toBeVisible();

    // Planta baja: Cama Ejecutivo, otro precio.
    await page.getByRole("button", { name: "Planta Baja (Cama Ejecutivo)" }).click();
    await seat(page, "51").click();
    await expect(page.getByText("2 de 2 asientos seleccionados")).toBeVisible();
    await expect(page.getByText(/\$\s?130\.000/)).toBeVisible();

    await seat(page, "50").click();
    await expect(page.getByText(/Ya seleccionaste tus 2 asientos/)).toBeVisible();
    await expect(page.getByText("2 de 2 asientos seleccionados")).toBeVisible();

    // Deseleccionar libera el cupo.
    await seat(page, "51").click();
    await expect(page.getByText("1 de 2 asientos seleccionados")).toBeVisible();
  });

  test("compra de dos pasajeros: total y dos asientos reservados", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(seatsUrl(trip, 2));
    await pickSeats(page, ["9", "10"]);
    await expect(page.getByText("Pasajeros: 2")).toBeVisible();
    await fillPassenger(page, 0);
    await fillPassenger(page, 1, { first_name: "Luis", dni: "30111999", email: "luis.e2e@example.com" });
    await page.getByRole("button", { name: "Continuar al pago" }).click();

    await page.waitForURL(/\/pago\?booking_id=/);
    await expect(page.getByText(/\$\s?100\.000/).first()).toBeVisible();
    expect(seatStatus(trip.id, "9")).toBe("reserved");
    expect(seatStatus(trip.id, "10")).toBe("reserved");
    const booking = bookingFromUrl(page);
    expect(sql(`SELECT count(*) FROM passengers WHERE booking_id = '${booking.id}';`)[0]).toBe("2");
  });

  test("validaciones del formulario de pasajeros", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(seatsUrl(trip, 2));
    await pickSeats(page, ["11", "12"]);

    const submit = page.getByRole("button", { name: "Continuar al pago" });
    await submit.click();
    for (const field of ["Nombres", "Apellidos", "DNI", "Email", "Teléfono"]) {
      await expect(page.getByText(`${field} es obligatorio`).first()).toBeVisible();
    }
    await expect(page).toHaveURL(/\/compra\//);

    await fillPassenger(page, 0, { email: "no-es-un-email", dni: "12ab", phone: "123" });
    await fillPassenger(page, 1, { dni: "30111222" });
    await expect(page.getByText("Email inválido")).toBeVisible();
    await expect(page.getByText("DNI inválido (7 u 8 dígitos)")).toBeVisible();
    await expect(page.getByText("Teléfono inválido")).toBeVisible();

    // Mismo DNI en los dos pasajeros.
    await fillPassenger(page, 0, { dni: "30111222" });
    await expect(page.getByText("Este DNI ya fue ingresado para otro pasajero").first()).toBeVisible();
    await submit.click();
    await expect(page).toHaveURL(/\/compra\//);
    expect(seatStatus(trip.id, "11")).toBe("available");
  });

  test("asiento tomado por otro comprador mientras se completan los datos", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(seatsUrl(trip));
    await pickSeats(page, ["13"]);
    await fillPassenger(page, 0);

    await createBooking(trip.id, ["13"], { ...PASSENGER, email: "otro.e2e@example.com" });

    await page.getByRole("button", { name: "Continuar al pago" }).click();
    await expect(page.getByText("Ese asiento ya no está disponible.")).toBeVisible();
    await expect(page).toHaveURL(/\/compra\//);
  });

  test("dos compradores reservan el mismo asiento al mismo tiempo: solo uno lo consigue", async ({ api }) => {
    const trip = await api.createTrip();
    const results = await Promise.allSettled([
      createBooking(trip.id, ["14"], { ...PASSENGER, email: "a.e2e@example.com" }),
      createBooking(trip.id, ["14"], { ...PASSENGER, email: "b.e2e@example.com" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // El que pierde recibe 409 seat_unavailable, nunca un 500.
    expect(String(lost[0].reason)).toContain("409");
    expect(sql(`SELECT count(*) FROM passengers p JOIN seats s ON s.id = p.seat_id
                WHERE s.trip_id = '${trip.id}' AND s.seat_number = '14';`)[0]).toBe("1");
  });

  test("un asiento reservado o vendido aparece deshabilitado en el mapa", async ({ page, api }) => {
    const trip = await api.createTrip();
    await createBooking(trip.id, ["15"]);
    const sold = await createBooking(trip.id, ["16"], { ...PASSENGER, email: "v.e2e@example.com" });
    confirmBooking(sold.id);

    await page.goto(seatsUrl(trip));
    await expect(seat(page, "15")).toBeDisabled();
    await expect(seat(page, "16")).toBeDisabled();
    await expect(seat(page, "17")).toBeEnabled();
  });

  test("regresión: un asiento de una reserva vencida se puede volver a comprar", async ({ page, api }) => {
    test.setTimeout(150_000);
    const trip = await api.createTrip();
    const first = await createBooking(trip.id, ["18"]);
    makeBookingOverdue(first.id);
    // expire_bookings_job corre cada minuto.
    await expect.poll(() => bookingStatus(first.id), { timeout: 100_000, intervals: [3_000] }).toBe("expired");
    expect(seatStatus(trip.id, "18")).toBe("available");

    await page.goto(seatsUrl(trip));
    await pickSeats(page, ["18"]);
    await fillPassenger(page, 0, { email: "segundo.e2e@example.com" });
    await page.getByRole("button", { name: "Continuar al pago" }).click();
    await page.waitForURL(/\/pago\?booking_id=/);
    expect(seatStatus(trip.id, "18")).toBe("reserved");
  });

  test("/pago sin datos, con token inválido y con reserva ya pagada", async ({ page, api }) => {
    await page.goto(`${WEB}/pago`);
    await expect(page.getByText("No encontramos una reserva para pagar.")).toBeVisible();

    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["19"]);
    await page.goto(`${WEB}/pago?booking_id=${booking.id}&token=token-falso`);
    await expect(page.getByText("No pudimos cargar tu reserva.")).toBeVisible();

    confirmBooking(booking.id);
    await page.goto(`${WEB}/pago?booking_id=${booking.id}&token=${encodeURIComponent(booking.confirmation_token)}`);
    await expect(page.getByText("Esta reserva ya no se puede pagar: venció o ya fue pagada.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar al pago" })).toHaveCount(0);
  });

  test("la API rechaza reservas inválidas", async ({ api }) => {
    const trip = await api.createTrip();
    const ctx = await request.newContext({ baseURL: API });
    const csrf = (await (await ctx.get("/csrf-token")).json()).csrf_token;
    const seats = (await (await ctx.get(`/trips/${trip.id}/seats`)).json()) as { id: string; seat_number: string }[];
    const seatId = seats.find((s) => s.seat_number === "20")!.id;
    const passenger = { seat_id: seatId, ...PASSENGER };
    const body = { trip_id: trip.id, contact_email: PASSENGER.email, seat_ids: [seatId], passengers: [passenger] };

    // Sin token CSRF.
    expect((await ctx.post("/bookings", { data: body })).status()).toBe(403);
    // Viaje inexistente.
    const missing = await ctx.post("/bookings", {
      data: { ...body, trip_id: "00000000-0000-0000-0000-000000000000" },
      headers: { "X-CSRF-Token": csrf },
    });
    expect(missing.status()).toBe(404);
    // Email de contacto inválido.
    const badEmail = await ctx.post("/bookings", {
      data: { ...body, contact_email: "nope" },
      headers: { "X-CSRF-Token": csrf },
    });
    expect(badEmail.status()).toBe(422);
    // Viaje cancelado.
    await api.patch(`/admin/trips/${trip.id}`, { status: "cancelled" });
    const cancelled = await ctx.post("/bookings", { data: body, headers: { "X-CSRF-Token": csrf } });
    expect(cancelled.status()).toBe(409);
    expect(seatStatus(trip.id, "20")).toBe("available");
    await ctx.dispose();
  });

  test("un viaje sin tramos de precio no se puede reservar", async ({ api }) => {
    const trip = await api.createTrip({ withPrices: false });
    const err = await createBooking(trip.id, ["21"]).then(() => null, (e) => String(e));
    expect(err).not.toBeNull();
    expect(seatStatus(trip.id, "21")).toBe("available");
  });
});
