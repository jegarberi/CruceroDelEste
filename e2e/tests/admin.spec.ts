import { request } from "@playwright/test";
import { test, expect, adminLogin, selectOption, resultsUrl, seatsUrl, seat } from "../support/fixtures";
import { createBooking, PASSENGER } from "../support/api";
import { confirmBooking, seatStatus, sql } from "../support/db";
import { ADMIN, ADMIN_EMAIL, API, LAYOUT_NAME, STOPS } from "../support/env";

const uid = () => Math.random().toString(36).slice(2, 8);

test.describe("Admin — acceso", () => {
  test("sin sesión, las pantallas del panel redirigen al login", async ({ page }) => {
    for (const path of ["/viajes", "/reservas", "/reembolsos", "/contracargos", "/configuracion", "/dashboard"]) {
      await page.goto(`${ADMIN}${path}`);
      await expect(page).toHaveURL(`${ADMIN}/login`);
    }
  });

  test("credenciales incorrectas muestran error y no dan acceso", async ({ page }) => {
    await adminLogin(page, ADMIN_EMAIL, "clave-incorrecta");
    await expect(page.getByText("Email o contraseña incorrectos.")).toBeVisible();
    await adminLogin(page, "nadie@example.com", "clave-incorrecta");
    await expect(page.getByText("Email o contraseña incorrectos.")).toBeVisible();
    await page.goto(`${ADMIN}/viajes`);
    await expect(page).toHaveURL(`${ADMIN}/login`);
  });

  test("login, navegación por el menú y cierre de sesión", async ({ page }) => {
    await adminLogin(page);
    await page.waitForURL("**/dashboard");
    for (const [link, heading] of [
      ["Viajes", "Viajes"],
      ["Reservas", "Reservas"],
      ["Reembolsos", "Reembolsos"],
      ["Contracargos", "Contracargos"],
      ["Catálogo", "Catálogo"],
    ]) {
      await page.getByRole("link", { name: link, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
    // La sesión sobrevive a una recarga.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Catálogo" })).toBeVisible();

    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page).toHaveURL(`${ADMIN}/login`);
    await page.goto(`${ADMIN}/viajes`);
    await expect(page).toHaveURL(`${ADMIN}/login`);
  });

  test("la API de admin exige sesión y token CSRF", async ({ api }) => {
    const anon = await request.newContext({ baseURL: API });
    for (const path of ["/admin/bookings", "/admin/trips", "/admin/refund-requests", "/admin/chargebacks", "/admin/me"]) {
      expect((await anon.get(path)).status(), path).toBe(401);
    }
    await anon.dispose();
    // Con sesión pero sin el header CSRF, una escritura se rechaza.
    const noCsrf = await api.ctx.post("/admin/stops", { data: { name: `E2E sin csrf ${uid()}`, country: "AR" } });
    expect(noCsrf.status()).toBe(403);
  });
});

test.describe("Admin — catálogo, viajes y ventas", () => {
  test.beforeEach(async ({ page }) => {
    await adminLogin(page);
    await page.waitForURL("**/dashboard");
  });

  test("paradas: alta, duplicado, edición y baja", async ({ page }) => {
    const name = `E2E Parada ${uid()}`;
    await page.goto(`${ADMIN}/configuracion`);

    await page.getByRole("button", { name: "Agregar parada" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Guardar" })).toBeDisabled();
    await dialog.getByLabel("Nombre").fill(name);
    await selectOption(page, 0, "Paraguay");
    await dialog.getByLabel("Provincia").fill("E2E Itapúa");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Parada creada")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText("Paraguay");

    // Mismo nombre otra vez.
    await page.getByRole("button", { name: "Agregar parada" }).click();
    await dialog.getByLabel("Nombre").fill(name);
    await selectOption(page, 0, "Argentina");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Ya existe una parada con ese nombre.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    // Editar.
    await row.getByRole("button", { name: "Editar parada" }).click();
    await expect(page.getByRole("dialog", { name: "Editar parada" })).toBeVisible();
    // El país se muestra por nombre, no por código.
    await expect(dialog.getByRole("combobox")).toContainText("Paraguay");
    await dialog.getByLabel("Provincia").fill("E2E Alto Paraná");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Parada actualizada")).toBeVisible();
    await expect(row).toContainText("E2E Alto Paraná");

    // Eliminar.
    await row.getByRole("button", { name: "Eliminar parada" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Parada eliminada")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
  });

  test("una parada usada por una ruta no se puede eliminar", async ({ page }) => {
    await page.goto(`${ADMIN}/configuracion`);
    const row = page.getByRole("row").filter({ hasText: STOPS.origin.province });
    await row.getByRole("button", { name: "Eliminar parada" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Parada eliminada")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: STOPS.origin.province })).toHaveCount(1);
  });

  test("rutas: debe ser internacional, no se duplica, y se puede crear y eliminar", async ({ page, api }) => {
    const pyName = `E2E Destino ${uid()}`;
    await api.json(await api.post("/admin/stops", { name: pyName, country: "PY", province: "E2E Central" }), "parada");
    await page.goto(`${ADMIN}/configuracion`);
    const dialog = page.getByRole("dialog");

    // AR → AR: cabotaje, prohibido.
    await page.getByRole("button", { name: "Agregar ruta" }).click();
    await selectOption(page, 0, new RegExp(STOPS.origin.name));
    await selectOption(page, 1, new RegExp(STOPS.otherAr.name));
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Las rutas deben ser internacionales (AR → PY o PY → AR).")).toBeVisible();
    // El backend también la rechaza si se saltea el formulario.
    const direct = await api.post("/admin/routes", {
      origin_stop_id: await api.stopId(STOPS.origin.name),
      destination_stop_id: await api.stopId(STOPS.otherAr.name),
    });
    expect(direct.status()).toBe(422);

    // Ya existe.
    await selectOption(page, 1, new RegExp(STOPS.destination.name));
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Esta ruta ya existe.")).toBeVisible();

    // Nueva.
    await selectOption(page, 1, new RegExp(pyName));
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Ruta creada")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: pyName }).last();
    await expect(row).toContainText(STOPS.origin.name);

    await row.getByRole("button", { name: "Eliminar ruta" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Ruta eliminada")).toBeVisible();
  });

  test("una ruta con viajes no se puede eliminar", async ({ page, api }) => {
    await api.createTrip();
    await page.goto(`${ADMIN}/configuracion`);
    const row = page
      .getByRole("row")
      .filter({ hasText: STOPS.origin.name })
      .filter({ hasText: STOPS.destination.name });
    await row.getByRole("button", { name: "Eliminar ruta" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("No se puede eliminar: la ruta tiene viajes asociados.")).toBeVisible();
  });

  test("paradas de una ruta: agregar y reordenar", async ({ page, api }) => {
    // Parada propia: la ruta no choca con la de otra corrida.
    const pyName = `E2E Orden ${uid()}`;
    const py = await api.json<{ id: string }>(
      await api.post("/admin/stops", { name: pyName, country: "PY", province: "E2E Central" }),
      "parada",
    );
    const arId = await api.stopId(STOPS.otherAr.name);
    const route = await api.json<{ id: string }>(
      await api.post("/admin/routes", { origin_stop_id: arId, destination_stop_id: py.id }),
      "ruta",
    );
    for (const [order, stop_id] of [arId, py.id].entries()) {
      await api.json(await api.post(`/admin/routes/${route.id}/stops`, { stop_id, order }), "parada de ruta");
    }

    await page.goto(`${ADMIN}/configuracion`);
    await page
      .getByRole("row")
      .filter({ hasText: STOPS.otherAr.name })
      .filter({ hasText: pyName })
      .getByRole("button", { name: "Gestionar paradas de la ruta" })
      .click();
    const items = page.getByRole("dialog").getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(STOPS.otherAr.name);

    // Regresión doble: el PUT estaba bloqueado por CORS y, además, intercambiar
    // dos posiciones devolvía siempre 409.
    await items.first().getByRole("button", { name: "Bajar parada" }).click();
    await expect(items.first()).toContainText(pyName);
    await expect(page.getByText("Error al reordenar las paradas.")).toHaveCount(0);
  });

  test("layouts: alta, duplicado, y baja solo si no tiene viajes programados", async ({ page, api }) => {
    const name = `E2E Layout ${uid()}`;
    await page.goto(`${ADMIN}/configuracion`);
    const dialog = page.getByRole("dialog");

    await page.getByRole("button", { name: "Agregar layout" }).click();
    const save = dialog.getByRole("button", { name: "Guardar" });
    await dialog.getByLabel("Nombre").fill(name);
    await dialog.getByLabel("Asientos Semi Cama").fill("4");
    // Hace falta al menos un asiento Cama.
    await dialog.getByLabel("Asientos Cama").fill("0");
    await expect(save).toBeDisabled();
    await dialog.getByLabel("Asientos Cama").fill("2");
    await save.click();
    await expect(page.getByText("Layout creado")).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();
    // Numeración automática: Semi Cama 1–4, Cama 5–6.
    expect(sql(`SELECT s.seat_number || ':' || s.seat_type FROM seat_layout_seats s
                JOIN seat_layouts l ON l.id = s.seat_layout_id
                WHERE l.name = '${name}' ORDER BY s.display_order;`)).toEqual([
      "1:semi_cama", "2:semi_cama", "3:semi_cama", "4:semi_cama", "5:cama", "6:cama",
    ]);

    // Nombre repetido.
    await page.getByRole("button", { name: "Agregar layout" }).click();
    await dialog.getByLabel("Nombre").fill(name);
    await dialog.getByLabel("Asientos Semi Cama").fill("1");
    await dialog.getByLabel("Asientos Cama").fill("1");
    await save.click();
    await expect(page.getByText("Ya existe un layout con ese nombre.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    // En uso por un viaje: no se puede borrar.
    const layoutId = sql(`SELECT id FROM seat_layouts WHERE name = '${name}';`)[0];
    const departure = new Date(Date.now() + 500 * 86_400_000);
    const trip = await api.json<{ id: string }>(
      await api.post("/admin/trips", {
        route_id: await api.routeId(),
        seat_layout_id: layoutId,
        departure_at: departure.toISOString(),
        arrival_at: new Date(departure.getTime() + 17 * 3_600_000).toISOString(),
      }),
      "viaje",
    );
    expect(sql(`SELECT count(*) FROM seats WHERE trip_id = '${trip.id}';`)[0]).toBe("6");
    await row.getByRole("button", { name: "Eliminar layout" }).click();
    await dialog.getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("No se puede eliminar: el layout tiene viajes programados.")).toBeVisible();
    await expect(row).toBeVisible();

    // Con el viaje cancelado ya no lo frena: se borra y el viaje queda, sin layout.
    expect((await api.patch(`/admin/trips/${trip.id}`, { status: "cancelled" })).ok()).toBe(true);
    await row.getByRole("button", { name: "Eliminar layout" }).click();
    await dialog.getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Layout eliminado")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
    expect(sql(`SELECT status || ':' || coalesce(seat_layout_id::text, 'sin layout') FROM trips
                WHERE id = '${trip.id}';`)).toEqual(["cancelled:sin layout"]);
    expect(sql(`SELECT count(*) FROM seats WHERE trip_id = '${trip.id}';`)[0]).toBe("6");
  });

  test("el layout que usa el sitio público no se puede borrar mientras tenga viajes programados", async ({ api }) => {
    await api.createTrip();
    expect((await api.delete(`/admin/seat-layouts/${await api.layoutId()}`)).status()).toBe(409);
  });

  test("viajes: alta por formulario con validación de fechas", async ({ page }) => {
    await page.goto(`${ADMIN}/viajes`);
    await page.getByRole("button", { name: "Nuevo viaje" }).click();
    const dialog = page.getByRole("dialog");
    await selectOption(page, 0, new RegExp(STOPS.origin.name));
    await selectOption(page, 1, new RegExp(LAYOUT_NAME));
    const dates = dialog.locator('input[type="date"]');
    const times = dialog.locator('input[type="time"]');

    // Salida en el pasado.
    await dates.nth(0).fill("2020-01-01");
    await times.nth(0).fill("10:00");
    await dates.nth(1).fill("2020-01-02");
    await times.nth(1).fill("03:00");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("La fecha de salida no puede ser en el pasado.")).toBeVisible();

    // Llegada anterior a la salida.
    await dates.nth(0).fill("2031-03-10");
    await dates.nth(1).fill("2031-03-09");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("La llegada debe ser posterior a la salida.").first()).toBeVisible();

    // Válido.
    await dates.nth(1).fill("2031-03-11");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Viaje creado")).toBeVisible();
    // Se crea con sus 60 asientos y sin precios cargados.
    const tripId = sql("SELECT id FROM trips WHERE departure_at::date = '2031-03-10';")[0];
    expect(sql(`SELECT count(*) FROM seats WHERE trip_id = '${tripId}';`)[0]).toBe("60");
    await page.goto(`${ADMIN}/viajes/${tripId}`);
    await expect(page.getByText(`${LAYOUT_NAME} · 12C / 48SC`)).toBeVisible();
  });

  test("tramos de precio: validaciones, alta y baja; el precio llega al sitio público", async ({ page, api }) => {
    const trip = await api.createTrip({ withPrices: false });
    await page.goto(`${ADMIN}/viajes/${trip.id}`);
    const dialog = page.getByRole("dialog");
    const fields = dialog.getByRole("spinbutton");
    const save = dialog.getByRole("button", { name: "Guardar" });

    await page.getByRole("button", { name: "Agregar tramo" }).click();
    await selectOption(page, 0, "Semi Cama");

    // No arranca en 0.
    await fields.nth(0).fill("5");
    await fields.nth(1).fill("20");
    await fields.nth(2).fill("40000");
    await save.click();
    await expect(page.getByText("El primer tramo debe arrancar desde 0 asientos vendidos.")).toBeVisible();

    // Máximo menor al mínimo.
    await fields.nth(0).fill("10");
    await fields.nth(1).fill("5");
    await save.click();
    await expect(page.getByText("El valor máximo debe ser mayor al mínimo.")).toBeVisible();

    // Supera la capacidad (48 semi cama).
    await fields.nth(0).fill("0");
    await fields.nth(1).fill("60");
    await save.click();
    await expect(page.getByText("El rango supera la cantidad de asientos disponibles para este tipo.")).toBeVisible();

    // Válido: 0–20 a $40.000.
    await fields.nth(1).fill("20");
    await save.click();
    await expect(page.getByText("Tramo creado")).toBeVisible();

    // Superpuesto y con hueco.
    await page.getByRole("button", { name: "Agregar tramo" }).click();
    await selectOption(page, 0, "Semi Cama");
    await fields.nth(0).fill("10");
    await fields.nth(1).fill("30");
    await fields.nth(2).fill("45000");
    await save.click();
    await expect(page.getByText("Este rango se superpone con un tramo existente.")).toBeVisible();
    await fields.nth(0).fill("25");
    await fields.nth(1).fill("48");
    await save.click();
    await expect(page.getByText("Hay un hueco entre este tramo y el anterior.")).toBeVisible();

    // Segundo tramo contiguo: 20–48 a $45.000.
    await fields.nth(0).fill("20");
    await save.click();
    await expect(page.getByText("Tramo creado").last()).toBeVisible();
    expect(sql(`SELECT min_sold || '-' || max_sold || ':' || price FROM price_tranches
                WHERE trip_id = '${trip.id}' ORDER BY min_sold;`)).toEqual(["0-20:40000", "20-48:45000"]);

    // El sitio público muestra el precio del tramo vigente (0 vendidos).
    await page.goto(resultsUrl(trip));
    await expect(page.getByText(/\$\s?40\.000/).first()).toBeVisible();
  });

  test("el precio sube de tramo a medida que se venden pasajes", async ({ api }) => {
    const trip = await api.createTrip({ withPrices: false });
    for (const [min_sold, max_sold, price] of [[0, 2, 40000], [2, 48, 45000]]) {
      await api.json(
        await api.post(`/admin/trips/${trip.id}/price-tranches`, { seat_type: "semi_cama", min_sold, max_sold, price }),
        "tramo",
      );
    }
    const first = await createBooking(trip.id, ["1", "2"]);
    expect(first.total_amount).toBe(80000);
    confirmBooking(first.id);
    const second = await createBooking(trip.id, ["3"], { ...PASSENGER, email: "tramo2.e2e@example.com" });
    expect(second.total_amount).toBe(45000);
  });

  test("bloquear un asiento lo saca de la venta y desbloquearlo lo devuelve", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(`${ADMIN}/viajes/${trip.id}`);
    await page.getByRole("button", { name: "Ver asientos" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "7", exact: true }).click();
    await expect.poll(() => seatStatus(trip.id, "7")).toBe("blocked");

    const pub = await page.context().newPage();
    await pub.goto(seatsUrl(trip));
    await expect(seat(pub, "7")).toBeDisabled();
    await expect(seat(pub, "8")).toBeEnabled();
    // Tampoco se puede reservar por API.
    expect(await createBooking(trip.id, ["7"]).then(() => "ok", (e) => String(e))).toContain("409");

    await dialog.getByRole("button", { name: "7", exact: true }).click();
    await expect.poll(() => seatStatus(trip.id, "7")).toBe("available");
    await pub.reload();
    await expect(seat(pub, "7")).toBeEnabled();
    await pub.close();
  });

  test("un asiento vendido no se puede bloquear desde el panel", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["9"]);
    confirmBooking(booking.id);
    await page.goto(`${ADMIN}/viajes/${trip.id}`);
    await page.getByRole("button", { name: "Ver asientos" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "9", exact: true }).click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    expect(seatStatus(trip.id, "9")).toBe("sold");
  });

  test("editar viaje: cambiar horario y cancelarlo lo saca de la búsqueda", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(`${ADMIN}/viajes/${trip.id}`);
    await page.getByRole("button", { name: "Editar viaje" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="time"]').first().fill("16:30");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Viaje actualizado")).toBeVisible();
    await expect(page.getByText(/16:30/).first()).toBeVisible();

    await page.getByRole("button", { name: "Editar viaje" }).click();
    await selectOption(page, 0, "Cancelado");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Viaje actualizado").last()).toBeVisible();
    await expect(page.getByText("Cancelado").first()).toBeVisible();

    await page.goto(resultsUrl(trip));
    await expect(page.getByText("No encontramos viajes para esta búsqueda.")).toBeVisible();
  });

  test("un viaje con reservas confirmadas no se puede cancelar ni eliminar", async ({ page, api }) => {
    const trip = await api.createTrip();
    const booking = await createBooking(trip.id, ["10"]);
    confirmBooking(booking.id);

    await page.goto(`${ADMIN}/viajes/${trip.id}`);
    await page.getByRole("button", { name: "Editar viaje" }).click();
    await selectOption(page, 0, "Cancelado");
    await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("No se puede cancelar: el viaje tiene reservas confirmadas.")).toBeVisible();

    expect((await api.delete(`/admin/trips/${trip.id}`)).status()).toBe(409);
    expect(sql(`SELECT status FROM trips WHERE id = '${trip.id}';`)[0]).toBe("scheduled");
  });

  test("un viaje sin reservas se puede eliminar", async ({ api }) => {
    const trip = await api.createTrip();
    expect((await api.delete(`/admin/trips/${trip.id}`)).status()).toBe(204);
    expect(sql(`SELECT count(*) FROM trips WHERE id = '${trip.id}';`)[0]).toBe("0");
    expect(sql(`SELECT count(*) FROM seats WHERE trip_id = '${trip.id}';`)[0]).toBe("0");
  });

  test("reservas: listado, filtros por estado y detalle con pasajeros", async ({ page, api }) => {
    const trip = await api.createTrip();
    const email = `venta-${uid()}.e2e@example.com`;
    const confirmed = await createBooking(trip.id, ["11", "12"], { ...PASSENGER, email });
    confirmBooking(confirmed.id);
    const pendingEmail = `pend-${uid()}.e2e@example.com`;
    await createBooking(trip.id, ["13"], { ...PASSENGER, email: pendingEmail });

    await page.goto(`${ADMIN}/reservas`);
    const confirmedRow = page.getByRole("row").filter({ hasText: email });
    const pendingRow = page.getByRole("row").filter({ hasText: pendingEmail });
    await expect(confirmedRow).toBeVisible();
    await expect(pendingRow).toBeVisible();
    await expect(confirmedRow).toContainText(/100\.000/);

    await page.getByRole("button", { name: "Confirmadas" }).click();
    await expect(confirmedRow).toBeVisible();
    await expect(pendingRow).toHaveCount(0);

    await page.getByRole("button", { name: "Pendientes de pago" }).click();
    await expect(pendingRow).toBeVisible();
    await expect(confirmedRow).toHaveCount(0);

    await page.getByRole("button", { name: "Todas" }).click();
    await confirmedRow.click();
    await expect(page).toHaveURL(new RegExp(`/reservas/${confirmed.id}`));
    await expect(page.getByText(email).first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: PASSENGER.last_name })).toHaveCount(2);
  });

  test("una reserva inexistente muestra 'no encontrada'", async ({ page }) => {
    await page.goto(`${ADMIN}/reservas/00000000-0000-0000-0000-000000000000`);
    await expect(page.getByText("Reserva no encontrada.")).toBeVisible();
  });

  test("contracargos: pantalla y filtros cargan sin datos", async ({ page }) => {
    await page.goto(`${ADMIN}/contracargos`);
    await expect(page.getByText("No hay contracargos.")).toBeVisible();
    await page.getByRole("button", { name: "En proceso" }).click();
    await expect(page.getByText("No hay contracargos.")).toBeVisible();
  });
});
