import { test, expect, resultsUrl, seatsUrl } from "../support/fixtures";
import { API, STOPS, WEB } from "../support/env";
import { arDate } from "../support/api";

test.describe("Usuario — sitio público y búsqueda", () => {
  test("la landing carga con navegación y buscador", async ({ page }) => {
    await page.goto(WEB);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Pasajes baratos");
    await expect(page.getByRole("button", { name: "Buscar" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Destinos" })).toHaveAttribute("href", "/destinos");
  });

  for (const path of ["/destinos", "/nosotros", "/preguntas-frecuentes", "/arrepentimiento"]) {
    test(`la página ${path} responde y muestra contenido`, async ({ page }) => {
      const res = await page.goto(`${WEB}${path}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  }

  test("una ruta inexistente devuelve 404", async ({ page }) => {
    const res = await page.goto(`${WEB}/no-existe-e2e`);
    expect(res?.status()).toBe(404);
  });

  test("regla AR↔PY: con origen argentino el destino solo ofrece paradas de Paraguay", async ({ page }) => {
    await page.goto(WEB);
    await page.getByText("Origen", { exact: true }).click();
    const panel = page.getByPlaceholder("Buscar parada...").locator("xpath=../..");
    await expect(panel).toContainText(STOPS.origin.name);
    await expect(panel).toContainText(STOPS.destination.name);
    await panel.getByText(STOPS.origin.name).click();

    await page.getByText("Destino", { exact: true }).click();
    const destPanel = page.getByPlaceholder("Buscar parada...").locator("xpath=../..");
    await expect(destPanel).toContainText(STOPS.destination.name);
    await expect(destPanel).not.toContainText(STOPS.otherAr.name);
    await expect(destPanel).not.toContainText("Argentina");
  });

  test("regla AR↔PY: la API solo devuelve destinos del país opuesto", async ({ request }) => {
    const stops = (await (await request.get(`${API}/stops`)).json()) as { id: string; name: string; country: string }[];
    const origin = stops.find((s) => s.name === STOPS.origin.name)!;
    const valid = (await (await request.get(`${API}/stops/${origin.id}/valid-destinations`)).json()) as { country: string }[];
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((s) => s.country === "PY")).toBe(true);
  });

  test("búsqueda completa desde la landing llega a resultados con el viaje", async ({ page, api }) => {
    // Fecha cercana y fija (fuera del rango 20+ que usan las demás pruebas).
    const trip = await api.createTrip({ daysAhead: 5 });
    await page.goto(WEB);
    // Por defecto es "Ida y vuelta", que exige fecha de vuelta.
    await page.getByRole("button", { name: "Ida y vuelta" }).click();
    await page.getByText("Solo ida").click();
    await page.getByText("Origen", { exact: true }).click();
    await page.getByPlaceholder("Buscar parada...").locator("xpath=../..").getByText(STOPS.origin.name).click();
    await page.getByText("Destino", { exact: true }).click();
    await page.getByPlaceholder("Buscar parada...").locator("xpath=../..").getByText(STOPS.destination.name).click();

    await page.getByRole("button", { name: "Fecha de ida" }).click();
    const dayCell = page.locator(`[data-day="${trip.date}"] button`);
    if (!(await dayCell.isVisible())) await page.getByRole("button", { name: "Go to the Next Month" }).click();
    await dayCell.click();

    await page.getByRole("button", { name: "Buscar" }).click();
    await page.waitForURL(/\/resultados\?/);
    await expect(page.getByText("60 asientos disponibles")).toBeVisible();
    await expect(page.getByText(/\$\s?50\.000/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Ver asientos/ })).toHaveCount(1);
  });

  test("el buscador no navega si faltan origen, destino o fecha", async ({ page }) => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(WEB + "/");
  });

  // Regresión: el selector de año listaba 100 años hacia atrás y ninguno hacia
  // adelante, así que en diciembre no se podía buscar un viaje de enero.
  test("el calendario ofrece el año próximo y ningún año pasado", async ({ page }) => {
    await page.goto(WEB);
    await page.getByRole("button", { name: "Fecha de ida" }).click();
    const year = new Date().getFullYear();
    const years = page.getByLabel("Choose the Year").locator("option");
    await expect(years).toHaveText([String(year), String(year + 1)]);
  });

  test("resultados: muestra horario, precio mínimo y lleva al mapa de asientos", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(resultsUrl(trip, 2));
    await expect(page.getByText("15:00")).toBeVisible();
    await expect(page.getByText("2 pasajeros")).toBeVisible();
    await page.getByRole("button", { name: /Ver asientos/ }).click();
    await expect(page).toHaveURL(new RegExp(`/asientos/${trip.id}\\?passengers=2`));
    await expect(page.getByText("0 de 2 asientos seleccionados")).toBeVisible();
  });

  test("resultados: una fecha sin viajes muestra el estado vacío", async ({ page, api }) => {
    const trip = await api.createTrip();
    const other = new Date(trip.departure.getTime() + 400 * 86_400_000);
    await page.goto(resultsUrl({ ...trip, date: arDate(other) }));
    await expect(page.getByText("No encontramos viajes para esta búsqueda.")).toBeVisible();
  });

  test("resultados: los filtros ocultan el viaje y 'Limpiar filtros' lo recupera", async ({ page, api }) => {
    const trip = await api.createTrip(); // sale 15:00 → franja Tarde
    await page.goto(resultsUrl(trip));
    const card = page.getByRole("button", { name: /Ver asientos/ });
    await expect(card).toHaveCount(1);

    await page.getByRole("checkbox", { name: /Mañana/ }).click();
    await expect(card).toHaveCount(0);

    await page.getByRole("button", { name: "Limpiar filtros" }).first().click();
    await expect(card).toHaveCount(1);

    await page.getByRole("checkbox", { name: /Tarde/ }).click();
    await expect(card).toHaveCount(1);
  });

  test("un viaje cancelado no aparece en la búsqueda", async ({ page, api }) => {
    const trip = await api.createTrip();
    const res = await api.patch(`/admin/trips/${trip.id}`, { status: "cancelled" });
    expect(res.ok()).toBe(true);
    await page.goto(resultsUrl(trip));
    await expect(page.getByText("No encontramos viajes para esta búsqueda.")).toBeVisible();
  });

  test("el mapa de asientos sin cantidad de pasajeros vuelve a resultados", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(`${WEB}/asientos/${trip.id}`);
    await expect(page).toHaveURL(/\/resultados/);
  });

  test("el mapa de asientos tiene botón para volver a los resultados", async ({ page, api }) => {
    const trip = await api.createTrip();
    await page.goto(resultsUrl(trip));
    await page.getByRole("button", { name: /Ver asientos/ }).click();
    await expect(page.getByRole("heading", { name: "Seleccioná tus asientos" })).toBeVisible();
    await page.getByRole("button", { name: "← Volver" }).click();
    await expect(page).toHaveURL(/\/resultados\?/);
  });

  // Regresión: GET /trips filtraba departure_date por día UTC. Un viaje que sale
  // 21:30 (ART) del día D es 00:30 UTC del día D+1 y no aparecía al buscar el día D.
  test("un viaje nocturno aparece al buscar por su fecha local", async ({ page, api }) => {
    const trip = await api.createTrip({ hourUtc: 0, minuteUtc: 30 }); // 21:30 ART del día anterior
    await page.goto(resultsUrl(trip));
    await expect(page.getByRole("button", { name: /Ver asientos/ })).toHaveCount(1);
    await expect(page.getByText("21:30")).toBeVisible();
  });

  test("el mapa de asientos de un viaje inexistente no rompe la página", async ({ page }) => {
    await page.goto(seatsUrl({ id: "00000000-0000-0000-0000-000000000000", departure: new Date(), date: "" }));
    await expect(page.getByRole("button", { name: "Continuar" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Application error");
  });
});
