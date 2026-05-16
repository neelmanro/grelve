const DEFAULT_API = "http://127.0.0.1:8000";

/** Base URL for server-side calls to FastAPI (`API_URL` in `.env` / `.env.local`). */
export function getApiBaseUrl(): string {
  const url = process.env.API_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  return DEFAULT_API;
}

/** Base URL for browser calls to FastAPI (`NEXT_PUBLIC_API_URL` in `.env.local`). */
export function getPublicApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  return DEFAULT_API;
}
