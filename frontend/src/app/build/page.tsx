"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { BuildWavePanel } from "@/components/shipyard/BuildWavePanel";
import { streamShipyardBuildRun } from "@/lib/shipyard-api";
import {
  applyStreamEvent,
  appendActivity,
  createBuildWaves,
  type RunView,
} from "@/lib/shipyard-run-state";

function createInitialBuildRun(runId: string): RunView {
  return {
    runId,
    status: "running",
    phase: "build",
    waves: createBuildWaves(),
    agents: [],
    activities: [],
  };
}

function BuildRunnerInner({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunView>(() => createInitialBuildRun(runId));
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    void streamShipyardBuildRun(runId, {
      signal: controller.signal,
      onEvent: (event) => {
        setRun((current) => (current ? applyStreamEvent(current, event) : current));
      },
      onError: (message) => {
        setRun((current) => {
          if (!current) return current;
          return {
            ...current,
            status: "failed",
            activities: appendActivity(current.activities, {
              kind: "error",
              title: "Build failed",
              body: message,
              tone: "danger",
            }),
          };
        });
        setError(message);
      },
      onDone: () => {
        setRun((current) => {
          if (!current || current.status === "failed") return current;
          return {
            ...current,
            status: "done",
            agents: current.agents.map((agent) =>
              agent.status === "running" ? { ...agent, status: "done" } : agent,
            ),
          };
        });
      },
    });

    return () => {
      controller.abort();
    };
  }, [runId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <main className="shipyard-shell build-page">
      <header className="shipyard-header shipyard-header-run-only">
        <div className="shipyard-header-actions">
          <Link className="preview-secondary-link" href="/">
            Planning
          </Link>
        </div>
      </header>
      {error ? <p className="preview-setup-error">{error}</p> : null}
      <BuildWavePanel run={run} />
    </main>
  );
}

function BuildPageContent() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("runId");

  if (!runId) {
    return (
      <main className="shipyard-shell build-page">
        <section className="preview-center-card">
          <strong>Missing run</strong>
          <p>Start planning first, then continue to the build phase.</p>
          <Link className="continue-build-button" href="/">
            Back to planning
          </Link>
        </section>
      </main>
    );
  }

  return <BuildRunnerInner key={runId} runId={runId} />;
}

export default function BuildPage() {
  return (
    <Suspense
      fallback={
        <main className="shipyard-shell build-page">
          <section className="preview-center-card">
            <p className="message-meta">Loading build...</p>
          </section>
        </main>
      }
    >
      <BuildPageContent />
    </Suspense>
  );
}
