import type { ShipyardPreviewInfo, ShipyardStreamEvent, ShipyardTodoItem } from "@/types/shipyard";

export type RunStatus = "idle" | "running" | "done" | "failed";
export type AgentStatus = "queued" | "running" | "done";
export type RunPhase = "planning" | "build";
export type ActivityTone = "neutral" | "success" | "warning" | "danger";
export type ActivityKind = "tool" | "log" | "error";
export type ActivityStatus = "running" | "success" | "error";

export type AgentView = {
  id: string;
  name: string;
  status: AgentStatus;
  wave?: number;
  todos?: ShipyardTodoItem[];
};

export type ActivityView = {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  tone: ActivityTone;
  timestamp: string;
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status?: ActivityStatus;
  logs?: string;
  agentName?: string;
  wave?: number;
};

export type RunView = {
  runId?: string;
  status: RunStatus;
  phase: RunPhase;
  activeWave?: number;
  waves: WaveView[];
  preview?: ShipyardPreviewInfo;
  streamText: string;
  agents: AgentView[];
  activities: ActivityView[];
};

export type WaveStatus = "queued" | "running" | "done" | "failed";

export type WaveView = {
  number: number;
  title: string;
  status: WaveStatus;
};

export type WorkflowStepId = "intake" | "product" | "system" | "api" | "tasks" | "repo";
export type WorkflowStepStatus = "queued" | "running" | "done" | "failed";

export type WorkflowStep = {
  id: WorkflowStepId;
  number: string;
  title: string;
  label: string;
  description: string;
  artifactPath?: string;
};

export const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "intake",
    number: "01",
    title: "Intake",
    label: "Writing Intake",
    description: "Normalizes the request, constraints, and fixed brand rules.",
    artifactPath: "docs/intake.md",
  },
  {
    id: "product",
    number: "02",
    title: "Product Brief",
    label: "Writing Product Brief",
    description: "Turns the raw prompt into a focused product brief.",
    artifactPath: "docs/product_brief.md",
  },
  {
    id: "system",
    number: "03",
    title: "System Design",
    label: "Writing System Design",
    description: "Translates the brief into app structure, entities, and workflows.",
    artifactPath: "docs/system_design.md",
  },
  {
    id: "api",
    number: "04",
    title: "API Contract",
    label: "Writing API Contract",
    description: "Locks frontend, backend, data, and error contracts before code.",
    artifactPath: "docs/api_contract.md",
  },
  {
    id: "tasks",
    number: "05",
    title: "Task Breakdown",
    label: "Writing Task Breakdown",
    description: "Creates file-owned work orders for future parallel build agents.",
    artifactPath: "docs/task_breakdown.md",
  },
  {
    id: "repo",
    number: "06",
    title: "Repo Setup",
    label: "Setting Up Repo",
    description: "Creates the planning-ready scaffold, docs, and setup report.",
  },
];

export const BUILD_WAVES = [
  { number: 1, title: "Foundation", agents: ["Backend Data Agent", "Frontend Shell Agent"] },
  { number: 2, title: "Core Product", agents: ["Backend API Agent", "Frontend Feature Agent"] },
  { number: 3, title: "API Connection", agents: ["Frontend API Integration Agent"] },
  { number: 4, title: "Integration", agents: ["Integration Agent"] },
  { number: 5, title: "Review", agents: ["Review Agent"] },
  { number: 6, title: "Deploy Preview", agents: ["Deploy Preview Agent"] },
] as const;

