"use client";

import { FormEvent, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ShipyardActivityItem } from "@/components/shipyard/ShipyardActivityItem";
import { streamShipyardRun } from "@/lib/shipyard-api";
import {
  activitiesForPlanningStep,
  appendActivity,
  applyStreamEvent,
  createId,
  getActiveWorkflowStepId,
  nowLabel,
  repoActivities,
  workflowSegmentProgress,
  workflowStatusForStep,
  WORKFLOW_STEPS,
  type RunView,
  type WorkflowStep,
  type WorkflowStepId,
} from "@/lib/shipyard-run-state";
import {
  FIXED_SHIPYARD_STACK,
  type ShipyardStreamEvent,
} from "@/types/shipyard";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  run?: RunView;
};

type ChatState = {
  messages: ChatMessage[];
  activeAssistantMessageId: string | null;
};

type ChatAction =
  | { type: "start_run"; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { type: "stream_event"; messageId: string; event: ShipyardStreamEvent }
  | { type: "run_done"; messageId: string }
  | { type: "run_error"; messageId: string; message: string };

function createAssistantRunMessage(): ChatMessage {
  return {
    id: createId("assistant"),
    role: "assistant",
    content: "",
    createdAt: nowLabel(),
    run: {
      status: "running",
      phase: "planning",
      waves: [],
      streamText: "",
      agents: [],
      activities: [],
    },
  };
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "start_run":
      return {
        activeAssistantMessageId: action.assistantMessage.id,
        messages: [...state.messages, action.userMessage, action.assistantMessage],
      };
    case "stream_event":
      return updateRunMessage(state, action.messageId, (run) => applyStreamEvent(run, action.event));
    case "run_done":
      return {
        activeAssistantMessageId: null,
        messages: state.messages.map((message) => {
          if (message.id !== action.messageId || !message.run) return message;
          if (message.run.status === "failed") return message;
          return {
            ...message,
            run: {
              ...message.run,
              status: "done",
              agents: message.run.agents.map((agent) =>
                agent.status === "running" ? { ...agent, status: "done" } : agent,
              ),
              activities: message.run.activities,
            },
          };
        }),
      };
    case "run_error":
      return {
        activeAssistantMessageId: null,
        messages: state.messages.map((message) => {
          if (message.id !== action.messageId || !message.run) return message;
          return {
            ...message,
            run: {
              ...message.run,
              status: "failed",
              activities: appendActivity(message.run.activities, {
                kind: "error",
                title: "Run failed",
                body: action.message,
                tone: "danger",
              }),
            },
          };
        }),
      };
    default:
      return state;
  }
}

function updateRunMessage(
  state: ChatState,
  messageId: string,
  updater: (run: RunView) => RunView,
): ChatState {
  return {
    ...state,
    messages: state.messages.map((message) => {
      if (message.id !== messageId || !message.run) return message;
      return { ...message, run: updater(message.run) };
    }),
  };
}


