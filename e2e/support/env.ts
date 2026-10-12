// Puertos del stack de e2e/docker-compose.yml.
export const API = process.env.E2E_API_URL ?? "http://localhost:8811";
export const WEB = process.env.E2E_WEB_URL ?? "http://localhost:8812";
export const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:8813";

export const ADMIN_EMAIL = "e2e-admin@example.com";
export const ADMIN_PASSWORD = "e2e-password-123";

// Paradas propias de la suite (creadas en global-setup).
export const STOPS = {
  origin: { name: "E2E Retiro", country: "AR", province: "E2E Buenos Aires" },
  otherAr: { name: "E2E Rosario", country: "AR", province: "E2E Santa Fe" },
  destination: { name: "E2E Asunción", country: "PY", province: "E2E Central" },
} as const;

export const LAYOUT_NAME = "Standard - 2 Pisos";
export const PRICE_SEMI_CAMA = 50_000;
export const PRICE_CAMA = 80_000;
