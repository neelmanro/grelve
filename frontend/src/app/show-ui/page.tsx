import Link from "next/link";

import { AssistantMarkdown } from "@/components/AssistantMarkdown";
import { BuildWavePanel } from "@/components/shipyard/BuildWavePanel";
import { createBuildWaves, type RunView } from "@/lib/shipyard-run-state";

import type { ShipyardPreviewInfo } from "@/types/shipyard";

const MOCK_PREVIEW: ShipyardPreviewInfo = {
  editor_url: "https://example.com/editor",
  preview_url: "https://preview.example.com",
  frontend_url: "http://localhost:3000",
  backend_url: "http://localhost:8000",
  backend_command: "uvicorn main:app --reload --port 8000",
  frontend_command: "npm run dev",
  env_required: false,
  env_notes: "",
};

/** Static snapshot of `/build?runId=…` — Wave 2, two agents, activity feed (not the old dark log strip). */
const MOCK_BUILD_RUN: RunView = (() => {
  const waves = createBuildWaves().map((w) =>
    w.number <= 1 ? { ...w, status: "done" as const } : w.number === 2 ? { ...w, status: "running" as const } : w,
  );
  return {
    runId: "mock-ui-build",
    status: "running",
    phase: "build",
    activeWave: 2,
    preview: MOCK_PREVIEW,
    streamText: "",
    waves,
    agents: [
      {
        id: "mock-agent-backend-api",
        name: "Backend API Agent",
        status: "running",
        wave: 2,
        todos: [
          { id: "t1", content: "Read API contract and backend data files", status: "completed" },
          { id: "t2", content: "Implement required FastAPI routes", status: "in_progress" },
          { id: "t3", content: "Add validation and standard errors", status: "pending" },
          { id: "t4", content: "Run backend checks", status: "pending" },
        ],
      },
      {
        id: "mock-agent-frontend-feature",
        name: "Frontend Feature Agent",
        status: "done",
        wave: 2,
        todos: [
          { id: "t5", content: "Read API contract and frontend shell", status: "completed" },
          { id: "t6", content: "Build main feature views", status: "completed" },
          { id: "t7", content: "Preserve fixed brand rules", status: "completed" },
        ],
      },
    ],
    activities: [
      {
        id: "mock-act-1",
        kind: "tool",
        title: "read_skill",
        tone: "neutral",
        timestamp: "11:02 AM",
        toolName: "read_skill",
        status: "success",
        agentName: "Backend API Agent",
        wave: 2,
        input: { name: "api_contract_skill.md" },
      },
      {
        id: "mock-act-2",
        kind: "tool",
        title: "write_file",
        tone: "neutral",
        timestamp: "11:03 AM",
        toolName: "write_file",
        toolId: "tool-write-1",
        status: "running",
        agentName: "Backend API Agent",
        wave: 2,
        input: {
          path: "backend/app/routes/shipyard.py",
          content: '"""Shipyard streaming routes."""\n\nfrom fastapi import APIRouter\n\nrouter = APIRouter()',
        },
      },
      {
        id: "mock-act-3",
        kind: "tool",
        title: "run_command",
        tone: "neutral",
        timestamp: "11:04 AM",
        toolName: "run_command",
        status: "success",
        agentName: "Frontend Feature Agent",
        wave: 2,
        input: { command: "npm run lint", cwd: "frontend" },
        result: { output: "✔ No issues found\n\nChecked 24 files." },
      },
      {
        id: "mock-act-4",
        kind: "tool",
        title: "finish_task",
        tone: "success",
        timestamp: "11:05 AM",
        toolName: "finish_task",
        status: "success",
        agentName: "Frontend Feature Agent",
        wave: 2,
        result: { summary: "- Shell + feature views aligned with contract\n- **Next:** API integration wave wires `streamShipyardBuildRun`" },
      },
    ],
  };
})();

