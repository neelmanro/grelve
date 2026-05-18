from __future__ import annotations

import asyncio
import difflib
import glob as globlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel, Field


#################################
# Configuration
#################################

BASE_DIR = Path(__file__).resolve().parent
RUNS_DIR = BASE_DIR / ".shipyard_runs"
SKILLS_DIR = BASE_DIR / "agent_skills"

load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / ".env.local", override=True)


def env(name: str, default: str) -> str:
    return os.getenv(name, default).strip() or default


MAX_AGENT_TURNS = int(env("SHIPYARD_MAX_AGENT_TURNS", "500"))
MAX_FILE_READ_BYTES = 2_000_000
MAX_FILE_WRITE_BYTES = 2_000_000
MAX_COMMAND_SECONDS = 120
SKIP_DIRS = frozenset({".git", ".next", ".turbo", ".venv", "venv", "node_modules", "dist", "build", "__pycache__", ".tmp", ".home"})
API_PREFIX = env("API_V1_PREFIX", "/api/v1")
PROJECT_NAME = env("PROJECT_NAME", "jinoe API")
GROQ_MODEL = env("GROQ_TRANSLATION_MODEL", "whisper-large-v3")
# Shipyard agents: OpenAI-compatible chat completions (default DeepSeek, non-reasoning chat model).
DEEPSEEK_BASE_URL = env("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = env("DEEPSEEK_MODEL", "deepseek-chat")
CODE_SERVER_IMAGE = env("SHIPYARD_CODE_SERVER_IMAGE", "jinoe-shipyard-code-server:latest")
EDITOR_BIND_HOST = env("SHIPYARD_EDITOR_BIND_HOST", "127.0.0.1")
EDITOR_PUBLIC_HOST = env("SHIPYARD_EDITOR_PUBLIC_HOST", "127.0.0.1")
EDITOR_PORT_BASE = int(env("SHIPYARD_EDITOR_PORT_BASE", "43000"))
CORS_ORIGINS = [
    origin.strip()
    for origin in env(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]

RUNS_DIR.mkdir(parents=True, exist_ok=True)

#################################
# END Configuration
#################################


#################################
# FastAPI App
#################################

app = FastAPI(title=PROJECT_NAME, version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get(f"{API_PREFIX}/health", tags=["health"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": PROJECT_NAME,
        "docs": "/docs",
    }

#################################
# END FastAPI App
#################################


#################################
# Speech Transcription
#################################

class TranscribeResponse(BaseModel):
    text: str


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

#################################
# END Speech Transcription
#################################


#################################
# Shipyard API Models
#################################

class ShipyardStack(BaseModel):
    frontend: Literal["Next.js TypeScript React"] = "Next.js TypeScript React"
    backend: Literal["FastAPI"] = "FastAPI"
    database: Literal["SQLite"] = "SQLite"


class ShipyardRunCreate(BaseModel):
    prompt: str = Field(min_length=3, max_length=20_000)
    stack: ShipyardStack = Field(default_factory=ShipyardStack)


class ShipyardRunCreated(BaseModel):
    run_id: str
    stream_url: str


@dataclass
class ShipyardRun:
    id: str
    prompt: str
    stack: ShipyardStack
    root_path: Path
    workspace_path: Path
    status: str = "queued"
    error: str | None = None
    stream_started: bool = False
    build_started: bool = False
    preview: dict[str, Any] | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


SHIPYARD_RUNS: dict[str, ShipyardRun] = {}

#################################
# END Shipyard API Models
#################################


#################################
# Shipyard Routes
#################################

@app.post(
    f"{API_PREFIX}/shipyard/runs",
    response_model=ShipyardRunCreated,
    tags=["shipyard"],
)
def create_shipyard_run(payload: ShipyardRunCreate) -> ShipyardRunCreated:
    run_id = uuid4().hex
    run_root = RUNS_DIR / run_id
    workspace = run_root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    run = ShipyardRun(
        id=run_id,
        prompt=payload.prompt.strip(),
        stack=payload.stack,
        root_path=run_root,
        workspace_path=workspace,
    )
    SHIPYARD_RUNS[run_id] = run

    return ShipyardRunCreated(
        run_id=run.id,
        stream_url=f"{API_PREFIX}/shipyard/runs/{run.id}/stream",
    )


@app.get(f"{API_PREFIX}/shipyard/runs/{{run_id}}/stream", tags=["shipyard"])
async def stream_shipyard_run(run_id: str) -> StreamingResponse:
    run = SHIPYARD_RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Shipyard run not found.")

    return StreamingResponse(
        run_shipyard_planning_workflow(run),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get(f"{API_PREFIX}/shipyard/runs/{{run_id}}/build-stream", tags=["shipyard"])
async def stream_shipyard_build(run_id: str) -> StreamingResponse:
    run = SHIPYARD_RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Shipyard run not found.")
    if run.status not in {"planning_done", "done"}:
        raise HTTPException(status_code=409, detail="Planning must finish before building.")

    return StreamingResponse(
        run_shipyard_build_workflow(run),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

#################################
# END Shipyard Routes
#################################


#################################
# Shipyard Workflow
#################################

@dataclass(frozen=True)
class ShipyardAgentTask:
    name: str
    instructions: str
    max_turns: int
    wave: int | None = None
    todos: tuple[str, ...] = ()


@dataclass(frozen=True)
class ShipyardPlanningStep:
    name: str
    skill: str
    output: str
    inputs: tuple[str, ...] = ()


SHIPYARD_PLANNING_SYSTEM = """You are a Shipyard planning agent running one deterministic planning step.

The backend has already loaded your skill instructions and every prior planning artifact you need.
Do not ask for tools, files, or follow-up questions.
Do not mention backend orchestration.
Write only the requested markdown artifact for this step.

Reliability rules:
- Use the provided skill instructions as the contract for your output.
- Treat prior artifacts as source-of-truth context.
- Do not invent scope beyond the user prompt and prior artifacts.
- Preserve the fixed MVP stack: Next.js TypeScript React frontend, FastAPI backend, SQLite database.
- Preserve the fixed UI brand rules: white background, black text, yellow #E3F848 for primary buttons and accents.
- Return markdown only."""


SHIPYARD_TASK_SYSTEM = """You are a Shipyard coding agent running one focused task inside an isolated workspace.

Use tools to do real work. Do not pretend.

Interaction rules:
- Start by writing a short natural update to the user.
- Use one tool call per assistant turn.
- After each tool result, continue with the full context in the next turn.
- If you are writing markdown or code, call the relevant write tool so the UI can stream the file content and then show the diff.
- Do not ask follow-up questions.
- Do not access files outside the assigned workspace.
- Keep the fixed MVP stack: Next.js TypeScript React frontend, FastAPI backend, SQLite database.
- Use the fixed UI brand rules whenever you touch frontend: white background, black text, yellow #E3F848 for primary buttons and accents.
- If this task has todos, call update_todos before starting work and whenever a todo moves to in_progress or completed.
- Call finish_task when this task is complete."""


PLANNING_STEPS: tuple[ShipyardPlanningStep, ...] = (
    ShipyardPlanningStep(
        name="Intake Agent",
        skill="intake_skill.md",
        output="docs/intake.md",
    ),
    ShipyardPlanningStep(
        name="Product Brief Agent",
        skill="product_brief_skill.md",
        output="docs/product_brief.md",
        inputs=("docs/intake.md",),
    ),
    ShipyardPlanningStep(
        name="System Design Agent",
        skill="system_design_skill.md",
        output="docs/system_design.md",
        inputs=("docs/intake.md", "docs/product_brief.md"),
    ),
    ShipyardPlanningStep(
        name="API Contract Agent",
        skill="api_contract_skill.md",
        output="docs/api_contract.md",
        inputs=("docs/intake.md", "docs/product_brief.md", "docs/system_design.md"),
    ),
    ShipyardPlanningStep(
        name="Task Breakdown Agent",
        skill="task_breakdown_skill.md",
        output="docs/task_breakdown.md",
        inputs=("docs/intake.md", "docs/product_brief.md", "docs/system_design.md", "docs/api_contract.md"),
    ),
)


REPO_SETUP_TASK = ShipyardAgentTask(
    name="Repo Setup Agent",
    max_turns=MAX_AGENT_TURNS,
    instructions=(
        "Your task is Repo Setup. First read repo_setup_skill.md and tools_skill.md with read_skill in separate turns. "
        "Then read docs/intake.md, docs/product_brief.md, docs/system_design.md, docs/api_contract.md, and docs/task_breakdown.md with read_artifact. "
        "Use workspace tools to create the planning-ready starter repo only. You are a setup agent, not an implementation agent. "
        "Create folders, manifests, config, placeholder modules, health/status scaffolding, README, AGENTS.md, and setup reports. "
        "Do not implement product models, product routes, API contract endpoints, external service calls, database CRUD, typed product API clients, product tests, or real UI workflows. "
        "Do not execute the agent work orders in docs/task_breakdown.md; only reference them in AGENTS.md and the setup report for future agents. "
        "The backend has already mirrored planning artifacts into workspace/docs. Do not rewrite, recopy, overwrite, or edit docs/intake.md, "
        "docs/product_brief.md, docs/system_design.md, docs/api_contract.md, or docs/task_breakdown.md. "
        "Run setup-level verification commands only. If a check fails because product behavior is missing, report it instead of implementing the product. "
        "Finally write docs/repo_setup_report.md with write_artifact and finish."
    ),
)


SHIPYARD_BUILD_WAVES: list[tuple[str, tuple[ShipyardAgentTask, ...]]] = [
    (
        "Foundation",
        (
            ShipyardAgentTask(
                name="Backend Data Agent",
                wave=1,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Read planning docs and owned backend files",
                    "Create SQLite data layer and schema models",
                    "Add seed/init helpers without UI work",
                    "Run backend syntax checks",
                ),
                instructions=(
                    "Build phase task: Backend Data only. Read docs/intake.md, docs/product_brief.md, docs/system_design.md, "
                    "docs/api_contract.md, and docs/task_breakdown.md. Inspect backend files only. Own backend/app/database.py, "
                    "backend/app/models.py, backend/app/schemas.py, and backend/app/services/*. Do not edit frontend files or API route files unless needed for imports. "
                    "Create the data/schema foundation from the API contract. If AI features are required by the contract, add backend/.env.example with OPENAI_API_KEY placeholder. "
                    "Run python syntax checks where possible."
                ),
            ),
            ShipyardAgentTask(
                name="Frontend Shell Agent",
                wave=1,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Read planning docs and frontend scaffold",
                    "Create app shell and shared layout",
                    "Apply fixed white/black/yellow brand system",
                    "Run frontend checks if dependencies exist",
                ),
                instructions=(
                    "Build phase task: Frontend Shell only. Read docs/intake.md, docs/product_brief.md, docs/system_design.md, "
                    "docs/api_contract.md, and docs/task_breakdown.md. Own frontend/src/app/layout.tsx, frontend/src/app/globals.css, "
                    "frontend/src/components/* shell components, and frontend/src/types/*. Do not edit backend files. "
                    "Create a clean app shell using white background, black text, and yellow #E3F848 primary accents. No marketing hero, no extra palette."
                ),
            ),
        ),
    ),
    (
        "Core Product",
        (
            ShipyardAgentTask(
                name="Backend API Agent",
                wave=2,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Read API contract and backend data files",
                    "Implement required FastAPI routes",
                    "Add validation and standard errors",
                    "Run backend checks",
                ),
                instructions=(
                    "Build phase task: Backend API only. Read all planning docs, then inspect backend/app. Own backend/app/main.py, "
                    "backend/app/routes/*, and backend/tests/*. Do not edit frontend files. Implement REST endpoints exactly from docs/api_contract.md. "
                    "Use the existing data/schema files instead of inventing a second model layer."
                ),
            ),
            ShipyardAgentTask(
                name="Frontend Feature Agent",
                wave=2,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Read API contract and frontend shell",
                    "Build main feature views",
                    "Add empty/loading/error UI states",
                    "Preserve fixed brand rules",
                ),
                instructions=(
                    "Build phase task: Frontend Feature UI only. Read all planning docs, then inspect frontend files. Own frontend/src/app/page.tsx "
                    "and frontend/src/components/* feature components. Do not edit backend files or API client files. Build the core workflow screens from the brief. "
                    "Use white background, black text, yellow #E3F848 primary actions, and a minimal business-focused UI."
                ),
            ),
        ),
    ),
    (
        "API Connection",
        (
            ShipyardAgentTask(
                name="Frontend API Integration Agent",
                wave=3,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Read frontend views and API contract",
                    "Create typed API client",
                    "Connect views to backend routes",
                    "Run frontend checks",
                ),
                instructions=(
                    "Build phase task: Frontend API Integration only. Own frontend/src/lib/*, frontend/src/types/*, and small edits in frontend/src/app/page.tsx "
                    "needed to wire API calls. Do not edit backend implementation. Match docs/api_contract.md exactly and handle loading, empty, and error states."
                ),
            ),
        ),
    ),
    (
        "Integration",
        (
            ShipyardAgentTask(
                name="Integration Agent",
                wave=4,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Inspect frontend and backend together",
                    "Fix contract drift",
                    "Run available backend and frontend checks",
                    "Write integration notes",
                ),
                instructions=(
                    "Build phase task: Integration. Read all docs and inspect both frontend and backend. You may edit frontend and backend files only to fix mismatches "
                    "between the API contract and implementation. Do not add new product scope. Run available checks and write docs/integration_report.md."
                ),
            ),
        ),
    ),
    (
        "Review",
        (
            ShipyardAgentTask(
                name="Review Agent",
                wave=5,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Review code against planning docs",
                    "Check tests, edge cases, and UX states",
                    "Fix small high-confidence issues",
                    "Write review report",
                ),
                instructions=(
                    "Build phase task: Review. Act like a code review plus QA agent. Read all docs, inspect the repo, run available checks, and fix small obvious issues. "
                    "Look for contract drift, missing error states, fragile validation, and AI slop UI. Keep brand rules intact. Write docs/review_report.md."
                ),
            ),
        ),
    ),
    (
        "Deploy Preview",
        (
            ShipyardAgentTask(
                name="Deploy Preview Agent",
                wave=6,
                max_turns=MAX_AGENT_TURNS,
                todos=(
                    "Verify run commands",
                    "Check backend terminal command",
                    "Check frontend terminal command",
                    "Write preview instructions",
                ),
                instructions=(
                    "Build phase task: Deploy Preview. Verify the project has two clear terminal commands: one for FastAPI backend "
                    "and one for Next.js frontend. If AI features are required, make sure backend/.env.example documents OPENAI_API_KEY or the exact provider key. "
                    "Call start_editor_server to launch the Docker/code-server editor for the generated workspace. If Docker is unavailable, continue and publish editor_url as empty. "
                    "Publish preview metadata with publish_preview, including frontend_url, backend_url, env_required, env_notes, and the exact two terminal commands. "
                    "Then write docs/deploy_preview.md with the same instructions and known issues. Do not leave long-running commands active inside run_command."
                ),
            ),
        ),
    ),
]