export function createId(prefix: string): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${cryptoId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function nowLabel(): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

export function createBuildWaves(): WaveView[] {
  return BUILD_WAVES.map((wave) => ({
    number: wave.number,
    title: wave.title,
    status: "queued",
  }));
}

export function setWaveStatus(
  waves: WaveView[],
  waveNumber: number,
  status: WaveStatus,
  title?: string,
): WaveView[] {
  const base = waves.length ? waves : createBuildWaves();
  return base.map((wave) =>
    wave.number === waveNumber ? { ...wave, title: title || wave.title, status } : wave,
  );
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function friendlyAgentName(name: string): string {
  const normalized = normalizeName(name);
  if (normalized.includes("backenddata")) return "Backend Data Agent";
  if (normalized.includes("backendapi")) return "Backend API Agent";
  if (normalized.includes("frontendshell")) return "Frontend Shell Agent";
  if (normalized.includes("frontendfeature")) return "Frontend Feature Agent";
  if (normalized.includes("frontendapi")) return "Frontend API Integration Agent";
  if (normalized.includes("integration")) return "Integration Agent";
  if (normalized.includes("review")) return "Review Agent";
  if (normalized.includes("deploy")) return "Deploy Preview Agent";
  if (normalized.includes("intake")) return "Intake Agent";
  if (normalized.includes("product")) return "Product Brief Agent";
  if (normalized.includes("system")) return "System Design Agent";
  if (normalized.includes("api")) return "API Contract Agent";
  if (normalized.includes("task") || normalized.includes("breakdown")) return "Task Breakdown Agent";
  if (normalized.includes("repo")) return "Repo Setup Agent";
  return name || "Agent";
}

export function appendActivity(
  activities: ActivityView[],
  next: Omit<ActivityView, "id" | "timestamp">,
): ActivityView[] {
  return [
    ...activities,
    {
      ...next,
      id: createId("activity"),
      timestamp: nowLabel(),
    },
  ].slice(-80);
}

export function toolPath(activity: ActivityView): string {
  return stringValue(activity.result?.path) || stringValue(activity.input?.path) || "";
}

export function toolContent(activity: ActivityView): string {
  const input = activity.input ?? {};
  const result = activity.result ?? {};
  if (activity.status === "running") {
    return (
      stringValue(input.content) ||
      stringValue(input.new_text) ||
      stringValue(input.__rawArguments)
    );
  }
  return stringValue(result.content) || stringValue(result.diff) || "";
}

export function isMarkdownPreviewPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown");
}

export function parsePartialToolInput(raw: string | undefined): Record<string, unknown> {
  const fallback: Record<string, unknown> = raw ? { __rawArguments: raw } : {};
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { __rawArguments: raw, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    const pathMatch = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
    const content = raw.match(/"(?:content|new_text)"\s*:\s*"((?:\\.|[^"\\])*)$/)?.[1];
    return {
      ...fallback,
      ...(pathMatch ? { path: safeJsonStringFragment(pathMatch) } : {}),
      ...(content ? { content: safeJsonStringFragment(content) } : {}),
    };
  }
  return fallback;
}

export function inferToolNameFromArguments(raw: string | undefined): string {
  if (!raw) return "write_file";
  if (raw.includes("write_artifact")) return "write_artifact";
  if (raw.includes('"old_text"') || raw.includes('"new_text"')) return "edit_file";
  return "write_file";
}

export function safeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\?$/, "")}"`);
  } catch {
    return value.replaceAll("\\n", "\n").replaceAll('\\"', '"');
  }
}

function setAgentStatus(
  agents: AgentView[],
  name: string,
  status: AgentStatus,
  wave?: number,
): AgentView[] {
  const normalizedName = normalizeName(name);
  const existing = agents.some((agent) => normalizeName(agent.name) === normalizedName);
  const next: AgentView[] = existing
    ? agents
    : [...agents, { id: createId("agent"), name, status: "queued", wave }];

  return next.map((agent) => {
    if (normalizeName(agent.name) === normalizedName) return { ...agent, status, wave: wave ?? agent.wave };
    return agent;
  });
}

function setAgentTodos(
  agents: AgentView[],
  name: string,
  todos: ShipyardTodoItem[],
  wave?: number,
): AgentView[] {
  const normalizedName = normalizeName(name);
  const existing = agents.some((agent) => normalizeName(agent.name) === normalizedName);
  const next: AgentView[] = existing
    ? agents
    : [...agents, { id: createId("agent"), name, status: "running", wave }];

  return next.map((agent) =>
    normalizeName(agent.name) === normalizedName ? { ...agent, todos, wave: wave ?? agent.wave } : agent,
  );
}

function appendOrMergeToolLog(
  activities: ActivityView[],
  event: Extract<ShipyardStreamEvent, { type: "tool_log" }>,
): ActivityView[] {
  const index = activities.findIndex((activity) => activity.toolId && activity.toolId === event.toolId);
  if (index >= 0) {
    const current = activities[index];
    return [
      ...activities.slice(0, index),
      {
        ...current,
        kind: "tool",
        agentName: event.agent ? friendlyAgentName(event.agent) : current.agentName,
        wave: event.wave ?? current.wave,
        logs: `${current.logs ?? ""}${event.chunk}`,
        timestamp: nowLabel(),
      },
      ...activities.slice(index + 1),
    ];
  }

  return appendActivity(activities, {
    kind: "tool",
    title: event.toolName ? event.toolName : "run_command",
    tone: event.stream === "stderr" ? "warning" : "neutral",
    toolId: event.toolId,
    toolName: event.toolName,
    agentName: event.agent ? friendlyAgentName(event.agent) : undefined,
    wave: event.wave,
    status: "running",
    logs: event.chunk,
  });
}

