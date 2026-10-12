import apiClient from "./client";
import type { CountryEnum, StopRead } from "@/types/trips";

export async function getStops(): Promise<StopRead[]> {
  // GET /stops es público y sale con Cache-Control max-age=300 (pensado para el
  // sitio). Sin esto el navegador le devuelve al admin la lista vieja durante
  // 5 minutos y una parada recién creada o borrada no se ve. El parámetro
  // cambia en cada pedido y el backend lo ignora.
  const response = await apiClient.get<StopRead[]>("/stops", { params: { _: Date.now() } });
  return response.data;
}

export async function createStop(data: {
  name: string;
  country: CountryEnum;
  province?: string;
}): Promise<StopRead> {
  const response = await apiClient.post<StopRead>("/admin/stops", data);
  return response.data;
}

export async function deleteStop(id: string): Promise<void> {
  await apiClient.delete(`/admin/stops/${id}`);
}

export async function updateStop(
  id: string,
  data: { name?: string; country?: CountryEnum; province?: string }
): Promise<StopRead> {
  const response = await apiClient.patch<StopRead>(`/admin/stops/${id}`, data);
  return response.data;
}