async def run_shipyard_planning_workflow(run: ShipyardRun) -> AsyncGenerator[str, None]:
    if run.stream_started:
        yield sse(event("error", message="This Shipyard run has already been started. Create a new run."))
        return

    run.stream_started = True
    run.status = "planning"
    try:
        (run.root_path / "artifacts").mkdir(parents=True, exist_ok=True)
        async for payload in run_shipyard_tasks(run):
            yield sse(payload)

        run.status = "planning_done"
        yield sse(event("done", run_id=run.id, phase="planning"))
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        yield sse(event("error", message=str(exc)))


async def run_shipyard_build_workflow(run: ShipyardRun) -> AsyncGenerator[str, None]:
    if run.build_started:
        yield sse(event("error", message="Build has already been started for this run."))
        return

    run.build_started = True
    run.status = "building"
    try:
        for wave_number, (wave_title, tasks) in enumerate(SHIPYARD_BUILD_WAVES, start=1):
            yield sse(event("wave_start", wave=wave_number, title=wave_title))
            async for payload in run_shipyard_wave(run, wave_number, wave_title, tasks):
                yield sse(payload)
            yield sse(event("wave_done", wave=wave_number, title=wave_title))

        run.status = "done"
        yield sse(event("done", run_id=run.id, phase="build"))
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)
        yield sse(event("error", message=str(exc)))


