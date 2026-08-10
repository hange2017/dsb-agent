import type { ToolDef } from "./types";

export type TodoItem = { id: string; content: string; done: boolean };

export class TodoManager {
  private items: TodoItem[] = [];
  private seq = 0;

  list(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  replaceAll(items: TodoItem[]): void {
    this.items = items.map((i) => ({ ...i }));
    let maxSeq = this.seq;
    for (const item of this.items) {
      const match = /^t(\d+)$/.exec(item.id);
      if (match) {
        maxSeq = Math.max(maxSeq, Number(match[1]));
      }
    }
    this.seq = maxSeq;
  }
  add(content: string): TodoItem {
    const item = { id: `t${++this.seq}`, content, done: false };
    this.items.push(item);
    return item;
  }
  update(id: string, done: boolean): boolean {
    const it = this.items.find((i) => i.id === id);
    if (!it) return false;
    it.done = done;
    return true;
  }
  clear(): void {
    this.items = [];
  }
  toPromptBlock(): string {
    if (this.items.length === 0) return "## 任务清单\n(空)";
    const lines = this.items.map((i) => `- [${i.done ? "x" : " "}] ${i.content} (${i.id})`);
    return "## 任务清单\n" + lines.join("\n");
  }
}

export const TODO_TOOL_DEF: ToolDef = {
  name: "TodoWrite",
  description: "管理任务清单:list/add/update/clear。长任务建议先建清单再逐项完成。",
  input_schema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "add", "update", "clear"] },
      content: { type: "string" },
      id: { type: "string" },
      done: { type: "boolean" },
    },
    required: ["op"],
  },
};
