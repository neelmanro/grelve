"use client";

import { useLayoutEffect, useRef } from "react";

import { AssistantMarkdown } from "@/components/AssistantMarkdown";
import {
  isMarkdownPreviewPath,
  isPlanningArtifactPath,
  stringValue,
  toolContent,
  type ActivityView,
} from "@/lib/shipyard-run-state";

export const PREPARING_NEXT_MOVES = "Preparing next moves";

export function AutoScrollPre({
  text,
  className = "activity-code",
  followTail = true,
}: {
  text: string;
  className?: string;
  followTail?: boolean;
}) {
  const ref = useRef<HTMLPreElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!followTail) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
      return;
    }
    const sync = () => {
      el.scrollTop = el.scrollHeight;
    };
    sync();
    const id = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(id);
  }, [text, followTail]);
  return (
    <pre ref={ref} className={className}>
      {text}
    </pre>
  );
}

export function ShipyardActivityItem({ activity }: { activity: ActivityView }) {
  const toolName = activity.toolName || activity.title;
  const result = activity.result ?? {};
  const input = activity.input ?? {};

  if (toolName === "finish_task") {
    const summary = stringValue(result.summary);
    return (
      <section className={`activity-card activity-finish-task activity-${activity.status ?? "running"}`}>
        <div className="activity-file-header">
          <strong>{PREPARING_NEXT_MOVES}</strong>
        </div>
        {summary ? (
          <div className="activity-markdown-preview activity-markdown-preview-finish">
            <AssistantMarkdown content={summary} />
          </div>
        ) : null}
      </section>
    );
  }

  if (toolName === "write_artifact" || toolName === "write_file" || toolName === "edit_file") {
    const path = stringValue(result.path) || stringValue(input.path) || "Workspace file";
    const isPlanningArtifact = isPlanningArtifactPath(path);
    const isWorkspacePlanningDocCopy =
      toolName === "write_file" &&
      path.startsWith("docs/") &&
      isMarkdownPreviewPath(path);
    const errorMessage = stringValue(result.error);
    const content =
      activity.status === "running"
        ? stringValue(input.content) || stringValue(input.new_text) || stringValue(input.__rawArguments)
        : activity.status === "error"
          ? errorMessage || stringValue(result.detail)
        : isPlanningArtifact
          ? toolContent(activity)
          : stringValue(result.diff) || "No textual diff available.";
    const added = Number(result.added ?? 0);
    const removed = Number(result.removed ?? 0);
    const showPlanningMarkdownDone =
      isPlanningArtifact &&
      activity.status === "success" &&
      isMarkdownPreviewPath(path) &&
      Boolean(stringValue(result.content).trim());
    const previewMarkdown =
      activity.status === "running" && isMarkdownPreviewPath(path) && Boolean(content.trim());
    const showMarkdownBody = previewMarkdown || showPlanningMarkdownDone;
    const markdownBody = showPlanningMarkdownDone ? stringValue(result.content) : content;
    const cardToneClass =
      isPlanningArtifact && activity.status === "success"
        ? "activity-planning-artifact-done"
        : `activity-${activity.status ?? "running"}`;

    if (isWorkspacePlanningDocCopy && activity.status !== "error") {
      return (
        <section className={`activity-card activity-${activity.status ?? "running"}`}>
          <div className="activity-file-header">
            <strong>{path}</strong>
            <span>{activity.status === "running" ? "copying" : "copied"}</span>
          </div>
          <p className="activity-inline">Copied planning document into the generated workspace.</p>
        </section>
      );
    }

    const headerRight =
      activity.status === "running" ? (
        <span>streaming</span>
      ) : activity.status === "error" ? (
        <span>error</span>
      ) : isPlanningArtifact && activity.status === "success" ? null : !isPlanningArtifact ? (
        <span>
          <b className="diff-add">+{added}</b> <b className="diff-remove">-{removed}</b>
        </span>
      ) : (
        <span>{activity.status ?? "error"}</span>
      );

    return (
      <section className={`activity-card ${cardToneClass}`}>
        <div className="activity-file-header">
          <strong>{path}</strong>
          {headerRight}
        </div>
        {showMarkdownBody ? (
          <div className="activity-markdown-preview">
            <AssistantMarkdown content={markdownBody} />
          </div>
        ) : (
          <AutoScrollPre
            followTail={activity.status === "running"}
            text={
              content ||
              (activity.status === "running" ? "Preparing file update..." : "No textual diff available.")
            }
          />
        )}
      </section>
    );
  }

  if (toolName === "run_command") {
    const command = stringValue(input.command);
    const cwd = stringValue(input.cwd) || ".";
    const output = activity.logs || stringValue(result.output);

    return (
      <section className={`activity-card activity-${activity.status ?? "running"}`}>
        <div className="activity-file-header">
          <strong>
            [{cwd}] {command}
          </strong>
          <span>{activity.status ?? "running"}</span>
        </div>
        <AutoScrollPre followTail={activity.status === "running"} text={output || "Waiting for terminal output..."} />
      </section>
    );
  }

  if (
    toolName === "read_skill" ||
    toolName === "read_artifact" ||
    toolName === "read_file" ||
    toolName === "list_files" ||
    toolName === "glob" ||
    toolName === "grep"
  ) {
    const label =
      stringValue(input.name) ||
      stringValue(input.path) ||
      stringValue(input.pattern) ||
      toolName;
    const heading =
      {
        read_file: "Read workspace file",
        read_artifact: "Read planning doc",
        read_skill: "Read skill",
        list_files: "List files",
        glob: "Glob files",
        grep: "Search in files",
      }[toolName] ?? toolName;
    return (
      <section className={`activity-card activity-${activity.status ?? "running"}`}>
        <div className="activity-file-header">
          <strong>{heading}</strong>
          <span>{activity.status ?? "running"}</span>
        </div>
        <p className="activity-inline">{label}</p>
      </section>
    );
  }

  const isCodeLike = activity.kind === "log" || activity.body?.includes("\n");

  return (
    <section className={`activity-item activity-${activity.tone}`}>
      <div className="activity-header">
        <span className={`activity-icon activity-icon-${activity.kind}`} />
        <strong>{activity.title}</strong>
        <time>{activity.timestamp}</time>
      </div>
      {activity.body ? (
        isCodeLike ? (
          <AutoScrollPre text={activity.body} />
        ) : (
          <p>{activity.body}</p>
        )
      ) : null}
    </section>
  );
}
