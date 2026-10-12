# Pruebas E2E (Playwright)

Corren contra un stack propio (`docker-compose.yml` de esta carpeta), aislado
del de desarrollo: otra base (en memoria), otros puertos (8811–8813).

```bash
npm install
npx playwright install chromium
npm run stack:up     # construye y levanta backend, frontends y Postgres
npm test             # las 5 suites; el reporte queda en playwright-report/
npm run stack:down
```

Después de cambiar código de la app hay que volver a correr `npm run stack:up`
(los frontends se compilan dentro de la imagen).

| Suite | Cubre |
|---|---|
| `usuario.spec.ts` | Landing, buscador, regla AR↔PY, resultados y filtros |
| `compra.spec.ts` | Asientos, datos del pasajero, reserva, pago, concurrencia |
| `cancelacion.spec.ts` | Pago abandonado, liberar asientos, rechazo, vencimiento |
| `devolucion.spec.ts` | Botón de arrepentimiento y reembolsos |
| `admin.spec.ts` | Login, catálogo, viajes, tramos, asientos, reservas |

## Lo que no se prueba de punta a punta

- **El pago en MercadoPago.** Ocurre en su sitio. La prueba llega hasta la
  redirección al checkout; para lo que sigue, `support/db.ts` deja la reserva
  como la dejaría un pago real (`confirmBooking`).
- **El reembolso dentro de plazo.** Necesita un pago real que devolver. Se
  prueba el camino en que MercadoPago lo rechaza; el exitoso queda en los tests
  de integración del backend.

El stack usa el `MERCADOPAGO_ACCESS_TOKEN` de `backend/.env` solo para crear la
preferencia. Emails, webhooks y límites de pedidos están desactivados.
