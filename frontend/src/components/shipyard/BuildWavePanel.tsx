"use client";

import { useLayoutEffect, useMemo, useRef } from "react";

import type { ShipyardPreviewInfo, ShipyardTodoItem } from "@/types/shipyard";

import { ShipyardActivityItem } from "@/components/shipyard/ShipyardActivityItem";
import {
  BUILD_WAVES,
  createBuildWaves,
  normalizeName,
  type ActivityView,
  type RunView,
  type WaveView,
} from "@/lib/shipyard-run-state";

function PreviewActionBar({ preview }: { preview: ShipyardPreviewInfo }) {
  const editorEnabled = Boolean(preview.editor_url);

  return (
    <section className="preview-action-bar" aria-label="Editor and preview">
      <div className="preview-action-buttons">
        {editorEnabled ? (
          <a className="preview-action-button" href={preview.editor_url} target="_blank" rel="noreferrer">
            Editor
          </a>
        ) : (
          <button type="button" className="preview-action-button preview-action-button-disabled" disabled>
            Editor
          </button>
        )}
        <a className="preview-action-button preview-action-button-primary" href={preview.preview_url} target="_blank" rel="noreferrer">
          Preview
        </a>
      </div>
      <div className="preview-action-meta">
        {preview.env_required ? (
          <p>
            <strong>Env required:</strong> {preview.env_notes}
          </p>
        ) : (
          <p>No required env vars detected.</p>
        )}
        <p>
          Backend: <code>{preview.backend_command}</code>
        </p>
        <p>
          Frontend: <code>{preview.frontend_command}</code>
        </p>
      </div>
    </section>
  );
}

function BuildWaveRail({ waves, activeWave }: { waves: WaveView[]; activeWave: number }) {
  return (
    <nav className="build-wave-rail" aria-label="Build waves">
      {waves.map((wave, index) => (
        <div key={wave.number} className="build-wave-rail-item">
          <span
            className={[
              "build-wave-dot",
              wave.status === "done" ? "build-wave-dot-done" : "",
              wave.status === "running" || activeWave === wave.number ? "build-wave-dot-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />
          {index < waves.length - 1 ? <span className="build-wave-line" /> : null}
        </div>
      ))}
    </nav>
  );
}

function AgentTodoList({ todos }: { todos: ShipyardTodoItem[] }) {
  const fallback = ["Waiting for agent checklist"];
  const visibleTodos = todos.length
    ? todos
    : fallback.map((content, index) => ({ id: `fallback-${index}`, content, status: "pending" as const }));

  return (
    <div className="build-agent-todos">
      {visibleTodos.map((todo) => (
        <div key={todo.id} className="build-agent-todo">
          <span className={`build-agent-todo-mark build-agent-todo-${todo.status}`}>
            {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : ""}
          </span>
          <p>{todo.content}</p>
        </div>
      ))}
    </div>
  );
}

function BuildAgentActivityColumn({ run, agentName, wave }: { run: RunView; agentName: string; wave: number }) {
  const agent = run.agents.find((candidate) => normalizeName(candidate.name) === normalizeName(agentName));
  const activities = useMemo(
    () =>
      run.activities.filter(
        (activity: ActivityView) =>
          activity.wave === wave && normalizeName(activity.agentName ?? "") === normalizeName(agentName),
      ),
    [run.activities, wave, agentName],
  );

  const feedRef = useRef<HTMLDivElement>(null);
  const feedInnerRef = useRef<HTMLDivElement>(null);
  const activityScrollKey = useMemo(
    () => activities.map((a) => `${a.id}:${a.status ?? ""}:${a.toolName ?? ""}:${a.title}`).join("|"),
    [activities],
  );

  const scrollFeedToBottom = () => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  /** New tool rows / status changes: always follow the tail (terminal-style). */
  useLayoutEffect(() => {
    scrollFeedToBottom();
    requestAnimationFrame(scrollFeedToBottom);
  }, [activityScrollKey]);

  /** Growing cards (streaming body, expanded output) without a new row. */
  useLayoutEffect(() => {
    const outer = feedRef.current;
    const inner = feedInnerRef.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;

    const nearBottom = () => {
      const gap = outer.scrollHeight - outer.scrollTop - outer.clientHeight;
      return gap < 100;
    };

    const ro = new ResizeObserver(() => {
      if (nearBottom()) {
        outer.scrollTop = outer.scrollHeight;
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <article className="build-agent-card">
      <header className="build-agent-card-header">
        <div>
          <strong>{agentName}</strong>
          <span>{agent?.status ?? "queued"}</span>
        </div>
        <i className={`build-agent-status build-agent-status-${agent?.status ?? "queued"}`} aria-hidden />
      </header>
      <AgentTodoList todos={agent?.todos ?? []} />
      <div
        ref={feedRef}
        className="activity-feed workflow-log-feed build-agent-activity-feed"
        aria-label={`${agentName} tool activity`}
      >
        <div ref={feedInnerRef} className="build-agent-activity-feed-inner">
          {activities.length > 0 ? (
            activities.map((activity) => <ShipyardActivityItem key={activity.id} activity={activity} />)
          ) : (
            <p className="repo-console-empty">Tool calls and command output stream here.</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function BuildWavePanel({ run }: { run: RunView }) {
  const activeWaveNumber = run.activeWave ?? 1;
  const activeWave = BUILD_WAVES.find((wave) => wave.number === activeWaveNumber) ?? BUILD_WAVES[0];
  const waveState = run.waves.find((wave) => wave.number === activeWave.number);

  return (
    <div className="build-wave-run">
      {run.preview ? <PreviewActionBar preview={run.preview} /> : null}
      <BuildWaveRail waves={run.waves.length ? run.waves : createBuildWaves()} activeWave={activeWave.number} />
      <section className="build-wave-page" aria-label={`Wave ${activeWave.number}`}>
        <div className="build-wave-header">
          <p>Wave {activeWave.number}</p>
          <h2>{activeWave.title}</h2>
          <span>{waveState?.status ?? "queued"}</span>
        </div>
        <div className={`build-agent-grid build-agent-grid-${activeWave.agents.length}`}>
          {activeWave.agents.map((agentName) => (
            <BuildAgentActivityColumn key={agentName} run={run} agentName={agentName} wave={activeWave.number} />
          ))}
        </div>
      </section>
    </div>
  );
}
