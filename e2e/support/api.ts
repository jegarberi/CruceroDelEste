import { APIRequestContext, request } from "@playwright/test";
import { sql } from "./db";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API,
  LAYOUT_NAME,
  PRICE_CAMA,
  PRICE_SEMI_CAMA,
  STOPS,
} from "./env";

/**
 * Cliente de la API con sesión de admin. Maneja el doble envío de CSRF
 * (GET /csrf-token + header X-CSRF-Token) igual que los frontends.
 */
export class AdminApi {
  private constructor(
    readonly ctx: APIRequestContext,
    private readonly csrf: string,
  ) {}

  static async login(): Promise<AdminApi> {
    const ctx = await request.newContext({ baseURL: API });
    const csrf = (await (await ctx.get("/csrf-token")).json()).csrf_token as string;
    const api = new AdminApi(ctx, csrf);
    const res = await api.post("/admin/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (!res.ok()) throw new Error(`login admin falló: ${res.status()} ${await res.text()}`);
    return api;
  }

  get headers() {
    return { "X-CSRF-Token": this.csrf };
  }

  post(url: string, data?: unknown) {
    return this.ctx.post(url, { data, headers: this.headers });
  }

  patch(url: string, data?: unknown) {
    return this.ctx.patch(url, { data, headers: this.headers });
  }

  delete(url: string) {
    return this.ctx.delete(url, { headers: this.headers });
  }

  async json<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
    if (!res.ok()) throw new Error(`${what} falló: ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async stopId(name: string): Promise<string> {
    const stops = await this.json<{ id: string; name: string }[]>(await this.ctx.get("/stops"), "GET /stops");
    const stop = stops.find((s) => s.name === name);
    if (!stop) throw new Error(`parada ${name} no existe`);
    return stop.id;
  }

  /** Ruta E2E Retiro → E2E Asunción (la crea global-setup). */
  async routeId(): Promise<string> {
    const [origin, destination] = await Promise.all([
      this.stopId(STOPS.origin.name),
      this.stopId(STOPS.destination.name),
    ]);
    const routes = await this.json<{ id: string; origin_stop: { id: string }; destination_stop: { id: string } }[]>(
      await this.ctx.get("/admin/routes"),
      "GET /admin/routes",
    );
    const route = routes.find((r) => r.origin_stop.id === origin && r.destination_stop.id === destination);
    if (!route) throw new Error("ruta E2E no existe");
    return route.id;
  }

  async layoutId(): Promise<string> {
    const layouts = await this.json<{ id: string; name: string }[]>(
      await this.ctx.get("/admin/seat-layouts"),
      "GET /admin/seat-layouts",
    );
    const layout = layouts.find((l) => l.name === LAYOUT_NAME);
    if (!layout) throw new Error(`layout ${LAYOUT_NAME} no existe`);
    return layout.id;
  }

  /**
   * Crea un viaje propio para una prueba, con precio para ambas clases.
   * Cada prueba usa el suyo para no pisarse los asientos con las demás.
   */
  async createTrip(opts: { withPrices?: boolean; hourUtc?: number; minuteUtc?: number; daysAhead?: number } = {}): Promise<Trip> {
    // 18:00 UTC = 15:00 en Argentina: lejos de la medianoche en ambos husos.
    const { withPrices = true, hourUtc = 18, minuteUtc = 0 } = opts;
    // Un día distinto por viaje (global-setup vacía los viajes al empezar), así
    // cada búsqueda por fecha devuelve solo el viaje de la prueba.
    const departure = new Date();
    if (opts.daysAhead !== undefined) {
      departure.setUTCDate(departure.getUTCDate() + opts.daysAhead);
    } else {
      const day = Number(sql("SELECT nextval('e2e_trip_day');")[0]);
      // De a dos días: un viaje nocturno cae en el día local anterior al UTC.
      departure.setUTCDate(departure.getUTCDate() + 20 + day * 2);
    }
    departure.setUTCHours(hourUtc, minuteUtc, 0, 0);
    const arrival = new Date(departure.getTime() + 17 * 3_600_000);
    const trip = await this.json<{ id: string }>(
      await this.post("/admin/trips", {
        route_id: await this.routeId(),
        seat_layout_id: await this.layoutId(),
        departure_at: departure.toISOString(),
        arrival_at: arrival.toISOString(),
      }),
      "POST /admin/trips",
    );
    if (withPrices) {
      await this.json(
        await this.post(`/admin/trips/${trip.id}/price-tranches`, {
          seat_type: "semi_cama", min_sold: 0, max_sold: 48, price: PRICE_SEMI_CAMA,
        }),
        "tramo semi_cama",
      );
      await this.json(
        await this.post(`/admin/trips/${trip.id}/price-tranches`, {
          seat_type: "cama", min_sold: 0, max_sold: 12, price: PRICE_CAMA,
        }),
        "tramo cama",
      );
    }
    return { id: trip.id, departure, date: arDate(departure) };
  }

  async dispose() {
    await this.ctx.dispose();
  }
}

export interface Trip {
  id: string;
  departure: Date;
  /** Fecha de salida en hora argentina, YYYY-MM-DD (lo que usa el buscador). */
  date: string;
}

export function arDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
}

export interface PassengerInput {
  first_name: string;
  last_name: string;
  dni: string;
  email: string;
  phone: string;
}

export const PASSENGER: PassengerInput = {
  first_name: "Ana",
  last_name: "García",
  dni: "30111222",
  email: "ana.e2e@example.com",
  phone: "1155550000",
};

export interface Booking {
  id: string;
  booking_code: string;
  confirmation_token: string;
  total_amount: number;
}

/** Crea una reserva por API pública (atajo para pruebas que no son del formulario de compra). */
export async function createBooking(
  tripId: string,
  seatNumbers: string[],
  passenger: PassengerInput = PASSENGER,
): Promise<Booking> {
  const ctx = await request.newContext({ baseURL: API });
  try {
    const csrf = (await (await ctx.get("/csrf-token")).json()).csrf_token as string;
    const seats = (await (await ctx.get(`/trips/${tripId}/seats`)).json()) as { id: string; seat_number: string }[];
    const seatIds = seatNumbers.map((n) => {
      const seat = seats.find((s) => s.seat_number === n);
      if (!seat) throw new Error(`asiento ${n} no existe`);
      return seat.id;
    });
    const res = await ctx.post("/bookings", {
      headers: { "X-CSRF-Token": csrf },
      data: {
        trip_id: tripId,
        contact_email: passenger.email,
        seat_ids: seatIds,
        passengers: seatIds.map((seat_id, i) => ({
          seat_id,
          ...passenger,
          // El DNI no puede repetirse dentro de una reserva.
          dni: String(Number(passenger.dni) + i),
        })),
      },
    });
    if (res.status() !== 201) throw new Error(`POST /bookings falló: ${res.status()} ${await res.text()}`);
    return (await res.json()) as Booking;
  } finally {
    await ctx.dispose();
  }
}
