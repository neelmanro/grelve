"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { mockMarkdownChunks } from "./mock-markdown";
import { TaskBreakdownMockPanel } from "./task-breakdown-mock-panel";

const CHUNKS = mockMarkdownChunks();

export default function MockTaskBreakdownPage() {
  const [markdown, setMarkdown] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (streamTimerRef.current != null) {
        window.clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
  }, []);

  const handleStart = () => {
    if (streamTimerRef.current != null) {
      window.clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }

    setMarkdown("");
    setStreaming(true);

    if (CHUNKS.length === 0) {
      setStreaming(false);
      return;
    }

    let i = 0;
    streamTimerRef.current = window.setInterval(() => {
      if (i >= CHUNKS.length) {
        if (streamTimerRef.current != null) {
          window.clearInterval(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        setStreaming(false);
        return;
      }
      setMarkdown(CHUNKS[i]);
      i += 1;
    }, 320);
  };

  return (
    <main className="shipyard-shell">
      <header
        className="shipyard-header"
        style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}
      >
        <div>
          <p className="workflow-eyebrow" style={{ marginBottom: 6 }}>
            Mock only — no backend
          </p>
          <h1 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 750, letterSpacing: "-0.02em" }}>Mock · task breakdown</h1>
          <p style={{ margin: "8px 0 0", color: "var(--muted)", fontSize: "0.88rem", maxWidth: 560 }}>
            Waves 1–6 cards are always shown; markdown streams in like the real write_artifact feed. Route:{" "}
            <code>/mock/task-breakdown</code>
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/" className="preview-action-button" style={{ textDecoration: "none" }}>
            ← Home
          </Link>
          <button type="button" className="shipyard-header-stop" onClick={handleStart} disabled={streaming}>
            {streaming ? "Streaming…" : "Start"}
          </button>
        </div>
      </header>

      <section className="chat-window" style={{ paddingTop: 20 }} aria-label="Mock task breakdown">
        <div className="chat-window-content">
          <article className="workflow-message" style={{ marginBottom: 0 }}>
            <TaskBreakdownMockPanel markdown={markdown} streaming={streaming} />
          </article>
        </div>
      </section>
    </main>
  );
}
