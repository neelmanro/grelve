"use client";

import type { ChangeEvent, CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type Flow = "compose" | "path" | "quiz" | "aiSkip";

type QuizOption = {
  id: string;
  title: string;
  description: string;
};

type QuizQuestion = {
  id: string;
  summaryLabel: string;
  prompt: string;
  otherPlaceholder: string;
  options: QuizOption[];
};

/** Fourth row in the list; opens the text field when selected. */
const QUIZ_OTHER_OPTION_ID = "__other__";

const QUIZ_OTHER_ROW: QuizOption = {
  id: QUIZ_OTHER_OPTION_ID,
  title: "Other",
  description: "Something not listed above.",
};

const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    summaryLabel: "Product type",
    prompt: "What type of product are we building?",
    otherPlaceholder: "Describe another product type",
    options: [
      {
        id: "internal",
        title: "Internal tool",
        description: "A private app used by a team inside a company.",
      },
      {
        id: "saas",
        title: "Customer facing SaaS",
        description: "A product users sign into and use regularly.",
      },
      {
        id: "admin",
        title: "Admin dashboard",
        description: "A control panel for managing data, users, or operations.",
      },
    ],
  },
  {
    id: "q2",
    summaryLabel: "Main user",
    prompt: "Who is the main user?",
    otherPlaceholder: "Describe the user",
    options: [
      {
        id: "founder",
        title: "Founder or owner",
        description: "Someone who needs visibility and control.",
      },
      {
        id: "internal",
        title: "Internal team member",
        description: "Someone doing daily work inside the product.",
      },
      {
        id: "customer",
        title: "Customer",
        description: "Someone outside the company using the product.",
      },
    ],
  },
  {
    id: "q3",
    summaryLabel: "First version focus",
    prompt: "What should the first version focus on?",
    otherPlaceholder: "Describe the launch focus",
    options: [
      {
        id: "speed",
        title: "Speed",
        description: "Build the simplest working version fast.",
      },
      {
        id: "polish",
        title: "Polish",
        description: "Make the first version feel clean and impressive.",
      },
      {
        id: "data",
        title: "Data structure",
        description: "Get the database, logic, and flows right first.",
      },
    ],
  },
  {
    id: "q4",
    summaryLabel: "Build approach",
    prompt: "How should the AI build the product?",
    otherPlaceholder: "Describe the build style",
    options: [
      {
        id: "mvp",
        title: "Simple MVP",
        description: "Only build what is needed for the first working version.",
      },
      {
        id: "production",
        title: "Production ready",
        description:
          "Use cleaner structure, stronger validation, and scalable patterns.",
      },
      {
        id: "design",
        title: "Design first",
        description: "Make the UI feel premium before adding deeper logic.",
      },
    ],
  },
  {
    id: "q5",
    summaryLabel: "After the plan",
    prompt: "What should happen after the plan is created?",
    otherPlaceholder: "Describe the next step",
    options: [
      {
        id: "tasks",
        title: "Generate tasks",
        description: "Break the product into clear build tasks.",
      },
      {
        id: "architecture",
        title: "Generate architecture",
        description: "Show the stack, database, APIs, and system flow.",
      },
      {
        id: "local",
        title: "Start building locally",
        description: "Create the app structure and first working screens.",
      },
    ],
  },
];

type StepAnswer = { optionId: string | null; other: string };

type BlueprintPhase = "review" | "phase1" | "phase2" | "complete";

/** Phase 1 — blueprint (timeline + shared stream panel). */
const PHASE1_STEPS: readonly {
  title: string;
  successDescription: string;
  stream: readonly string[];
}[] = [
  {
    title: "Product brief",
    successDescription:
      "Goal, user, problem, and success criteria.",
    stream: [
      "Reading product prompt...",
      "Understanding target user...",
      "Defining product goal...",
      "Capturing success criteria...",
    ],
  },
  {
    title: "App workflow",
    successDescription: "The main user journey from start to finish.",
    stream: [
      "Mapping the core workflow...",
      "Sequencing key user actions...",
      "Tracing entry and exit paths...",
    ],
  },
  {
    title: "UX and screen plan",
    successDescription:
      "Screens, layout, and interaction direction.",
    stream: [
      "Planning main screens...",
      "Outlining layout hierarchy...",
      "Noting primary interactions...",
      "Aligning flows to user goals...",
    ],
  },
  {
    title: "Technical architecture",
    successDescription: "Stack, services, and system structure.",
    stream: [
      "Choosing architecture direction...",
      "Selecting core services...",
      "Balancing complexity and speed...",
    ],
  },
] as const;

/** Phase 2 — build preparation (horizontal pipeline, per-card streams). */
const PHASE2_STEPS: readonly {
  title: string;
  cardDescription: string;
  stream: readonly string[];
}[] = [
  {
    title: "Data and API contracts",
    cardDescription:
      "Defines the core models, endpoints, request shapes, response shapes, and data flow.",
    stream: [
      "Reading blueprint context...",
      "Defining data boundaries...",
      "Mapping request and response shapes...",
      "Checking implementation order...",
    ],
  },
  {
    title: "Repository skeleton",
    cardDescription:
      "Creates the project folder structure, key files, app boundaries, and starter organization.",
    stream: [
      "Creating folder structure...",
      "Separating app boundaries...",
      "Preparing starter files...",
      "Refining project organization...",
    ],
  },
  {
    title: "Task and agent context",
    cardDescription:
      "Breaks the build into clear tasks with enough context for AI agents to execute.",
    stream: [
      "Breaking work into build tasks...",
      "Writing agent context packets...",
      "Checking task dependencies...",
      "Preparing execution order...",
    ],
  },
] as const;

function getVisiblePhase2CardIndex(
  timeline: ("queued" | "generating" | "done_pending" | "done")[],
): number {
  const active = timeline.findIndex(
    (s) => s === "generating" || s === "done_pending",
  );
  if (active !== -1) return active;
  const nextQueued = timeline.findIndex((s) => s === "queued");
  if (nextQueued !== -1) return nextQueued;
  return Math.max(0, timeline.length - 1);
}

function emptyAnswers(): StepAnswer[] {
  return Array.from({ length: QUIZ_QUESTIONS.length }, () => ({
    optionId: null,
    other: "",
  }));
}

