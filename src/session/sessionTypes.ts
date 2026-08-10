import type { ToolBodyBlock } from "../chat/toolPresentation";

export type SessionToolPresentation = {
  displayName: string;
  headerSecondary?: string;
  summary?: string;
  body?: ToolBodyBlock[];
};

export type SessionEvent =
  | { kind: "user"; text: string; timestamp: number }
  | { kind: "assistant"; text: string; final?: boolean; timestamp: number }
  | {
      kind: "tool";
      name: string;
      status: "running" | "completed" | "error";
      detail?: string;
      input?: unknown;
      presentation?: SessionToolPresentation;
      timestamp: number;
    }
  | { kind: "thinking"; text: string; durationMs?: number; timestamp: number };

export type SessionSummary = { id: string; title: string; updatedAt: number };
