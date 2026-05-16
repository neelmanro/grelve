# Frontend

Next.js (App Router, TypeScript, Tailwind CSS v4).

Full-stack run instructions are in the **repository root** `README.md`.

```bash
npm install
npm run dev
```

Environment: `API_URL` in `.env` and `.env.local` (server-side fetch to FastAPI). For **browser** calls (e.g. voice transcription), set `NEXT_PUBLIC_API_URL` to your FastAPI origin (defaults to `http://127.0.0.1:8000`).
