import { request } from "@playwright/test";
import { AdminApi } from "./support/api";
import { backendScript, sql } from "./support/db";
import { ADMIN_EMAIL, ADMIN_PASSWORD, API, LAYOUT_NAME, STOPS } from "./support/env";

/**
 * Deja la base del stack E2E con lo mínimo que las pruebas dan por hecho:
 * layout de asientos, un admin, tres paradas y la ruta entre dos de ellas.
 * Es idempotente: se puede correr la suite varias veces sobre el mismo stack.
 */
export default async function globalSetup() {
  const ping = await request.newContext({ baseURL: API });
  try {
    await ping.get("/stops", { timeout: 5_000 });
  } catch {
    throw new Error(`El stack E2E no responde en ${API}. Levantalo con: npm run stack:up`);
  } finally {
    await ping.dispose();
  }

  // La base es exclusiva de la suite: se parte de cero en cada corrida.
  sql("TRUNCATE refund_requests, chargebacks, passengers, bookings, seats, price_tranches, trips CASCADE;");
  sql("DROP SEQUENCE IF EXISTS e2e_trip_day; CREATE SEQUENCE e2e_trip_day;");

  // seed_seat_layout no es idempotente (falla si el layout ya existe).
  if (sql(`SELECT 1 FROM seat_layouts WHERE name = '${LAYOUT_NAME}';`).length === 0) {
    backendScript("scripts.seed_seat_layout");
    backendScript("scripts.seed_layout_seats");
  }

  if (sql(`SELECT 1 FROM admin_users WHERE email = '${ADMIN_EMAIL}';`).length === 0) {
    backendScript("scripts.create_admin", ["--email", ADMIN_EMAIL, "--password", ADMIN_PASSWORD]);
  }

  const api = await AdminApi.login();
  try {
    const existing = (await (await api.ctx.get("/stops")).json()) as { id: string; name: string }[];
    const ids: Record<string, string> = {};
    for (const stop of Object.values(STOPS)) {
      const found = existing.find((s) => s.name === stop.name);
      ids[stop.name] = found
        ? found.id
        : (await api.json<{ id: string }>(await api.post("/admin/stops", stop), `crear parada ${stop.name}`)).id;
    }

    const routes = (await (await api.ctx.get("/admin/routes")).json()) as {
      origin_stop: { id: string };
      destination_stop: { id: string };
    }[];
    const hasRoute = routes.some(
      (r) => r.origin_stop.id === ids[STOPS.origin.name] && r.destination_stop.id === ids[STOPS.destination.name],
    );
    if (!hasRoute) {
      await api.json(
        await api.post("/admin/routes", {
          origin_stop_id: ids[STOPS.origin.name],
          destination_stop_id: ids[STOPS.destination.name],
        }),
        "crear ruta E2E",
      );
    }
  } finally {
    await api.dispose();
  }
}
