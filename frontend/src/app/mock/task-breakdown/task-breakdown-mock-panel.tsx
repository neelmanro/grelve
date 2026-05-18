"use client";

import { BUILD_WAVES, toolContent, type ActivityView } from "@/lib/shipyard-run-state";

type ParsedWorkOrder = {
  name: string;
  purpose: string;
  todos: string[];
  mustBuild: string[];
  owns: string[];
  verification: string[];
  isPlaceholder?: boolean;
  wave?: number;
  waveTitle?: string;
};

const TASK_FIELD_LABELS = [
  "Purpose",
  "Todos",
  "Owns",
  "Reads",
  "Must Build",
  "Must Not Touch",
  "Verification",
  "Handoff",
  "Dependencies",
];

function TaskMiniSection({
  title,
  items,
  variant = "plain",
}: {
  title: string;
  items: string[];
  variant?: "plain" | "check" | "mono";
}) {
  const visible = items.slice(0, 4);
  return (
    <div className="task-mini-section">
      <strong>{title}</strong>
      {visible.length > 0 ? (
        <ul className={`task-mini-list task-mini-list-${variant}`}>
          {visible.map((item, index) => (
            <li key={item} className={variant === "check" && index === 0 ? "task-check-active" : undefined}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="task-mini-skeleton" aria-hidden>
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

function TaskBreakdownCards({ activity }: { activity: ActivityView }) {
  const content = toolContent(activity);
  const orders = parseTaskBreakdown(content);
  const groups = groupWorkOrdersByWave(orders);

  return (
    <div className="task-breakdown-stage" aria-label="Build agent work orders (mock)">
      <header className="task-breakdown-head">
        <div>
          <p className="task-breakdown-kicker">Build work orders</p>
          <h3>Preparing specialized agents</h3>
        </div>
        <span>{activity.status === "running" ? "streaming" : "ready"}</span>
      </header>

      <div className="task-wave-list">
        {groups.map((group) => (
          <section key={group.number} className="task-wave">
            <div className="task-wave-header">
              <span>Wave {group.number}</span>
              <strong>{group.title}</strong>
            </div>
            <div className="task-agent-grid">
              {group.orders.map((order) => (
                <article
                  key={order.name}
                  className={`task-agent-card${order.isPlaceholder ? " task-agent-card-waiting" : ""}`}
                >
                  <div className="task-agent-card-top">
                    <h4>{order.name}</h4>
                    <p>{order.purpose || "Waiting for generated instructions..."}</p>
                  </div>
                  <TaskMiniSection title="Todos" items={order.todos} variant="check" />
                  <TaskMiniSection title="Must build" items={order.mustBuild} variant="check" />
                  <TaskMiniSection title="Owns" items={order.owns} variant="mono" />
                  <TaskMiniSection title="Verify" items={order.verification} variant="mono" />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function TaskBreakdownMockPanel({ markdown, streaming }: { markdown: string; streaming: boolean }) {
  const activity: ActivityView = {
    id: "mock-task-breakdown",
    kind: "tool",
    title: "write_artifact",
    tone: "neutral",
    timestamp: "mock",
    toolName: "write_artifact",
    status: streaming ? "running" : "success",
    input:
      streaming && markdown
        ? { path: "docs/task_breakdown.md", content: markdown }
        : { path: "docs/task_breakdown.md", content: markdown },
    result: streaming ? {} : { path: "docs/task_breakdown.md", content: markdown },
  };

  return <TaskBreakdownCards activity={activity} />;
}

function parseTaskBreakdown(markdown: string): ParsedWorkOrder[] {
  const agentSectionMatch = markdown.match(/## Agent Work Orders\s*([\s\S]*?)(?=\n## |$)/i);
  const agentSection = agentSectionMatch?.[1] ?? markdown;
  const sections = [...agentSection.matchAll(/^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s+|\n## |$)/gim)];

  return sections
    .map((section) => {
      const name = cleanupText(section[1]);
      const body = section[2] ?? "";
      const waveInfo = waveForAgent(name);
      return {
        name,
        purpose: cleanupText(fieldText(body, "Purpose")),
        todos: fieldBlockItems(body, "Todos"),
        mustBuild: fieldBlockItems(body, "Must Build"),
        owns: fieldBlockItems(body, "Owns"),
        verification: fieldBlockItems(body, "Verification"),
        wave: waveInfo?.number,
        waveTitle: waveInfo?.title,
      };
    })
    .filter((order) => order.name.toLowerCase().includes("agent"));
}

function groupWorkOrdersByWave(orders: ParsedWorkOrder[]) {
  const orderMap = new Map(orders.map((order) => [normalizeAgentName(order.name), order]));
  return BUILD_WAVES.map((wave) => ({
    number: wave.number,
    title: wave.title,
    orders: wave.agents.map((agentName) => {
      const parsed = orderMap.get(normalizeAgentName(agentName));
      return parsed
        ? { ...parsed, name: agentName, wave: wave.number, waveTitle: wave.title }
        : {
            name: agentName,
            purpose: "",
            todos: [],
            mustBuild: [],
            owns: [],
            verification: [],
            isPlaceholder: true,
            wave: wave.number,
            waveTitle: wave.title,
          };
    }),
  }));
}

function waveForAgent(agentName: string): { number: number; title: string } | undefined {
  const normalized = normalizeAgentName(agentName);
  const wave = BUILD_WAVES.find((candidate) =>
    candidate.agents.some((agent) => normalizeAgentName(agent) === normalized),
  );
  return wave ? { number: wave.number, title: wave.title } : undefined;
}

function fieldText(body: string, label: string): string {
  const block = fieldBlock(body, label);
  return cleanupText(unfenceMarkdown(block).split("\n").find((line) => cleanupText(line)) ?? "");
}

function fieldBlockItems(body: string, label: string): string[] {
  const block = unfenceMarkdown(fieldBlock(body, label));
  return block
    .split("\n")
    .map((line) => cleanupText(line.replace(/^(\d+[.)]\s+|[-*]\s+)/, "")))
    .filter(Boolean)
    .filter((line) => !fieldLabelRegex().test(line));
}

function fieldBlock(body: string, label: string): string {
  const labels = TASK_FIELD_LABELS.map(escapeRegex).join("|");
  const match = body.match(
    new RegExp(`(?:^|\\n)${escapeRegex(label)}:\\s*\\n*([\\s\\S]*?)(?=\\n(?:${labels}):|\\n###\\s+|\\n##\\s+|$)`, "i"),
  );
  return match?.[1] ?? "";
}

function unfenceMarkdown(value: string): string {
  return value
    .replace(/```(?:text|md|markdown)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function fieldLabelRegex(): RegExp {
  return new RegExp(`^(${TASK_FIELD_LABELS.map(escapeRegex).join("|")}):$`, "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanupText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim();
}

function normalizeAgentName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
