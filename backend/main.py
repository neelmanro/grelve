import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

_root = Path(__file__).resolve().parent
load_dotenv(_root / ".env")
load_dotenv(_root / ".env.local", override=True)

API_V1_PREFIX = os.getenv("API_V1_PREFIX", "/api/v1").strip() or "/api/v1"
PROJECT_NAME = os.getenv("PROJECT_NAME", "jinoe API").strip() or "jinoe API"
_cors = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
)
CORS_ORIGIN_LIST = [o.strip() for o in _cors.split(",") if o.strip()]

app = FastAPI(title=PROJECT_NAME, version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGIN_LIST,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get(f"{API_V1_PREFIX}/health", tags=["health"], summary="Liveness check")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {"service": PROJECT_NAME, "docs": "/docs"}
