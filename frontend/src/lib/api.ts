/** Base URL for server-side calls to FastAPI (`API_URL` in `.env` / `.env.local`). */
export function getApiBaseUrl(): string {
  const url = process.env.API_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  return "http://127.0.0.1:8000";
}
