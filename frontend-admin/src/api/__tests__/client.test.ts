import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import apiClient from "@/api/client";

// Session auth is a httpOnly cookie set by POST /admin/login and sent
// automatically by the browser via `withCredentials: true` — there is no
// token in JS-accessible storage. The only client-side logic left to test is
// the response interceptor's 401 handling (redirect to /login).

type RejectedResponse = (error: unknown) => Promise<unknown>;

function responseErrorInterceptor(): RejectedResponse {
  // axios stores registered handlers on the manager; index 0 is the one
  // client.ts registers.
  const handler = (apiClient.interceptors.response as unknown as {
    handlers: { rejected: RejectedResponse }[];
  }).handlers[0];
  return handler.rejected;
}

type RequestInterceptor = (
  config: InternalAxiosRequestConfig
) => Promise<InternalAxiosRequestConfig>;

function requestInterceptor(): RequestInterceptor {
  const handler = (apiClient.interceptors.request as unknown as {
    handlers: { fulfilled: RequestInterceptor }[];
  }).handlers[0];
  return handler.fulfilled;
}

function config(method: string): InternalAxiosRequestConfig {
  return { method, headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
}

// El interceptor de request no inyecta la sesión (esa viaja en la cookie
// httpOnly): solo agrega el token CSRF que el backend exige en todo request
// que modifica datos.
describe("interceptor de request (CSRF)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no toca los GET ni pide el token", async () => {
    const get = vi.spyOn(apiClient, "get");

    const result = await requestInterceptor()(config("get"));

    expect(result.headers.has("X-CSRF-Token")).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("agrega X-CSRF-Token a POST/PATCH/PUT/DELETE pidiendo el token una sola vez", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { csrf_token: "tok-1" } });

    for (const method of ["post", "patch", "put", "delete"]) {
      const result = await requestInterceptor()(config(method));
      expect(result.headers.get("X-CSRF-Token")).toBe("tok-1");
    }

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/csrf-token");
  });
});

describe("interceptor de response (manejo de 401)", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // jsdom no implementa navegación real; reemplazamos location por un objeto
    // con href escribible para poder observar la redirección.
    // @ts-expect-error location es read-only en la definición de lib.dom
    delete window.location;
    // @ts-expect-error asignamos un stub mínimo
    window.location = { href: "", pathname: "/viajes" } as Location;
  });

  afterEach(() => {
    // @ts-expect-error restauramos la location original
    window.location = originalLocation;
  });

  it("redirige a /login ante un 401", async () => {
    const error = { response: { status: 401 } };

    await expect(responseErrorInterceptor()(error)).rejects.toBe(error);

    expect(window.location.href).toBe("/login");
  });

  it("no redirige si ya está en /login", async () => {
    window.location.pathname = "/login";
    const error = { response: { status: 401 } };

    await expect(responseErrorInterceptor()(error)).rejects.toBe(error);

    expect(window.location.href).toBe("");
  });

  it("no redirige ante errores que no son 401", async () => {
    const error = { response: { status: 500 } };

    await expect(responseErrorInterceptor()(error)).rejects.toBe(error);

    expect(window.location.href).toBe("");
  });
});