async def run_shipyard_tasks(run: ShipyardRun) -> AsyncGenerator[dict[str, Any], None]:
    for step in PLANNING_STEPS:
        task = planning_task(step)
        yield task_event(task, "agent_start")
        async for payload in run_shipyard_planning_step(run, step):
            yield with_task_meta(task, payload)
        yield task_event(task, "agent_done")

    yield task_event(REPO_SETUP_TASK, "agent_start")
    async for payload in run_shipyard_task(run, REPO_SETUP_TASK):
        yield with_task_meta(REPO_SETUP_TASK, payload)
    yield task_event(REPO_SETUP_TASK, "agent_done")


async def run_shipyard_wave(
    run: ShipyardRun,
    wave_number: int,
    wave_title: str,
    tasks: tuple[ShipyardAgentTask, ...],
) -> AsyncGenerator[dict[str, Any], None]:
    queue: asyncio.Queue[dict[str, Any] | BaseException | None] = asyncio.Queue()

    async def pump(task: ShipyardAgentTask) -> None:
        try:
            await queue.put(task_event(task, "agent_start", wave=wave_number, wave_title=wave_title))
            if task.todos:
                await queue.put(task_event(task, "todo_update", wave=wave_number, wave_title=wave_title, todos=initial_todos(task)))
            async for payload in run_shipyard_task(run, task):
                await queue.put(with_task_meta(task, payload, wave=wave_number, wave_title=wave_title))
            await queue.put(task_event(task, "agent_done", wave=wave_number, wave_title=wave_title))
        except BaseException as exc:  # noqa: BLE001 - preserve task failure in the stream.
            await queue.put(exc)
        finally:
            await queue.put(None)

    workers = [asyncio.create_task(pump(task)) for task in tasks]
    finished = 0
    try:
        while finished < len(workers):
            item = await queue.get()
            if item is None:
                finished += 1
                continue
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        for worker in workers:
            if not worker.done():
                worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)


def task_event(task: ShipyardAgentTask, event_type: str, **extra: Any) -> dict[str, Any]:
    return with_task_meta(task, event(event_type), **extra)


def initial_todos(task: ShipyardAgentTask) -> list[dict[str, str]]:
    return [
        {"id": f"todo-{index}", "content": content, "status": "pending"}
        for index, content in enumerate(task.todos, start=1)
    ]


def with_task_meta(task: ShipyardAgentTask, payload: dict[str, Any], **extra: Any) -> dict[str, Any]:
    enriched = {**payload, "agent": task.name, **extra}
    if task.wave is not None:
        enriched.setdefault("wave", task.wave)
    return enriched


def planning_task(step: ShipyardPlanningStep) -> ShipyardAgentTask:
    return ShipyardAgentTask(
        name=step.name,
        max_turns=1,
        instructions=f"Write {step.output} from {step.skill} and fixed prior inputs.",
    )


async def run_shipyard_planning_step(
    run: ShipyardRun,
    step: ShipyardPlanningStep,
) -> AsyncGenerator[dict[str, Any], None]:
    messages = build_planning_step_messages(run, step)
    tool_id = f"planning-write-{normalize_event_id(step.output)}"
    content_parts: list[str] = []
    last_tool_delta_length = 0

    yield event(
        "tool_start",
        id=tool_id,
        name="write_artifact",
        input={"path": step.output, "content": ""},
    )

    async for chunk in stream_llm_text(messages, temperature=0.2):
        if not chunk:
            continue
        content_parts.append(chunk)
        content = "".join(content_parts)
        yield text_delta(chunk)

        # Keep the planning preview live without sending a full JSON payload for every tiny token.
        if len(content) - last_tool_delta_length >= 240 or "\n" in chunk:
            last_tool_delta_length = len(content)
            yield event(
                "tool_delta",
                id=tool_id,
                name="write_artifact",
                arguments=json.dumps({"path": step.output, "content": content}, ensure_ascii=False),
                arguments_delta=chunk,
            )

    raw_content = "".join(content_parts)
    content = normalize_planning_artifact(raw_content)
    if not content.strip():
        raise RuntimeError(f"{step.name} produced an empty artifact for {step.output}.")

    if content != raw_content or len(content) != last_tool_delta_length:
        yield event(
            "tool_delta",
            id=tool_id,
            name="write_artifact",
            arguments=json.dumps({"path": step.output, "content": content}, ensure_ascii=False),
            arguments_delta="",
        )

    result = tool_write_artifact(run, {"path": step.output, "content": content})
    mirror_planning_artifact_to_workspace(run, step.output, content)
    if isinstance(result.get("diff"), str) and result["diff"]:
        yield event("file_diff", path=result.get("path"), diff=result["diff"])
    yield event(
        "tool_result",
        id=tool_id,
        name="write_artifact",
        ok=bool(result.get("ok")),
        detail=summarize_tool_result(result),
        result=trim_tool_result(result),
    )


async def run_shipyard_task(run: ShipyardRun, task: ShipyardAgentTask) -> AsyncGenerator[dict[str, Any], None]:
    messages = build_task_messages(run, task)
    tools = shipyard_tool_specs()

    for _turn in range(1, task.max_turns + 1):
        message: dict[str, Any] | None = None
        async for model_event in stream_llm_with_tools(messages, tools=tools, temperature=0.2):
            if model_event.get("type") == "content_delta":
                content = str(model_event.get("content") or "")
                if content:
                    yield text_delta(content)
            elif model_event.get("type") == "tool_call_delta":
                # The model can occasionally emit several tool calls in one assistant turn.
                # This runner executes one tool per turn, so only stream the first call's
                # partial arguments to the UI; otherwise unexecuted calls appear as stuck
                # "running" rows until a later turn.
                if model_event.get("index") not in (None, 0):
                    continue
                yield event(
                    "tool_delta",
                    id=str(model_event.get("id") or ""),
                    name=str(model_event.get("name") or ""),
                    arguments=str(model_event.get("arguments") or ""),
                    arguments_delta=str(model_event.get("arguments_delta") or ""),
                )
            elif model_event.get("type") == "message" and isinstance(model_event.get("message"), dict):
                message = model_event["message"]
            await asyncio.sleep(0)

        if message is None:
            raise RuntimeError("Model stream ended without an assistant message.")

        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list) or not tool_calls:
            messages.append(format_assistant_message_for_history(message))
            raise RuntimeError(f"{task.name} stopped without calling finish_task.")
        if len(tool_calls) > 1:
            message = {**message, "tool_calls": tool_calls[:1]}
            tool_calls = tool_calls[:1]
        messages.append(format_assistant_message_for_history(message))

        for tool_call in tool_calls:
            tool_id, tool_name, args = parse_tool_call(tool_call)
            yield event("tool_start", id=tool_id, name=tool_name, input=args)

            if tool_name == "run_command":
                result: dict[str, Any] = {"ok": False, "error": "Command did not finish."}
                async for command_event in execute_run_command_stream(run, args):
                    if command_event.get("event") == "tool_log":
                        yield {**command_event, "id": tool_id, "name": tool_name}
                    elif command_event.get("event") == "tool_result":
                        result = command_event.get("result") if isinstance(command_event.get("result"), dict) else result
                yield event(
                    "tool_result",
                    id=tool_id,
                    name=tool_name,
                    ok=bool(result.get("ok")),
                    detail=summarize_tool_result(result),
                    result=trim_tool_result(result),
                )
            else:
                result = await execute_shipyard_tool(run, tool_name, args)
                if isinstance(result.get("diff"), str) and result["diff"]:
                    yield event("file_diff", path=result.get("path"), diff=result["diff"])
                if tool_name == "update_todos" and isinstance(result.get("todos"), list):
                    yield event("todo_update", todos=result["todos"])
                if tool_name == "publish_preview" and result.get("ok"):
                    yield event("preview_ready", preview=result)
                if tool_name == "start_editor_server" and result.get("ok"):
                    yield event("editor_ready", editor=result)
                yield event(
                    "tool_result",
                    id=tool_id,
                    name=tool_name,
                    ok=bool(result.get("ok")),
                    detail=summarize_tool_result(result),
                    result=trim_tool_result(result),
                )

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "name": tool_name,
                    "content": json.dumps(trim_tool_result(result), ensure_ascii=False, default=str),
                }
            )

            if tool_name == "finish_task" and result.get("ok"):
                return

            break

    raise RuntimeError(f"{task.name} stopped after {task.max_turns} turns.")