function StepperCheck() {
  return (
    <svg className="workflow-stepper-check" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Static workflow rail: steps 1–5 done, Repo Setup (06) running — matches a late planning run. */
function MockWorkflowStepperRepoRunning() {
  const steps = [
    { num: "01", label: "Intake", state: "done" as const },
    { num: "02", label: "Product Brief", state: "done" as const },
    { num: "03", label: "System Design", state: "done" as const },
    { num: "04", label: "API Contract", state: "done" as const },
    { num: "05", label: "Task Breakdown", state: "done" as const },
    { num: "06", label: "Repo Setup", state: "running" as const, current: true },
  ];

  return (
    <nav className="workflow-stepper" aria-label="Workflow progress (mock)">
      <ol className="workflow-stepper-list">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          const trackFill =
            index < 4 ? "workflow-stepper-fill-full" : index === 4 ? "workflow-stepper-fill-partial" : "";
          return (
            <li key={step.label} className="workflow-stepper-item">
              <span className="workflow-stepper-node-wrap">
                <span
                  className={[
                    "workflow-stepper-node",
                    `workflow-stepper-node-${step.state}`,
                    step.current ? "workflow-stepper-node-current" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={step.label}
                >
                  {step.state === "done" ? <StepperCheck /> : <span className="workflow-stepper-num">{step.num}</span>}
                </span>
                <span className="workflow-stepper-label">{step.label}</span>
              </span>
              {!isLast ? (
                <span className="workflow-stepper-track" aria-hidden>
                  <span className={`workflow-stepper-fill ${trackFill}`} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** System Design step active with a live document card (mid-planning). */
function MockWorkflowStepperSystemRunning() {
  const steps = [
    { num: "01", label: "Intake", state: "done" as const },
    { num: "02", label: "Product Brief", state: "done" as const },
    { num: "03", label: "System Design", state: "running" as const, current: true },
    { num: "04", label: "API Contract", state: "queued" as const },
    { num: "05", label: "Task Breakdown", state: "queued" as const },
    { num: "06", label: "Repo Setup", state: "queued" as const },
  ];
  return (
    <nav className="workflow-stepper" aria-label="Workflow progress (mock)">
      <ol className="workflow-stepper-list">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          let fill = "workflow-stepper-fill-none";
          if (index === 0) fill = "workflow-stepper-fill-full";
          if (index === 1) fill = "workflow-stepper-fill-partial";
          return (
            <li key={step.label} className="workflow-stepper-item">
              <span className="workflow-stepper-node-wrap">
                <span
                  className={[
                    "workflow-stepper-node",
                    `workflow-stepper-node-${step.state}`,
                    step.current ? "workflow-stepper-node-current" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {step.state === "done" ? <StepperCheck /> : <span className="workflow-stepper-num">{step.num}</span>}
                </span>
                <span className="workflow-stepper-label">{step.label}</span>
              </span>
              {!isLast ? (
                <span className="workflow-stepper-track" aria-hidden>
                  <span className={`workflow-stepper-fill ${fill}`} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function ShowUiPage() {
  return (
    <main className="shipyard-shell">
      <header className="shipyard-header" style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 12 }}>
        <div>
          <p className="workflow-eyebrow" style={{ marginBottom: 4 }}>
            Dev preview
          </p>
          <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 750, letterSpacing: "-0.03em" }}>show-ui</h1>
          <p style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: "0.9rem", maxWidth: 620 }}>
            Planning sections mirror <code>/</code>. Build section uses the real{" "}
            <code>BuildWavePanel</code> (same as <code>/build?runId=…</code>): preview bar, wave rail, two agent cards,
            todos, and the <strong>open activity feed</strong> per agent — not the old black console strip.
          </p>
        </div>
        <Link href="/" className="preview-action-button" style={{ textDecoration: "none", alignSelf: "flex-start" }}>
          ← Home
        </Link>
      </header>

      <div className="chat-window" style={{ paddingTop: 20 }}>
        <div className="chat-window-content">
          <article className="workflow-message">
            <p className="message-meta" style={{ marginBottom: 12 }}>
              1 · Mid-planning — document step + streaming card
            </p>
            <div className="workflow-run workflow-run-open">
              <MockWorkflowStepperSystemRunning />
              <div className="workflow-board">
                <section className="document-stage" aria-label="Mock document activity">
                  <div className="document-activity-strip document-activity-primary">
                    <section className="activity-card activity-running activity-planning-artifact-done">
                      <div className="activity-file-header">
                        <strong>docs/system_design.md</strong>
                        <span>streaming</span>
                      </div>
                      <div className="activity-markdown-preview">
                        <AssistantMarkdown content="## System overview\n\n- **Web:** Next.js App Router\n- **API:** FastAPI + streaming\n\n> Mock content while tools stream." />
                      </div>
                    </section>
                  </div>
                </section>
              </div>
            </div>
          </article>

          <article className="workflow-message" style={{ marginTop: 36 }}>
            <p className="message-meta" style={{ marginBottom: 12 }}>
              2 · Repo setup — open activity list (no outer box)
            </p>
            <div className="workflow-run workflow-run-open">
              <MockWorkflowStepperRepoRunning />
              <div className="workflow-board">
                <section className="repo-stage" aria-label="Mock repo logs">
                  <div className="activity-feed workflow-log-feed">
                    <section className="activity-card activity-success">
                      <div className="activity-file-header">
                        <strong>read_skill</strong>
                        <span>success</span>
                      </div>
                      <p className="activity-inline">repo_setup_skill.md</p>
                    </section>
                    <section className="activity-card activity-success">
                      <div className="activity-file-header">
                        <strong>docs/intake.md</strong>
                        <span>success</span>
                      </div>
                      <div className="activity-markdown-preview">
                        <AssistantMarkdown content="Intake captured. **Goal:** demo UI." />
                      </div>
                    </section>
                    <section className="activity-card activity-running">
                      <div className="activity-file-header">
                        <strong>[.] npm install</strong>
                        <span>running</span>
                      </div>
                      <pre className="activity-code">
                        {`added 42 packages in 3s\n\n2 moderate severity vulnerabilities\n\nRun npm audit for details.`}
                      </pre>
                    </section>
                    <section className="activity-card activity-success">
                      <div className="activity-file-header">
                        <strong>Preparing next moves</strong>
                      </div>
                      <div className="activity-markdown-preview activity-markdown-preview-finish">
                        <AssistantMarkdown content="- Wrote scaffold files\n- Next: verify `package.json` scripts" />
                      </div>
                    </section>
                    <section className="activity-item activity-neutral">
                      <div className="activity-header">
                        <span className="activity-icon activity-icon-log" />
                        <strong>update_todos</strong>
                        <time>10:40 PM</time>
                      </div>
                    </section>
                  </div>
                </section>
              </div>
            </div>
          </article>

          <article className="workflow-message" style={{ marginTop: 36 }}>
            <p className="message-meta" style={{ marginBottom: 12 }}>
              3 · Build phase — same component as <code>/build</code> (Wave 2 · Core Product, two agents)
            </p>
            <BuildWavePanel run={MOCK_BUILD_RUN} />
          </article>

          <article className="workflow-message" style={{ marginTop: 36, marginBottom: 40 }}>
            <p className="message-meta" style={{ marginBottom: 12 }}>
              4 · Planning complete CTA (home page when planning status is done)
            </p>
            <div className="continue-build-panel">
              <div>
                <strong>Planning phase complete</strong>
                <p>The intake, brief, system design, API contract, task breakdown, and repo scaffold are ready.</p>
              </div>
              <button type="button" className="continue-build-button" disabled>
                Continue building → opens <code>/build?runId=…</code>
              </button>
            </div>
          </article>
        </div>
      </div>
    </main>
  );
}
