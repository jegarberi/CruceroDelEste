import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PagoContent } from "../PagoContent";
import type { BookingRead } from "@/types/trips";

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

const getBookingMock = vi.fn();
const createBookingPaymentMock = vi.fn();
const createDevTestPaymentMock = vi.fn();

vi.mock("@/api", () => ({
  getBooking: (...args: unknown[]) => getBookingMock(...args),
  createBookingPayment: (...args: unknown[]) => createBookingPaymentMock(...args),
  createDevTestPayment: (...args: unknown[]) => createDevTestPaymentMock(...args),
}));

function booking(overrides: Partial<BookingRead> = {}): BookingRead {
  const stop = (name: string, country: "AR" | "PY") => ({
    id: name,
    name,
    country,
    province: null,
    created_at: "2026-01-01T00:00:00Z",
  });
  return {
    id: "booking-1",
    booking_code: "ERP-ABCD-2345",
    status: "pending_payment",
    contact_email: "ana@example.com",
    total_amount: 24500,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    trip: {
      id: "trip-1",
      route: { id: "route-1", origin_stop: stop("Retiro", "AR"), destination_stop: stop("Asunción", "PY") },
      departure_at: "2026-12-01T20:00:00Z",
      arrival_at: "2026-12-02T12:00:00Z",
      status: "scheduled",
    },
    passengers: [],
    ...overrides,
  };
}

describe("PagoContent", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams({ booking_id: "booking-1", token: "tok" });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("muestra el resumen y redirige a la URL que devuelve el backend al pagar", async () => {
    getBookingMock.mockResolvedValue(booking());
    createBookingPaymentMock.mockResolvedValue({
      status: 201,
      json: async () => ({ method: "mercadopago", redirect_url: "https://mp.example.com/pay" }),
    });
    Object.defineProperty(window, "location", { configurable: true, value: { href: "" } });

    render(<PagoContent />);

    expect(await screen.findByText("Reserva Nº ERP-ABCD-2345")).toBeInTheDocument();
    expect(screen.getByText("$ 24.500")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /MercadoPago/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /Continuar al pago/ }));

    await waitFor(() => expect(window.location.href).toBe("https://mp.example.com/pay"));
    expect(createBookingPaymentMock).toHaveBeenCalledWith("booking-1", "tok", "mercadopago");
  });

  it("no ofrece pagar una reserva vencida", async () => {
    getBookingMock.mockResolvedValue(booking({ expires_at: new Date(Date.now() - 60_000).toISOString() }));

    render(<PagoContent />);

    expect(await screen.findByText(/ya no se puede pagar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continuar al pago/ })).not.toBeInTheDocument();
  });

  it("muestra el error y permite reintentar si el medio de pago falla", async () => {
    getBookingMock.mockResolvedValue(booking());
    createBookingPaymentMock.mockResolvedValue({ status: 502, json: async () => ({}) });

    render(<PagoContent />);
    await userEvent.click(await screen.findByRole("button", { name: /Continuar al pago/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/No pudimos conectar/);
    expect(screen.getByRole("button", { name: /Continuar al pago/ })).toBeEnabled();
  });

  it("el panel de desarrollador solo aparece con ?dev=1 y crea un pago de prueba", async () => {
    getBookingMock.mockResolvedValue(booking());
    const { unmount } = render(<PagoContent />);
    await screen.findByText("Reserva Nº ERP-ABCD-2345");
    expect(screen.queryByText(/pago de prueba/i)).not.toBeInTheDocument();
    unmount();

    mockSearchParams = new URLSearchParams({ dev: "1" });
    createDevTestPaymentMock.mockResolvedValue({
      status: 201,
      json: async () => ({ redirect_url: "https://mp.example.com/test", sandbox_redirect_url: null }),
    });
    render(<PagoContent />);

    await userEvent.clear(screen.getByLabelText("Monto (ARS)"));
    await userEvent.type(screen.getByLabelText("Monto (ARS)"), "1500");
    await userEvent.click(screen.getByRole("button", { name: /Crear pago de prueba/ }));

    expect(await screen.findByRole("link", { name: /Abrir checkout →/ })).toHaveAttribute(
      "href",
      "https://mp.example.com/test"
    );
    expect(createDevTestPaymentMock).toHaveBeenCalledWith(1500, "Pago de prueba");
    expect(getBookingMock).toHaveBeenCalledTimes(1);
  });
});