def build_task_messages(run: ShipyardRun, task: ShipyardAgentTask) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SHIPYARD_TASK_SYSTEM},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "task_name": task.name,
                    "task_instructions": task.instructions,
                    "user_prompt": run.prompt,
                    "selected_stack": run.stack.model_dump(),
                    "workspace": str(run.workspace_path),
                    "available_artifacts": list_artifact_paths(run),
                    "todo_seed": initial_todos(task),
                },
                ensure_ascii=False,
            ),
        },
    ]


def build_planning_step_messages(run: ShipyardRun, step: ShipyardPlanningStep) -> list[dict[str, Any]]:
    skill_content = read_skill(step.skill)
    input_artifacts = {
        path: read_artifact_text(run, path)
        for path in step.inputs
    }
    return [
        {"role": "system", "content": SHIPYARD_PLANNING_SYSTEM},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "task_name": step.name,
                    "skill_file": step.skill,
                    "skill_instructions": skill_content,
                    "output_path": step.output,
                    "user_prompt": run.prompt,
                    "selected_stack": run.stack.model_dump(),
                    "input_artifacts": input_artifacts,
                },
                ensure_ascii=False,
            ),
        },
    ]


def read_artifact_text(run: ShipyardRun, path: str) -> str:
    target = safe_artifact_path(run, path)
    if not target.is_file():
        raise RuntimeError(f"Required planning artifact is missing before this step: {path}")
    return target.read_text(encoding="utf-8", errors="replace")


