import type { SessionEvent } from "./sessionTypes";

export type SessionTodoItem = { id: string; content: string; done: boolean };

const kMaxBodyChars = 4000;

const workspaceSlug = (root: string): string =>
  root.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function lastUserTexts(events: SessionEvent[], limit: number): string[] {
  const texts: string[] = [];
  for (let i = events.length - 1; i >= 0 && texts.length < limit; i--) {
    const ev = events[i];
    if (ev.kind === "user" && ev.text.trim() !== "") texts.unshift(ev.text.trim());
  }
  return texts;
}

function toolSnippet(ev: Extract<SessionEvent, { kind: "tool" }>): string {
  const input = ev.input;
  if (input !== null && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.path === "string" && o.path !== "") return o.path;
    if (typeof o.command === "string" && o.command !== "") return o.command.slice(0, 120);
  }
  if (ev.detail && ev.detail.trim() !== "") return ev.detail.trim().slice(0, 120);
  return "";
}

function lastTools(events: SessionEvent[], limit: number): string[] {
  const lines: string[] = [];
  for (let i = events.length - 1; i >= 0 && lines.length < limit; i--) {
    const ev = events[i];
    if (ev.kind !== "tool") continue;
    const snippet = toolSnippet(ev);
    lines.unshift(snippet ? `${ev.name}: ${snippet}` : ev.name);
  }
  return lines;
}

function formatTodos(todos: SessionTodoItem[]): { open: string[]; done: string[] } {
  const open: string[] = [];
  const done: string[] = [];
  for (const t of todos) {
    if (t.done) done.push(t.content);
    else open.push(t.content);
  }
  return { open, done };
}

function truncateBody(body: string): string {
  if (body.length <= kMaxBodyChars) return body;
  return body.slice(0, kMaxBodyChars - 3) + "...";
}

/** 从会话事件与 todos 启发式拼接进度记忆条目(不调 LLM)。 */
export function buildSessionProgressMemory(input: {
  workspaceRoot: string;
  sessionId: string;
  events: SessionEvent[];
  todos: SessionTodoItem[];
}): { name: string; description: string; body: string; updatedAt: number } {
  const openCount = input.todos.filter((t) => !t.done).length;
  const name = `session-progress-${workspaceSlug(input.workspaceRoot)}`;
  const description = `会话进度 · ${openCount} 待办`;

  const users = lastUserTexts(input.events, 3);
  const { open, done } = formatTodos(input.todos);
  // 最近工具 ≤3 条,每行 100 字符内截断:进度记忆只需"最近在做什么",不需要完整输出
  const tools = lastTools(input.events, 3).map((t) => (t.length > 100 ? t.slice(0, 100) + "…" : t));
  const updatedAt = input.events.length > 0 ? input.events[input.events.length - 1].timestamp : Date.now();
  const isoTime = new Date(updatedAt).toISOString();

  const sections: string[] = ["# 会话进度", "", `**sessionId:** \`${input.sessionId}\`  ·  **时间:** ${isoTime}`, ""];

  if (users.length > 0) {
    sections.push("## 最近用户目标", "");
    for (const u of users) sections.push(`- ${u}`);
    sections.push("");
  }

  sections.push("## 待办", "");
  if (open.length > 0) {
    sections.push("### 未完成", "");
    for (const t of open) sections.push(`- [ ] ${t}`);
    sections.push("");
  } else {
    sections.push("_无未完成待办_", "");
  }
  if (done.length > 0) {
    sections.push("### 已完成", "");
    for (const t of done) sections.push(`- [x] ${t}`);
    sections.push("");
  }

  if (tools.length > 0) {
    sections.push("## 最近工具", "");
    for (const t of tools) sections.push(`- ${t}`);
    sections.push("");
  }

  return {
    name,
    description,
    body: truncateBody(sections.join("\n")),
    updatedAt,
  };
}
