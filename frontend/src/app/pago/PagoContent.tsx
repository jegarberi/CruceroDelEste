"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createBookingPayment, createDevTestPayment, getBooking } from "@/api";
import { BlueButton } from "@/components/core/BlueButton";
import type { BookingRead } from "@/types/trips";

type PaymentMethodId = "mercadopago";

// Para sumar un medio de pago: agregarlo acá y al Literal de PaymentCreate en
// el backend (app/schemas/bookings.py), más su rama en POST /bookings/{id}/payments.
const PAYMENT_METHODS: { id: PaymentMethodId; label: string; description: string }[] = [
  {
    id: "mercadopago",
    label: "MercadoPago",
    description: "Tarjeta de crédito o débito, o dinero en cuenta.",
  },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; booking: BookingRead; payable: boolean };

// Misma tarjeta que el resto del sitio (ver FaqContent): blanca, borde fino, sombra suave.
const card =
  "bg-[var(--color-white)] border border-[var(--color-border)] shadow-[var(--shadow-xs)] rounded-[var(--radius-md)] p-5 flex flex-col gap-3";
const title = "font-[family-name:var(--font-display)] text-[var(--color-text-primary)] font-bold m-0";
const muted = "font-[family-name:var(--font-body)] text-[var(--color-text-muted)] text-sm m-0";
const input =
  "font-[family-name:var(--font-body)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text-primary)]";

function formatArs(amount: number): string {
  return `$ ${amount.toLocaleString("es-AR")}`;
}

function toArTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function PagoContent() {
  const searchParams = useSearchParams();
  const bookingId = searchParams.get("booking_id") ?? "";
  const token = searchParams.get("token") ?? "";
  const devMode = searchParams.get("dev") === "1";

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [method, setMethod] = useState<PaymentMethodId>(PAYMENT_METHODS[0].id);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState("");

  useEffect(() => {
    if (!bookingId || !token) return;
    let cancelled = false;
    getBooking(bookingId, token)
      .then((booking) => {
        if (cancelled) return;
        const payable =
          booking.status === "pending_payment" && new Date(booking.expires_at).getTime() > Date.now();
        setLoad({ kind: "ready", booking, payable });
      })
      .catch(() => {
        if (!cancelled) setLoad({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId, token]);

  async function handlePay() {
    setPaying(true);
    setPayError("");
    try {
      const res = await createBookingPayment(bookingId, token, method);
      if (res.status === 201) {
        const data = await res.json();
        window.location.href = data.redirect_url;
        return;
      }
      if (res.status === 409) {
        setPayError("Esta reserva venció o ya fue pagada. Volvé a buscar tu viaje.");
      } else if (res.status === 429) {
        setPayError("Demasiados intentos. Esperá un minuto y probá de nuevo.");
      } else {
        setPayError("No pudimos conectar con el medio de pago. Probá de nuevo.");
      }
    } catch {
      setPayError("No pudimos conectar con el medio de pago. Probá de nuevo.");
    }
    setPaying(false);
  }

  const hasBookingParams = Boolean(bookingId && token);

  return (
    <main
      className="bg-[var(--color-surface)] min-h-screen px-4 pb-16"
      // Deja lugar para el Navbar fijo, igual que /preguntas-frecuentes.
      style={{ paddingTop: "calc(clamp(52px, 6vw, 72px) + 32px)" }}
    >
      <div className="max-w-[640px] mx-auto flex flex-col gap-3">
        <h1 className={`${title} text-center text-[clamp(28px,5vw,40px)]`}>Pagá tu reserva</h1>
        <p className="font-[family-name:var(--font-body)] text-[var(--color-text-muted)] text-base leading-relaxed text-center m-0 mb-7">
          Revisá el resumen y elegí cómo querés pagar.
        </p>

        {!hasBookingParams && !devMode && (
          <div className={card}>
            <p className={muted}>No encontramos una reserva para pagar.</p>
            <Link href="/" className="text-[var(--color-primary)] font-semibold text-sm">
              Volver al inicio
            </Link>
          </div>
        )}

        {hasBookingParams && load.kind === "loading" && (
          <div className={card}>
            <p className={`${muted} text-center`}>Cargando tu reserva…</p>
          </div>
        )}

        {hasBookingParams && load.kind === "error" && (
          <div className={card} role="alert">
            <p className={muted}>No pudimos cargar tu reserva. Revisá el enlace o volvé a intentarlo.</p>
            <Link href="/" className="text-[var(--color-primary)] font-semibold text-sm">
              Volver al inicio
            </Link>
          </div>
        )}

        {hasBookingParams && load.kind === "ready" && (
          <>
            <div className={card}>
              <p className={muted}>Reserva Nº {load.booking.booking_code}</p>
              <p className={`${title} text-[22px]`}>
                {load.booking.trip.route.origin_stop.name} → {load.booking.trip.route.destination_stop.name}
              </p>
              <p className={muted}>
                {load.booking.passengers.length === 1
                  ? "1 pasajero"
                  : `${load.booking.passengers.length} pasajeros`}
              </p>
            </div>

            <div className="flex items-baseline justify-between bg-[var(--color-primary)] text-[var(--color-white)] rounded-[var(--radius-lg)] px-6 py-5">
              <span className="font-[family-name:var(--font-body)] text-base">Total a pagar</span>
              <span className="font-[family-name:var(--font-display)] font-bold text-[28px]">
                {formatArs(load.booking.total_amount)}
              </span>
            </div>

            {load.payable ? (
              <div className={card}>
                <h2 className={`${title} text-[17px]`}>Medio de pago</h2>
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Medio de pago">
                  {PAYMENT_METHODS.map((m) => (
                    <label
                      key={m.id}
                      className={`flex items-start gap-3 border rounded-[var(--radius-sm)] p-3 cursor-pointer ${
                        method === m.id ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"
                      }`}
                    >
                      <input
                        type="radio"
                        name="payment-method"
                        value={m.id}
                        checked={method === m.id}
                        onChange={() => setMethod(m.id)}
                        className="mt-1 accent-[var(--color-primary)]"
                      />
                      <span className="flex flex-col">
                        <span className="font-[family-name:var(--font-body)] font-semibold text-[var(--color-text-primary)]">
                          {m.label}
                        </span>
                        <span className={muted}>{m.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className={muted}>
                  Tenés hasta las {toArTime(load.booking.expires_at)} para pagar. Después los asientos se liberan.
                </p>
                {payError && (
                  <p role="alert" className="font-[family-name:var(--font-body)] text-[var(--color-accent)] text-sm m-0">
                    {payError}
                  </p>
                )}
                <BlueButton variant="blue" onClick={handlePay} disabled={paying} arrow>
                  {paying ? "Redirigiendo…" : "Continuar al pago"}
                </BlueButton>
              </div>
            ) : (
              <div className={card} role="alert">
                <p className={muted}>Esta reserva ya no se puede pagar: venció o ya fue pagada.</p>
                <Link href="/" className="text-[var(--color-primary)] font-semibold text-sm">
                  Buscar otro viaje
                </Link>
              </div>
            )}
          </>
        )}

        {devMode && <DevPaymentPanel />}
      </div>
    </main>
  );
}

// Herramienta de desarrollo (/pago?dev=1): crea un checkout de MercadoPago por
// un monto libre, sin reserva. El backend solo expone el endpoint fuera de producción.
function DevPaymentPanel() {
  const searchParams = useSearchParams();
  const [amount, setAmount] = useState("1000");
  const [description, setDescription] = useState("Pago de prueba");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<{ redirect_url: string; sandbox_redirect_url: string | null } | null>(null);

  // MercadoPago vuelve a esta misma URL con el resultado en la query.
  const returned = ["status", "payment_id", "external_reference"]
    .map((key) => [key, searchParams.get(key)] as const)
    .filter(([, value]) => value);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError("");
    setLinks(null);
    try {
      const res = await createDevTestPayment(Number(amount), description);
      if (res.status === 201) {
        setLinks(await res.json());
      } else if (res.status === 404) {
        setError("No disponible en este entorno: el backend corre con ENVIRONMENT=production.");
      } else if (res.status === 422) {
        setError("Monto o descripción inválidos.");
      } else {
        setError(`MercadoPago o el backend respondieron con error (HTTP ${res.status}).`);
      }
    } catch {
      setError("No se pudo contactar al backend.");
    }
    setCreating(false);
  }

  // Borde punteado rojo: es una herramienta interna, no parte del flujo de compra.
  return (
    <div className={`${card} border-dashed`} style={{ borderColor: "var(--color-accent)" }}>
      <h2 className={`${title} text-lg`}>Desarrollador · pago de prueba</h2>
      <p className={muted}>Crea un checkout de MercadoPago por un monto libre, sin reserva.</p>

      {returned.length > 0 && (
        <p className={muted}>
          MercadoPago devolvió: {returned.map(([key, value]) => `${key}=${value}`).join(" · ")}
        </p>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3">
        <label className={`${muted} flex flex-col gap-1`}>
          Monto (ARS)
          <input
            type="number"
            min={1}
            step={1}
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={input}
          />
        </label>
        <label className={`${muted} flex flex-col gap-1`}>
          Descripción
          <input
            type="text"
            required
            maxLength={120}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={input}
          />
        </label>
        <BlueButton variant="navy" type="submit" disabled={creating}>
          {creating ? "Creando…" : "Crear pago de prueba"}
        </BlueButton>
      </form>

      {error && (
        <p role="alert" className="font-[family-name:var(--font-body)] text-[var(--color-accent)] text-sm m-0">
          {error}
        </p>
      )}

      {links && (
        <div className="flex flex-col gap-2">
          <a href={links.redirect_url} className="text-[var(--color-primary)] font-semibold text-sm">
            Abrir checkout →
          </a>
          {links.sandbox_redirect_url && (
            <a href={links.sandbox_redirect_url} className="text-[var(--color-primary)] font-semibold text-sm">
              Abrir checkout sandbox →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
