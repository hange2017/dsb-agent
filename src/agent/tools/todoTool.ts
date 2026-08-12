import type { ToolDef } from "./types";

export type TodoItem = { id: string; content: string; done: boolean };

/** 把 content 内嵌的 markdown 勾选框与条目 done 对齐,避免「主项已完成但正文仍是 - [ ]」误导模型反复执行。 */
export function syncEmbeddedCheckboxes(content: string, done: boolean): string {
  const mark = done ? "x" : " ";
  return content.replace(/^(\s*[-*]\s+)\[[ xX]\]/gm, `$1[${mark}]`);
}

export class TodoManager {
  private items: TodoItem[] = [];
  private seq = 0;

  list(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  hasPending(): boolean {
    return this.items.some((i) => !i.done);
  }

  replaceAll(items: TodoItem[]): void {
    this.items = items.map((i) => ({
      id: i.id,
      content: syncEmbeddedCheckboxes(i.content, i.done),
      done: i.done,
    }));
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
    it.content = syncEmbeddedCheckboxes(it.content, done);
    return true;
  }
  clear(): void {
    this.items = [];
  }
  toPromptBlock(): string {
    if (this.items.length === 0) return "## 任务清单\n(空)";
    const lines = this.items.map((i) => {
      const content = syncEmbeddedCheckboxes(i.content, i.done);
      return `- [${i.done ? "x" : " "}] ${content} (${i.id})`;
    });
    return "## 任务清单\n" + lines.join("\n");
  }
}

export const TODO_TOOL_DEF: ToolDef = {
  name: "TodoWrite",
  description:
    "管理任务清单:list/add/update/clear。长任务建议先建清单再逐项完成。" +
    "子步骤请用多条独立 todo(各自 id),不要在单条 content 里嵌套 - [ ] 清单;" +
    "update done=true 表示整项完成。全部完成后无需再调用本工具。",
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
