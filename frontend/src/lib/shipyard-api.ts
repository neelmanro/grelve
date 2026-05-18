import { getPublicApiBaseUrl } from "@/lib/api";
import type {
  RawShipyardStreamEvent,
  ShipyardRunRequest,
  ShipyardPreviewInfo,
  ShipyardStreamEvent,
  ShipyardTodoItem,
} from "@/types/shipyard";

type StreamHandlers = {
  onEvent: (event: ShipyardStreamEvent) => void;
  onError: (message: string) => void;
  onDone: () => void;
  signal?: AbortSignal;
};

type RunCreateResponse = {
  run_id?: string;
  id?: string;
  stream_url?: string;
};

const API_PREFIX = "/api/v1";

export async function streamShipyardRun(
  request: ShipyardRunRequest,
  handlers: StreamHandlers,
): Promise<void> {
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    handlers.onDone();
  };

  try {
    const createResponse = await fetch(`${getPublicApiBaseUrl()}${API_PREFIX}/shipyard/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: handlers.signal,
    });

    if (!createResponse.ok) {
      handlers.onError(await formatApiError(createResponse));
      finish();
      return;
    }

    if (isEventStream(createResponse)) {
      await readEventStream(createResponse, handlers);
      finish();
      return;
    }

    const data = (await createResponse.json()) as RunCreateResponse;
    const runId = data.run_id ?? data.id;
    if (runId) {
      handlers.onEvent({ type: "run_created", runId, raw: { run_id: runId } });
    }
    const rawStreamUrl =
      data.stream_url ??
      (runId ? `${getPublicApiBaseUrl()}${API_PREFIX}/shipyard/runs/${runId}/stream` : null);
    const streamUrl = rawStreamUrl ? absoluteApiUrl(rawStreamUrl) : null;

    if (!streamUrl) {
      handlers.onError("The backend created a run but did not return a stream URL.");
      finish();
      return;
    }

    const streamResponse = await fetch(streamUrl, { signal: handlers.signal });
    if (!streamResponse.ok) {
      handlers.onError(await formatApiError(streamResponse));
      finish();
      return;
    }

    await readEventStream(streamResponse, handlers);
    finish();
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      finish();
      return;
    }
    handlers.onError(error instanceof Error ? error.message : "Stream failed.");
    finish();
  }
}

export async function streamShipyardBuildRun(
  runId: string,
  handlers: StreamHandlers,
): Promise<void> {
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    handlers.onDone();
  };

  try {
    const streamResponse = await fetch(
      `${getPublicApiBaseUrl()}${API_PREFIX}/shipyard/runs/${runId}/build-stream`,
      { signal: handlers.signal },
    );
    if (!streamResponse.ok) {
      handlers.onError(await formatApiError(streamResponse));
      finish();
      return;
    }

    await readEventStream(streamResponse, handlers);
    finish();
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      finish();
      return;
    }
    handlers.onError(error instanceof Error ? error.message : "Build stream failed.");
    finish();
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

function absoluteApiUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${getPublicApiBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
}

async function readEventStream(
  response: Response,
  handlers: Pick<StreamHandlers, "onEvent" | "onError">,
): Promise<void> {
  if (!response.body) {
    handlers.onError("The backend response did not include a stream body.");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      handleStreamBlock(block, handlers);
    }
  }

  if (buffer.trim()) {
    handleStreamBlock(buffer, handlers);
  }
}

function handleStreamBlock(
  block: string,
  handlers: Pick<StreamHandlers, "onEvent" | "onError">,
): void {
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;

    const payload = line.slice(5).trim();
    // Heartbeats, padding, and OpenAI-style stream terminators must NOT become a Shipyard
    // "done" event — that prematurely completes the run in the UI while the server is still working.
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(payload) as RawShipyardStreamEvent;
      handlers.onEvent(normalizeShipyardEvent(parsed));
    } catch {
      handlers.onEvent({ type: "text_delta", text: payload, raw: { payload } });
    }
  }
}

function normalizeShipyardEvent(raw: RawShipyardStreamEvent): ShipyardStreamEvent {
  if (typeof raw.c === "string") {
    return { type: "text_delta", text: raw.c, agent: stringValue(raw.agent), wave: numberValue(raw.wave), raw };
  }

  const eventName = stringValue(raw.event ?? raw.type ?? raw.kind);

  if (eventName === "error") {
    return {
      type: "error",
      message: stringValue(raw.error ?? raw.message ?? raw.detail) || "Request failed.",
      raw,
    };
  }

  if (eventName === "done" || eventName === "complete") {
    return { type: "done", phase: phaseValue(raw.phase), raw };
  }

  if (eventName === "agent_start" || eventName === "agent_started") {
    return {
      type: "agent_start",
      agent: stringValue(raw.agent ?? raw.name ?? raw.title) || "Agent",
      title: stringValue(raw.title),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "agent_done" || eventName === "agent_completed") {
    return {
      type: "agent_done",
      agent: stringValue(raw.agent ?? raw.name ?? raw.title) || "Agent",
      title: stringValue(raw.title),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "wave_start" || eventName === "wave_done") {
    return {
      type: eventName,
      wave: numberValue(raw.wave) ?? 0,
      title: stringValue(raw.title),
      raw,
    };
  }

  if (eventName === "todo_update") {
    return {
      type: "todo_update",
      agent: stringValue(raw.agent) || "Agent",
      wave: numberValue(raw.wave),
      todos: todoItemsValue(raw.todos),
      raw,
    };
  }

  if (eventName === "preview_ready") {
    return {
      type: "preview_ready",
      preview: previewInfoValue(raw.preview),
      raw,
    };
  }

  if (eventName === "tool_start" || eventName === "tool_call") {
    return {
      type: "tool_start",
      toolId: stringValue(raw.id ?? raw.tool_id),
      toolName: stringValue(raw.name ?? raw.tool ?? raw.tool_name) || "tool",
      input: raw.input ?? raw.arguments,
      agent: stringValue(raw.agent),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "tool_delta") {
    return {
      type: "tool_delta",
      toolId: stringValue(raw.id ?? raw.tool_id),
      toolName: stringValue(raw.name ?? raw.tool ?? raw.tool_name),
      arguments: stringValue(raw.arguments),
      argumentsDelta: stringValue(raw.arguments_delta),
      agent: stringValue(raw.agent),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "tool_result") {
    return {
      type: "tool_result",
      toolId: stringValue(raw.id ?? raw.tool_id),
      toolName: stringValue(raw.name ?? raw.tool ?? raw.tool_name),
      result: recordValue(raw.result),
      ok: raw.ok === true,
      agent: stringValue(raw.agent),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "tool_log" || eventName === "command_log") {
    return {
      type: "tool_log",
      toolId: stringValue(raw.id ?? raw.tool_id),
      toolName: stringValue(raw.name ?? raw.tool ?? raw.tool_name),
      stream: stringValue(raw.stream),
      chunk: stringValue(raw.chunk ?? raw.text ?? raw.output),
      agent: stringValue(raw.agent),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  if (eventName === "file_diff" || eventName === "diff") {
    return {
      type: "file_diff",
      path: stringValue(raw.path ?? raw.file),
      diff: stringValue(raw.diff ?? raw.content),
      raw,
    };
  }

  if (eventName === "artifact" || eventName === "artifact_saved") {
    return {
      type: "artifact",
      name: stringValue(raw.name ?? raw.title ?? raw.path) || "Artifact",
      path: stringValue(raw.path),
      content: stringValue(raw.content),
      raw,
    };
  }

  if (eventName === "markdown_delta" || eventName === "content_delta") {
    return {
      type: "text_delta",
      text: stringValue(raw.content ?? raw.text ?? raw.delta),
      agent: stringValue(raw.agent),
      wave: numberValue(raw.wave),
      raw,
    };
  }

  return {
    type: "status",
    title: eventName || "Status update",
    detail: stringValue(raw.message ?? raw.detail ?? raw.text),
    raw,
  };
}

async function formatApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail = stringValue(data.detail ?? data.error);
    if (detail) return detail;
  } catch {
    try {
      const text = await response.text();
      if (text.trim()) return text.trim();
    } catch {
      /* ignore */
    }
  }

  return `Request failed (${response.status})`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function phaseValue(value: unknown): "planning" | "build" | undefined {
  return value === "planning" || value === "build" ? value : undefined;
}

function todoItemsValue(value: unknown): ShipyardTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => typeof item.id === "string" && typeof item.content === "string")
    .map((item) => {
      const status: ShipyardTodoItem["status"] =
        item.status === "completed" || item.status === "in_progress" || item.status === "pending"
          ? item.status
          : "pending";
      return {
        id: String(item.id),
        content: String(item.content),
        status,
      };
    });
}

function previewInfoValue(value: unknown): ShipyardPreviewInfo {
  const record = recordValue(value);
  return {
    editor_url: stringValue(record.editor_url),
    preview_url: stringValue(record.preview_url),
    frontend_url: stringValue(record.frontend_url),
    backend_url: stringValue(record.backend_url),
    backend_command: stringValue(record.backend_command),
    frontend_command: stringValue(record.frontend_command),
    env_required: record.env_required === true,
    env_notes: stringValue(record.env_notes),
  };
}
