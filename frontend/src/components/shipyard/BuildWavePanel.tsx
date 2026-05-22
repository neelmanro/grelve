"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef } from "react";

import type { ShipyardTodoItem } from "@/types/shipyard";

import { ShipyardActivityItem } from "@/components/shipyard/ShipyardActivityItem";
import {
  BUILD_WAVES,
  createBuildWaves,
  normalizeName,
  type ActivityView,
  type RunView,
  type WaveView,
} from "@/lib/shipyard-run-state";

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

  const latestActivity = activities[activities.length - 1];
  const latestIsCompletedFileDiff =
    latestActivity?.status === "success" &&
    (latestActivity.toolName === "write_file" || latestActivity.toolName === "edit_file");

  const scrollFeedToBottom = () => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const scrollActivityToTop = (activityId: string) => {
    const outer = feedRef.current;
    const inner = feedInnerRef.current;
    if (!outer || !inner) return;
    const target = inner.querySelector<HTMLElement>(`[data-activity-id="${activityId}"]`);
    if (!target) return;
    outer.scrollTop = Math.max(0, target.offsetTop - inner.offsetTop);
  };

  /** New logs follow the tail; completed file diffs pin to their header. */
  useLayoutEffect(() => {
    if (latestIsCompletedFileDiff && latestActivity) {
      scrollActivityToTop(latestActivity.id);
      requestAnimationFrame(() => scrollActivityToTop(latestActivity.id));
      return;
    }
    scrollFeedToBottom();
    requestAnimationFrame(scrollFeedToBottom);
  }, [activityScrollKey, latestActivity, latestIsCompletedFileDiff]);

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
      if (latestActivity?.status === "running" || nearBottom()) {
        outer.scrollTop = outer.scrollHeight;
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [latestActivity?.status]);

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
            activities.map((activity) => (
              <div key={activity.id} data-activity-id={activity.id} className="build-agent-activity-entry">
                <ShipyardActivityItem activity={activity} />
              </div>
            ))
          ) : (
            <p className="repo-console-empty">Tool calls and command output stream here.</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function BuildWavePanel({
  run,
}: {
  run: RunView;
}) {
  const activeWaveNumber = run.activeWave ?? 1;
  const activeWave = BUILD_WAVES.find((wave) => wave.number === activeWaveNumber) ?? BUILD_WAVES[0];
  const waveState = run.waves.find((wave) => wave.number === activeWave.number);
  const showPreviewLink = run.status === "done" && Boolean(run.runId);

  return (
    <div className="build-wave-run">
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
      {showPreviewLink ? (
        <section className="build-preview-footer" aria-label="Start preview">
          <div>
            <strong>Build complete</strong>
            <p>Start the local FastAPI and Next.js preview when you are ready.</p>
          </div>
          <Link className="continue-build-button" href={`/preview?runId=${encodeURIComponent(run.runId ?? "")}`}>
            Continue
          </Link>
        </section>
      ) : null}
    </div>
  );
}
