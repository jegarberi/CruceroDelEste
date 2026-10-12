import { test as base, expect, Page } from "@playwright/test";
import { AdminApi, PASSENGER, PassengerInput, Trip } from "./api";
import { ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD, STOPS, WEB } from "./env";

export const test = base.extend<{ api: AdminApi }>({
  api: async ({}, use) => {
    const api = await AdminApi.login();
    await use(api);
    await api.dispose();
  },
});

export { expect };

// ── Sitio público ────────────────────────────────────────────────────────

export function resultsUrl(trip: Trip, passengers = 1): string {
  const q = new URLSearchParams({
    origin: STOPS.origin.name,
    destination: STOPS.destination.name,
    date: trip.date,
    passengers: String(passengers),
  });
  return `${WEB}/resultados?${q}`;
}

export function seatsUrl(trip: Trip, passengers = 1): string {
  return `${WEB}/asientos/${trip.id}?passengers=${passengers}`;
}

/** Botón de un asiento en el mapa (exacto: "1" no debe matchear "10"). */
export function seat(page: Page, number: string) {
  return page.getByRole("button", { name: number, exact: true });
}

export async function pickSeats(page: Page, numbers: string[]) {
  for (const n of numbers) await seat(page, n).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: "Datos de los pasajeros" })).toBeVisible();
}

export async function fillPassenger(page: Page, index: number, p: Partial<PassengerInput> = {}) {
  const data = { ...PASSENGER, ...p };
  await page.getByLabel("Nombres").nth(index).fill(data.first_name);
  await page.getByLabel("Apellidos").nth(index).fill(data.last_name);
  await page.getByLabel("DNI").nth(index).fill(data.dni);
  await page.getByLabel("Email").nth(index).fill(data.email);
  await page.getByLabel("Teléfono").nth(index).fill(data.phone);
}

/** Lee booking_id y token de la URL de /pago. */
export function bookingFromUrl(page: Page): { id: string; token: string } {
  const url = new URL(page.url());
  return { id: url.searchParams.get("booking_id") ?? "", token: url.searchParams.get("token") ?? "" };
}

export function confirmationUrl(b: { id: string; token: string }, status: string, paymentId?: string): string {
  const q = new URLSearchParams({ booking_id: b.id, token: b.token, status });
  if (paymentId) q.set("payment_id", paymentId);
  return `${WEB}/confirmacion?${q}`;
}

// ── Panel de administración ──────────────────────────────────────────────

export async function adminLogin(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

/** Elige una opción en un Select de shadcn/base-ui dentro del diálogo abierto. */
export async function selectOption(page: Page, comboIndex: number, option: string | RegExp) {
  await page.getByRole("dialog").getByRole("combobox").nth(comboIndex).click();
  await page.getByRole("option", { name: option }).click();
}
