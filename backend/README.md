# API

Single-file FastAPI app: `main.py`. Loads `.env` then `.env.local` from this directory.

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
