# jinoe

Monorepo with a **Next.js** (React, TypeScript) frontend and a **FastAPI** Python API.

## Structure

| Path        | Role                                      |
| ----------- | ----------------------------------------- |
| `frontend/` | Next.js App Router, Tailwind CSS v4       |
| `backend/`  | FastAPI in `main.py`, routes under `/api/v1` |

## Prerequisites

- Node.js 20+
- Python 3.11+

## Run locally

**1. API (terminal 1)**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for interactive OpenAPI.

**2. Web (terminal 2)**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The home page uses `API_URL` from `.env` / `.env.local` (server-side) to call the health endpoint.

## Environment

- `frontend/.env` and `frontend/.env.local` — set `API_URL` to the FastAPI base (default `http://127.0.0.1:8000`).
- `backend/.env` and `backend/.env.local` — optional overrides for `API_V1_PREFIX`, `PROJECT_NAME`, and comma-separated `CORS_ORIGINS`.

## Scripts

| Location   | Command        | Description        |
| ---------- | -------------- | ------------------ |
| `frontend` | `npm run dev`  | Next.js dev server |
| `frontend` | `npm run build`| Production build   |
| `backend`  | `uvicorn main:app --reload` | API with hot reload |