export default function Neel() {
  const [input, setInput] = useState("");
  const mode = "Composer 2";
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const quizOtherInputRef = useRef<HTMLInputElement>(null);
  const genRunRef = useRef(0);
  const [flow, setFlow] = useState<Flow>("compose");
  const [quizStep, setQuizStep] = useState(0);
  const [answers, setAnswers] = useState<StepAnswer[]>(emptyAnswers);
  const [blueprintPhase, setBlueprintPhase] =
    useState<BlueprintPhase>("review");
  const [genTimeline, setGenTimeline] = useState<
    ("queued" | "generating" | "done_pending" | "done")[]
  >(() => Array.from({ length: PHASE1_STEPS.length }, () => "queued"));
  const [genStreamLines, setGenStreamLines] = useState<
    { id: string; text: string }[]
  >([]);
  const [genProgress, setGenProgress] = useState(0);
  const [phase2Timeline, setPhase2Timeline] = useState<
    ("queued" | "generating" | "done_pending" | "done")[]
  >(() => Array.from({ length: PHASE2_STEPS.length }, () => "queued"));
  const [phase2LinesByStep, setPhase2LinesByStep] = useState<
    { id: string; text: string }[][]
  >(() => PHASE2_STEPS.map(() => []));
  const [phase2Progress, setPhase2Progress] = useState(0);

  const resetGenerationState = useCallback(() => {
    setGenTimeline(
      Array.from({ length: PHASE1_STEPS.length }, () => "queued"),
    );
    setGenStreamLines([]);
    setGenProgress(0);
    setPhase2Timeline(
      Array.from({ length: PHASE2_STEPS.length }, () => "queued"),
    );
    setPhase2LinesByStep(PHASE2_STEPS.map(() => []));
    setPhase2Progress(0);
  }, []);

  const backToCompose = useCallback(() => {
    setFlow("compose");
    setQuizStep(0);
    setAnswers(emptyAnswers());
    setBlueprintPhase("review");
    resetGenerationState();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [resetGenerationState]);

  const openPath = () => {
    const trimmed = input.trim();
    if (!trimmed || flow !== "compose") return;
    setFlow("path");
  };

  const startQuiz = useCallback(() => {
    setAnswers(emptyAnswers());
    setQuizStep(0);
    setBlueprintPhase("review");
    resetGenerationState();
    setFlow("quiz");
  }, [resetGenerationState]);

  const chooseAiFromPath = useCallback(() => {
    setFlow("aiSkip");
  }, []);

  const exitQuizToAi = useCallback(() => {
    setFlow("aiSkip");
    setQuizStep(0);
    setAnswers(emptyAnswers());
    setBlueprintPhase("review");
    resetGenerationState();
  }, [resetGenerationState]);

  const openPathFromQuiz = useCallback(() => {
    setFlow("path");
    setQuizStep(0);
    setAnswers(emptyAnswers());
    setBlueprintPhase("review");
    resetGenerationState();
  }, [resetGenerationState]);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (flow !== "path") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") backToCompose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow, backToCompose]);

  useEffect(() => {
    if (flow !== "quiz") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (blueprintPhase === "phase1" || blueprintPhase === "phase2") return;
      if (blueprintPhase === "complete") {
        setBlueprintPhase("review");
        resetGenerationState();
        return;
      }
      if (quizStep === 5) {
        setQuizStep(4);
        return;
      }
      if (quizStep > 0) {
        setQuizStep((s) => s - 1);
        return;
      }
      openPathFromQuiz();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow, quizStep, openPathFromQuiz, blueprintPhase, resetGenerationState]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      openPath();
    }
  };

  const currentAnswer = answers[quizStep] ?? {
    optionId: null,
    other: "",
  };
  const isReview = quizStep === 5;
  const question = QUIZ_QUESTIONS[quizStep];
  const isOtherSelected = currentAnswer.optionId === QUIZ_OTHER_OPTION_ID;
  const listOptions =
    question != null ? [...question.options, QUIZ_OTHER_ROW] : [];
  const canContinueStep =
    isReview ||
    (question != null &&
      currentAnswer.optionId != null &&
      (currentAnswer.optionId !== QUIZ_OTHER_OPTION_ID ||
        currentAnswer.other.trim().length > 0));

  useEffect(() => {
    if (flow !== "quiz" || !isOtherSelected) return;
    const id = requestAnimationFrame(() =>
      quizOtherInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, [flow, quizStep, isOtherSelected]);

  const setOption = (optionId: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      if (quizStep >= 0 && quizStep < next.length) {
        const clearOther = optionId !== QUIZ_OTHER_OPTION_ID;
        next[quizStep] = {
          optionId,
          other: clearOther ? "" : next[quizStep].other,
        };
      }
      return next;
    });
  };

  const setOther = (value: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      if (quizStep >= 0 && quizStep < next.length) {
        next[quizStep] = { ...next[quizStep], other: value };
      }
      return next;
    });
  };

  const goNext = () => {
    if (!canContinueStep || isReview) return;
    if (quizStep < QUIZ_QUESTIONS.length - 1) {
      setQuizStep((s) => s + 1);
    } else {
      setBlueprintPhase("review");
      setQuizStep(5);
    }
  };

  const goBack = () => {
    if (quizStep <= 0) return;
    setQuizStep((s) => s - 1);
  };

  const mockGenerateBlueprint = () => {
    console.info("[mock] Generate blueprint", { prompt: input, answers });
    resetGenerationState();
    setBlueprintPhase("phase1");
  };

  const progressFraction = isReview
    ? 1
    : (quizStep + 1) / QUIZ_QUESTIONS.length;

  useEffect(() => {
    if (blueprintPhase !== "phase1") return;
    const runId = ++genRunRef.current;
    let alive = true;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    (async () => {
      for (let step = 0; step < PHASE1_STEPS.length; step++) {
        if (!alive || genRunRef.current !== runId) return;
        setGenTimeline((prev) =>
          prev.map((_, i) =>
            i < step ? "done" : i === step ? "generating" : "queued",
          ),
        );
        setGenStreamLines([]);
        const lines = PHASE1_STEPS[step].stream;
        for (let li = 0; li < lines.length; li++) {
          await sleep(340 + (li % 4) * 55);
          if (!alive || genRunRef.current !== runId) return;
          setGenStreamLines((prev) => [
            ...prev,
            { id: `g-${runId}-${step}-${li}`, text: lines[li]! },
          ]);
          setGenProgress(
            (step + (li + 1) / lines.length) / PHASE1_STEPS.length,
          );
        }
        await sleep(320);
        if (!alive || genRunRef.current !== runId) return;
        setGenTimeline((prev) =>
          prev.map((_, i) =>
            i < step ? "done" : i === step ? "done_pending" : "queued",
          ),
        );
        await sleep(420);
        if (!alive || genRunRef.current !== runId) return;
        setGenTimeline((prev) =>
          prev.map((_, i) => (i <= step ? "done" : "queued")),
        );
      }
      if (!alive || genRunRef.current !== runId) return;
      setGenProgress(1);
      await sleep(520);
      if (!alive || genRunRef.current !== runId) return;
      setBlueprintPhase("phase2");
    })();

    return () => {
      alive = false;
    };
  }, [blueprintPhase]);

  useEffect(() => {
    if (blueprintPhase !== "phase2") return;
    const runId = ++genRunRef.current;
    let alive = true;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    (async () => {
      setPhase2Timeline(
        Array.from({ length: PHASE2_STEPS.length }, () => "queued"),
      );
      setPhase2LinesByStep(PHASE2_STEPS.map(() => []));
      setPhase2Progress(0);
      await sleep(520);
      if (!alive || genRunRef.current !== runId) return;

      for (let step = 0; step < PHASE2_STEPS.length; step++) {
        if (!alive || genRunRef.current !== runId) return;
        setPhase2Timeline((prev) =>
          prev.map((_, i) =>
            i < step ? "done" : i === step ? "generating" : "queued",
          ),
        );
        const lines = PHASE2_STEPS[step].stream;
        for (let li = 0; li < lines.length; li++) {
          await sleep(560 + (li % 5) * 120);
          if (!alive || genRunRef.current !== runId) return;
          setPhase2LinesByStep((prev) => {
            const next = prev.map((arr) => [...arr]);
            const line = lines[li];
            if (line == null) return prev;
            next[step] = [
              ...next[step],
              { id: `p2-${runId}-${step}-${li}`, text: line },
            ];
            return next;
          });
          setPhase2Progress(
            (step + (li + 1) / lines.length) / PHASE2_STEPS.length,
          );
        }
        await sleep(380);
        if (!alive || genRunRef.current !== runId) return;
        setPhase2Timeline((prev) =>
          prev.map((_, i) =>
            i < step ? "done" : i === step ? "done_pending" : "queued",
          ),
        );
        await sleep(520);
        if (!alive || genRunRef.current !== runId) return;
        setPhase2Timeline((prev) =>
          prev.map((_, i) => (i <= step ? "done" : "queued")),
        );
        await sleep(280);
      }
      if (!alive || genRunRef.current !== runId) return;
      setPhase2Progress(1);
      await sleep(420);
      if (!alive || genRunRef.current !== runId) return;
      setBlueprintPhase("complete");
    })();

    return () => {
      alive = false;
    };
  }, [blueprintPhase]);

  return (
    <div style={styles.root}>
      <style>{css}</style>

      <div
        className={`neel-content ${visible ? "neel-in" : ""}`}
        style={flow === "path" ? styles.mainDimmed : undefined}
        aria-hidden={flow === "path" || flow === "quiz" || flow === "aiSkip"}
      >
        <div style={styles.greeting}>
          <span style={styles.hey}>Hey, Neel.</span>
          <span style={styles.sub}>What are we building today?</span>
        </div>

        <div
          style={{
            ...styles.composer,
            ...(focused ? styles.composerFocused : {}),
          }}
        >
          <textarea
            ref={textareaRef}
            style={styles.textarea}
            value={input}
            readOnly={flow !== "compose"}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              setInput(e.target.value)
            }
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKey}
            placeholder={"Plan, Build, / for commands, @ for context"}
            rows={4}
          />

          <div style={styles.bottomBar}>
            <div style={styles.bottomLeft}>
              <button type="button" style={styles.plusBtn} aria-label="Attach">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path
                    d="M7.5 1.5v12M1.5 7.5h12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>

              <button type="button" style={styles.modeBtn} aria-label="Switch mode">
                <span style={styles.modeName}>{mode}</span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  style={{ opacity: 0.4 }}
                >
                  <circle
                    cx="6"
                    cy="6"
                    r="4.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M4 5.5L6 7.5l2-2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  style={{ opacity: 0.3 }}
                >
                  <path
                    d="M2 4l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div style={styles.bottomRight}>
              <button
                type="button"
                style={{
                  ...styles.sendBtn,
                  ...(input.trim().length > 0 && flow === "compose"
                    ? styles.sendBtnActive
                    : {}),
                }}
                aria-label="Send"
                disabled={!input.trim() || flow !== "compose"}
                onClick={openPath}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M7 11V3M3 7l4-4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              <button type="button" style={styles.micBtn} aria-label="Voice">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect
                    x="4.5"
                    y="1"
                    width="5"
                    height="7"
                    rx="2.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path
                    d="M2.5 7A4.5 4.5 0 0011.5 7M7 11.5V13M5 13h4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {flow === "path" && (
        <div
          style={styles.pathOverlay}
          role="presentation"
          onClick={backToCompose}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="path-modal-title"
            style={styles.pathModal}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="path-modal-title" style={styles.pathModalTitle}>
              Before the AI builds, choose the direction.
            </h2>
            <p style={styles.pathModalBody}>
              Answer a short quiz so the plan, stack, and architecture match what
              you want.
            </p>
            <p style={styles.pathModalMeta}>
              Skip it and the AI will decide from your prompt.
            </p>
            <div style={styles.choiceRow}>
              <button type="button" style={styles.choiceBtn} onClick={startQuiz}>
                Start quiz
              </button>
              <button
                type="button"
                style={styles.choiceBtnOutline}
                onClick={chooseAiFromPath}
              >
                Let AI decide
              </button>
            </div>
            <button
              type="button"
              style={styles.pathModalBack}
              onClick={backToCompose}
            >
              Edit prompt
            </button>
          </div>
        </div>
      )}

      {flow === "quiz" && (
        <div style={styles.quizRoot}>
          <div
            style={{
              ...styles.quizColumn,
              ...(isReview && blueprintPhase !== "review"
                ? blueprintPhase === "phase1"
                  ? styles.quizColumnWide
                  : styles.quizColumnPhase2
                : {}),
            }}
          >
            {(!isReview ||
              (isReview && blueprintPhase === "review")) && (
              <>
                <h1 style={styles.quizPageTitle}>
                  Shape the product before the AI builds.
                </h1>
                <p style={styles.quizPageSubtitle}>
                  Answer a few quick questions so the AI can choose the right
                  plan, stack, and architecture.
                </p>
              </>
            )}

            {!isReview && question != null && (
              <div
                key={quizStep}
                className="quiz-card-anim"
                style={styles.quizCard}
              >
                <div style={styles.quizProgressRow}>
                  <span style={styles.quizProgressLabel}>
                    Question {quizStep + 1} of {QUIZ_QUESTIONS.length}
                  </span>
                </div>
                <div style={styles.quizProgressTrack}>
                  <div
                    style={{
                      ...styles.quizProgressFill,
                      width: `${progressFraction * 100}%`,
                    }}
                  />
                </div>
                <h2 style={styles.quizQuestionTitle}>{question.prompt}</h2>
                <div style={styles.quizOptionListOuter}>
                  {listOptions.map((opt) => {
                    const selected = currentAnswer.optionId === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className="quiz-list-row"
                        style={{
                          ...styles.quizListRow,
                        }}
                        onClick={() => setOption(opt.id)}
                      >
                        <span style={styles.quizCheckSlot} aria-hidden>
                          <span
                            style={{
                              ...styles.quizCheckRing,
                              ...(selected
                                ? styles.quizCheckRingSelected
                                : {}),
                            }}
                          >
                            {selected ? (
                              <svg
                                width="11"
                                height="11"
                                viewBox="0 0 15 15"
                                fill="none"
                                style={styles.quizCheckSvg}
                              >
                                <path
                                  d="M2.5 7.5L6 11l6.5-7.5"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            ) : null}
                          </span>
                        </span>
                        <span style={styles.quizListRowText}>
                          <span
                            style={{
                              ...styles.quizListOptionTitle,
                              ...(selected
                                ? styles.quizListOptionTitleSelected
                                : {}),
                            }}
                          >
                            {opt.title}
                          </span>
                          <span style={styles.quizListOptionDesc}>
                            {opt.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {isOtherSelected && (
                  <input
                    ref={quizOtherInputRef}
                    id="quiz-other"
                    type="text"
                    style={styles.quizOtherInputReveal}
                    value={currentAnswer.other}
                    onChange={(e) => setOther(e.target.value)}
                    placeholder={question.otherPlaceholder}
                    autoComplete="off"
                  />
                )}
                <div style={styles.quizNav}>
                  <button
                    type="button"
                    style={{
                      ...styles.quizNavBtnGhost,
                      ...(quizStep === 0 ? styles.quizNavBtnDisabled : {}),
                    }}
                    onClick={goBack}
                    disabled={quizStep === 0}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.quizNavBtnPrimary,
                      ...(canContinueStep
                        ? {}
                        : styles.quizNavBtnPrimaryInactive),
                    }}
                    onClick={goNext}
                    disabled={!canContinueStep}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {isReview && blueprintPhase === "review" && (
              <div
                key="review-card"
                className="quiz-card-anim"
                style={styles.quizCard}
              >
                <ul style={styles.quizSummaryListReview}>
                  {QUIZ_QUESTIONS.map((q, i) => {
                    const a = answers[i];
                    const opt =
                      a?.optionId != null && a.optionId !== QUIZ_OTHER_OPTION_ID
                        ? q.options.find((o) => o.id === a.optionId)
                        : null;
                    const otherTrim = a?.other?.trim();
                    const line =
                      a?.optionId === QUIZ_OTHER_OPTION_ID && otherTrim
                        ? otherTrim
                        : opt != null
                          ? opt.title
                          : "—";
                    return (
                      <li
                        key={q.id}
                        style={{
                          ...styles.quizSummaryItem,
                          ...(i === QUIZ_QUESTIONS.length - 1
                            ? styles.quizSummaryItemLast
                            : {}),
                        }}
                      >
                        <span style={styles.quizSummaryLabel}>
                          {q.summaryLabel}
                        </span>
                        <span style={styles.quizSummaryValue}>{line}</span>
                      </li>
                    );
                  })}
                </ul>
                <div style={styles.quizNavReviewSolo}>
                  <button
                    type="button"
                    style={styles.quizNavBtnPrimaryWide}
                    onClick={mockGenerateBlueprint}
                  >
                    Generate blueprint
                  </button>
                </div>
              </div>
            )}

            {blueprintPhase === "phase1" && (
              <div
                className="quiz-card-anim gen-workspace-fade"
                style={styles.genWorkspace}
              >
                <div style={styles.genProgressTop}>
                  <div style={styles.genProgressTopTrack}>
                    <div
                      className="gen-progress-fill"
                      style={{
                        ...styles.genProgressTopFill,
                        width: `${Math.min(100, genProgress * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <h2 style={styles.genMainTitle}>Generating your blueprint.</h2>
                <p style={styles.genMainSubtitle}>
                  The AI is turning your idea into a structured product plan,
                  workflow, interface direction, and architecture.
                </p>
                <div className="gen-two-cols" style={styles.genTwoCol}>
                  <div style={styles.genTimelineCol} aria-label="Blueprint progress">
                    {PHASE1_STEPS.map((step, i) => {
                      const st = genTimeline[i] ?? "queued";
                      const done = st === "done";
                      const pending = st === "done_pending";
                      const active = st === "generating";
                      const queued = st === "queued";
                      return (
                        <div
                          key={step.title}
                          className="gen-timeline-step"
                          style={{
                            ...styles.genTimelineStep,
                            ...(queued ? styles.genTimelineStepQueued : {}),
                          }}
                        >
                          <span
                            style={{
                              ...styles.genTimelineDot,
                              ...(done ? styles.genTimelineDotDone : {}),
                              ...(active ? styles.genTimelineDotRingActive : {}),
                            }}
                            aria-hidden
                          >
                            {done ? (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 12 12"
                                fill="none"
                                style={styles.genTimelineCheck}
                              >
                                <path
                                  d="M2.5 6L5 8.5L9.5 3"
                                  stroke="currentColor"
                                  strokeWidth="1.6"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            ) : pending ? (
                              <span style={styles.genTimelineDotPending} />
                            ) : (
                              <span
                                style={{
                                  ...styles.genTimelineDotInner,
                                  ...(active
                                    ? styles.genTimelineDotInnerActive
                                    : {}),
                                }}
                              />
                            )}
                          </span>
                          <div style={styles.genTimelineTextCol}>
                            <span
                              style={{
                                ...styles.genTimelineTitle,
                                ...(queued
                                  ? styles.genTimelineTitleMuted
                                  : {}),
                                ...(active
                                  ? styles.genTimelineTitleEmphasized
                                  : {}),
                              }}
                            >
                              {step.title}
                            </span>
                            <span style={styles.genTimelineStatus}>
                              {pending
                                ? "Done"
                                : done
                                  ? ""
                                  : active
                                    ? "Generating"
                                    : "Queued"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={styles.genStreamPanel}>
                    <div style={styles.genStreamInner}>
                      {genStreamLines.map((line) => (
                        <p
                          key={line.id}
                          className="gen-stream-line"
                          style={styles.genStreamLine}
                        >
                          {line.text}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {blueprintPhase === "phase2" && (
              <div
                className="phase2-root phase2-enter"
                style={styles.p2Root}
              >
                <div style={styles.p2Inner}>
                  <div style={styles.p2HeadBlock}>
                    <p style={styles.p2Kicker}>Phase 2</p>
                    <h2 style={styles.p2Heading}>Preparing the build system.</h2>
                    <p style={styles.p2Sub}>
                      The AI is turning the blueprint into implementation ready
                      contracts, structure, and agent context.
                    </p>
                  </div>
                  <div style={styles.p2ProgressTop}>
                    <div style={styles.p2ProgressTrack}>
                      <div
                        className="gen-progress-fill"
                        style={{
                          ...styles.p2ProgressFill,
                          width: `${Math.min(100, phase2Progress * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div style={styles.p2StepperWrap}>
                    <div
                      className="p2-stepper-bar"
                      style={styles.p2StepperBar}
                      aria-label="Build preparation steps"
                    >
                      {PHASE2_STEPS.flatMap((_, i) => {
                        const st = phase2Timeline[i] ?? "queued";
                        const isDone = st === "done";
                        const isPending = st === "done_pending";
                        const isGenerating = st === "generating";
                        const isQueued = st === "queued";
                        const dot = (
                          <div
                            key={`p2-dot-${i}`}
                            style={styles.p2StepperDotWrap}
                          >
                            <span
                              className={
                                isGenerating || isPending
                                  ? "p2-stepper-dot-active"
                                  : undefined
                              }
                              style={{
                                ...styles.p2StepperDot,
                                ...(isQueued ? styles.p2StepperDotQueued : {}),
                                ...(isGenerating || isPending
                                  ? styles.p2StepperDotActive
                                  : {}),
                                ...(isDone && !isPending
                                  ? styles.p2StepperDotDone
                                  : {}),
                              }}
                              aria-hidden
                            >
                              {isDone && !isPending ? (
                                <svg
                                  width="8"
                                  height="8"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  style={styles.p2StepperDotCheck}
                                >
                                  <path
                                    d="M1.5 5.5L4 8l4.5-5"
                                    stroke="#ffffff"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              ) : null}
                            </span>
                          </div>
                        );
                        if (i === 0) return [dot];
                        return [
                          <div
                            key={`p2-dash-${i}`}
                            className="p2-stepper-dash"
                            style={styles.p2StepperDash}
                            aria-hidden
                          />,
                          dot,
                        ];
                      })}
                    </div>
                    <div
                      className="p2-single-card-stage"
                      style={styles.p2SingleCardStage}
                    >
                      {(() => {
                        const vi = getVisiblePhase2CardIndex(phase2Timeline);
                        const step = PHASE2_STEPS[vi];
                        if (step == null) return null;
                        const st = phase2Timeline[vi] ?? "queued";
                        const isDone = st === "done";
                        const isPending = st === "done_pending";
                        const isGenerating = st === "generating";
                        const isQueued = st === "queued";
                        const lines = phase2LinesByStep[vi] ?? [];
                        const showStreamZone =
                          !isQueued &&
                          (isGenerating || isPending || isDone);
                        const streamCalm =
                          isDone && !isPending && !isGenerating;

                        return (
                          <div
                            key={vi}
                            className="p2-single-card quiz-card-anim"
                            style={styles.p2SingleCardCell}
                          >
                            <div
                              className="p2-card-wrap"
                              style={{
                                ...styles.p2Card,
                                ...(isQueued ? styles.p2CardQueued : {}),
                                ...(isGenerating || isPending
                                  ? styles.p2CardActive
                                  : {}),
                                ...(isDone && !isPending
                                  ? styles.p2CardDone
                                  : {}),
                              }}
                            >
                              <div style={styles.p2CardTop}>
                                <div style={styles.p2CardTopMain}>
                                  <h3
                                    style={{
                                      ...styles.p2CardTitle,
                                      ...(isQueued
                                        ? styles.p2CardTitleQueued
                                        : {}),
                                      ...(isGenerating || isPending
                                        ? styles.p2CardTitleActive
                                        : {}),
                                    }}
                                  >
                                    {step.title}
                                  </h3>
                                  <p
                                    style={{
                                      ...styles.p2CardDesc,
                                      ...(isQueued
                                        ? styles.p2CardDescQueued
                                        : {}),
                                    }}
                                  >
                                    {step.cardDescription}
                                  </p>
                                </div>
                                <div style={styles.p2CardMeta}>
                                  <span
                                    style={{
                                      ...styles.p2CardStatus,
                                      ...(isQueued
                                        ? styles.p2CardStatusQueued
                                        : {}),
                                    }}
                                  >
                                    {isPending
                                      ? "Done"
                                      : isDone
                                        ? "Done"
                                        : isGenerating
                                          ? "Generating"
                                          : "Queued"}
                                  </span>
                                  {isDone && !isPending ? (
                                    <span
                                      style={styles.p2CardCheck}
                                      aria-hidden
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 12 12"
                                        fill="none"
                                        style={styles.genTimelineCheck}
                                      >
                                        <path
                                          d="M2.5 6L5 8.5L9.5 3"
                                          stroke="currentColor"
                                          strokeWidth="1.6"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        />
                                      </svg>
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              {showStreamZone ? (
                                <div style={styles.p2StreamZone}>
                                  <p style={styles.p2WhatsLabel}>
                                    {isGenerating || isPending
                                      ? "What's happening"
                                      : "Steps"}
                                  </p>
                                  {lines.map((line) => (
                                    <p
                                      key={line.id}
                                      className="p2-stream-line"
                                      style={{
                                        ...styles.p2StreamLine,
                                        ...(streamCalm
                                          ? styles.p2StreamLineCalm
                                          : {}),
                                      }}
                                    >
                                      {line.text}
                                    </p>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {blueprintPhase === "complete" && (
              <div
                className="quiz-card-anim gen-workspace-fade"
                style={styles.bpSuccessRoot}
              >
                <h2 style={styles.genMainTitle}>Build blueprint ready.</h2>
                <p style={{ ...styles.genMainSubtitle, maxWidth: "640px" }}>
                  Your product now has a clear plan, architecture, implementation
                  structure, and agent ready build context.
                </p>
                <div style={styles.bpSuccessPhaseBlock}>
                  <p style={styles.bpSuccessPhaseHeading}>Phase 1</p>
                  <div
                    className="bp-success-phase1-grid"
                    style={styles.bpSuccessPhase1Grid}
                  >
                    {PHASE1_STEPS.map((step) => (
                      <div key={step.title} style={styles.bpSuccessCard}>
                        <p style={styles.bpSuccessCardTitle}>{step.title}</p>
                        <p style={styles.bpSuccessCardDesc}>
                          {step.successDescription}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={styles.bpSuccessPhaseBlock}>
                  <p style={styles.bpSuccessPhaseHeading}>Phase 2</p>
                  <div
                    className="bp-success-phase2-grid"
                    style={styles.bpSuccessPhase2Grid}
                  >
                    {PHASE2_STEPS.map((step) => (
                      <div
                        key={step.title}
                        style={{
                          ...styles.bpSuccessCard,
                          ...styles.bpSuccessCardPhase2,
                        }}
                      >
                        <p style={styles.bpSuccessCardTitle}>{step.title}</p>
                        <p style={styles.bpSuccessCardDesc}>
                          {step.cardDescription}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={styles.bpSuccessActions}>
                  <button
                    type="button"
                    style={styles.quizNavBtnPrimary}
                    onClick={() =>
                      console.info("[mock] Start building", {
                        prompt: input,
                        answers,
                      })
                    }
                  >
                    Start building
                  </button>
                  <button
                    type="button"
                    style={styles.bpSuccessBtnOutline}
                    onClick={() =>
                      console.info("[mock] View blueprint", {
                        prompt: input,
                        answers,
                      })
                    }
                  >
                    View blueprint
                  </button>
                  <button
                    type="button"
                    style={styles.quizNavBtnGhost}
                    onClick={() => {
                      resetGenerationState();
                      setBlueprintPhase("review");
                    }}
                  >
                    Edit inputs
                  </button>
                </div>
              </div>
            )}

            {blueprintPhase === "review" && (
              <button
                type="button"
                style={styles.quizLetAi}
                onClick={exitQuizToAi}
              >
                Let AI decide
              </button>
            )}
          </div>
        </div>
      )}

      {flow === "aiSkip" && (
        <div style={styles.aiSkipRoot}>
          <div style={styles.aiSkipCard}>
            <p style={styles.aiSkipTitle}>The AI will decide from your prompt.</p>
            <p style={styles.aiSkipBody}>
              No quiz answers will be sent. You can change this anytime.
            </p>
            <div style={styles.aiSkipActions}>
              <button
                type="button"
                style={styles.quizNavBtnGhost}
                onClick={backToCompose}
              >
                Edit prompt
              </button>
              <button
                type="button"
                style={styles.quizNavBtnPrimary}
                onClick={() => setFlow("path")}
              >
                Choose direction
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.grain} aria-hidden="true" />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    minHeight: "100vh",
    background: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
    position: "relative",
    overflow: "hidden",
  },
  grain: {
    position: "fixed",
    inset: 0,
    pointerEvents: "none",
    opacity: 0.04,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
    backgroundSize: "200px 200px",
    backgroundRepeat: "repeat",
  },
  greeting: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    marginBottom: "2rem",
    gap: "8px",
  },
  hey: {
    fontSize: "clamp(28px, 4vw, 40px)",
    fontWeight: 500,
    color: "#0a0a0a",
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
  },
  sub: {
    fontSize: "clamp(14px, 2vw, 16px)",
    color: "#0a0a0a",
    fontWeight: 400,
    letterSpacing: "0.01em",
  },
  composer: {
    width: "min(680px, 92vw)",
    background: "#ffffff",
    border: "none",
    borderRadius: "16px",
    display: "flex",
    flexDirection: "column",
    transition: "box-shadow 0.2s ease",
    overflow: "hidden",
    boxShadow: "0 1px 0 rgba(10, 10, 10, 0.04), 0 8px 24px rgba(10, 10, 10, 0.04)",
  },
  composerFocused: {
    boxShadow:
      "0 1px 0 rgba(10, 10, 10, 0.06), 0 10px 28px rgba(10, 10, 10, 0.07)",
  },
  textarea: {
    background: "none",
    border: "none",
    outline: "none",
    resize: "none",
    color: "#0a0a0a",
    fontSize: "15px",
    fontFamily: "inherit",
    fontWeight: 400,
    letterSpacing: "0.01em",
    caretColor: "#0a0a0a",
    padding: "18px 18px 10px",
    lineHeight: 1.6,
    minHeight: "110px",
  },
  bottomBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px 12px",
    borderTop: "none",
  },
  bottomLeft: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  bottomRight: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  plusBtn: {
    width: "30px",
    height: "30px",
    borderRadius: "50%",
    border: "none",
    background: "#f5f5f5",
    color: "#0a0a0a",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background-color 0.15s ease, color 0.15s ease",
    flexShrink: 0,
  },
  modeBtn: {
    background: "none",
    border: "none",
    color: "#0a0a0a",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "4px 0",
    fontFamily: "inherit",
    transition: "color 0.15s",
  },
  modeName: {
    fontSize: "13px",
    fontWeight: 400,
    letterSpacing: "0.01em",
  },
  micBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    border: "none",
    background: "#f5f5f5",
    color: "#0a0a0a",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background-color 0.15s ease, color 0.15s ease",
  },
  sendBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    border: "none",
    background: "#f0f0f0",
    color: "#a3a3a3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "background 0.2s, color 0.2s",
    flexShrink: 0,
  },
  sendBtnActive: {
    background: "#0a0a0a",
    color: "#ffffff",
  },
  mainDimmed: {
    opacity: 0.38,
    filter: "blur(1px)",
    pointerEvents: "none",
    transition: "opacity 0.25s ease, filter 0.25s ease",
  },
  pathOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px 16px",
    backgroundColor: "rgba(255, 255, 255, 0.86)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  },
  pathModal: {
    width: "100%",
    maxWidth: "420px",
    boxSizing: "border-box",
    padding: "22px 18px 16px",
    borderRadius: "14px",
    border: "none",
    backgroundColor: "#ffffff",
    boxShadow: "0 12px 40px rgba(10, 10, 10, 0.08)",
  },
  pathModalTitle: {
    margin: 0,
    fontSize: "21px",
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.22,
    color: "#0a0a0a",
    textAlign: "left",
  },
  pathModalBody: {
    margin: "12px 0 0",
    fontSize: "14px",
    lineHeight: 1.5,
    fontWeight: 400,
    color: "#0a0a0a",
    textAlign: "left",
  },
  pathModalMeta: {
    margin: "16px 0 0",
    fontSize: "12px",
    lineHeight: 1.45,
    fontWeight: 400,
    color: "#0a0a0a",
    textAlign: "left",
    opacity: 0.72,
  },
  pathModalBack: {
    display: "block",
    width: "fit-content",
    marginTop: "14px",
    padding: "4px 0",
    border: "none",
    background: "none",
    color: "#0a0a0a",
    fontSize: "12px",
    fontFamily: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  choiceRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "26px",
  },
  choiceBtn: {
    flex: "1 1 160px",
    padding: "9px 12px",
    borderRadius: "10px",
    border: "none",
    background: "#0a0a0a",
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: 500,
    fontFamily: "inherit",
    letterSpacing: "0.005em",
    cursor: "pointer",
    transition: "background 0.15s, opacity 0.15s",
  },
  choiceBtnOutline: {
    flex: "1 1 160px",
    padding: "9px 12px",
    borderRadius: "10px",
    border: "none",
    background: "#f5f5f5",
    color: "#0a0a0a",
    fontSize: "14px",
    fontWeight: 500,
    fontFamily: "inherit",
    letterSpacing: "0.005em",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  quizRoot: {
    position: "fixed",
    inset: 0,
    zIndex: 150,
    backgroundColor: "#ffffff",
    overflowY: "auto",
    display: "flex",
    justifyContent: "center",
    padding: "48px 20px 64px",
    boxSizing: "border-box",
  },
  quizColumn: {
    width: "100%",
    maxWidth: "560px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
  },
  quizPageTitle: {
    margin: 0,
    fontSize: "clamp(22px, 4vw, 28px)",
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.2,
    color: "#0a0a0a",
    textAlign: "center",
  },
  quizPageSubtitle: {
    margin: "8px 0 0",
    fontSize: "14px",
    lineHeight: 1.5,
    fontWeight: 400,
    color: "#525252",
    textAlign: "center",
  },
  quizCard: {
    marginTop: "16px",
    width: "100%",
    maxWidth: "520px",
    alignSelf: "center",
    boxSizing: "border-box",
    padding: "12px 0 0",
    backgroundColor: "transparent",
  },
  quizProgressRow: {
    display: "flex",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  quizProgressLabel: {
    fontSize: "12px",
    fontWeight: 500,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#737373",
  },
  quizProgressTrack: {
    marginTop: "8px",
    height: "2px",
    borderRadius: "1px",
    backgroundColor: "#ececec",
    overflow: "hidden",
  },
  quizProgressFill: {
    height: "100%",
    backgroundColor: "#0a0a0a",
    borderRadius: "1px",
    transition: "width 0.4s cubic-bezier(0.22, 1, 0.36, 1)",
  },
  quizQuestionTitle: {
    margin: "14px 0 0",
    fontSize: "18px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    lineHeight: 1.35,
    color: "#0a0a0a",
    textAlign: "left",
  },
  quizOptionListOuter: {
    marginTop: "14px",
    borderRadius: 0,
    border: "none",
    overflow: "visible",
    backgroundColor: "transparent",
  },
  quizListRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    minHeight: "76px",
    padding: "14px 0",
    border: "none",
    margin: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
    transition: "background-color 0.15s ease",
    boxSizing: "border-box",
  },
  quizCheckSlot: {
    width: "22px",
    height: "22px",
    minWidth: "22px",
    minHeight: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "#0a0a0a",
  },
  quizCheckRing: {
    width: "17px",
    height: "17px",
    borderRadius: "50%",
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: "#d4d4d4",
    backgroundColor: "transparent",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  quizCheckRingSelected: {
    borderColor: "#0a0a0a",
  },
  quizCheckSvg: {
    display: "block",
    color: "#0a0a0a",
  },
  quizListRowText: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginLeft: "10px",
  },
  quizListOptionTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#0a0a0a",
    lineHeight: 1.25,
  },
  quizListOptionTitleSelected: {
    fontWeight: 600,
    color: "#000000",
    letterSpacing: "-0.01em",
  },
  quizListOptionDesc: {
    fontSize: "13px",
    fontWeight: 400,
    color: "#6b6b6b",
    lineHeight: 1.4,
  },
  quizOtherInputReveal: {
    marginTop: "10px",
    width: "100%",
    height: "44px",
    boxSizing: "border-box",
    padding: "0 14px",
    borderRadius: "14px",
    border: "none",
    fontSize: "13px",
    fontFamily: "inherit",
    color: "#0a0a0a",
    outline: "none",
    backgroundColor: "#f5f5f5",
    transition: "background-color 0.15s ease",
  },
  quizNav: {
    marginTop: "22px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
  },
  quizNavReview: {
    marginTop: "28px",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: "10px",
    flexWrap: "wrap",
  },
  quizNavBtnGhost: {
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    color: "#0a0a0a",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    transition: "background-color 0.15s ease",
  },
  quizNavBtnPrimary: {
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    color: "#ffffff",
    backgroundColor: "#0a0a0a",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    transition: "background-color 0.15s ease, color 0.15s ease",
  },
  quizNavBtnPrimaryInactive: {
    backgroundColor: "#ebebeb",
    color: "#8a8a8a",
    cursor: "not-allowed",
  },
  quizNavBtnDisabled: {
    opacity: 0.35,
    cursor: "not-allowed",
    pointerEvents: "none",
  },
  quizSummaryItem: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    paddingBottom: "12px",
  },
  quizSummaryItemLast: {
    paddingBottom: 0,
  },
  quizSummaryLabel: {
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#737373",
  },
  quizSummaryValue: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#0a0a0a",
  },
  quizColumnWide: {
    maxWidth: "880px",
  },
  quizColumnPhase2: {
    maxWidth: "1120px",
    width: "100%",
  },
  quizSummaryListReview: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  quizNavReviewSolo: {
    marginTop: "32px",
    display: "flex",
    justifyContent: "center",
    width: "100%",
  },
  quizNavBtnPrimaryWide: {
    padding: "12px 28px",
    width: "100%",
    maxWidth: "420px",
    fontSize: "14px",
    fontWeight: 500,
    fontFamily: "inherit",
    color: "#ffffff",
    backgroundColor: "#0a0a0a",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    transition: "background-color 0.15s ease, color 0.15s ease",
  },
  genWorkspace: {
    marginTop: "8px",
    width: "100%",
    maxWidth: "880px",
    alignSelf: "center",
    boxSizing: "border-box",
    padding: "8px 0 0",
  },
  genProgressTop: {
    marginBottom: "22px",
  },
  genProgressTopTrack: {
    height: "2px",
    borderRadius: "1px",
    backgroundColor: "#ececec",
    overflow: "hidden",
  },
  genProgressTopFill: {
    height: "100%",
    backgroundColor: "#0a0a0a",
    borderRadius: "1px",
    width: "0%",
  },
  genMainTitle: {
    margin: 0,
    fontSize: "clamp(22px, 3vw, 28px)",
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.2,
    color: "#0a0a0a",
    textAlign: "center",
  },
  genMainSubtitle: {
    margin: "10px auto 0",
    maxWidth: "580px",
    fontSize: "14px",
    lineHeight: 1.55,
    fontWeight: 400,
    color: "#525252",
    textAlign: "center",
  },
  genTwoCol: {
    marginTop: "28px",
    display: "flex",
    flexDirection: "row",
    alignItems: "stretch",
    gap: "clamp(24px, 4vw, 40px)",
    flexWrap: "wrap",
  },
  genTimelineCol: {
    flex: "0 0 240px",
    minWidth: "200px",
    display: "flex",
    flexDirection: "column",
    gap: "0",
    borderLeft: "1px solid #ebebeb",
    paddingLeft: "18px",
    marginLeft: "6px",
  },
  genTimelineStep: {
    position: "relative",
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "12px",
    padding: "14px 0 16px",
    transition:
      "opacity 0.45s ease, transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)",
  },
  genTimelineStepQueued: {
    opacity: 0.55,
  },
  genTimelineDot: {
    flexShrink: 0,
    width: "22px",
    height: "22px",
    marginLeft: "-31px",
    marginTop: "1px",
    borderRadius: "50%",
    backgroundColor: "#ffffff",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#e5e5e5",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
  },
  genTimelineDotInner: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: "#c4c4c4",
    backgroundColor: "transparent",
    boxSizing: "border-box",
  },
  genTimelineDotInnerActive: {
    borderColor: "#0a0a0a",
    backgroundColor: "#0a0a0a",
  },
  genTimelineDotPending: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    backgroundColor: "#a3a3a3",
  },
  genTimelineCheck: {
    display: "block",
    color: "#0a0a0a",
  },
  genTimelineDotDone: {
    borderColor: "#0a0a0a",
    backgroundColor: "#ffffff",
  },
  genTimelineDotRingActive: {
    borderColor: "#0a0a0a",
  },
  genTimelineTextCol: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  genTimelineTitle: {
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    color: "#0a0a0a",
    lineHeight: 1.3,
  },
  genTimelineTitleMuted: {
    color: "#9a9a9a",
    fontWeight: 500,
  },
  genTimelineTitleEmphasized: {
    color: "#0a0a0a",
    fontWeight: 600,
  },
  genTimelineStatus: {
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#8c8c8c",
    minHeight: "14px",
  },
  genStreamPanel: {
    flex: "1 1 280px",
    minWidth: "min(100%, 320px)",
    minHeight: "300px",
    borderRadius: "12px",
    border: "1px solid #e8e8e8",
    backgroundColor: "#fafafa",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  genStreamInner: {
    padding: "16px 18px 20px",
    maxHeight: "360px",
    overflowY: "auto",
  },
  genStreamLine: {
    margin: 0,
    padding: "6px 0",
    fontSize: "13px",
    lineHeight: 1.45,
    fontWeight: 400,
    color: "#3d3d3d",
    letterSpacing: "0.01em",
    fontFamily: "inherit",
  },
  p2Root: {
    width: "100%",
    maxWidth: "1120px",
    alignSelf: "center",
    boxSizing: "border-box",
    padding: "28px 0 48px",
  },
  p2Inner: {
    width: "100%",
  },
  p2HeadBlock: {
    width: "100%",
    maxWidth: "1120px",
  },
  p2Kicker: {
    margin: "0 0 8px",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#8c8c8c",
  },
  p2Heading: {
    margin: 0,
    fontSize: "clamp(24px, 3.2vw, 34px)",
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.2,
    color: "#0a0a0a",
  },
  p2Sub: {
    margin: "12px 0 0",
    fontSize: "15px",
    lineHeight: 1.55,
    fontWeight: 400,
    color: "#525252",
    maxWidth: "54ch",
  },
  p2ProgressTop: {
    marginTop: "22px",
    marginBottom: "28px",
  },
  p2ProgressTrack: {
    height: "2px",
    borderRadius: "1px",
    backgroundColor: "#ececec",
    overflow: "hidden",
  },
  p2ProgressFill: {
    height: "100%",
    backgroundColor: "#0a0a0a",
    borderRadius: "1px",
    width: "0%",
  },
  p2StepperWrap: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    width: "100%",
    marginTop: "4px",
  },
  p2StepperBar: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    padding: "0 6px",
    boxSizing: "border-box",
  },
  p2StepperDash: {
    flex: "1 1 0",
    minWidth: "16px",
    height: "0",
    borderTop: "1px dashed #c6c6c6",
    alignSelf: "center",
    margin: "0 2px",
  },
  p2StepperDotWrap: {
    flexShrink: 0,
    width: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  p2StepperDot: {
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: "#ffffff",
    transition:
      "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.35s ease, border-color 0.35s ease",
  },
  p2StepperDotQueued: {
    borderColor: "#d6d6d6",
    backgroundColor: "#ffffff",
  },
  p2StepperDotActive: {
    borderColor: "#0a0a0a",
    backgroundColor: "#0a0a0a",
  },
  p2StepperDotDone: {
    borderColor: "#0a0a0a",
    backgroundColor: "#0a0a0a",
    width: "14px",
    height: "14px",
  },
  p2StepperDotCheck: {
    display: "block",
  },
  p2SingleCardStage: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "center",
    width: "100%",
    alignItems: "stretch",
  },
  p2SingleCardCell: {
    width: "100%",
    maxWidth: "620px",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  p2Card: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#e5e5e5",
    borderRadius: "14px",
    backgroundColor: "#ffffff",
    padding: "18px 16px 16px",
    boxSizing: "border-box",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    transition: "border-color 0.45s ease, background-color 0.45s ease",
  },
  p2CardQueued: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ececec",
    backgroundColor: "#ffffff",
  },
  p2CardActive: {
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: "#0a0a0a",
    backgroundColor: "#f0f0f0",
  },
  p2CardDone: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#dedede",
    backgroundColor: "#fafafa",
  },
  p2CardTop: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    flexWrap: "wrap",
  },
  p2CardTopMain: {
    flex: "1 1 220px",
    minWidth: "200px",
  },
  p2CardTitle: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    lineHeight: 1.25,
    color: "#0a0a0a",
    transition: "color 0.35s ease",
  },
  p2CardTitleQueued: {
    color: "#a3a3a3",
    fontWeight: 500,
  },
  p2CardTitleActive: {
    color: "#0a0a0a",
    fontWeight: 600,
  },
  p2CardDesc: {
    margin: "8px 0 0",
    fontSize: "12px",
    lineHeight: 1.45,
    fontWeight: 400,
    color: "#5c5c5c",
    transition: "color 0.35s ease",
  },
  p2CardDescQueued: {
    color: "#b0b0b0",
  },
  p2CardMeta: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    minWidth: "100px",
  },
  p2CardStatus: {
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "#8c8c8c",
  },
  p2CardStatusQueued: {
    color: "#b5b5b5",
  },
  p2CardCheck: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  p2StreamZone: {
    marginTop: "14px",
    paddingTop: "12px",
    borderTop: "1px solid #ebebeb",
    flex: 1,
    minHeight: "0",
    maxHeight: "160px",
    overflowY: "auto",
  },
  p2WhatsLabel: {
    margin: "0 0 8px",
    fontSize: "10px",
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "#737373",
  },
  p2StreamLine: {
    margin: 0,
    padding: "4px 0",
    fontSize: "12px",
    lineHeight: 1.45,
    fontWeight: 400,
    color: "#404040",
    fontFamily: "inherit",
  },
  p2StreamLineCalm: {
    color: "#949494",
  },
  bpSuccessRoot: {
    marginTop: "8px",
    width: "100%",
    maxWidth: "1000px",
    alignSelf: "center",
    boxSizing: "border-box",
    padding: "8px 0 0",
  },
  bpSuccessPhaseBlock: {
    marginTop: "28px",
  },
  bpSuccessPhaseHeading: {
    margin: "0 0 12px",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "#737373",
  },
  bpSuccessPhase1Grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "12px",
  },
  bpSuccessPhase2Grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "14px",
  },
  bpSuccessCard: {
    padding: "16px 16px 15px",
    borderRadius: "12px",
    border: "1px solid #ececec",
    backgroundColor: "#ffffff",
    boxSizing: "border-box",
    transition: "border-color 0.2s ease",
  },
  bpSuccessCardTitle: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: "#0a0a0a",
    lineHeight: 1.25,
  },
  bpSuccessCardDesc: {
    margin: "6px 0 0",
    fontSize: "13px",
    lineHeight: 1.45,
    fontWeight: 400,
    color: "#737373",
  },
  bpSuccessCardPhase2: {
    borderColor: "#d0d0d0",
    backgroundColor: "#f7f7f7",
    padding: "18px 17px 17px",
  },
  bpSuccessActions: {
    marginTop: "28px",
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    justifyContent: "center",
    alignItems: "center",
  },
  bpSuccessBtnOutline: {
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    color: "#0a0a0a",
    backgroundColor: "#f5f5f5",
    border: "1px solid #e5e5e5",
    borderRadius: "10px",
    cursor: "pointer",
    transition: "background-color 0.15s ease, border-color 0.15s ease",
  },
  quizLetAi: {
    marginTop: "20px",
    alignSelf: "center",
    border: "none",
    background: "none",
    fontSize: "12px",
    fontWeight: 500,
    fontFamily: "inherit",
    color: "#737373",
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  aiSkipRoot: {
    position: "fixed",
    inset: 0,
    zIndex: 160,
    backgroundColor: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  aiSkipCard: {
    maxWidth: "400px",
    textAlign: "center",
  },
  aiSkipTitle: {
    margin: 0,
    fontSize: "17px",
    fontWeight: 600,
    color: "#0a0a0a",
    letterSpacing: "-0.02em",
  },
  aiSkipBody: {
    margin: "10px 0 0",
    fontSize: "14px",
    lineHeight: 1.5,
    color: "#525252",
  },
  aiSkipActions: {
    marginTop: "22px",
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    justifyContent: "center",
  },
};

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap');

* { box-sizing: border-box; }

.neel-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 0.55s ease, transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
}
.neel-content.neel-in {
  opacity: 1;
  transform: translateY(0);
}

.quiz-card-anim {
  animation: quizCardIn 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes quizCardIn {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.992);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

button.quiz-list-row:not([aria-checked="true"]):hover {
  background-color: #fafafa !important;
}

button.quiz-list-row[aria-checked="true"] {
  background-color: transparent !important;
}

textarea::placeholder,
input::placeholder {
  color: #737373;
}
textarea::-webkit-scrollbar { display: none; }

button:focus,
button:focus-visible {
  outline: none;
}

input:focus,
input:focus-visible,
textarea:focus,
textarea:focus-visible {
  outline: none;
}

.gen-progress-fill {
  transition: width 1.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.gen-workspace-fade {
  animation: genWorkspaceIn 0.48s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes genWorkspaceIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.gen-stream-line {
  animation: streamLineIn 0.44s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes streamLineIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 700px) {
  .gen-two-cols {
    flex-direction: column;
  }
  .bp-success-phase1-grid,
  .bp-success-phase2-grid {
    grid-template-columns: 1fr !important;
  }
}

@media (max-width: 900px) {
  .p2-stepper-bar {
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 10px;
  }
  .p2-stepper-bar .p2-stepper-dash {
    min-width: 40px;
  }
}

.p2-stepper-dot-active {
  animation: p2StepperPulse 1.45s ease-in-out infinite;
}

@keyframes p2StepperPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.9;
  }
}

.phase2-enter {
  animation: phase2In 0.68s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes phase2In {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.p2-stream-line {
  animation: p2StreamIn 0.58s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes p2StreamIn {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;
