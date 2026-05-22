# Grelve frontend

Next.js App Router UI for the Grelve orchestrator. Product details: [grelve.com](https://grelve.com/).

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Planning chat and six-step workflow |
| `/build?runId=…` | Build waves and agent activity |
| `/preview?runId=…` | Start and open local app preview |

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `NEXT_PUBLIC_API_URL` to your FastAPI origin (default `http://127.0.0.1:8000`).

Full stack instructions: [../README.md](../README.md).
