import { execFileSync } from "node:child_process";
import path from "node:path";

const COMPOSE_DIR = path.resolve(__dirname, "..");

function compose(args: string[], input?: string): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: COMPOSE_DIR,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Corre SQL contra la base del stack E2E. Devuelve filas "a|b|c". */
export function sql(query: string): string[] {
  const out = compose(
    ["exec", "-T", "postgres", "psql", "-U", "e2e", "-d", "e2e", "-At", "-v", "ON_ERROR_STOP=1"],
    query,
  );
  return out ? out.split("\n") : [];
}

/** Corre un script de backend/scripts dentro del contenedor del backend. */
export function backendScript(module: string, args: string[] = []): string {
  return compose(["exec", "-T", "backend", "python", "-m", module, ...args]);
}

// MercadoPago no se puede pagar desde una prueba: estos helpers dejan la
// reserva en el estado en que la dejaría el pago real (ver confirm_booking,
// expire_booking y mark_booking_refunded en backend/app/services/booking.py).

export function confirmBooking(bookingId: string, mpPaymentId = "e2e-payment"): void {
  sql(`
    UPDATE seats SET status = 'sold', reserved_at = NULL
      WHERE id IN (SELECT seat_id FROM passengers WHERE booking_id = '${bookingId}');
    UPDATE bookings SET status = 'confirmed', confirmed_at = now(), mp_payment_id = '${mpPaymentId}'
      WHERE id = '${bookingId}';
  `);
}

/** Vence la reserva: el job expire_bookings_job (cada 1 min) la expira y libera asientos. */
export function makeBookingOverdue(bookingId: string): void {
  sql(`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = '${bookingId}';`);
}

export function bookingStatus(bookingId: string): string {
  return sql(`SELECT status FROM bookings WHERE id = '${bookingId}';`)[0];
}

export function seatStatus(tripId: string, seatNumber: string): string {
  return sql(
    `SELECT status FROM seats WHERE trip_id = '${tripId}' AND seat_number = '${seatNumber}';`,
  )[0];
}
