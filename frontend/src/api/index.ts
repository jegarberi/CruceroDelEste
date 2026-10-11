import type { StopRead, TripRead, SeatRead, BookingRead } from "@/types/trips"

const BASE_URL = process.env.NEXT_PUBLIC_API_URL

// El backend exige en todo POST el header X-CSRF-Token igual a una cookie
// HttpOnly que él mismo emite en GET /csrf-token. El token vive en memoria:
// nunca en localStorage ni en una cookie legible por JS.
let csrfToken: Promise<string> | null = null

function getCsrfToken(): Promise<string> {
  csrfToken ??= fetch(`${BASE_URL}/csrf-token`, { credentials: "include" })
    .then((response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      return response.json()
    })
    .then((data: { csrf_token: string }) => data.csrf_token)
    .catch((err) => {
      csrfToken = null
      throw err
    })
  return csrfToken
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const send = async () =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": await getCsrfToken() },
      body: JSON.stringify(body),
    })

  const response = await send()
  if (response.status !== 403) return response
  // La cookie pudo haberse borrado desde que pedimos el token: renovar y reintentar una vez.
  const detail = await response.clone().json().then((data) => data?.detail, () => null)
  if (detail !== "csrf_failed") return response
  csrfToken = null
  return send()
}

let stopsCache: StopRead[] | null = null
let stopsCachePromise: Promise<StopRead[]> | null = null

export async function getStops(): Promise<StopRead[]> {
  if (stopsCache !== null) return stopsCache

  if (stopsCachePromise !== null) return stopsCachePromise

  stopsCachePromise = fetch(`${BASE_URL}/stops`, { next: { revalidate: 300 } })
    .then((response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      return response.json() as Promise<StopRead[]>
    })
    .then((data) => {
      stopsCache = data
      stopsCachePromise = null
      return data
    })
    .catch((err) => {
      stopsCachePromise = null
      throw err
    })

  return stopsCachePromise
}

export async function getValidDestinations(stopId: string): Promise<StopRead[]> {
  const response = await fetch(`${BASE_URL}/stops/${stopId}/valid-destinations`)
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function searchTrips(params: {
  origin?: string
  originProvince?: string
  destination?: string
  destinationProvince?: string
  departureDate?: string
}): Promise<TripRead[]> {
  const query = new URLSearchParams()
  if (params.originProvince) query.set("origin_province", params.originProvince)
  else if (params.origin) query.set("origin", params.origin)
  if (params.destinationProvince) query.set("destination_province", params.destinationProvince)
  else if (params.destination) query.set("destination", params.destination)
  if (params.departureDate) query.set("departure_date", params.departureDate)

  const response = await fetch(`${BASE_URL}/trips?${query.toString()}`)
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function getTrip(tripId: string): Promise<TripRead> {
  const response = await fetch(`${BASE_URL}/trips/${tripId}`)
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function getTripSeats(tripId: string): Promise<SeatRead[]> {
  const response = await fetch(`${BASE_URL}/trips/${tripId}/seats`)
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function getBooking(bookingId: string, token: string): Promise<BookingRead> {
  const response = await fetch(
    `${BASE_URL}/bookings/${bookingId}?token=${encodeURIComponent(token)}`
  )
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return response.json()
}

export async function createBooking(payload: {
  trip_id: string
  contact_email: string
  seat_ids: string[]
  passengers: {
    seat_id: string
    first_name: string
    last_name: string
    dni: string
    email: string
    phone: string | null
  }[]
}): Promise<Response> {
  return postJson("/bookings", payload)
}

export async function refundRequest(bookingId: string, email: string): Promise<Response> {
  return postJson(`/bookings/${bookingId}/refund-request`, { email })
}

export async function createBookingPayment(
  bookingId: string,
  token: string,
  method: string
): Promise<Response> {
  return postJson(`/bookings/${bookingId}/payments?token=${encodeURIComponent(token)}`, { method })
}

// Solo existe en el backend cuando ENVIRONMENT != "production" (404 en producción).
export async function createDevTestPayment(amount: number, title: string): Promise<Response> {
  return postJson("/dev/payments", { amount, title })
}

// Le pide al backend que consulte ese pago en MercadoPago y confirme la reserva
// si está aprobado, sin esperar el webhook. Devuelve la reserva (BookingRead).
export async function verifyBookingPayment(
  bookingId: string,
  token: string,
  paymentId: string
): Promise<Response> {
  return postJson(
    `/bookings/${bookingId}/payments/${encodeURIComponent(paymentId)}/verify?token=${encodeURIComponent(token)}`,
    {}
  )
}

// El comprador desiste de una reserva sin pagar: sus asientos vuelven a estar
// a la venta ya, sin esperar a que venza. Devuelve la reserva (BookingRead).
export async function releaseBooking(bookingId: string, token: string): Promise<Response> {
  return postJson(`/bookings/${bookingId}/release?token=${encodeURIComponent(token)}`, {})
}
