import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / ".env.local", override=True)


def env(name: str, default: str) -> str:
    return os.getenv(name, default).strip() or default


API_PREFIX = env("API_V1_PREFIX", "/api/v1")
PROJECT_NAME = env("PROJECT_NAME", "jinoe API")
GROQ_MODEL = env("GROQ_TRANSLATION_MODEL", "whisper-large-v3")

CORS_ORIGINS = [
    origin.strip()
    for origin in env(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]


app = FastAPI(title=PROJECT_NAME, version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranscribeResponse(BaseModel):
    text: str


@app.get(f"{API_PREFIX}/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post(f"{API_PREFIX}/transcribe", response_model=TranscribeResponse, tags=["speech"])
async def transcribe(audio: UploadFile = File(...)) -> TranscribeResponse:
    api_key = env("GROQ_API_KEY", "")

    if not api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is missing.")

    audio_bytes = await audio.read()

    if len(audio_bytes) < 32:
        raise HTTPException(status_code=400, detail="Audio file is empty or too short.")

    filename = audio.filename or "recording.webm"
    client = Groq(api_key=api_key)

    try:
        result = client.audio.translations.create(
            file=(filename, audio_bytes),
            model=GROQ_MODEL,
            response_format="json",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Groq translation failed: {exc}",
        ) from exc

    return TranscribeResponse(text=(result.text or "").strip())


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": PROJECT_NAME,
        "docs": "/docs",
    }