def mirror_planning_artifact_to_workspace(run: ShipyardRun, path: str, content: str) -> None:
    if not path.startswith("docs/") or not path.endswith(".md"):
        raise RuntimeError(f"Planning artifact mirror path must be docs/*.md: {path}")
    target = safe_workspace_path(run, path, require_file_shape=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def list_artifact_paths(run: ShipyardRun) -> list[str]:
    artifacts_root = run.root_path / "artifacts"
    if not artifacts_root.is_dir():
        return []
    return [f"docs/{path.relative_to(artifacts_root).as_posix()}" for path in sorted(artifacts_root.rglob("*.md"))]


#################################
# END Shipyard Workflow
#################################



#################################
# Shipyard Agent Tools
#################################

def shipyard_tool_specs() -> list[dict[str, Any]]:
    def spec(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required or [],
                    "additionalProperties": False,
                },
            },
        }

    path_prop = {"type": "string", "description": "Relative path inside the generated workspace or artifacts area."}
    todo_prop = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "content": {"type": "string"},
                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
            },
            "required": ["id", "content", "status"],
            "additionalProperties": False,
        },
    }
    return [
        spec("read_skill", "Read one Shipyard agent skill from backend/agent_skills.", {"name": path_prop}, ["name"]),
        spec("write_artifact", "Create or replace a markdown planning artifact under docs/.", {"path": path_prop, "content": {"type": "string"}}, ["path", "content"]),
        spec("read_artifact", "Read a markdown planning artifact previously written by the agent.", {"path": path_prop}, ["path"]),
        spec("list_files", "List files and folders inside the generated workspace.", {"path": path_prop, "max_entries": {"type": "integer"}}, []),
        spec("glob", "Find files and folders by glob pattern inside the generated workspace.", {"pattern": {"type": "string"}, "path": path_prop, "max_entries": {"type": "integer"}}, ["pattern"]),
        spec("grep", "Search text files inside the generated workspace with a regular expression.", {"pattern": {"type": "string"}, "path": path_prop, "glob": {"type": "string"}, "max_matches": {"type": "integer"}}, ["pattern"]),
        spec("read_file", "Read a UTF-8 text file from the generated workspace.", {"path": path_prop, "offset": {"type": "integer"}, "limit": {"type": "integer"}, "max_bytes": {"type": "integer"}}, ["path"]),
        spec("write_file", "Create or replace a UTF-8 text file in the generated workspace.", {"path": path_prop, "content": {"type": "string"}}, ["path", "content"]),
        spec("edit_file", "Replace one exact text region in an existing workspace file.", {"path": path_prop, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, ["path", "old_text", "new_text"]),
        spec("delete_file", "Delete one file inside the generated workspace.", {"path": path_prop}, ["path"]),
        spec("move_file", "Move or rename one file inside the generated workspace.", {"source": path_prop, "destination": path_prop}, ["source", "destination"]),
        spec("run_command", "Run a bounded terminal command from a relative cwd inside the generated workspace.", {"command": {"type": "string"}, "cwd": path_prop, "timeout_seconds": {"type": "integer"}}, ["command"]),
        spec("update_todos", "Publish the current checklist for this agent.", {"todos": todo_prop}, ["todos"]),
        spec("start_editor_server", "Start or restart a Docker code-server editor for the generated workspace.", {"restart": {"type": "boolean"}}, []),
        spec(
            "publish_preview",
            "Publish final editor and preview handoff metadata for the UI.",
            {
                "editor_url": {"type": "string"},
                "preview_url": {"type": "string"},
                "frontend_url": {"type": "string"},
                "backend_url": {"type": "string"},
                "backend_command": {"type": "string"},
                "frontend_command": {"type": "string"},
                "env_required": {"type": "boolean"},
                "env_notes": {"type": "string"},
            },
            ["preview_url", "frontend_url", "backend_url", "backend_command", "frontend_command", "env_required", "env_notes"],
        ),
        spec("finish_task", "Mark the current Shipyard task complete.", {"summary": {"type": "string"}}, ["summary"]),
    ]


async def execute_shipyard_tool(run: ShipyardRun, name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "read_skill":
            return tool_read_skill(args)
        if name == "write_artifact":
            return tool_write_artifact(run, args)
        if name == "read_artifact":
            return tool_read_artifact(run, args)
        if name == "list_files":
            return tool_list_files(run, args)
        if name == "glob":
            return tool_glob(run, args)
        if name == "grep":
            return tool_grep(run, args)
        if name == "read_file":
            return tool_read_file(run, args)
        if name == "write_file":
            return tool_write_file(run, args)
        if name == "edit_file":
            return tool_edit_file(run, args)
        if name == "delete_file":
            return tool_delete_file(run, args)
        if name == "move_file":
            return tool_move_file(run, args)
        if name == "update_todos":
            return tool_update_todos(args)
        if name == "start_editor_server":
            return tool_start_editor_server(run, args)
        if name == "publish_preview":
            return tool_publish_preview(run, args)
        if name == "finish_task":
            return {"ok": True, "summary": str(args.get("summary") or "Shipyard task complete.")}
        return {"ok": False, "error": f"Unknown tool: {name}"}
    except Exception as exc:  # noqa: BLE001 - tool errors must return to the agent.
        return {"ok": False, "error": str(exc)}


def tool_read_skill(args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    content = read_skill(name)
    return {"ok": True, "name": name, "content": content}


def tool_update_todos(args: dict[str, Any]) -> dict[str, Any]:
    raw_todos = args.get("todos")
    if not isinstance(raw_todos, list):
        raise ValueError("update_todos requires a todos array.")
    todos = []
    for index, raw_item in enumerate(raw_todos, start=1):
        if not isinstance(raw_item, dict):
            raise ValueError("Each todo must be an object.")
        content = str(raw_item.get("content") or "").strip()
        if not content:
            raise ValueError("Each todo needs content.")
        status = str(raw_item.get("status") or "pending")
        if status not in {"pending", "in_progress", "completed"}:
            raise ValueError("Todo status must be pending, in_progress, or completed.")
        todo_id = str(raw_item.get("id") or f"todo-{index}").strip()
        todos.append({"id": todo_id, "content": content, "status": status})
    return {"ok": True, "todos": todos}


def tool_start_editor_server(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    restart = bool(args.get("restart"))
    docker = shutil.which("docker")
    if not docker:
        return {
            "ok": False,
            "editor_url": "",
            "error": "Docker is not available. Start Docker Desktop, then run the editor step again.",
        }

    dockerfile = (BASE_DIR.parent / "docker" / "jinoe-workspace" / "Dockerfile").resolve(strict=False)
    if not dockerfile.is_file():
        return {"ok": False, "editor_url": "", "error": f"Missing code-server Dockerfile: {dockerfile}"}

    container = f"jinoe-shipyard-editor-{run.id[:12]}"
    if restart:
        run_local_command([docker, "rm", "-f", container], cwd=run.workspace_path, timeout=60, check=False)

    if container_running(docker, container):
        port = editor_port_for_run(run)
        editor_url = editor_url_for_port(port)
        if wait_for_http(editor_health_url(port), timeout_seconds=8):
            return {
                "ok": True,
                "editor_url": editor_url,
                "container_name": container,
                "port": port,
                "message": "Editor is already running.",
            }
        run_local_command([docker, "rm", "-f", container], cwd=run.workspace_path, timeout=60, check=False)

    image_exists = run_local_command([docker, "image", "inspect", CODE_SERVER_IMAGE], cwd=BASE_DIR.parent, timeout=30, check=False)
    if not image_exists["ok"]:
        build = run_local_command(
            [docker, "build", "-t", CODE_SERVER_IMAGE, "-f", str(dockerfile), str(dockerfile.parent)],
            cwd=BASE_DIR.parent,
            timeout=900,
            check=False,
        )
        if not build["ok"]:
            return {
                "ok": False,
                "editor_url": "",
                "error": f"Could not build code-server image. {build.get('output', '')[-1200:]}",
            }

    port = find_editor_port(run)
    chown = run_local_command(
        [
            docker,
            "run",
            "--rm",
            "-v",
            f"{run.workspace_path}:/home/coder/project",
            "--user",
            "root",
            CODE_SERVER_IMAGE,
            "sh",
            "-lc",
            "chown -R coder:coder /home/coder/project",
        ],
        cwd=run.workspace_path,
        timeout=120,
        check=False,
    )
    if not chown["ok"]:
        return {
            "ok": False,
            "editor_url": "",
            "error": f"Could not prepare editor workspace permissions. {chown.get('output', '')[-1200:]}",
        }

    run_local_command([docker, "rm", "-f", container], cwd=run.workspace_path, timeout=60, check=False)
    started = run_local_command(
        [
            docker,
            "run",
            "-d",
            "--name",
            container,
            "-p",
            f"{EDITOR_BIND_HOST}:{port}:8080",
            "-v",
            f"{run.workspace_path}:/home/coder/project",
            "-w",
            "/home/coder/project",
            CODE_SERVER_IMAGE,
            "code-server",
            "--auth",
            "none",
            "--bind-addr",
            "0.0.0.0:8080",
            "/home/coder/project",
        ],
        cwd=run.workspace_path,
        timeout=120,
        check=False,
    )
    if not started["ok"]:
        return {
            "ok": False,
            "editor_url": "",
            "error": f"Could not start code-server editor. {started.get('output', '')[-1200:]}",
        }

    if not wait_for_http(editor_health_url(port), timeout_seconds=45):
        run_local_command([docker, "rm", "-f", container], cwd=run.workspace_path, timeout=60, check=False)
        return {"ok": False, "editor_url": "", "error": "The editor container started but did not become ready."}

    return {
        "ok": True,
        "editor_url": editor_url_for_port(port),
        "container_name": container,
        "port": port,
        "message": "Editor is ready.",
    }


def tool_publish_preview(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    preview = {
        "ok": True,
        "editor_url": str(args.get("editor_url") or "").strip(),
        "preview_url": str(args.get("preview_url") or "").strip(),
        "frontend_url": str(args.get("frontend_url") or "").strip(),
        "backend_url": str(args.get("backend_url") or "").strip(),
        "backend_command": str(args.get("backend_command") or "").strip(),
        "frontend_command": str(args.get("frontend_command") or "").strip(),
        "env_required": bool(args.get("env_required")),
        "env_notes": str(args.get("env_notes") or "").strip(),
    }
    if not preview["preview_url"]:
        raise ValueError("publish_preview requires preview_url.")
    if not preview["frontend_url"]:
        raise ValueError("publish_preview requires frontend_url.")
    if not preview["backend_url"]:
        raise ValueError("publish_preview requires backend_url.")
    if not preview["backend_command"] or not preview["frontend_command"]:
        raise ValueError("publish_preview requires both backend_command and frontend_command.")
    run.preview = preview
    return preview


def tool_write_artifact(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    raw_path = str(args.get("path") or "").strip()
    content = str(args.get("content") or "")
    assert_write_size(content)
    if not raw_path.startswith("docs/") or not raw_path.endswith(".md"):
        raise ValueError("Artifacts must be markdown files under docs/.")
    target = safe_artifact_path(run, raw_path)
    previous = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    diff = unified_diff(raw_path, previous, content)
    added = sum(1 for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff.splitlines() if line.startswith("-") and not line.startswith("---"))
    return {
        "ok": True,
        "name": Path(raw_path).name,
        "path": raw_path,
        "content": content,
        "changed": previous != content,
        "added": added,
        "removed": removed,
        "diff": diff,
    }


def tool_read_artifact(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    raw_path = str(args.get("path") or "").strip()
    target = safe_artifact_path(run, raw_path)
    if not target.is_file():
        raise ValueError(f"Artifact does not exist: {raw_path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    return {"ok": True, "path": raw_path, "content": content}


def tool_list_files(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    base = safe_workspace_path(run, str(args.get("path") or "."), allow_root=True)
    if not base.is_dir():
        raise ValueError("list_files requires a directory path.")
    max_entries = bounded_int(args.get("max_entries"), default=120, minimum=1, maximum=500)
    entries = []
    for child in sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name in SKIP_DIRS:
            continue
        entries.append({"path": display_workspace_path(run, child), "type": "directory" if child.is_dir() else "file"})
        if len(entries) >= max_entries:
            break
    return {"ok": True, "entries": entries, "count": len(entries)}


def tool_glob(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    pattern = str(args.get("pattern") or "").strip()
    if not pattern:
        raise ValueError("glob requires a pattern.")
    base = safe_workspace_path(run, str(args.get("path") or "."), allow_root=True)
    if not base.is_dir():
        raise ValueError("glob requires a directory search base.")
    max_entries = bounded_int(args.get("max_entries"), default=200, minimum=1, maximum=1000)
    matches = []
    for raw_match in sorted(globlib.glob(pattern, root_dir=base, recursive=True)):
        candidate = (base / raw_match).resolve(strict=False)
        try:
            rel = candidate.relative_to(run.workspace_path.resolve())
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        matches.append(display_workspace_path(run, candidate))
        if len(matches) >= max_entries:
            break
    return {"ok": True, "matches": matches, "count": len(matches)}


def tool_grep(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    pattern = str(args.get("pattern") or "")
    if not pattern:
        raise ValueError("grep requires a pattern.")
    regex = re.compile(pattern)
    base = safe_workspace_path(run, str(args.get("path") or "."), allow_root=True)
    if not base.is_dir():
        raise ValueError("grep requires a directory search base.")
    max_matches = bounded_int(args.get("max_matches"), default=80, minimum=1, maximum=300)
    glob_value = str(args.get("glob") or "**/*").strip() or "**/*"
    matches = []
    for path in sorted(base.glob(glob_value)):
        if len(matches) >= max_matches:
            break
        if path.is_dir() or any(part in SKIP_DIRS for part in path.relative_to(run.workspace_path).parts):
            continue
        try:
            data = path.read_bytes()
            if b"\x00" in data[:2048]:
                continue
            lines = data.decode("utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_no, line in enumerate(lines, start=1):
            match = regex.search(line)
            if match:
                matches.append(f"{display_workspace_path(run, path)}:{line_no}:{match.start() + 1}:{line}")
                if len(matches) >= max_matches:
                    break
    return {"ok": True, "matches": matches, "count": len(matches)}


def tool_read_file(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    target = safe_workspace_path(run, str(args.get("path") or ""))
    if not target.is_file():
        raise ValueError("read_file requires an existing file.")
    max_bytes = bounded_int(args.get("max_bytes"), default=MAX_FILE_READ_BYTES, minimum=1, maximum=MAX_FILE_READ_BYTES)
    data = target.read_bytes()
    truncated_bytes = len(data) > max_bytes
    data = data[:max_bytes]
    if b"\x00" in data:
        raise ValueError("read_file cannot preview binary files.")
    lines = data.decode("utf-8", errors="replace").splitlines()
    offset = bounded_int(args.get("offset"), default=1, minimum=1, maximum=max(1, len(lines) + 1))
    limit = bounded_int(args.get("limit"), default=240, minimum=1, maximum=1000)
    selected = lines[offset - 1 : offset - 1 + limit]
    content = "\n".join(f"{line_no}|{line}" for line_no, line in enumerate(selected, start=offset))
    return {
        "ok": True,
        "path": display_workspace_path(run, target),
        "content": content,
        "line_count": len(lines),
        "offset": offset,
        "truncated": truncated_bytes or offset - 1 + limit < len(lines),
    }


def tool_write_file(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    content = str(args.get("content") or "")
    assert_write_size(content)
    target = safe_workspace_path(run, str(args.get("path") or ""), require_file_shape=True)
    previous = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return write_result(run, target, previous, content)


def tool_edit_file(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    target = safe_workspace_path(run, str(args.get("path") or ""), require_file_shape=True)
    if not target.is_file():
        raise ValueError("edit_file requires an existing file.")
    old_text = str(args.get("old_text") or "")
    new_text = str(args.get("new_text") or "")
    if not old_text:
        raise ValueError("edit_file old_text cannot be empty.")
    previous = target.read_text(encoding="utf-8", errors="replace")
    matches = previous.count(old_text)
    if matches != 1:
        raise ValueError(f"edit_file old_text must match exactly once; found {matches}.")
    updated = previous.replace(old_text, new_text, 1)
    assert_write_size(updated)
    target.write_text(updated, encoding="utf-8")
    return {**write_result(run, target, previous, updated), "replacements": 1}


def tool_delete_file(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    target = safe_workspace_path(run, str(args.get("path") or ""), require_file_shape=True)
    if not target.is_file():
        raise ValueError("delete_file only deletes existing files.")
    target.unlink()
    return {"ok": True, "path": display_workspace_path(run, target), "deleted": True}


def tool_move_file(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    source = safe_workspace_path(run, str(args.get("source") or ""), require_file_shape=True)
    destination = safe_workspace_path(run, str(args.get("destination") or ""), require_file_shape=True)
    if not source.is_file():
        raise ValueError("move_file requires an existing source file.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"ok": True, "source": display_workspace_path(run, source), "destination": display_workspace_path(run, destination)}


async def execute_run_command_stream(run: ShipyardRun, args: dict[str, Any]) -> AsyncGenerator[dict[str, Any], None]:
    try:
        command_meta = prepare_workspace_command(run, args)
    except Exception as exc:  # noqa: BLE001
        yield event("tool_result", result={"ok": False, "error": str(exc)})
        return

    process = await asyncio.create_subprocess_exec(
        *command_meta["argv"],
        cwd=str(command_meta["cwd_path"]),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=command_meta["env"],
    )
    output_parts: list[str] = []
    observed_chars = 0
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def drain(stream_name: str, reader: asyncio.StreamReader | None) -> None:
        nonlocal observed_chars
        if reader is None:
            return
        while True:
            chunk = await reader.read(1024)
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace")
            if observed_chars < 40_000:
                remaining = 40_000 - observed_chars
                kept = text[:remaining]
                if kept:
                    output_parts.append(kept)
                    observed_chars += len(kept)
            await queue.put(event("tool_log", stream=stream_name, chunk=text))

    stdout_task = asyncio.create_task(drain("stdout", process.stdout))
    stderr_task = asyncio.create_task(drain("stderr", process.stderr))
    wait_task = asyncio.create_task(process.wait())
    timed_out = False
    deadline = asyncio.get_running_loop().time() + float(command_meta["timeout"])

    try:
        while True:
            if wait_task.done() and stdout_task.done() and stderr_task.done() and queue.empty():
                break
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                timed_out = True
                process.kill()
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=min(0.15, remaining))
            except asyncio.TimeoutError:
                continue
            yield item
        return_code = await process.wait() if timed_out else await wait_task
    finally:
        for task in (stdout_task, stderr_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    output = "".join(output_parts).strip() or "(no output)"
    if observed_chars >= 40_000:
        output = f"{output}\n\n[output truncated]"
    yield event(
        "tool_result",
        result={
            "ok": return_code == 0 and not timed_out,
            "command": command_meta["command"],
            "cwd": command_meta["cwd"],
            "exit_code": return_code,
            "timed_out": timed_out,
            "output": output,
        },
    )


def prepare_workspace_command(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    command = str(args.get("command") or "").strip()
    if not command:
        raise ValueError("run_command requires a command.")
    assert_safe_command(command)
    cwd = str(args.get("cwd") or ".").strip() or "."
    cwd_path = safe_workspace_path(run, cwd, allow_root=True)
    if not cwd_path.is_dir():
        raise ValueError("run_command cwd must be an existing directory.")
    timeout = bounded_int(args.get("timeout_seconds"), default=MAX_COMMAND_SECONDS, minimum=1, maximum=MAX_COMMAND_SECONDS)
    home = run.workspace_path / ".home"
    tmp = run.workspace_path / ".tmp"
    home.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)
    env_vars = {
        **os.environ,
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "npm_config_cache": str(home / ".npm"),
        "PIP_CACHE_DIR": str(home / ".pip"),
    }
    return {
        "argv": ["sh", "-lc", command],
        "command": command,
        "cwd": cwd,
        "cwd_path": cwd_path,
        "timeout": timeout,
        "env": env_vars,
    }


def safe_workspace_path(
    run: ShipyardRun,
    raw: str,
    *,
    allow_root: bool = False,
    require_file_shape: bool = False,
) -> Path:
    cleaned = str(raw or "").strip().replace("\\", "/")
    if "\x00" in cleaned or cleaned.startswith("/"):
        raise ValueError("Path must stay inside the generated workspace.")
    if not cleaned or cleaned == ".":
        if not allow_root:
            raise ValueError("A file path is required.")
        return run.workspace_path.resolve()
    if any(part == ".." for part in cleaned.split("/")):
        raise ValueError("Path traversal is not allowed.")
    if require_file_shape and cleaned.endswith("/"):
        raise ValueError("A file path is required, not a directory path.")
    target = (run.workspace_path / cleaned).resolve(strict=False)
    target.relative_to(run.workspace_path.resolve())
    if ".git" in target.relative_to(run.workspace_path.resolve()).parts:
        raise ValueError("Direct .git access is not allowed.")
    return target


def safe_artifact_path(run: ShipyardRun, raw: str) -> Path:
    cleaned = str(raw or "").strip().replace("\\", "/")
    if "\x00" in cleaned or cleaned.startswith("/") or any(part == ".." for part in cleaned.split("/")):
        raise ValueError("Artifact path must stay inside the run artifact area.")
    if not cleaned.startswith("docs/"):
        raise ValueError("Artifact path must start with docs/.")
    target = (run.root_path / "artifacts" / cleaned.removeprefix("docs/")).resolve(strict=False)
    target.relative_to((run.root_path / "artifacts").resolve())
    return target


def display_workspace_path(run: ShipyardRun, path: Path) -> str:
    rendered = path.resolve(strict=False).relative_to(run.workspace_path.resolve()).as_posix()
    return rendered if rendered != "." else "."


def unified_diff(path: str, previous: str, updated: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            previous.splitlines(),
            updated.splitlines(),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            lineterm="",
        )
    )


def write_result(run: ShipyardRun, target: Path, previous: str, updated: str) -> dict[str, Any]:
    path = display_workspace_path(run, target)
    diff = unified_diff(path, previous, updated)
    added = sum(1 for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff.splitlines() if line.startswith("-") and not line.startswith("---"))
    return {"ok": True, "path": path, "changed": previous != updated, "added": added, "removed": removed, "diff": diff}


#################################
# END Shipyard Agent Tools
#################################


#################################
# LLM Helpers
#################################

async def complete_llm(
    messages: list[dict[str, Any]],
    *,
    temperature: float,
) -> str:
    message = await complete_llm_message(messages, tools=None, temperature=temperature)
    return str(message.get("content") or "").strip()


async def complete_llm_message(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    temperature: float,
) -> dict[str, Any]:
    if not env("DEEPSEEK_API_KEY", ""):
        raise RuntimeError("DEEPSEEK_API_KEY is required for Shipyard agents.")
    return await complete_openai_chat_message(messages=messages, tools=tools, temperature=temperature)


async def stream_llm_text(
    messages: list[dict[str, Any]],
    *,
    temperature: float,
) -> AsyncGenerator[str, None]:
    if not env("DEEPSEEK_API_KEY", ""):
        raise RuntimeError("DEEPSEEK_API_KEY is required for Shipyard agents.")
    async for chunk in stream_openai_chat_text(messages=messages, temperature=temperature):
        yield chunk


async def stream_llm_with_tools(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]],
    temperature: float,
) -> AsyncGenerator[dict[str, Any], None]:
    if not env("DEEPSEEK_API_KEY", ""):
        raise RuntimeError("DEEPSEEK_API_KEY is required for Shipyard agents.")
    async for item in stream_openai_chat_message(messages=messages, tools=tools, temperature=temperature):
        yield item


async def stream_openai_chat_message(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    temperature: float,
) -> AsyncGenerator[dict[str, Any], None]:
    queue: asyncio.Queue[dict[str, Any] | Exception | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def worker() -> None:
        content_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        tool_call_prefix = f"tool-call-{uuid4().hex}"
        try:
            payload = build_openai_chat_payload(messages=messages, tools=tools, temperature=temperature, stream=True)
            request = build_openai_chat_request(payload)
            with urllib.request.urlopen(request, timeout=180) as response:
                while True:
                    raw_line = response.readline()
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        parsed = json.loads(data)
                        delta = parsed["choices"][0].get("delta", {})
                    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                        continue
                    if not isinstance(delta, dict):
                        continue
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        content_parts.append(content)
                        loop.call_soon_threadsafe(queue.put_nowait, {"type": "content_delta", "content": content})
                    for tool_delta in merge_tool_call_deltas(tool_calls, delta.get("tool_calls"), tool_call_prefix):
                        loop.call_soon_threadsafe(queue.put_nowait, {"type": "tool_call_delta", **tool_delta})
            loop.call_soon_threadsafe(
                queue.put_nowait,
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": "".join(content_parts),
                        "tool_calls": finished_tool_calls(tool_calls),
                    },
                },
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            loop.call_soon_threadsafe(queue.put_nowait, RuntimeError(f"LLM request failed ({exc.code}): {detail}"))
        except Exception as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    worker_task = asyncio.create_task(asyncio.to_thread(worker))
    try:
        while True:
            item = await queue.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise RuntimeError(str(item)) from item
            yield item
    finally:
        await worker_task


async def complete_openai_chat_message(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float,
) -> dict[str, Any]:
    payload = build_openai_chat_payload(messages=messages, tools=tools, temperature=temperature, stream=False)
    data = await asyncio.to_thread(post_openai_chat_json, payload)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("LLM returned no choices.")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise RuntimeError("LLM returned an invalid message.")
    return normalize_openai_message(message)


async def stream_openai_chat_text(
    *,
    messages: list[dict[str, Any]],
    temperature: float,
) -> AsyncGenerator[str, None]:
    queue: asyncio.Queue[str | Exception | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def worker() -> None:
        try:
            payload = build_openai_chat_payload(messages=messages, tools=None, temperature=temperature, stream=True)
            request = build_openai_chat_request(payload)
            with urllib.request.urlopen(request, timeout=180) as response:
                while True:
                    raw_line = response.readline()
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        parsed = json.loads(data)
                        content = parsed["choices"][0].get("delta", {}).get("content")
                    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                        content = None
                    if content:
                        loop.call_soon_threadsafe(queue.put_nowait, str(content))
        except Exception as exc:  # noqa: BLE001 - surfaced into the SSE stream.
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    worker_task = asyncio.create_task(asyncio.to_thread(worker))
    try:
        while True:
            item = await queue.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise RuntimeError(f"LLM stream failed: {item}") from item
            yield item
    finally:
        await worker_task


def build_openai_chat_payload(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float,
    stream: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": float(temperature),
        "stream": stream,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def post_openai_chat_json(payload: dict[str, Any]) -> dict[str, Any]:
    request = build_openai_chat_request(payload)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM request failed ({exc.code}): {detail}") from exc
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise RuntimeError("LLM returned invalid JSON.")
    return data


def build_openai_chat_request(payload: dict[str, Any]) -> urllib.request.Request:
    api_key = env("DEEPSEEK_API_KEY", "")
    url = f"{DEEPSEEK_BASE_URL.rstrip('/')}/chat/completions"
    return urllib.request.Request(
        url=url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if payload.get("stream") else "application/json",
        },
        method="POST",
    )


def normalize_openai_message(message: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {
        "role": "assistant",
        "content": str(message.get("content") or ""),
    }
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list):
        normalized["tool_calls"] = [
            call for call in tool_calls if isinstance(call, dict)
        ]
    return normalized


def merge_tool_call_deltas(
    tool_calls: dict[int, dict[str, Any]],
    deltas: Any,
    call_id_prefix: str,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not isinstance(deltas, list):
        return events
    for fallback_index, raw_delta in enumerate(deltas):
        delta = tool_delta_to_dict(raw_delta)
        raw_index = delta.get("index")
        index = raw_index if isinstance(raw_index, int) else fallback_index
        current = tool_calls.setdefault(
            index,
            {
                "id": f"{call_id_prefix}-{index}",
                "type": "function",
                "function": {"name": "", "arguments": ""},
            },
        )
        if isinstance(delta.get("type"), str):
            current["type"] = delta["type"]
        function_delta = delta.get("function")
        if not isinstance(function_delta, dict):
            continue
        function = current.setdefault("function", {"name": "", "arguments": ""})
        if isinstance(function_delta.get("name"), str) and function_delta["name"]:
            function["name"] = function_delta["name"]
        arguments_delta = ""
        if isinstance(function_delta.get("arguments"), str):
            arguments_delta = function_delta["arguments"]
            function["arguments"] = str(function.get("arguments") or "") + arguments_delta
        events.append(
            {
                "id": str(current.get("id") or f"tool-call-{index}"),
                "index": index,
                "name": str(function.get("name") or ""),
                "arguments": str(function.get("arguments") or ""),
                "arguments_delta": arguments_delta,
            }
        )
    return events


def tool_delta_to_dict(raw_delta: Any) -> dict[str, Any]:
    if isinstance(raw_delta, dict):
        delta = dict(raw_delta)
    else:
        delta = {
            "index": getattr(raw_delta, "index", None),
            "id": getattr(raw_delta, "id", None),
            "type": getattr(raw_delta, "type", None),
            "function": getattr(raw_delta, "function", None),
        }
    function = delta.get("function")
    if function is not None and not isinstance(function, dict):
        delta["function"] = {
            "name": getattr(function, "name", None),
            "arguments": getattr(function, "arguments", None),
        }
    return delta


def finished_tool_calls(tool_calls: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    finished: list[dict[str, Any]] = []
    for index in sorted(tool_calls):
        call = tool_calls[index]
        function = call.get("function")
        if not isinstance(function, dict) or not function.get("name"):
            continue
        finished.append(
            {
                "id": str(call.get("id") or f"tool-call-{index}"),
                "type": str(call.get("type") or "function"),
                "function": {
                    "name": str(function.get("name") or ""),
                    "arguments": str(function.get("arguments") or ""),
                },
            }
        )
    return finished


def parse_tool_call(tool_call: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    function = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
    tool_id = str(tool_call.get("id") or uuid4().hex)
    tool_name = str(function.get("name") or "")
    raw_args = str(function.get("arguments") or "{}")
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    return tool_id, tool_name, args


def format_assistant_message_for_history(message: dict[str, Any]) -> dict[str, Any]:
    formatted = {
        "role": "assistant",
        "content": message.get("content") or "",
    }
    if isinstance(message.get("tool_calls"), list):
        formatted["tool_calls"] = message["tool_calls"]
    return formatted

#################################
# END LLM Helpers
#################################


#################################
# Shared Helpers
#################################

def sse(payload: dict[str, Any] | str) -> str:
    if isinstance(payload, str):
        return f"data: {payload}\n\n"
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def event(event_type: str, **payload: Any) -> dict[str, Any]:
    return {"event": event_type, **payload}


def text_delta(text: str) -> dict[str, str]:
    return {"event": "markdown_delta", "content": text}


def normalize_event_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-")
    return cleaned or uuid4().hex


def normalize_planning_artifact(content: str) -> str:
    normalized = content.strip()
    fence_match = re.fullmatch(r"```(?:md|markdown)?\s*\n(.*?)\n```", normalized, flags=re.DOTALL | re.IGNORECASE)
    if fence_match:
        normalized = fence_match.group(1).strip()
    return f"{normalized}\n"


def read_skill(filename: str) -> str:
    path = (SKILLS_DIR / filename).resolve(strict=False)
    path.relative_to(SKILLS_DIR.resolve())
    if not path.is_file():
        raise RuntimeError(f"Missing agent skill: {filename}")
    return path.read_text(encoding="utf-8")


def chunk_text(text: str, size: int = 900) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks = []
    current = ""
    for paragraph in text.splitlines(keepends=True):
        if len(current) + len(paragraph) > size and current:
            chunks.append(current)
            current = ""
        current += paragraph
    if current:
        chunks.append(current)
    return chunks


def bounded_int(raw: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def assert_write_size(content: str) -> None:
    if len(content.encode("utf-8")) > MAX_FILE_WRITE_BYTES:
        raise ValueError(f"File write is too large. Limit is {MAX_FILE_WRITE_BYTES} bytes.")


def assert_safe_command(command: str) -> None:
    blocked_fragments = ("..", "$HOME", "${HOME}", "/Users/", "/private/", "/System/", "/Library/")
    if any(fragment in command for fragment in blocked_fragments):
        raise ValueError("Command must stay inside the generated workspace.")

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as exc:
        raise ValueError(f"Command could not be parsed safely: {exc}") from exc

    for token in tokens:
        if token.startswith(("http://", "https://")):
            continue
        if token.startswith(("/", "~")):
            raise ValueError("Command must use relative workspace paths only.")


def trim_tool_result(result: dict[str, Any], limit: int = 35_000) -> dict[str, Any]:
    raw = json.dumps(result, ensure_ascii=False, default=str)
    if len(raw) <= limit:
        return result
    trimmed = dict(result)
    for key in ("output", "content", "diff"):
        if isinstance(trimmed.get(key), str) and len(trimmed[key]) > 8_000:
            trimmed[key] = trimmed[key][-8_000:] + "\n[trimmed]"
    return trimmed


def summarize_tool_result(result: dict[str, Any]) -> str:
    if not result.get("ok"):
        return str(result.get("error") or "Tool failed.")
    if result.get("path") and result.get("changed") is not None:
        changed = "changed" if result.get("changed") else "unchanged"
        return f"{result['path']} {changed}."
    if result.get("deleted"):
        return f"Deleted {result.get('path')}."
    if result.get("source") and result.get("destination"):
        return f"Moved {result['source']} to {result['destination']}."
    if result.get("command"):
        return f"Command exited {result.get('exit_code')}."
    if isinstance(result.get("matches"), list):
        return f"Found {result.get('count', len(result['matches']))} matches."
    if isinstance(result.get("entries"), list):
        return f"Listed {result.get('count', len(result['entries']))} entries."
    if result.get("line_count") is not None:
        return f"Read {result.get('path')} from line {result.get('offset', 1)}."
    return "Tool completed."


def run_local_command(
    argv: list[str],
    *,
    cwd: Path,
    timeout: int,
    check: bool = True,
) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = "\n".join(part for part in [exc.stdout, exc.stderr] if isinstance(part, str)).strip()
        return {"ok": False, "exit_code": None, "timed_out": True, "output": output or "Command timed out."}
    output = "\n".join(part for part in [completed.stdout, completed.stderr] if part).strip()
    ok = completed.returncode == 0
    if check and not ok:
        raise RuntimeError(output or f"Command failed: {' '.join(argv)}")
    return {
        "ok": ok,
        "exit_code": completed.returncode,
        "timed_out": False,
        "output": output,
    }


def container_running(docker: str, name: str) -> bool:
    result = run_local_command(
        [docker, "inspect", "-f", "{{.State.Running}}", name],
        cwd=BASE_DIR,
        timeout=20,
        check=False,
    )
    return result["ok"] and str(result.get("output") or "").strip() == "true"


def editor_port_for_run(run: ShipyardRun) -> int:
    offset = int(run.id[:8], 16) % 10_000
    return EDITOR_PORT_BASE + offset


def find_editor_port(run: ShipyardRun) -> int:
    start = editor_port_for_run(run)
    for offset in range(200):
        port = start + offset
        if port <= 65535 and host_port_free(EDITOR_BIND_HOST, port):
            return port
    raise RuntimeError("No free editor port found. Close another editor and try again.")


def host_port_free(host: str, port: int) -> bool:
    bind_host = host if host not in {"0.0.0.0", "::", ""} else "127.0.0.1"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((bind_host, port))
            return True
        except OSError:
            return False


def editor_url_for_port(port: int) -> str:
    return f"http://{EDITOR_PUBLIC_HOST}:{port}"


def editor_health_url(port: int) -> str:
    health_host = EDITOR_BIND_HOST if EDITOR_BIND_HOST not in {"0.0.0.0", "::", ""} else "127.0.0.1"
    return f"http://{health_host}:{port}"


def wait_for_http(url: str, *, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "shipyard-healthcheck/1.0"})
            with urllib.request.urlopen(request, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except Exception:  # noqa: BLE001 - readiness polling is best effort.
            time.sleep(0.5)
    return False

#################################
# END Shared Helpers
#################################
