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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
PROJECT_NAME = env("PROJECT_NAME", "Grelve API")
# Grelve agents: OpenAI-compatible chat completions.
OPENAI_BASE_URL = env("OPENAI_BASE_URL", "https://api.openai.com/v1")
DEEPSEEK_BASE_URL = env("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
SHIPYARD_LLM_BASE_URL = env("SHIPYARD_LLM_BASE_URL", DEEPSEEK_BASE_URL)
SHIPYARD_LLM_MODEL = env("SHIPYARD_LLM_MODEL", env("DEEPSEEK_MODEL", "deepseek-v4-pro"))
# DeepSeek V4 Pro promo rates (cache-miss input / output per 1M tokens). Override in .env as pricing changes.
SHIPYARD_LLM_INPUT_COST_PER_1M = float(env("SHIPYARD_LLM_INPUT_COST_PER_1M", "0.435"))
SHIPYARD_LLM_OUTPUT_COST_PER_1M = float(env("SHIPYARD_LLM_OUTPUT_COST_PER_1M", "0.87"))
SHIPYARD_LLM_THINKING = env("SHIPYARD_LLM_THINKING", "disabled")
PREVIEW_BIND_HOST = env("SHIPYARD_PREVIEW_BIND_HOST", "127.0.0.1")
PREVIEW_PUBLIC_HOST = env("SHIPYARD_PREVIEW_PUBLIC_HOST", "127.0.0.1")
PREVIEW_FRONTEND_PORT_BASE = int(env("SHIPYARD_PREVIEW_FRONTEND_PORT_BASE", "3000"))
PREVIEW_BACKEND_PORT_BASE = int(env("SHIPYARD_PREVIEW_BACKEND_PORT_BASE", "8000"))
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


class ShipyardPreviewStart(BaseModel):
    env_text: str = Field(default="", max_length=20_000)


class ShipyardPreviewConfig(BaseModel):
    env_required: bool
    env_notes: str
    env_template: str


class ShipyardRunMetrics(BaseModel):
    built_in_seconds: float
    agents_run: int
    waves_completed: int
    files_changed: int
    lines_added: int
    lines_removed: int
    checks_passed: int
    checks_total: int
    tokens_used: int
    token_usage_estimated: bool
    estimated_cost_usd: float
    model: str


@dataclass
class ShipyardMetrics:
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    agents_run: set[str] = field(default_factory=set)
    waves_completed: set[int] = field(default_factory=set)
    files_changed: set[str] = field(default_factory=set)
    lines_added: int = 0
    lines_removed: int = 0
    checks_passed: int = 0
    checks_total: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    token_usage_estimated: bool = False


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
    preview_processes: list[subprocess.Popen[Any]] = field(default_factory=list)
    metrics: ShipyardMetrics = field(default_factory=ShipyardMetrics)
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
        raise HTTPException(status_code=404, detail="Grelve run not found.")

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
        raise HTTPException(status_code=404, detail="Grelve run not found.")
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


@app.post(f"{API_PREFIX}/shipyard/runs/{{run_id}}/preview", tags=["shipyard"])
def start_shipyard_preview(run_id: str, payload: ShipyardPreviewStart) -> dict[str, Any]:
    run = SHIPYARD_RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Grelve run not found.")
    if run.status != "done":
        raise HTTPException(status_code=409, detail="Build must finish before preview can start.")

    try:
        return start_fixed_stack_preview(run, payload.env_text)
    except Exception as exc:  # noqa: BLE001 - surface preview startup details to the UI.
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get(
    f"{API_PREFIX}/shipyard/runs/{{run_id}}/preview-config",
    response_model=ShipyardPreviewConfig,
    tags=["shipyard"],
)
def get_shipyard_preview_config(run_id: str) -> ShipyardPreviewConfig:
    run = SHIPYARD_RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Grelve run not found.")
    config = preview_env_config(run)
    return ShipyardPreviewConfig(**config)


@app.get(
    f"{API_PREFIX}/shipyard/runs/{{run_id}}/metrics",
    response_model=ShipyardRunMetrics,
    tags=["shipyard"],
)
def get_shipyard_run_metrics(run_id: str) -> ShipyardRunMetrics:
    run = SHIPYARD_RUNS.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Grelve run not found.")
    return ShipyardRunMetrics(**shipyard_metrics_payload(run))


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


@dataclass(frozen=True)
class ShipyardLLMConfig:
    model: str
    reasoning_effort: str = ""


SHIPYARD_AGENT_LLM_CONFIGS: dict[str, ShipyardLLMConfig] = {
    "Intake Agent": ShipyardLLMConfig("gpt-5.4-mini", "none"),
    "Product Brief Agent": ShipyardLLMConfig("gpt-5.4-mini", "none"),
    "System Design Agent": ShipyardLLMConfig("gpt-5.4-mini", "none"),
    "API Contract Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Task Breakdown Agent": ShipyardLLMConfig("gpt-5.4-mini", "none"),
    "Repo Setup Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Backend Data Agent": ShipyardLLMConfig("gpt-5.4", "none"),
    "Frontend Shell Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Backend API Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Frontend Feature Agent": ShipyardLLMConfig("gpt-5.4", "none"),
    "Frontend API Integration Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Integration Agent": ShipyardLLMConfig("deepseek-v4-flash"),
    "Review Agent": ShipyardLLMConfig("deepseek-v4-flash"),
}
DEFAULT_SHIPYARD_LLM_CONFIG = ShipyardLLMConfig(
    SHIPYARD_LLM_MODEL,
    env("SHIPYARD_LLM_REASONING_EFFORT", ""),
)


SHIPYARD_PLANNING_SYSTEM = """You are a Grelve planning agent running one deterministic planning step.

The backend has already loaded your skill instructions and every prior planning artifact you need.
Do not ask for tools, files, or follow-up questions.
Do not mention backend orchestration.
Write only the requested markdown artifact for this step.

Reliability rules:
- Use the provided skill instructions as the contract for your output.
- Treat prior artifacts as source-of-truth context.
- Do not invent scope beyond the user prompt and prior artifacts.
- Include obvious category-standard product behavior when it is table stakes for the requested product, but do not add unrelated features.
- Preserve the fixed MVP stack: Next.js TypeScript React frontend, FastAPI backend, SQLite database.
- Preserve the fixed UI brand rules: white background, black text, yellow #E3F848 for primary buttons and accents.
- Return markdown only."""


SHIPYARD_TASK_SYSTEM = """You are a Grelve coding agent running one focused task inside an isolated workspace.

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
- Build professional enterprise product UI: dense but readable tables/forms, restrained borders, clear navigation, strong empty/loading/error states, no marketing hero pages, no decorative gradients, no AI-slop visuals.
- Implement obvious category-standard behavior already implied by the plan, such as streamed chat responses for chat/AI products, searchable tables/detail forms for CRM tools, and filters/readable data states for dashboards.
- Do not write giant source files in one tool call. Split large UI into smaller components. If a file must be large, use write_file for the first small chunk or an empty file, then append_file_chunk in multiple chunks.
- Keep individual file-write tool arguments comfortably below 50KB whenever possible.
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
]


async def run_shipyard_planning_workflow(run: ShipyardRun) -> AsyncGenerator[str, None]:
    if run.stream_started:
        yield sse(event("error", message="This Grelve run has already been started. Create a new run."))
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
            run.metrics.waves_completed.add(wave_number)
            yield sse(event("wave_done", wave=wave_number, title=wave_title))

        run.status = "done"
        run.metrics.finished_at = datetime.now(timezone.utc)
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

    llm_config = shipyard_llm_config_for_agent(step.name)
    async for chunk in stream_llm_text(run, messages, temperature=0.2, llm_config=llm_config):
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
    llm_config = shipyard_llm_config_for_agent(task.name)
    if task.wave is not None:
        run.metrics.agents_run.add(task.name)

    for _turn in range(1, task.max_turns + 1):
        message: dict[str, Any] | None = None
        async for model_event in stream_llm_with_tools(run, messages, tools=tools, temperature=0.2, llm_config=llm_config):
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

            if args.get("_tool_parse_error"):
                result = {
                    "ok": False,
                    "error": (
                        "Malformed tool arguments. Retry the same tool call with valid JSON arguments. "
                        "If writing a large file, use append_file_chunk in smaller chunks."
                    ),
                    "parse_error": args.get("_tool_parse_error"),
                }
                yield event(
                    "tool_result",
                    id=tool_id,
                    name=tool_name,
                    ok=False,
                    detail=summarize_tool_result(result),
                    result=trim_tool_result(result),
                )
            elif tool_name == "run_command":
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
        spec("read_skill", "Read one Grelve agent skill from backend/agent_skills.", {"name": path_prop}, ["name"]),
        spec("write_artifact", "Create or replace a markdown planning artifact under docs/.", {"path": path_prop, "content": {"type": "string"}}, ["path", "content"]),
        spec("read_artifact", "Read a markdown planning artifact previously written by the agent.", {"path": path_prop}, ["path"]),
        spec("list_files", "List files and folders inside the generated workspace.", {"path": path_prop, "max_entries": {"type": "integer"}}, []),
        spec("glob", "Find files and folders by glob pattern inside the generated workspace.", {"pattern": {"type": "string"}, "path": path_prop, "max_entries": {"type": "integer"}}, ["pattern"]),
        spec("grep", "Search text files inside the generated workspace with a regular expression.", {"pattern": {"type": "string"}, "path": path_prop, "glob": {"type": "string"}, "max_matches": {"type": "integer"}}, ["pattern"]),
        spec("read_file", "Read a UTF-8 text file from the generated workspace.", {"path": path_prop, "offset": {"type": "integer"}, "limit": {"type": "integer"}, "max_bytes": {"type": "integer"}}, ["path"]),
        spec("write_file", "Create or replace a UTF-8 text file in the generated workspace. For large files, write a small first chunk or empty file, then use append_file_chunk.", {"path": path_prop, "content": {"type": "string"}}, ["path", "content"]),
        spec("append_file_chunk", "Append one UTF-8 text chunk to an existing or new workspace file. Use this for large files instead of one huge write_file call.", {"path": path_prop, "content": {"type": "string"}, "reset": {"type": "boolean", "description": "If true, replace the file with this chunk instead of appending."}}, ["path", "content"]),
        spec("edit_file", "Replace one exact text region in an existing workspace file.", {"path": path_prop, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, ["path", "old_text", "new_text"]),
        spec("delete_file", "Delete one file inside the generated workspace.", {"path": path_prop}, ["path"]),
        spec("move_file", "Move or rename one file inside the generated workspace.", {"source": path_prop, "destination": path_prop}, ["source", "destination"]),
        spec("run_command", "Run a bounded terminal command from a relative cwd inside the generated workspace.", {"command": {"type": "string"}, "cwd": path_prop, "timeout_seconds": {"type": "integer"}}, ["command"]),
        spec("update_todos", "Publish the current checklist for this agent.", {"todos": todo_prop}, ["todos"]),
        spec(
            "publish_preview",
            "Publish final preview handoff metadata for the UI.",
            {
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
        spec("finish_task", "Mark the current Grelve task complete.", {"summary": {"type": "string"}}, ["summary"]),
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
        if name == "append_file_chunk":
            return tool_append_file_chunk(run, args)
        if name == "edit_file":
            return tool_edit_file(run, args)
        if name == "delete_file":
            return tool_delete_file(run, args)
        if name == "move_file":
            return tool_move_file(run, args)
        if name == "update_todos":
            return tool_update_todos(args)
        if name == "publish_preview":
            return tool_publish_preview(run, args)
        if name == "finish_task":
            return {"ok": True, "summary": str(args.get("summary") or "Grelve task complete.")}
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


def start_fixed_stack_preview(run: ShipyardRun, env_text: str) -> dict[str, Any]:
    backend_dir = run.workspace_path / "backend"
    frontend_dir = run.workspace_path / "frontend"
    if not backend_dir.is_dir():
        raise RuntimeError("Preview cannot start because workspace/backend is missing.")
    if not frontend_dir.is_dir():
        raise RuntimeError("Preview cannot start because workspace/frontend is missing.")

    stop_preview_processes(run)

    env_file = backend_dir / ".env"
    cleaned_env = env_text.strip()
    if cleaned_env:
        env_file.write_text(f"{cleaned_env}\n", encoding="utf-8")

    env_config = preview_env_config(run)
    env_required = bool(env_config["env_required"])
    env_notes = str(env_config["env_notes"])
    if env_required and not cleaned_env and not env_file.is_file():
        raise RuntimeError("This app needs environment variables before preview. Add the required NAME=value lines and continue.")

    frontend_port = find_preview_port(PREVIEW_FRONTEND_PORT_BASE)
    backend_port = find_preview_port(PREVIEW_BACKEND_PORT_BASE)
    bind_host = PREVIEW_BIND_HOST
    public_host = PREVIEW_PUBLIC_HOST

    backend_command = f"uvicorn app.main:app --reload --host {shlex.quote(bind_host)} --port {backend_port}"
    frontend_command = f"npm run dev -- --hostname {shlex.quote(bind_host)} --port {frontend_port}"

    backend_process = start_preview_process(run, "backend", backend_command, backend_dir)
    frontend_process = start_preview_process(run, "frontend", frontend_command, frontend_dir)
    run.preview_processes = [backend_process, frontend_process]

    backend_url = f"http://{public_host}:{backend_port}"
    frontend_url = f"http://{public_host}:{frontend_port}"

    if not wait_for_http(f"{backend_url}/docs", timeout_seconds=25):
        raise RuntimeError("Backend preview did not become ready. Check .shipyard_preview/backend.log in the run workspace.")
    if not wait_for_http(frontend_url, timeout_seconds=45):
        raise RuntimeError("Frontend preview did not become ready. Check .shipyard_preview/frontend.log in the run workspace.")

    preview = {
        "ok": True,
        "editor_url": "",
        "preview_url": frontend_url,
        "frontend_url": frontend_url,
        "backend_url": backend_url,
        "backend_command": f"cd backend && {backend_command}",
        "frontend_command": f"cd frontend && {frontend_command}",
        "env_required": env_required,
        "env_notes": env_notes,
    }
    run.preview = preview
    return preview


def shipyard_metrics_payload(run: ShipyardRun) -> dict[str, Any]:
    finished = run.metrics.finished_at or datetime.now(timezone.utc)
    built_seconds = max(0.0, (finished - run.metrics.started_at).total_seconds())
    prompt_tokens = run.metrics.prompt_tokens
    completion_tokens = run.metrics.completion_tokens
    tokens_used = prompt_tokens + completion_tokens
    estimated_cost = (
        (prompt_tokens / 1_000_000) * SHIPYARD_LLM_INPUT_COST_PER_1M
        + (completion_tokens / 1_000_000) * SHIPYARD_LLM_OUTPUT_COST_PER_1M
    )
    return {
        "built_in_seconds": round(built_seconds, 1),
        "agents_run": len(run.metrics.agents_run),
        "waves_completed": len(run.metrics.waves_completed),
        "files_changed": len(run.metrics.files_changed),
        "lines_added": run.metrics.lines_added,
        "lines_removed": run.metrics.lines_removed,
        "checks_passed": run.metrics.checks_passed,
        "checks_total": run.metrics.checks_total,
        "tokens_used": tokens_used,
        "token_usage_estimated": run.metrics.token_usage_estimated,
        "estimated_cost_usd": round(estimated_cost, 4),
        "model": shipyard_models_label(),
    }


def stop_preview_processes(run: ShipyardRun) -> None:
    for process in run.preview_processes:
        if process.poll() is None:
            process.terminate()
    run.preview_processes = []


def preview_env_config(run: ShipyardRun) -> dict[str, Any]:
    example = run.workspace_path / "backend" / ".env.example"
    if not example.is_file():
        return {"env_required": False, "env_notes": "", "env_template": ""}
    lines = [
        line.strip()
        for line in example.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.strip().startswith("#") and "=" in line
    ]
    if not lines:
        return {"env_required": False, "env_notes": "", "env_template": ""}
    names = [line.split("=", 1)[0].strip() for line in lines if line.split("=", 1)[0].strip()]
    if not names:
        return {"env_required": False, "env_notes": "", "env_template": ""}
    return {
        "env_required": True,
        "env_notes": "Set " + ", ".join(names) + " before starting preview.",
        "env_template": "\n".join(f"{name}=" for name in names),
    }


def start_preview_process(run: ShipyardRun, name: str, command: str, cwd: Path) -> subprocess.Popen[Any]:
    log_dir = run.workspace_path / ".shipyard_preview"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = (log_dir / f"{name}.log").open("ab")
    env_vars = {
        **os.environ,
        "HOME": str(run.workspace_path / ".home"),
        "TMPDIR": str(run.workspace_path / ".tmp"),
        "npm_config_cache": str(run.workspace_path / ".home" / ".npm"),
        "PIP_CACHE_DIR": str(run.workspace_path / ".home" / ".pip"),
    }
    (run.workspace_path / ".home").mkdir(parents=True, exist_ok=True)
    (run.workspace_path / ".tmp").mkdir(parents=True, exist_ok=True)
    try:
        process = subprocess.Popen(
            ["sh", "-lc", command],
            cwd=str(cwd),
            stdout=log_file,
            stderr=log_file,
            env=env_vars,
            start_new_session=True,
        )
    finally:
        log_file.close()
    time.sleep(0.5)
    if process.poll() is not None:
        raise RuntimeError(f"{name.title()} preview command exited early. Check .shipyard_preview/{name}.log.")
    return process


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


def tool_append_file_chunk(run: ShipyardRun, args: dict[str, Any]) -> dict[str, Any]:
    content = str(args.get("content") or "")
    target = safe_workspace_path(run, str(args.get("path") or ""), require_file_shape=True)
    previous = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
    updated = content if bool(args.get("reset")) else f"{previous}{content}"
    assert_write_size(updated)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(updated, encoding="utf-8")
    return write_result(run, target, previous, updated)


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
    command_ok = return_code == 0 and not timed_out
    run.metrics.checks_total += 1
    if command_ok:
        run.metrics.checks_passed += 1
    yield event(
        "tool_result",
        result={
            "ok": command_ok,
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
    if previous != updated:
        run.metrics.files_changed.add(path)
        run.metrics.lines_added += added
        run.metrics.lines_removed += removed
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
    message = await complete_llm_message(messages, tools=None, temperature=temperature, llm_config=DEFAULT_SHIPYARD_LLM_CONFIG)
    return str(message.get("content") or "").strip()


async def complete_llm_message(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    temperature: float,
    llm_config: ShipyardLLMConfig,
) -> dict[str, Any]:
    if not shipyard_llm_api_key(llm_config):
        raise RuntimeError(shipyard_llm_missing_key_message(llm_config))
    return await complete_openai_chat_message(messages=messages, tools=tools, temperature=temperature, llm_config=llm_config)


async def stream_llm_text(
    run: ShipyardRun,
    messages: list[dict[str, Any]],
    *,
    temperature: float,
    llm_config: ShipyardLLMConfig,
) -> AsyncGenerator[str, None]:
    if not shipyard_llm_api_key(llm_config):
        raise RuntimeError(shipyard_llm_missing_key_message(llm_config))
    async for chunk in stream_openai_chat_text(run=run, messages=messages, temperature=temperature, llm_config=llm_config):
        yield chunk


async def stream_llm_with_tools(
    run: ShipyardRun,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]],
    temperature: float,
    llm_config: ShipyardLLMConfig,
) -> AsyncGenerator[dict[str, Any], None]:
    if not shipyard_llm_api_key(llm_config):
        raise RuntimeError(shipyard_llm_missing_key_message(llm_config))
    async for item in stream_openai_chat_message(run=run, messages=messages, tools=tools, temperature=temperature, llm_config=llm_config):
        yield item


async def stream_openai_chat_message(
    *,
    run: ShipyardRun,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    temperature: float,
    llm_config: ShipyardLLMConfig,
) -> AsyncGenerator[dict[str, Any], None]:
    queue: asyncio.Queue[dict[str, Any] | Exception | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def worker() -> None:
        content_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        tool_call_prefix = f"tool-call-{uuid4().hex}"
        estimated_prompt_tokens = estimate_messages_tokens(messages)
        completion_text = ""
        saw_usage = False
        try:
            payload = build_openai_chat_payload(messages=messages, tools=tools, temperature=temperature, stream=True, llm_config=llm_config)
            request = build_openai_chat_request(payload, llm_config)
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
                        usage = parsed.get("usage")
                        if isinstance(usage, dict):
                            saw_usage = True
                            record_llm_usage(run, usage, estimated=False)
                        delta = parsed["choices"][0].get("delta", {})
                    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                        continue
                    if not isinstance(delta, dict):
                        continue
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        content_parts.append(content)
                        completion_text += content
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
            if not saw_usage:
                safely_record_estimated_llm_usage(run, estimated_prompt_tokens, estimate_text_tokens(completion_text))
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
    llm_config: ShipyardLLMConfig,
) -> dict[str, Any]:
    payload = build_openai_chat_payload(messages=messages, tools=tools, temperature=temperature, stream=False, llm_config=llm_config)
    data = await asyncio.to_thread(post_openai_chat_json, payload, llm_config)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("LLM returned no choices.")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise RuntimeError("LLM returned an invalid message.")
    return normalize_openai_message(message)


async def stream_openai_chat_text(
    *,
    run: ShipyardRun,
    messages: list[dict[str, Any]],
    temperature: float,
    llm_config: ShipyardLLMConfig,
) -> AsyncGenerator[str, None]:
    queue: asyncio.Queue[str | Exception | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def worker() -> None:
        estimated_prompt_tokens = estimate_messages_tokens(messages)
        completion_text = ""
        saw_usage = False
        try:
            payload = build_openai_chat_payload(messages=messages, tools=None, temperature=temperature, stream=True, llm_config=llm_config)
            request = build_openai_chat_request(payload, llm_config)
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
                        usage = parsed.get("usage")
                        if isinstance(usage, dict):
                            saw_usage = True
                            record_llm_usage(run, usage, estimated=False)
                        content = parsed["choices"][0].get("delta", {}).get("content")
                    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                        content = None
                    if content:
                        completion_text += str(content)
                        loop.call_soon_threadsafe(queue.put_nowait, str(content))
        except Exception as exc:  # noqa: BLE001 - surfaced into the SSE stream.
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            if not saw_usage:
                safely_record_estimated_llm_usage(run, estimated_prompt_tokens, estimate_text_tokens(completion_text))
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
    llm_config: ShipyardLLMConfig,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": llm_config.model,
        "messages": messages,
        "stream": stream,
    }
    if shipyard_llm_supports_custom_temperature(llm_config):
        payload["temperature"] = float(temperature)
    if llm_config.reasoning_effort and not tools:
        payload["reasoning_effort"] = llm_config.reasoning_effort
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    apply_provider_payload_options(payload, llm_config)
    return payload


def apply_provider_payload_options(payload: dict[str, Any], llm_config: ShipyardLLMConfig) -> None:
    if not shipyard_llm_uses_deepseek(llm_config):
        return
    if llm_config.model in {"deepseek-v4-flash", "deepseek-v4-pro"}:
        payload["thinking"] = {"type": "disabled"}
        return
    thinking = SHIPYARD_LLM_THINKING.lower()
    if thinking in ("disabled", "off", "false", "0", "none"):
        payload["thinking"] = {"type": "disabled"}
    elif thinking in ("enabled", "on", "true", "1"):
        payload["thinking"] = {"type": "enabled"}


def post_openai_chat_json(payload: dict[str, Any], llm_config: ShipyardLLMConfig) -> dict[str, Any]:
    request = build_openai_chat_request(payload, llm_config)
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


def shipyard_llm_config_for_agent(agent_name: str) -> ShipyardLLMConfig:
    return SHIPYARD_AGENT_LLM_CONFIGS.get(agent_name, DEFAULT_SHIPYARD_LLM_CONFIG)


def shipyard_models_label() -> str:
    labels = []
    seen = set()
    for config in SHIPYARD_AGENT_LLM_CONFIGS.values():
        label = f"{config.model} ({config.reasoning_effort})" if config.reasoning_effort else config.model
        if label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return "mixed: " + ", ".join(labels)


def shipyard_llm_base_url(llm_config: ShipyardLLMConfig) -> str:
    model = llm_config.model.lower()
    if model.startswith(("gpt-", "o")):
        return OPENAI_BASE_URL
    if model.startswith("deepseek"):
        return DEEPSEEK_BASE_URL
    return SHIPYARD_LLM_BASE_URL


def shipyard_llm_uses_deepseek(llm_config: ShipyardLLMConfig) -> bool:
    return "deepseek" in shipyard_llm_base_url(llm_config).lower() or llm_config.model.lower().startswith("deepseek")


def shipyard_llm_api_key(llm_config: ShipyardLLMConfig) -> str:
    if shipyard_llm_uses_deepseek(llm_config):
        return env("DEEPSEEK_API_KEY", "") or env("SHIPYARD_LLM_API_KEY", "")
    return env("OPENAI_API_KEY", "") or env("SHIPYARD_LLM_API_KEY", "")


def shipyard_llm_missing_key_message(llm_config: ShipyardLLMConfig) -> str:
    if shipyard_llm_uses_deepseek(llm_config):
        return "DEEPSEEK_API_KEY or SHIPYARD_LLM_API_KEY is required for Grelve agents."
    return "OPENAI_API_KEY or SHIPYARD_LLM_API_KEY is required for Grelve agents."


def shipyard_llm_supports_custom_temperature(llm_config: ShipyardLLMConfig) -> bool:
    if "api.openai.com" not in shipyard_llm_base_url(llm_config).lower():
        return True
    return not llm_config.model.lower().startswith("gpt-5")


def estimate_text_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text) / 4))


def estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    return estimate_text_tokens(json.dumps(messages, ensure_ascii=False, default=str))


def record_llm_usage(run: ShipyardRun, usage: dict[str, Any], *, estimated: bool) -> None:
    try:
        prompt_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    except (TypeError, ValueError):
        return
    if prompt_tokens <= 0 and completion_tokens <= 0:
        return
    run.metrics.prompt_tokens += max(0, prompt_tokens)
    run.metrics.completion_tokens += max(0, completion_tokens)
    run.metrics.token_usage_estimated = run.metrics.token_usage_estimated or estimated


def record_estimated_llm_usage(run: ShipyardRun, prompt_tokens: int, completion_tokens: int) -> None:
    record_llm_usage(
        run,
        {"prompt_tokens": max(0, prompt_tokens), "completion_tokens": max(0, completion_tokens)},
        estimated=True,
    )


def safely_record_estimated_llm_usage(run: ShipyardRun, prompt_tokens: int, completion_tokens: int) -> None:
    try:
        record_estimated_llm_usage(run, prompt_tokens, completion_tokens)
    except Exception:
        return


def build_openai_chat_request(payload: dict[str, Any], llm_config: ShipyardLLMConfig) -> urllib.request.Request:
    api_key = shipyard_llm_api_key(llm_config)
    if not api_key:
        raise RuntimeError(shipyard_llm_missing_key_message(llm_config))
    url = f"{shipyard_llm_base_url(llm_config).rstrip('/')}/chat/completions"
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
    except json.JSONDecodeError as exc:
        args = recover_tool_args(tool_name, raw_args)
        args["_tool_parse_error"] = f"{exc.msg} at char {exc.pos}"
    if not isinstance(args, dict):
        args = {"_tool_parse_error": "Tool arguments must be a JSON object."}
    args = normalize_tool_args(tool_name, args)
    return tool_id, tool_name, args


def recover_tool_args(tool_name: str, raw_args: str) -> dict[str, Any]:
    recovered: dict[str, Any] = {}
    if tool_name not in {"read_file", "write_file", "append_file_chunk", "edit_file", "delete_file", "move_file"}:
        return recovered

    path = recover_json_string_field(raw_args, ("path", "file_path", "filepath", "filename", "file"))
    if path:
        recovered["path"] = path
    content = recover_json_string_field(raw_args, ("content", "contents", "text", "data", "body"))
    if content is not None:
        recovered["content"] = content
    old_text = recover_json_string_field(raw_args, ("old_text",))
    if old_text is not None:
        recovered["old_text"] = old_text
    new_text = recover_json_string_field(raw_args, ("new_text",))
    if new_text is not None:
        recovered["new_text"] = new_text
    return recovered


def recover_json_string_field(raw: str, names: tuple[str, ...]) -> str | None:
    for name in names:
        pattern = re.compile(rf'"{re.escape(name)}"\s*:\s*"((?:\\.|[^"\\])*)"', re.DOTALL)
        match = pattern.search(raw)
        if not match:
            continue
        value = match.group(1)
        try:
            return json.loads(f'"{value}"')
        except json.JSONDecodeError:
            return value.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
    return None


def normalize_tool_args(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    if tool_name in {"read_file", "write_file", "append_file_chunk", "edit_file", "delete_file"} and "path" not in args:
        for alias in ("file_path", "filepath", "filename", "file"):
            if alias in args:
                args = {**args, "path": args[alias]}
                break
    if tool_name in {"write_file", "append_file_chunk"} and "content" not in args:
        for alias in ("contents", "text", "data", "body"):
            if alias in args:
                args = {**args, "content": args[alias]}
                break
    return args


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


def find_preview_port(start: int) -> int:
    for offset in range(200):
        port = start + offset
        if port <= 65535 and host_port_free(PREVIEW_BIND_HOST, port):
            return port
    raise RuntimeError("No free preview port found. Close another local server and try again.")


def host_port_free(host: str, port: int) -> bool:
    bind_host = host if host not in {"0.0.0.0", "::", ""} else "127.0.0.1"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((bind_host, port))
            return True
        except OSError:
            return False


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
