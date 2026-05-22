"use client";

import { useMemo, useState } from "react";

type AgentWorkOrder = {
  name: string;
  purpose: string;
  todos: string[];
  owns: string[];
  reads: string[];
  mustBuild: string[];
  mustNotTouch: string[];
  verification: string[];
  dependencies: string;
};

type BuildWave = {
  number: string;
  title: string;
  agents: string[];
};

type ParsedTaskBreakdown = {
  buildStrategy: string;
  constraints: string[];
  agents: AgentWorkOrder[];
  waves: BuildWave[];
  risks: string[];
};

const AGENT_FIELD_LABELS = [
  "Purpose",
  "Todos",
  "Owns",
  "Reads",
  "Must Build",
  "Must Not Touch",
  "Verification",
  "Handoff",
  "Dependencies",
] as const;

export function TaskBreakdownPlanView({
  content,
  status,
  isStreaming,
}: {
  content: string;
  status: string;
  isStreaming: boolean;
}) {
  const plan = useMemo(() => parseTaskBreakdown(content), [content]);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const activeAgent =
    plan.agents.find((agent) => agent.name === selectedAgentName) ??
    plan.agents[plan.agents.length - 1] ??
    plan.agents[0];

  if (!content.trim()) {
    return (
      <section className="task-plan-view task-plan-empty" aria-label="Task breakdown plan">
        <p>Preparing the parallel build plan...</p>
      </section>
    );
  }

  return (
    <section className="task-plan-view" aria-label="Task breakdown plan">
      <header className="task-plan-header">
        <div>
          <p>Execution Plan</p>
          <h2>Task Breakdown</h2>
        </div>
        <span className={`task-plan-status task-plan-status-${status}`}>
          {isStreaming ? "streaming" : status}
        </span>
      </header>

      {plan.buildStrategy ? (
        <section className="task-plan-strategy" aria-label="Build strategy">
          <strong>Build Strategy</strong>
          <p>{plan.buildStrategy}</p>
        </section>
      ) : null}

      {plan.constraints.length > 0 ? (
        <section className="task-plan-constraints" aria-label="Global constraints">
          {plan.constraints.slice(0, 8).map((constraint) => (
            <span key={constraint}>{constraint}</span>
          ))}
        </section>
      ) : null}

      <div className="task-plan-grid">
        <section className="task-wave-panel" aria-label="Parallel waves">
          <div className="task-section-title">
            <strong>Parallel Build Plan</strong>
            <span>{plan.waves.length || "..."} waves</span>
          </div>
          <div className="task-wave-list">
            {(plan.waves.length ? plan.waves : fallbackWaves(plan.agents)).map((wave) => (
              <article key={`${wave.number}-${wave.title}`} className="task-wave-card">
                <div className="task-wave-card-top">
                  <span>Wave {wave.number}</span>
                  <strong>{wave.title || "Work Orders"}</strong>
                </div>
                <div className="task-wave-agents">
                  {wave.agents.map((agentName) => {
                    const isActive = activeAgent?.name === agentName;
                    return (
                      <button
                        key={agentName}
                        type="button"
                        className={`task-wave-agent${isActive ? " task-wave-agent-active" : ""}`}
                        onClick={() => setSelectedAgentName(agentName)}
                        aria-pressed={isActive}
                      >
                        <i aria-hidden />
                        <span>{agentName}</span>
                      </button>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="task-agent-panel" aria-label="Selected agent work order">
          {activeAgent ? (
            <AgentWorkOrderCard agent={activeAgent} />
          ) : (
            <p className="task-plan-muted">Waiting for the first work order...</p>
          )}
        </section>
      </div>

      {plan.risks.length > 0 ? (
        <section className="task-risk-row" aria-label="Risks">
          <strong>Risks</strong>
          <div>
            {plan.risks.slice(0, 3).map((risk) => (
              <span key={risk}>{risk}</span>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function AgentWorkOrderCard({ agent }: { agent: AgentWorkOrder }) {
  return (
    <article className="task-agent-card">
      <header className="task-agent-card-header">
        <div>
          <p>Agent Work Order</p>
          <h3>{agent.name}</h3>
        </div>
        <span>ready</span>
      </header>

      {agent.purpose ? (
        <section className="task-agent-purpose">
          <strong>Purpose</strong>
          <p>{agent.purpose}</p>
        </section>
      ) : null}

      <TaskList title="Todos" items={agent.todos} ordered />

      <div className="task-agent-columns">
        <TaskList title="Owns" items={agent.owns} />
        <TaskList title="Must Not Touch" items={agent.mustNotTouch} />
      </div>

      <div className="task-agent-columns">
        <TaskList title="Reads" items={agent.reads} />
        <TaskList title="Verification" items={agent.verification} code />
      </div>

      {agent.mustBuild.length > 0 ? <TaskList title="Must Build" items={agent.mustBuild} /> : null}

      {agent.dependencies ? (
        <section className="task-agent-dependencies">
          <strong>Dependencies</strong>
          <p>{agent.dependencies}</p>
        </section>
      ) : null}
    </article>
  );
}

function TaskList({
  title,
  items,
  ordered = false,
  code = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  code?: boolean;
}) {
  if (items.length === 0) return null;
  const ListTag: "ol" | "ul" = ordered ? "ol" : "ul";
  return (
    <section className="task-agent-list">
      <strong>{title}</strong>
      <ListTag>
        {items.slice(0, 7).map((item) => (
          <li key={item}>
            {code ? <code>{item}</code> : <span>{item}</span>}
          </li>
        ))}
      </ListTag>
    </section>
  );
}

function parseTaskBreakdown(markdown: string): ParsedTaskBreakdown {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const agentBlocks = splitAgentBlocks(section(normalized, "Agent Work Orders"));
  const agents = agentBlocks.map(parseAgentBlock).filter((agent) => agent.name.trim().length > 0);

  return {
    buildStrategy: cleanInline(section(normalized, "Build Strategy")),
    constraints: parseList(section(normalized, "Global Constraints")).map(shortenConstraint),
    agents,
    waves: parseWaves(section(normalized, "Parallelization Plan")),
    risks: parseList(section(normalized, "Risks")).map(shortenConstraint),
  };
}

function section(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im"));
  return match?.[1]?.trim() ?? "";
}

function splitAgentBlocks(markdown: string): Array<{ name: string; body: string }> {
  const matches = [...markdown.matchAll(/^###\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return {
      name: cleanInline(match[1]),
      body: markdown.slice(start, end).trim(),
    };
  });
}

function parseAgentBlock(block: { name: string; body: string }): AgentWorkOrder {
  return {
    name: block.name,
    purpose: cleanInline(field(block.body, "Purpose")),
    todos: parseList(field(block.body, "Todos")),
    owns: parseList(field(block.body, "Owns")),
    reads: parseList(field(block.body, "Reads")),
    mustBuild: parseList(field(block.body, "Must Build")),
    mustNotTouch: parseList(field(block.body, "Must Not Touch")),
    verification: parseList(field(block.body, "Verification")),
    dependencies: cleanInline(field(block.body, "Dependencies")),
  };
}

function field(body: string, label: string): string {
  const labels = AGENT_FIELD_LABELS.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^${escaped}:\\s*$([\\s\\S]*?)(?=^(${labels}):\\s*$|(?![\\s\\S]))`, "im"));
  return stripFence(match?.[1]?.trim() ?? "");
}

function parseList(value: string): string[] {
  return stripFence(value)
    .split("\n")
    .map((line) => cleanInline(line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "")))
    .filter(Boolean);
}

function parseWaves(value: string): BuildWave[] {
  const lines = stripFence(value).split("\n");
  const waves: BuildWave[] = [];
  for (const line of lines) {
    const waveMatch = line.match(/^\s*Wave\s+(\d+):?\s*(.*?)\s*$/i);
    const agentMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (waveMatch) {
      waves.push({ number: waveMatch[1], title: waveMatch[2], agents: [] });
    } else if (agentMatch && waves.length > 0) {
      waves[waves.length - 1].agents.push(cleanInline(agentMatch[1]));
    }
  }
  return waves.filter((wave) => wave.agents.length > 0);
}

function fallbackWaves(agents: AgentWorkOrder[]): BuildWave[] {
  if (agents.length === 0) return [];
  return [{ number: "1", title: "Work Orders", agents: agents.map((agent) => agent.name) }];
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:text|md|markdown)?\s*\n([\s\S]*?)\n?```\s*$/i);
  return (match?.[1] ?? trimmed).trim();
}

function cleanInline(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenConstraint(value: string): string {
  const colonIndex = value.indexOf(":");
  return colonIndex > 0 ? value.slice(0, colonIndex).trim() : value;
}
