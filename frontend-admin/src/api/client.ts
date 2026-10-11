import axios from "axios";

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,
});

// The backend rejects every non-GET request unless the X-CSRF-Token header
// matches a httpOnly cookie it issues in GET /csrf-token. The token is kept in
// memory only; a page reload fetches it again.
let csrfToken: Promise<string> | null = null;

function getCsrfToken(): Promise<string> {
  csrfToken ??= apiClient
    .get<{ csrf_token: string }>("/csrf-token")
    .then((response) => response.data.csrf_token)
    .catch((error) => {
      csrfToken = null;
      throw error;
    });
  return csrfToken;
}

apiClient.interceptors.request.use(async (config) => {
  if (!["get", "head", "options"].includes((config.method ?? "get").toLowerCase())) {
    config.headers.set("X-CSRF-Token", await getCsrfToken());
  }
  return config;
});

// Session is carried by the httpOnly `admin_token` cookie (set by
// POST /admin/login) alongside `withCredentials: true` above — there is no
// token in JS-accessible storage, and never should be (LLE-334).
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export default apiClient;
