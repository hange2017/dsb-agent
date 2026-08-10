import * as fs from "fs";
import * as path from "path";

export interface MemoryEntry {
  name: string;
  description: string;
  body: string;
  updatedAt: number;
  /** 累计被 MemoryRead/MemoryList 触碰(读取)的次数,参与索引加权排序。 */
  accessCount?: number;
  /** 最近一次被读取的时间戳,参与索引加权排序(缺省回退 updatedAt)。 */
  lastAccessAt?: number;
  /** 常驻标记:true 时索引置顶且不受 limit 截断(用于关键项目约定等)。 */
  pinned?: boolean;
}

const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** 记忆整合元数据文件名(list() 因形状校验天然跳过,不会混入记忆索引)。 */
const DREAM_META_FILE = "meta.json";

/** 一次访问 ≈ 6 小时新鲜度:加权分数 = min(accessCount,100) * 步长 + 最近活跃时间。 */
const ACCESS_WEIGHT_MS = 6 * 60 * 60 * 1000;

/** 索引加权排序分数:pinned 恒最高,其余按「访问频率 × 步长 + 最近活跃时间」降序。 */
function rankScore(e: MemoryEntry): number {
  if (e.pinned) return Number.MAX_SAFE_INTEGER;
  const recency = e.lastAccessAt ?? e.updatedAt;
  const freq = Math.min(e.accessCount ?? 0, 100);
  return freq * ACCESS_WEIGHT_MS + recency;
}

/** 记忆条目的形状校验:跳过"合法 JSON 但形状不对"的文件(`{}`/`[]`/`"str"` 等),避免把
 * 缺字段的条目当作记忆注入 prompt(如 `- undefined: undefined`)。 */
function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.description === "string" && typeof v.body === "string";
}

export class MemoryStore {
  constructor(private readonly dir: string) {
    // 目录延迟到首次写入时创建:构造不触碰文件系统,配置的 memoryDir 不可写不会让
    // activate() 崩溃,而是由 MemoryWrite 工具调用返回错误。list/get/index 均检查
    // existsSync,可容忍目录不存在。
  }

  /**
   * 返回绑定到指定 projectKey 的子存储:文件落在 `<dir>/<projectKey>/`,
   * 与全局根目录、其他项目互不干扰。类型与根实例相同,接口零改动。
   */
  scoped(projectKey: string): MemoryStore {
    return new MemoryStore(path.join(this.dir, projectKey));
  }

  private fileFor(name: string): string {
    return path.join(this.dir, `${slug(name)}.json`);
  }

  list(): MemoryEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const entries: MemoryEntry[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as unknown;
        if (isMemoryEntry(parsed)) entries.push(parsed);
      } catch {
        // 单个损坏的 .json(截断/手改)跳过,不让一个坏文件拖垮整个清单/索引
      }
    }
    // 加权排序:pinned 常驻置顶,其余按访问频率 + 最近活跃时间降序
    return entries.sort((a, b) => rankScore(b) - rankScore(a));
  }

  get(name: string): MemoryEntry | undefined {
    const file = this.fileFor(name);
    if (!fs.existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isMemoryEntry(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** 触碰计数:MemoryRead/MemoryList 命中时记录一次访问(accessCount++、lastAccessAt=now),
   * 供索引加权排序使用。文件缺失/损坏时静默跳过,与 list/get 容错一致。 */
  touch(name: string): void {
    const file = this.fileFor(name);
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isMemoryEntry(parsed)) return;
      const e = parsed as MemoryEntry;
      fs.writeFileSync(
        file,
        JSON.stringify({ ...e, accessCount: (e.accessCount ?? 0) + 1, lastAccessAt: Date.now() }, null, 2),
        "utf8",
      );
    } catch {
      // 损坏文件跳过
    }
  }

  write(entry: MemoryEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // 覆盖时保留既有访问统计与 pinned(未显式变更时继承旧值,避免一次普通覆盖悄悄清掉
    // 常驻标记或历史访问);显式传 false/0 可解除。
    const prev = this.get(entry.name);
    const toSave = {
      ...entry,
      updatedAt: Date.now(),
      accessCount: entry.accessCount ?? prev?.accessCount ?? 0,
      lastAccessAt: entry.lastAccessAt ?? prev?.lastAccessAt,
      pinned: entry.pinned ?? prev?.pinned ?? false,
    };
    fs.writeFileSync(this.fileFor(entry.name), JSON.stringify(toSave, null, 2), "utf8");
  }

  delete(name: string): void {
    const file = this.fileFor(name);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  /**
   * 读取最近一次记忆整合(/memory dream)的时间戳,来自 `<dir>/meta.json`;
   * 未整合过或文件损坏时返回 undefined。list()/index() 的形状校验天然忽略该文件。
   */
  readDreamAt(): number | undefined {
    try {
      const file = path.join(this.dir, DREAM_META_FILE);
      if (!fs.existsSync(file)) return undefined;
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const ts = (raw as Record<string, unknown>).lastDreamAt;
      return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
    } catch {
      return undefined;
    }
  }

  /** 记录一次记忆整合时间到 `<dir>/meta.json`(目录不存在时自动创建)。 */
  writeDreamAt(ts: number): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, DREAM_META_FILE), JSON.stringify({ lastDreamAt: ts }, null, 2), "utf8");
  }

  /**
   * 索引截断选项:limit 截断条数、maxDescLen 截断单条 description。
   * 排序沿用 list() 的加权序;pinned 条目常驻:即使超过 limit 也会先被纳入
   * (pinned 数量本身超过 limit 时按加权序截断,防止常驻标记被滥用塞满索引)。
   */
  index(label?: string, opts?: { limit?: number; maxDescLen?: number }): string {
    const entries = this.list();
    if (entries.length === 0) return "";
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : undefined;
    const maxDescLen = opts?.maxDescLen !== undefined && opts.maxDescLen > 0 ? opts.maxDescLen : undefined;
    const pinned = entries.filter((e) => e.pinned);
    const rest = entries.filter((e) => !e.pinned);
    const picked: MemoryEntry[] =
      limit !== undefined ? [...pinned.slice(0, limit), ...rest.slice(0, Math.max(0, limit - pinned.length))] : entries;
    return picked
      .map((e) => {
        const desc = maxDescLen !== undefined && e.description.length > maxDescLen
          ? e.description.slice(0, maxDescLen) + "…"
          : e.description;
        return label ? `(${label}) ${e.name}: ${desc}` : `- ${e.name}: ${desc}`;
      })
      .join("\n");
  }
}

/**
 * 合并多个记忆索引块(全局 + 项目),空块/空白块跳过,重复行去重。
 * 项目 scope 可见的记忆 = 项目记忆 + 全局记忆(全局对所有项目共享,兼容旧版全局记忆)。
 */
export function mergeMemoryIndex(...indices: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of indices) {
    for (const line of (block ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.join("\n");
}
