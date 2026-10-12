import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ConfirmacionContent } from "../ConfirmacionContent";
import { getBooking, releaseBooking, verifyBookingPayment } from "@/api";
import type { BookingRead } from "@/types/trips";

// Primer uso de vi.useFakeTimers() en este repo.
//
// ConfirmacionContent usa setTimeout recursivo para el polling. Con fake
// timers, waitFor() interna de Testing Library también usa setTimeout para
// sus reintentos, así que nunca dispara y el test hace timeout. La solución
// correcta: usar act(async () => { ... }) para forzar que React procese los
// state updates y las promesas pendientes, SIN depender de setTimeout.

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/api", () => ({
  getBooking: vi.fn(),
  verifyBookingPayment: vi.fn(),
  releaseBooking: vi.fn(),
}));

function makeBookingRead(overrides: Partial<BookingRead> = {}): BookingRead {
  return {
    id: "booking-1",
    booking_code: "ERP-7K3M-9QX2",
    status: "confirmed",
    contact_email: "ana@example.com",
    total_amount: 25000,
    expires_at: "2026-01-01T00:15:00Z",
    trip: {
      id: "trip-1",
      route: {
        id: "route-1",
        origin_stop: { id: "s1", name: "Retiro", country: "AR", province: null, created_at: "" },
        destination_stop: { id: "s2", name: "Asunción", country: "PY", province: null, created_at: "" },
      },
      departure_at: "2026-09-01T10:00:00Z",
      arrival_at: "2026-09-02T03:00:00Z",
      status: "scheduled",
    },
    passengers: [
      {
        id: "p1",
        seat_id: "seat-1",
        first_name: "Ana",
        last_name: "García",
        dni: "12345678",
        email: "ana@example.com",
        phone: null,
      },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Tests sin polling — status distintos de "approved"
// ─────────────────────────────────────────────────────────

describe("ConfirmacionContent — status != approved (sin polling)", () => {
  beforeEach(() => {
    vi.mocked(getBooking).mockReset();
  });

  // test 7
  //
  // Sabotaje de lógica: en el JSX de ConfirmacionContent, cambiar
  //   {status === "pending" && (
  // por
  //   {status === "__never__" && (
  // Resultado: status="pending" ya no activa el bloque → "Pago en proceso"
  // no aparece en el DOM → test falla.
  it("status=pending muestra 'Pago en proceso' sin llamar a getBooking", () => {
    mockSearchParams = new URLSearchParams("status=pending&payment_id=999");
    render(<ConfirmacionContent />);

    expect(screen.getByText("Pago en proceso")).toBeInTheDocument();
    expect(vi.mocked(getBooking)).not.toHaveBeenCalled();
  });

  // test 8
  //
  // Sabotaje de lógica: en el JSX de ConfirmacionContent, cambiar
  //   {status !== "approved" && status !== "pending" && (
  // por
  //   {status !== "approved" && status === "pending" && (
  // Resultado: status="failure" hace que "failure !== pending" sea true,
  // pero "failure === pending" es false → el bloque no renderiza →
  // "Hubo un problema con tu pago" no aparece → test falla.
  // Recargar /confirmacion (la URL ya quedó sin query) no es un pago rechazado.
  it("sin status no muestra el error de pago", () => {
    mockSearchParams = new URLSearchParams("");
    render(<ConfirmacionContent />);

    expect(screen.getByText("No hay un pago para mostrar acá")).toBeInTheDocument();
    expect(screen.queryByText("Hubo un problema con tu pago")).not.toBeInTheDocument();
  });

  // Sabotaje de lógica: en el JSX de ConfirmacionContent, cambiar
  //   {status !== "" && status !== "null" && status !== "approved" && ...
  // quitando `status !== "null"`.
  // Resultado: el abandono vuelve a mostrarse como pago rechazado → test falla.
  it("status=null (volvió de MercadoPago sin pagar) ofrece reintentar o elegir otros asientos, sin error de pago", async () => {
    vi.mocked(getBooking).mockResolvedValueOnce(makeBookingRead({ status: "pending_payment" }));
    mockSearchParams = new URLSearchParams(
      "booking_id=booking-1&token=tok-1&status=null&payment_id=null",
    );
    render(<ConfirmacionContent />);

    expect(screen.getByText("No completaste el pago")).toBeInTheDocument();
    expect(screen.queryByText("Hubo un problema con tu pago")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a pagar →" })).toHaveAttribute(
      "href",
      "/pago?booking_id=booking-1&token=tok-1",
    );
    // Elegir otros asientos libera primero los de la reserva abandonada.
    vi.mocked(releaseBooking).mockResolvedValueOnce(new Response("{}"));
    const other = await screen.findByRole("button", { name: "Elegir otros asientos →" });
    await act(async () => {
      other.click();
    });
    expect(vi.mocked(releaseBooking)).toHaveBeenCalledWith("booking-1", "tok-1");
  });

  it("status=failure muestra 'Hubo un problema con tu pago' sin llamar a getBooking", () => {
    mockSearchParams = new URLSearchParams("status=failure&payment_id=999");
    render(<ConfirmacionContent />);

    expect(screen.getByText("Hubo un problema con tu pago")).toBeInTheDocument();
    expect(vi.mocked(getBooking)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────
// Tests con fake timers — status=approved → polling
// ─────────────────────────────────────────────────────────

describe("ConfirmacionContent — status=approved, polling (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSearchParams = new URLSearchParams(
      "status=approved&booking_id=booking-1&token=tok-abc&payment_id=mp-123"
    );
    vi.mocked(getBooking).mockReset();
    vi.mocked(verifyBookingPayment).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Al volver de MercadoPago se le pide al backend que verifique el pago antes
  // de empezar a consultar la reserva, para no depender del webhook.
  it("verifica el pago con el backend antes del primer poll", async () => {
    const order: string[] = [];
    vi.mocked(verifyBookingPayment).mockImplementation(async () => {
      order.push("verify");
      return new Response("{}");
    });
    vi.mocked(getBooking).mockImplementation(async () => {
      order.push("poll");
      return makeBookingRead({ status: "confirmed" });
    });

    render(<ConfirmacionContent />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(verifyBookingPayment).toHaveBeenCalledWith("booking-1", "tok-abc", "mp-123");
    expect(order).toEqual(["verify", "poll"]);
    expect(screen.getByText("¡Compra confirmada!")).toBeInTheDocument();
  });

  it("si la verificación falla igual consulta la reserva", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(verifyBookingPayment).mockRejectedValue(new Error("network"));
    vi.mocked(getBooking).mockResolvedValueOnce(makeBookingRead({ status: "confirmed" }));

    render(<ConfirmacionContent />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("¡Compra confirmada!")).toBeInTheDocument();
    vi.mocked(console.error).mockRestore();
  });

  // test 9
  //
  // Sabotaje de lógica: en poll(), cambiar
  //   if (data.status === "confirmed") {
  // por
  //   if (data.status === "__never__") {
  // Resultado: el estado confirmed nunca activa la rama terminal →
  // poll cae al retry, que agota el MAX_POLL_MS y muestra "exhausted" →
  // "¡Compra confirmada!" no aparece → test falla.
  it("muestra '¡Compra confirmada!' cuando el primer poll devuelve status confirmed", async () => {
    vi.mocked(getBooking).mockResolvedValueOnce(makeBookingRead({ status: "confirmed" }));

    render(<ConfirmacionContent />);

    // poll(0) llama getBooking que resuelve de inmediato (microtask).
    // act(async) vacía la cola de microtasks y fuerza el re-render de React.
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("¡Compra confirmada!")).toBeInTheDocument();
    // El booking_code vive en un <p> junto con "Reserva Nº " — regex para
    // que getByText busque por contenido parcial del elemento padre.
    expect(screen.getByText(/ERP-7K3M-9QX2/)).toBeInTheDocument();
  });

  // test 10
  //
  // Sabotaje de lógica: en poll(), cambiar
  //   if (data.status === "expired") {
  // por
  //   if (data.status === "__never__") {
  // Resultado: el estado expired no activa la rama terminal →
  // se reintenta hasta MAX_POLL_MS → "Tu reserva venció" no aparece → test falla.
  it("muestra 'Tu reserva venció' cuando el poll devuelve status expired", async () => {
    vi.mocked(getBooking).mockResolvedValueOnce(makeBookingRead({ status: "expired" }));

    render(<ConfirmacionContent />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("Tu reserva venció")).toBeInTheDocument();
  });

  // test 11 + F
  //
  // Sabotaje de lógica (a): en el catch de poll(), cambiar
  //   setPollState("token_invalid");
  // por
  //   setPollState("exhausted");
  // Resultado: getBooking lanzando va a "exhausted" en vez de "token_invalid" →
  // se renderiza la pantalla de timeout, no "¡Compra registrada!" → test falla.
  //
  // Sabotaje de lógica (b): en el catch de poll(), quitar el `return` final:
  //   setPollState("token_invalid");
  //   replaceUrlOnce();
  //   // return; ← eliminado
  // Resultado: la ejecución cae fuera del catch con `data` sin inicializar.
  // `data.status` lanza TypeError → promesa rechazada sin manejar →
  // vitest detecta el rechazo y falla el test.
  it("getBooking lanza → '¡Compra registrada!' y el poll se detiene (1 llamada tras 60s)", async () => {
    vi.mocked(getBooking).mockRejectedValueOnce(new Error("401 Unauthorized"));

    render(<ConfirmacionContent />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByText("¡Compra registrada!")).toBeInTheDocument();
    // Confirmar que NO se muestra el mensaje de "fallo de pago" (mensaje diferente).
    expect(screen.queryByText("Hubo un problema con tu pago")).not.toBeInTheDocument();
    expect(vi.mocked(getBooking)).toHaveBeenCalledTimes(1);
  });

  // test G: pending_payment → backoff exponencial 2s / 4s / ...
  //
  // Sabotaje de lógica: en poll(), cambiar
  //   timeoutId = setTimeout(() => poll(attempt + 1), nextDelayMs(attempt));
  // por
  //   timeoutId = setTimeout(() => poll(attempt + 1), 10_000);
  // Resultado: el delay fijo de 10s hace que a t=2.1s aún no haya disparado
  // el segundo poll → getBooking sigue en 1 llamada → la aserción de
  // "2 llamadas a t=2.1s" falla.
  it("pending_payment: a 1.9s hay 1 llamada; a 2.1s hay 2; a 6.1s hay 3", async () => {
    // getBooking siempre devuelve pending_payment → el poll nunca termina,
    // siempre programa el siguiente timeout.
    vi.mocked(getBooking).mockResolvedValue(makeBookingRead({ status: "pending_payment" }));

    render(<ConfirmacionContent />);

    // poll(0) se lanza de inmediato. nextDelayMs(0) = min(30000, 2000*1) = 2000ms.
    // A 1.9s: poll(0) completó (microtask), programó poll(1) a t=2000ms. No disparó aún.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_900);
    });
    expect(vi.mocked(getBooking)).toHaveBeenCalledTimes(1);

    // A 2.1s (200ms más): el setTimeout de 2000ms disparó → poll(1) → 2ª llamada.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(vi.mocked(getBooking)).toHaveBeenCalledTimes(2);

    // nextDelayMs(1) = min(30000, 2000*2) = 4000ms. poll(2) dispara a t=2000+4000=6000ms.
    // A 6.1s (4000ms más): poll(2) corrió → 3ª llamada.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(vi.mocked(getBooking)).toHaveBeenCalledTimes(3);
  });
});
