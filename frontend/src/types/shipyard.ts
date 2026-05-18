export type ShipyardStack = {
  frontend: "Next.js TypeScript React";
  backend: "FastAPI";
  database: "SQLite";
};

export type ShipyardRunRequest = {
  prompt: string;
  stack: ShipyardStack;
};

export type RawShipyardStreamEvent = Record<string, unknown>;

export type ShipyardTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type ShipyardPreviewInfo = {
  editor_url: string;
  preview_url: string;
  frontend_url: string;
  backend_url: string;
  backend_command: string;
  frontend_command: string;
  env_required: boolean;
  env_notes: string;
};

export type ShipyardStreamEvent =
  | {
      type: "run_created";
      runId: string;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "text_delta";
      text: string;
      agent?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "agent_start" | "agent_done";
      agent: string;
      title?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "wave_start" | "wave_done";
      wave: number;
      title: string;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "todo_update";
      agent: string;
      wave?: number;
      todos: ShipyardTodoItem[];
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "preview_ready";
      preview: ShipyardPreviewInfo;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "tool_start";
      toolId?: string;
      toolName: string;
      input?: unknown;
      agent?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "tool_delta";
      toolId?: string;
      toolName?: string;
      arguments?: string;
      argumentsDelta?: string;
      agent?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "tool_log";
      toolId?: string;
      toolName?: string;
      stream?: string;
      chunk: string;
      agent?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "tool_result";
      toolId?: string;
      toolName?: string;
      result?: Record<string, unknown>;
      ok?: boolean;
      agent?: string;
      wave?: number;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "file_diff";
      path?: string;
      diff: string;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "artifact";
      name: string;
      path?: string;
      content?: string;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "status";
      title: string;
      detail?: string;
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "done";
      phase?: "planning" | "build";
      raw: RawShipyardStreamEvent;
    }
  | {
      type: "error";
      message: string;
      raw: RawShipyardStreamEvent;
    };

export const FIXED_SHIPYARD_STACK: ShipyardStack = {
  frontend: "Next.js TypeScript React",
  backend: "FastAPI",
  database: "SQLite",
};
