import { defineConfig, devices } from "@playwright/test";

// Un solo worker: todas las pruebas comparten la base del stack E2E y varias
// tocan estado global (paradas, reservas, la corrida del job de expiración).
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
