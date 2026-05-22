const DEFAULT_API = "http://127.0.0.1:8000";

/** Base URL for browser calls to FastAPI (`NEXT_PUBLIC_API_URL` in `.env.local`). */
export function getPublicApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  return DEFAULT_API;
}
