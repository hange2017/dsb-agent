import * as fs from "fs";
import * as path from "path";
import type { SessionEvent, SessionSummary } from "./sessionTypes";
import type { ProviderMessage } from "../agent/provider/types";

/** 逐条校验 API 历史元素形状:防「合法 JSON 但结构错误」的文件被直接喂给模型 API。 */
function isProviderMessage(m: unknown): boolean {
  if (m === null || typeof m !== "object") return false;
  const msg = m as { role?: unknown; content?: unknown };
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  return typeof msg.content === "string" || Array.isArray(msg.content);
}

export class SessionStore {
  constructor(private readonly sessionsDir: string) {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private fileFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  private apiFileFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.api.json`);
  }

  private todosFileFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.todos.json`);
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const out: SessionSummary[] = [];
    for (const f of fs.readdirSync(this.sessionsDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      try {
        const stat = fs.statSync(path.join(this.sessionsDir, f));
        // 只读文件头部找首个 user 事件取标题,避免数百会话时整文件解析(性能)
        out.push({ id, title: this.peekTitle(id), updatedAt: stat.mtimeMs });
      } catch {
        // 单个文件损坏/不可读不影响整个列表
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 轻量标题提取:只读 JSONL 前 256KB(会话首个事件几乎总是 user),
   * 按行解析找第一个 `kind === "user"` 事件;找不到(异常结构/超长前缀)返回「新会话」。
   * 相比 `load(id)` 全量解析,数百会话场景下磁盘读与解析量下降一个数量级。
   */
  private peekTitle(id: string, maxBytes = 256 * 1024): string {
    const file = this.fileFor(id);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as { kind?: string; text?: string };
          if (ev && typeof ev === "object" && ev.kind === "user" && typeof ev.text === "string") {
            return ev.text.replace(/\s+/g, " ").slice(0, 40);
          }
        } catch {
          // 单行损坏或落在读取边界被截断:跳过,继续找下一个 user 事件
        }
      }
      return "新会话";
    } catch {
      return "新会话";
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // 关闭失败可忽略
        }
      }
    }
  }

  create(): string {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(this.fileFor(id), "", "utf8");
    return id;
  }

  /** 会话 JSONL 是否存在(用于 init 自动恢复前校验 lastSessionId)。 */
  exists(id: string): boolean {
    return fs.existsSync(this.fileFor(id));
  }

  append(id: string, ev: SessionEvent): void {
    fs.appendFileSync(this.fileFor(id), JSON.stringify(ev) + "\n", "utf8");
  }

  load(id: string): SessionEvent[] {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return [];
    const out: SessionEvent[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const ev = JSON.parse(line) as SessionEvent;
        if (ev && typeof ev === "object" && "kind" in ev) out.push(ev);
      } catch {
        // 跳过损坏的一行,不拖垮整个会话
      }
    }
    return out;
  }

  /** 覆写 API 历史真相源:tmp + rename 避免半写。持久化失败由调用方(try/catch)fail-open。 */
  saveApiHistory(id: string, messages: ProviderMessage[]): void {
    const file = this.apiFileFor(id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(messages), "utf8");
    fs.renameSync(tmp, file);
  }

  private blockFileFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.block.json`);
  }

  /** 保存压缩块快照(方向 3):会话恢复回退时把上次发送的压缩块原文当旧脉络,首轮可命中。tmp + rename 原子写。 */
  saveApiSnapshot(id: string, block: string): void {
    const file = this.blockFileFor(id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ block }), "utf8");
    fs.renameSync(tmp, file);
  }

  /** 读取压缩块快照;文件缺失/损坏/非块一律返回 null,绝不 throw。 */
  loadApiSnapshot(id: string): string | null {
    const file = this.blockFileFor(id);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") return null;
      const block = (parsed as Record<string, unknown>).block;
      if (typeof block !== "string" || !block.includes("[compacted]")) return null;
      return block;
    } catch {
      return null;
    }
  }

  /** 持久化 todos;tmp + rename 避免半写。 */
  saveTodos(id: string, items: Array<{ id: string; content: string; done: boolean }>): void {
    const file = this.todosFileFor(id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), "utf8");
    fs.renameSync(tmp, file);
  }

  /** 读取 todos;文件缺失或损坏一律返回 [],绝不 throw。 */
  loadTodos(id: string): Array<{ id: string; content: string; done: boolean }> {
    const file = this.todosFileFor(id);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: Array<{ id: string; content: string; done: boolean }> = [];
      for (const item of parsed) {
        if (item === null || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.content !== "string" || typeof o.done !== "boolean") continue;
        out.push({ id: o.id, content: o.content, done: o.done });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 读取 API 历史;文件缺失或损坏一律返回 [] ,绝不 throw。 */
  loadApiHistory(id: string): ProviderMessage[] {
    const file = this.apiFileFor(id);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isProviderMessage)) return [];
      return parsed as ProviderMessage[];
    } catch {
      return [];
    }
  }

  delete(id: string): void {
    const file = this.fileFor(id);
    if (fs.existsSync(file)) fs.rmSync(file);
    const api = this.apiFileFor(id);
    if (fs.existsSync(api)) fs.rmSync(api);
    const todos = this.todosFileFor(id);
    if (fs.existsSync(todos)) fs.rmSync(todos);
    const block = this.blockFileFor(id);
    if (fs.existsSync(block)) fs.rmSync(block);
  }
}

export function sessionIdToTitle(events: SessionEvent[]): string {
  const firstUser = events.find((e) => e.kind === "user");
  if (!firstUser || firstUser.kind !== "user") return "新会话";
  return firstUser.text.replace(/\s+/g, " ").slice(0, 40);
}

/**
 * 旧版会话目录布局:会话文件直接落在 sessionsRoot 根下。
 * 升级到按项目隔离后,把根下的会话文件(含 api/todos 伴生文件)迁移到
 * `<sessionsRoot>/<projectKey>/` 子目录。会话 id 是文件名,移动后不变,
 * 因此 lastSessionId(globalState) 指向的会话在迁移后仍可恢复。
 * 返回迁移的文件数;已有子目录与无关文件不处理;单个文件失败不阻断(fail-open)。
 */
export function migrateLegacySessions(sessionsRoot: string, projectKey: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  const legacyFiles = entries.filter(
    (f) => f.endsWith(".jsonl") || f.endsWith(".api.json") || f.endsWith(".todos.json"),
  );
  if (legacyFiles.length === 0) return 0;
  const dest = path.join(sessionsRoot, projectKey);
  fs.mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const f of legacyFiles) {
    try {
      fs.renameSync(path.join(sessionsRoot, f), path.join(dest, f));
      moved++;
    } catch {
      // 单个文件迁移失败不阻断其余
    }
  }
  return moved;
}

/** 列出 sessionsRoot 下已有的项目子目录(用于跨项目浏览/迁移)。 */
export function listSessionProjects(sessionsRoot: string): string[] {
  try {
    return fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