function upsertToolActivity(
  activities: ActivityView[],
  update: {
    toolId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    status: ActivityStatus;
    agentName?: string;
    wave?: number;
  },
): ActivityView[] {
  const index = activities.findIndex((activity) => activity.toolId && activity.toolId === update.toolId);
  if (index >= 0) {
    const current = activities[index];
    return [
      ...activities.slice(0, index),
      {
        ...current,
        toolName: update.toolName || current.toolName,
        title: update.toolName || current.title,
        input: { ...(current.input ?? {}), ...(update.input ?? {}) },
        status: update.status,
        agentName: update.agentName || current.agentName,
        wave: update.wave ?? current.wave,
        timestamp: nowLabel(),
      },
      ...activities.slice(index + 1),
    ];
  }

  return appendActivity(activities, {
    kind: "tool",
    title: update.toolName || "tool",
    tone: "neutral",
    toolId: update.toolId,
    toolName: update.toolName,
    input: update.input ?? {},
    status: update.status,
    agentName: update.agentName,
    wave: update.wave,
    logs: "",
  });
}

function finishToolActivity(
  activities: ActivityView[],
  event: Extract<ShipyardStreamEvent, { type: "tool_result" }>,
): ActivityView[] {
  const index = activities.findIndex((activity) => activity.toolId && activity.toolId === event.toolId);
  const status: ActivityStatus = event.result?.ok === false || event.ok === false ? "error" : "success";
  if (index < 0) {
    return appendActivity(activities, {
      kind: "tool",
      title: event.toolName || "tool",
      tone: status === "error" ? "danger" : "success",
      toolId: event.toolId,
      toolName: event.toolName,
      result: event.result,
      status,
      agentName: event.agent ? friendlyAgentName(event.agent) : undefined,
      wave: event.wave,
    });
  }

  const current = activities[index];
  return [
    ...activities.slice(0, index),
    {
      ...current,
      toolName: event.toolName || current.toolName,
      title: event.toolName || current.title,
      result: event.result,
      status,
      tone: status === "error" ? "danger" : "success",
      agentName: event.agent ? friendlyAgentName(event.agent) : current.agentName,
      wave: event.wave ?? current.wave,
      timestamp: nowLabel(),
    },
    ...activities.slice(index + 1),
  ];
}

export function applyStreamEvent(run: RunView, event: ShipyardStreamEvent): RunView {
  if (event.type === "run_created") {
    return {
      ...run,
      runId: event.runId,
    };
  }

  if (event.type === "text_delta") {
    return {
      ...run,
      streamText: run.streamText + event.text,
    };
  }

  if (event.type === "wave_start") {
    return {
      ...run,
      phase: "build",
      activeWave: event.wave,
      waves: setWaveStatus(run.waves.length ? run.waves : createBuildWaves(), event.wave, "running", event.title),
    };
  }

  if (event.type === "wave_done") {
    return {
      ...run,
      activeWave: event.wave < BUILD_WAVES.length ? event.wave + 1 : event.wave,
      waves: setWaveStatus(run.waves.length ? run.waves : createBuildWaves(), event.wave, "done", event.title),
    };
  }

  if (event.type === "todo_update") {
    return {
      ...run,
      agents: setAgentTodos(run.agents, friendlyAgentName(event.agent), event.todos, event.wave),
    };
  }

  if (event.type === "preview_ready") {
    return {
      ...run,
      preview: event.preview,
    };
  }

  if (event.type === "agent_start") {
    const agentName = friendlyAgentName(event.agent);
    return {
      ...run,
      agents: setAgentStatus(run.agents, agentName, "running", event.wave),
      activities: run.activities,
    };
  }

  if (event.type === "agent_done") {
    const agentName = friendlyAgentName(event.agent);
    return {
      ...run,
      agents: setAgentStatus(run.agents, agentName, "done", event.wave),
      activities: run.activities,
    };
  }

  if (event.type === "tool_start") {
    return {
      ...run,
      activities: upsertToolActivity(run.activities, {
        toolId: event.toolId,
        toolName: event.toolName,
        input: recordValue(event.input),
        status: "running",
        agentName: event.agent ? friendlyAgentName(event.agent) : undefined,
        wave: event.wave,
      }),
    };
  }

  if (event.type === "tool_delta") {
    return {
      ...run,
      activities: upsertToolActivity(run.activities, {
        toolId: event.toolId,
        toolName: event.toolName || inferToolNameFromArguments(event.arguments),
        input: parsePartialToolInput(event.arguments),
        status: "running",
        agentName: event.agent ? friendlyAgentName(event.agent) : undefined,
        wave: event.wave,
      }),
    };
  }

  if (event.type === "tool_log") {
    return {
      ...run,
      activities: appendOrMergeToolLog(run.activities, event),
    };
  }

  if (event.type === "file_diff") {
    return run;
  }

  if (event.type === "artifact") {
    return run;
  }

  if (event.type === "tool_result") {
    return {
      ...run,
      activities: finishToolActivity(run.activities, event),
    };
  }

  if (event.type === "error") {
    return {
      ...run,
      status: "failed",
      activities: appendActivity(run.activities, {
        kind: "error",
        title: "Backend error",
        body: event.message,
        tone: "danger",
      }),
    };
  }

  if (event.type === "done") {
    return {
      ...run,
      status: "done",
      activities: run.activities,
      agents: run.agents.map((agent) => (agent.status === "running" ? { ...agent, status: "done" } : agent)),
    };
  }

  if (event.type === "status") {
    return run;
  }

  return run;
}

