import type { MemoryEntry } from "./memoryStore";
import type { MemoryStore } from "./memoryStore";

/** 记忆管理页面的作用域:项目记忆 / 全局共享记忆。 */
export type MemoryScope = "project" | "global";

/**
 * 记忆管理器(引擎层,无 vscode 依赖):供记忆管理面板(panel)与测试使用。
 * 项目记忆与全局记忆分开读写;list 分组返回,便于 UI 分区展示。
 */
export class MemoryManager {
  constructor(
    private readonly project: MemoryStore,
    private readonly global: MemoryStore,
    private readonly projectKey: string,
  ) {}

  /** 当前项目 key(UI 展示当前项目标签)。 */
  key(): string {
    return this.projectKey;
  }

  /** 分组列出项目记忆与全局记忆(各自按 updatedAt 新→旧)。 */
  list(): { project: MemoryEntry[]; global: MemoryEntry[] } {
    return { project: this.project.list(), global: this.global.list() };
  }

  /** 校验并写入;scope=project 写项目,global 写全局。字段缺失/空白抛错。 */
  write(
    scope: MemoryScope,
    input: { name?: unknown; description?: unknown; body?: unknown },
  ): MemoryEntry {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!name) throw new Error("memory name is required");
    if (!description) throw new Error("memory description is required");
    if (!body) throw new Error("memory body is required");
    const entry: MemoryEntry = { name, description, body, updatedAt: Date.now() };
    (scope === "global" ? this.global : this.project).write(entry);
    return entry;
  }

  /** 删除;scope=project 只删项目,global 只删全局(同名互不影响)。 */
  delete(scope: MemoryScope, name: string): void {
    (scope === "global" ? this.global : this.project).delete(name);
  }
}