export default function Home() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [state, dispatch] = useReducer(chatReducer, {
    activeAssistantMessageId: null,
    messages: [],
  });
  const chatWindowRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement | null>(null);
  const chatBottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isRunning = state.activeAssistantMessageId != null;

  const canSubmit = prompt.trim().length > 0 && !isRunning;
  const isChatEmpty = state.messages.length === 0;

  const scrollChatToBottom = () => {
    const root = chatWindowRef.current;
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    chatBottomSentinelRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  };

  useLayoutEffect(() => {
    scrollChatToBottom();
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      scrollChatToBottom();
      raf2 = requestAnimationFrame(() => {
        scrollChatToBottom();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [state.messages, state.activeAssistantMessageId]);

  useEffect(() => {
    const content = chatContentRef.current;
    if (!content || isChatEmpty) return;

    let raf = 0;
    const scheduleScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        scrollChatToBottom();
        requestAnimationFrame(scrollChatToBottom);
      });
    };

    scheduleScroll();

    const resizeObserver = new ResizeObserver(scheduleScroll);
    resizeObserver.observe(content);

    const mutationObserver = new MutationObserver(scheduleScroll);
    mutationObserver.observe(content, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [isChatEmpty]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const submitPrompt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isRunning) return;

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: trimmed,
      createdAt: nowLabel(),
    };
    const assistantMessage = createAssistantRunMessage();
    const controller = new AbortController();

    abortRef.current?.abort();
    abortRef.current = controller;
    dispatch({ type: "start_run", userMessage, assistantMessage });
    setPrompt("");

    void streamShipyardRun(
      { prompt: trimmed, stack: FIXED_SHIPYARD_STACK },
      {
        signal: controller.signal,
        onEvent: (streamEvent) =>
          dispatch({
            type: "stream_event",
            messageId: assistantMessage.id,
            event: streamEvent,
          }),
        onError: (message) =>
          dispatch({
            type: "run_error",
            messageId: assistantMessage.id,
            message,
          }),
        onDone: () =>
          dispatch({
            type: "run_done",
            messageId: assistantMessage.id,
          }),
      },
    );
  };

  const stopRun = () => {
    abortRef.current?.abort();
    if (state.activeAssistantMessageId) {
      dispatch({
        type: "run_error",
        messageId: state.activeAssistantMessageId,
        message: "Run stopped by user.",
      });
    }
  };

  const continueBuild = (_messageId: string, runId?: string) => {
    if (!runId || isRunning) return;
    router.push(`/build?runId=${encodeURIComponent(runId)}`);
  };

  const composerOnlyIdle = isChatEmpty && !isRunning;

  return (
    <main
      className={["shipyard-shell", composerOnlyIdle ? "shipyard-shell-composer-only" : ""].filter(Boolean).join(" ")}
    >
      {isRunning ? (
        <header className="shipyard-header shipyard-header-run-only">
          <div className="shipyard-header-run-actions">
            <button type="button" className="shipyard-header-stop" onClick={stopRun}>
              Stop
            </button>
          </div>
        </header>
      ) : null}

      {!isChatEmpty ? (
        <section
          ref={chatWindowRef}
          className={`chat-window${isRunning ? " chat-window-running" : ""}`}
          aria-label="Build chat"
        >
          <div ref={chatContentRef} className="chat-window-content">
            {state.messages.map((message) => (
              <MessageBubble key={message.id} message={message} onContinueBuild={continueBuild} />
            ))}
            <div ref={chatBottomSentinelRef} className="chat-bottom-sentinel" aria-hidden />
          </div>
        </section>
      ) : null}

      {!isRunning ? (
        <div className={isChatEmpty ? "composer-anchor composer-anchor-empty" : "composer-anchor"}>
          <form className="composer" onSubmit={submitPrompt}>
            <div className="composer-input-wrap">
              <div className="composer-field-col">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Describe the app to plan and scaffold..."
                  rows={5}
                />
              </div>
              <div className="composer-actions-col">
                <button
                  type="submit"
                  className="composer-send-btn"
                  disabled={!canSubmit}
                  aria-label="Start build"
                >
                  <ComposerIconArrowUp />
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function ComposerIconArrowUp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 19V5M5 12l7-7 7 7"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MessageBubble({
  message,
  onContinueBuild,
}: {
  message: ChatMessage;
  onContinueBuild: (messageId: string, runId?: string) => void;
}) {
  if (message.role === "user") {
    return null;
  }

  return (
    <article className="workflow-message">
      {message.run ? (
        <RunTranscript
          run={message.run}
          onContinueBuild={() => onContinueBuild(message.id, message.run?.runId)}
        />
      ) : (
        message.content
      )}
    </article>
  );
}

function RunTranscript({ run, onContinueBuild }: { run: RunView; onContinueBuild: () => void }) {
  const activeStepId = getActiveWorkflowStepId(run);
  const activeStep = WORKFLOW_STEPS.find((step) => step.id === activeStepId) ?? WORKFLOW_STEPS[0];
  const planningStep =
    activeStep.id === "repo"
      ? WORKFLOW_STEPS.findLast((step) => step.artifactPath && workflowStatusForStep(run, step.id) === "done") ??
        WORKFLOW_STEPS[2]
      : activeStep;

  return (
    <div className="workflow-run workflow-run-open">
      <WorkflowStepRail run={run} activeStepId={activeStep.id} />

      <div className="workflow-board">
        <div className="workflow-stage">
          {activeStep.id === "repo" ? (
            <RepoSetupStage run={run} onContinueBuild={onContinueBuild} />
          ) : (
            <WorkflowDocumentStage run={run} step={planningStep} />
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowStepRail({
  run,
  activeStepId,
}: {
  run: RunView;
  activeStepId: WorkflowStepId;
}) {
  return (
    <nav className="workflow-stepper" aria-label="Workflow progress">
      <ol className="workflow-stepper-list">
        {WORKFLOW_STEPS.map((step, index) => {
          const status = workflowStatusForStep(run, step.id);
          const isLast = index === WORKFLOW_STEPS.length - 1;
          const segment = !isLast ? workflowSegmentProgress(run, index) : null;

          return (
            <li key={step.id} className="workflow-stepper-item">
              <span className="workflow-stepper-node-wrap">
                <span
                  className={`workflow-stepper-node workflow-stepper-node-${status}${activeStepId === step.id ? " workflow-stepper-node-current" : ""}`}
                  title={step.title}
                  aria-label={`${step.number} ${step.title}, ${status}`}
                >
                  {status === "done" ? <StepperCheckIcon /> : <span className="workflow-stepper-num">{step.number}</span>}
                </span>
                <span className="workflow-stepper-label">{step.title}</span>
              </span>
              {!isLast ? (
                <span className="workflow-stepper-track" aria-hidden>
                  <span className={`workflow-stepper-fill workflow-stepper-fill-${segment}`} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepperCheckIcon() {
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

function WorkflowDocumentStage({ run, step }: { run: RunView; step: WorkflowStep }) {
  const relatedActivities = activitiesForPlanningStep(run, step.id);

  const showAgentWaiting =
    run.status === "running" && run.phase === "planning" && relatedActivities.length === 0;

  return (
    <section className="document-stage" aria-label={step.label}>
      {relatedActivities.length > 0 ? (
        <div
          className="document-activity-strip document-activity-primary"
          aria-label={`${step.title} agent activity`}
        >
          {relatedActivities.map((activity) => (
            <ShipyardActivityItem key={activity.id} activity={activity} />
          ))}
        </div>
      ) : null}
      {showAgentWaiting ? (
        <p className="document-stage-waiting" aria-live="polite">
          Waiting for the agent…
        </p>
      ) : null}
    </section>
  );
}

function RepoSetupStage({ run, onContinueBuild }: { run: RunView; onContinueBuild: () => void }) {
  const activities = repoActivities(run);

  return (
    <section className="repo-stage" aria-label="Repo setup logs">
      <div className="activity-feed workflow-log-feed" aria-label="Commands, diffs, and tool output">
        {activities.length > 0 ? (
          activities.map((activity) => <ShipyardActivityItem key={activity.id} activity={activity} />)
        ) : (
          <p className="repo-console-empty">Repo setup will stream file diffs and command logs here.</p>
        )}
      </div>
      {run.status === "done" ? (
        <div className="continue-build-panel">
          <div>
            <strong>Planning phase complete</strong>
            <p>The intake, brief, system design, API contract, task breakdown, and repo scaffold are ready.</p>
          </div>
          <button type="button" className="continue-build-button" onClick={onContinueBuild}>
            Continue building
          </button>
        </div>
      ) : null}
    </section>
  );
}