export function workflowStepForAgent(name: string): WorkflowStepId | null {
  const normalized = normalizeName(name);
  if (normalized.includes("intake")) return "intake";
  if (normalized.includes("product")) return "product";
  if (normalized.includes("system")) return "system";
  if (normalized.includes("api")) return "api";
  if (normalized.includes("task") || normalized.includes("breakdown")) return "tasks";
  if (normalized.includes("repo")) return "repo";
  return null;
}

/** Display label for the planning agent that owns this workflow step (matches stream `agent` + friendlyAgentName). */
export function canonicalPlanningAgentLabel(stepId: WorkflowStepId): string {
  switch (stepId) {
    case "intake":
      return "Intake Agent";
    case "product":
      return "Product Brief Agent";
    case "system":
      return "System Design Agent";
    case "api":
      return "API Contract Agent";
    case "tasks":
      return "Task Breakdown Agent";
    case "repo":
      return "Repo Setup Agent";
  }
}

/** Full chronological tool activity for one planning agent (read_skill, read_artifact, writes, etc.). */
export function activitiesForPlanningStep(run: RunView, stepId: WorkflowStepId): ActivityView[] {
  const label = canonicalPlanningAgentLabel(stepId);
  const needle = normalizeName(label);
  return run.activities.filter(
    (activity) => activity.agentName && normalizeName(activity.agentName) === needle,
  );
}

export function workflowStatusForStep(run: RunView, stepId: WorkflowStepId): WorkflowStepStatus {
  const agent = run.agents.find((candidate) => workflowStepForAgent(candidate.name) === stepId);
  if (!agent) return "queued";
  if (run.status === "failed" && agent.status === "running") return "failed";
  return agent.status;
}

export function workflowSegmentProgress(run: RunView, leftIndex: number): "none" | "partial" | "full" {
  const left = workflowStatusForStep(run, WORKFLOW_STEPS[leftIndex].id);
  const right = workflowStatusForStep(run, WORKFLOW_STEPS[leftIndex + 1].id);
  if (left !== "done") return "none";
  if (right === "done") return "full";
  return "partial";
}

export function getActiveWorkflowStepId(run: RunView): WorkflowStepId {
  const runningAgent = run.agents.find((agent) => agent.status === "running");
  const runningStep = runningAgent ? workflowStepForAgent(runningAgent.name) : null;
  if (runningStep) return runningStep;

  const firstPending = WORKFLOW_STEPS.find((step) => workflowStatusForStep(run, step.id) !== "done");
  if (firstPending) return firstPending.id;
  return "repo";
}

function findLatestPlanningArtifactActivity(activities: ActivityView[], path: string): ActivityView | undefined {
  return [...activities]
    .reverse()
    .find((activity) => activity.toolName === "write_artifact" && toolPath(activity) === path);
}

export function planningDocumentForStep(run: RunView, step: WorkflowStep): {
  path: string;
  content: string;
  status: WorkflowStepStatus;
  isStreaming: boolean;
} {
  const path = step.artifactPath ?? "";
  const activity = path ? findLatestPlanningArtifactActivity(run.activities, path) : undefined;
  const content = activity ? toolContent(activity) : "";
  return {
    path,
    content,
    status: workflowStatusForStep(run, step.id),
    isStreaming: activity?.status === "running",
  };
}

export function isPlanningArtifactPath(path: string): boolean {
  return WORKFLOW_STEPS.some((step) => step.artifactPath === path);
}

export function isPlanningArtifactActivity(activity: ActivityView): boolean {
  return activity.toolName === "write_artifact" && isPlanningArtifactPath(toolPath(activity));
}

export function repoActivities(run: RunView): ActivityView[] {
  const operational = run.activities.filter((activity) => !isPlanningArtifactActivity(activity));
  return operational.length > 0 ? operational : run.activities;
}
