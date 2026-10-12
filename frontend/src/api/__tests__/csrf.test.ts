import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// El token CSRF se cachea a nivel de módulo, así que cada test importa una
// copia fresca de @/api.
async function loadApi() {
  vi.resetModules();
  return import("@/api");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const PAYLOAD = { trip_id: "t1", contact_email: "a@b.c", seat_ids: [], passengers: [] };

describe("CSRF en los POST del frontend público", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pide el token una sola vez y lo manda como header, con cookies, en cada POST", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrf_token: "tok-1" }))
      .mockResolvedValueOnce(json({}, 201))
      .mockResolvedValueOnce(json({}, 201));
    const api = await loadApi();

    await api.createBooking(PAYLOAD);
    await api.refundRequest("booking-1", "a@b.c");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toMatch(/\/csrf-token$/);
    expect(tokenInit).toEqual({ credentials: "include" });
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect(init.headers["X-CSRF-Token"]).toBe("tok-1");
    }
  });

  it("si el backend rechaza el token, lo renueva y reintenta una sola vez", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrf_token: "viejo" }))
      .mockResolvedValueOnce(json({ detail: "csrf_failed" }, 403))
      .mockResolvedValueOnce(json({ csrf_token: "nuevo" }))
      .mockResolvedValueOnce(json({ id: "booking-1" }, 201));
    const api = await loadApi();

    const res = await api.createBooking(PAYLOAD);

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers["X-CSRF-Token"]).toBe("nuevo");
  });

  it("no reintenta un 403 que no es de CSRF", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrf_token: "tok-1" }))
      .mockResolvedValueOnce(json({ detail: "Forbidden" }, 403));
    const api = await loadApi();

    const res = await api.createBookingPayment("booking-1", "bad-token", "mercadopago");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
