/**
 * ContextStore —— 冷存储:被分轨压缩替换出上下文的原始内容,按会话持久化。
 * 无 vscode 依赖,可单测;写入采用 tmp + rename 原子替换,fail-open。
 *
 * 文件布局(每会话一对):
 *   `<contextDir>/<sessionId>.context.json` —— 原文(完整 content)
 *   `<contextDir>/<sessionId>.index.json`   —— 索引(seq/type/role/summary/ts/hash,无 content,约原文 1/10)
 * 检索/统计只读索引,命中后才读原文;旧会话无索引文件时惰性迁移(读时从原文构建)。
 * 内存缓存按 mtime 失效:写路径统一清缓存,跨进程写入也能感知。
 */
import * as fs from "fs";
import * as path from "path";

export type ColdChunkType = "demand" | "conclusion" | "explanation" | "ledger" | "thinking";

/** 一条冷存储内容 */
export interface ColdChunk {
  /** 消息序号(与 API 历史中 assistant 消息的序号对应,会话内唯一) */
  seq: number;
  type: ColdChunkType;
  role: "user" | "assistant" | "tool";
  /** 简短摘要(供 ContextRecall 匹配,不带完整原文) */
  summary: string;
  /** 完整内容(原文或摘要后的说明/履历) */
  content: string;
  /** 创建时间戳(ms),prune 时按此淘汰最旧 */
  ts: number;
  /** 来源会话 id(跨会话合并视图/ContextRecall 跨会话检索时填充,本会话存储可缺省) */
  session?: string;
}

/** 索引条目:不含 content,附带内容哈希(供跨会话去重)与字节偏移(供按 seq 随机读原文)。 */
export interface ColdIndexEntry {
  seq: number;
  type: ColdChunkType;
  role: ColdChunk["role"];
  summary: string;
  ts: number;
  hash: string;
  /** chunk 对象在 .context.json 中的字节偏移(写入时记录,偏移直读免全量解析) */
  offset?: number;
  /** chunk 对象 JSON 字节长度 */
  length?: number;
}

interface ContextFileShape {
  chunks: ColdChunk[];
  compactedCount: number;
  prunedCount: number;
}

interface IndexFileShape {
  version: number;
  compacted: number;
  pruned: number;
  chunks: ColdIndexEntry[];
}

function emptyFile(): ContextFileShape {
  return { chunks: [], compactedCount: 0, prunedCount: 0 };
}

/**
 * 手工序列化 ContextFileShape 为紧凑 JSON,同时记录每个 chunk 对象的字节偏移。
 * 偏移随索引落盘后,ContextRecall 按 seq 回查可只读对应字节区间(fs.readSync),
 * 避免大文件(数十 MB)每次回查都整文件 JSON.parse。
 * 产物仍是合法 JSON:chunk 序列化自身合法,拼接处为逗号/括号。
 */
export function serializeWithOffsets(
  data: ContextFileShape,
): { text: string; offsets: Array<{ offset: number; length: number }> } {
  let text = `{"compactedCount":${data.compactedCount},"prunedCount":${data.prunedCount},"chunks":[`;
  const offsets: Array<{ offset: number; length: number }> = [];
  for (let i = 0; i < data.chunks.length; i++) {
    if (i > 0) text += ",";
    const chunkJson = JSON.stringify(data.chunks[i]);
    // 偏移必须是 UTF-8 字节位置(fs.readSync 按字节读);text.length 是 UTF-16 字符数,
    // 中文(3 字节/字符)会导致错位,故用 Buffer.byteLength 换算。
    offsets.push({ offset: Buffer.byteLength(text, "utf8"), length: Buffer.byteLength(chunkJson, "utf8") });
    text += chunkJson;
  }
  text += "]}\n";
  return { text, offsets };
}

function isColdChunk(c: unknown): c is ColdChunk {
  if (c === null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (typeof o.seq !== "number") return false;
  if (
    o.type !== "demand" &&
    o.type !== "conclusion" &&
    o.type !== "explanation" &&
    o.type !== "ledger" &&
    o.type !== "thinking"
  ) {
    return false;
  }
  if (o.role !== "user" && o.role !== "assistant" && o.role !== "tool") return false;
  if (typeof o.summary !== "string" || typeof o.content !== "string") return false;
  return typeof o.ts === "number";
}

function isColdIndexEntry(c: unknown): c is ColdIndexEntry {
  if (c === null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (typeof o.seq !== "number") return false;
  if (
    o.type !== "demand" &&
    o.type !== "conclusion" &&
    o.type !== "explanation" &&
    o.type !== "ledger" &&
    o.type !== "thinking"
  ) {
    return false;
  }
  if (o.role !== "user" && o.role !== "assistant" && o.role !== "tool") return false;
  if (typeof o.summary !== "string" || typeof o.ts !== "number") return false;
  return typeof o.hash === "string";
}

/**
 * 内容哈希(djb2,8 位 hex):用于跨会话去重与索引一致性,
 * 使索引不存 content 也能准确去重。
 */
export function contentHash(content: string): string {
  let h = 5381;
  const s = content ?? "";
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 从内容生成摘要:取首行并截断到 160 字符 */
export function makeSummary(type: ColdChunkType, content: string): string {
  const firstLine = (content ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  return firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;
}

/** 跨会话去重 key(不含 seq/ts/session,含内容哈希)。 */
function dedupeKey(type: ColdChunkType, role: ColdChunk["role"], summary: string, hash: string): string {
  return `${type}|${role}|${summary}|${hash}`;
}

export interface ContextStoreOptions {
  /** 单会话冷存储块上限(不含 thinking),超出部分在 prune 时淘汰最旧 */
  maxChunks?: number;
  /** thinking 块按字节独立限额(默认 2MB),超出部分在 prune 时淘汰最旧(至少保留一条) */
  maxThinkingBytes?: number;
}

export class ContextStore {
  private readonly maxChunks: number;
  private readonly maxThinkingBytes: number;
  /** 索引内存缓存:会话 → { mtimeMs, size, data },读盘前先比 mtime+size(ms 粒度下 size 补差)。 */
  private readonly indexCache = new Map<string, { mtimeMs: number; size: number; data: IndexFileShape }>();

  constructor(
    private readonly contextDir: string,
    opts: ContextStoreOptions = {},
  ) {
    this.maxChunks = opts.maxChunks ?? 80;
    this.maxThinkingBytes = opts.maxThinkingBytes ?? 2 * 1024 * 1024;
    fs.mkdirSync(this.contextDir, { recursive: true });
  }

  private fileFor(sessionId: string): string {
    return path.join(this.contextDir, `${sessionId}.context.json`);
  }

  private indexFileFor(sessionId: string): string {
    return path.join(this.contextDir, `${sessionId}.index.json`);
  }

  private read(sessionId: string): ContextFileShape {
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file)) {
      return emptyFile();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") return emptyFile();
      const shape = parsed as Partial<ContextFileShape>;
      const chunks = Array.isArray(shape.chunks) ? shape.chunks.filter(isColdChunk) : [];
      return {
        chunks,
        compactedCount: typeof shape.compactedCount === "number" ? shape.compactedCount : 0,
        prunedCount: typeof shape.prunedCount === "number" ? shape.prunedCount : 0,
      };
    } catch {
      return emptyFile();
    }
  }

  /** 写入原文文件(紧凑 JSON,带偏移记录),返回每个 chunk 的字节偏移。 */
  private write(sessionId: string, data: ContextFileShape): Array<{ offset: number; length: number }> {
    const file = this.fileFor(sessionId);
    const { text, offsets } = serializeWithOffsets(data);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    return offsets;
  }

  /** 由原文文件构建索引文件内容。 */
  private indexFromChunks(shape: ContextFileShape): IndexFileShape {
    return {
      version: 1,
      compacted: shape.compactedCount,
      pruned: shape.prunedCount,
      chunks: shape.chunks.map((c) => ({
        seq: c.seq,
        type: c.type,
        role: c.role,
        summary: c.summary,
        ts: c.ts,
        hash: contentHash(c.content),
      })),
    };
  }

  private writeIndex(sessionId: string, data: IndexFileShape): void {
    const file = this.indexFileFor(sessionId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, file);
    try {
      const stat = fs.statSync(file);
      this.indexCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    } catch {
      this.indexCache.delete(sessionId);
    }
  }

  /**
   * 读索引(含 mtime 缓存)。索引缺失/损坏 → 从原文惰性构建并写盘(fail-open);
   * 会话不存在时不创建任何文件。
   */
  private readIndex(sessionId: string): IndexFileShape {
    const file = this.indexFileFor(sessionId);
    if (!fs.existsSync(file)) {
      const data = this.indexFromChunks(this.read(sessionId));
      if (fs.existsSync(this.fileFor(sessionId))) {
        this.writeIndex(sessionId, data);
      }
      return data;
    }
    try {
      const stat = fs.statSync(file);
      const cached = this.indexCache.get(sessionId);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.data;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") throw new Error("bad index");
      const shape = parsed as Partial<IndexFileShape>;
      const chunks = Array.isArray(shape.chunks) ? shape.chunks.filter(isColdIndexEntry) : [];
      const data: IndexFileShape = {
        version: 1,
        compacted: typeof shape.compacted === "number" ? shape.compacted : 0,
        pruned: typeof shape.pruned === "number" ? shape.pruned : 0,
        chunks,
      };
      this.indexCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, data });
      return data;
    } catch {
      // 索引损坏 → 从原文重建
      const data = this.indexFromChunks(this.read(sessionId));
      this.writeIndex(sessionId, data);
      return data;
    }
  }

  /** 统一写路径:原文(带偏移)+ 索引原子写,并更新缓存。 */
  private persist(sessionId: string, data: ContextFileShape): void {
    const offsets = this.write(sessionId, data);
    const index = this.indexFromChunks(data);
    // 把序列化时记录的字节偏移并入索引条目,供按 seq 随机读原文
    index.chunks.forEach((c, i) => {
      const off = offsets[i];
      if (off) {
        c.offset = off.offset;
        c.length = off.length;
      }
    });
    this.writeIndex(sessionId, index);
  }

  /** 仅重建索引文件(不重写原文):从已解析的全量数据恢复带偏移索引(惰性升级旧格式)。 */
  private rebuildIndexWithOffsets(sessionId: string, data: ContextFileShape): void {
    try {
      const offsets = this.write(sessionId, data); // 原文已是最新,重写以产生偏移(原子替换,无内容变化)
      const index = this.indexFromChunks(data);
      index.chunks.forEach((c, i) => {
        const off = offsets[i];
        if (off) {
          c.offset = off.offset;
          c.length = off.length;
        }
      });
      this.writeIndex(sessionId, index);
    } catch {
      // 重建失败不影响既有数据与本次结果(fail-open)
    }
  }

  /** 追加冷存储块(与已有块合并) */
  append(sessionId: string, chunks: ColdChunk[]): void {
    if (!chunks || chunks.length === 0) return;
    const data = this.read(sessionId);
    data.chunks.push(...chunks);
    data.compactedCount += 1;
    this.persist(sessionId, data);
  }

  /** 加载某会话全部冷存储块(文件缺失/损坏 → []) */
  load(sessionId: string): ColdChunk[] {
    return this.read(sessionId).chunks;
  }

  /** 只读索引(不含 content,供检索/统计;附带内容哈希)。 */
  index(sessionId: string): ColdIndexEntry[] {
    return this.readIndex(sessionId).chunks;
  }

  /** 从原文文件读取指定字节区间并解析为单条 chunk;失败/越界返回 undefined。 */
  private readAt(sessionId: string, offset: number, length: number): ColdChunk | undefined {
    const file = this.fileFor(sessionId);
    if (!fs.existsSync(file) || length <= 0) return undefined;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, offset);
        if (read !== length) return undefined;
        const parsed = JSON.parse(buf.toString("utf8")) as unknown;
        return isColdChunk(parsed) ? parsed : undefined;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  /**
   * 按 seq 过滤取回完整块(seq 不在其中的忽略)。
   * 优先偏移直读:索引条目带字节偏移时,只 fs.readSync 对应区间再解析单条,
   * 避免大文件(数十 MB)每次回查都整文件 JSON.parse;
   * 旧格式索引(无偏移)或区间读失败 → 回退整文件解析,并顺带重建带偏移索引(下次走直读)。
   */
  get(sessionId: string, seqs: number[]): ColdChunk[] {
    const set = new Set(seqs);
    if (set.size === 0) return [];
    const idx = this.readIndex(sessionId);
    const wanted: ColdIndexEntry[] = [];
    for (const e of idx.chunks) {
      if (set.has(e.seq)) wanted.push(e);
    }
    if (wanted.length === 0) return [];
    // 全部条目都有偏移 → 逐条随机读
    if (wanted.every((e) => typeof e.offset === "number" && typeof e.length === "number")) {
      const out: ColdChunk[] = [];
      let fallback = false;
      for (const e of wanted) {
        const c = this.readAt(sessionId, e.offset as number, e.length as number);
        if (c && c.seq === e.seq) {
          out.push(c);
        } else {
          fallback = true; // 区间读失败/内容不一致(外部手改)→ 回退全量
          break;
        }
      }
      if (!fallback) return out;
    }
    // 回退:全量解析(旧索引无偏移 / 区间读失败)
    const all = this.read(sessionId);
    const hits = all.chunks.filter((c) => set.has(c.seq));
    // 顺带重建带偏移索引,让后续回查走随机读(旧格式惰性升级)
    this.rebuildIndexWithOffsets(sessionId, all);
    return hits;
  }

  /**
   * 按 seq 更新 chunk 摘要(thinking 脉络行回写;只改 summary,不覆盖 content/ts)。
   * 返回实际更新的条数;无匹配或未变化不写盘。
   */
  updateSummaries(sessionId: string, updates: Array<{ seq: number; summary: string }>): number {
    if (!updates || updates.length === 0) return 0;
    const data = this.read(sessionId);
    const bySeq = new Map(updates.map((u) => [u.seq, u.summary]));
    let n = 0;
    for (const c of data.chunks) {
      const summary = bySeq.get(c.seq);
      if (summary !== undefined && summary !== "" && c.summary !== summary) {
        c.summary = summary;
        n++;
      }
    }
    if (n > 0) {
      this.persist(sessionId, data);
    }
    return n;
  }

  /**
   * 淘汰最旧块至限额以内,返回被淘汰条数:
   *  - 非 thinking 块按条数(maxChunks)淘汰最旧;
   *  - thinking 块独立按字节(maxThinkingBytes)淘汰最旧,至少保留一条。
   */
  prune(sessionId: string): number {
    const data = this.read(sessionId);
    let removed = 0;

    const thinking = data.chunks
      .filter((c) => c.type === "thinking")
      .sort((a, b) => a.ts - b.ts);
    const others = data.chunks
      .filter((c) => c.type !== "thinking")
      .sort((a, b) => a.ts - b.ts);

    // 1) 非 thinking 按条数淘汰最旧
    if (others.length > this.maxChunks) {
      removed += others.length - this.maxChunks;
      others.splice(0, others.length - this.maxChunks);
    }

    // 2) thinking 按字节淘汰最旧(至少保留一条)
    if (this.maxThinkingBytes > 0 && thinking.length > 0) {
      let bytes = thinking.reduce((s, c) => s + Buffer.byteLength(c.content, "utf8"), 0);
      let drop = 0;
      while (bytes > this.maxThinkingBytes && thinking.length - drop > 1) {
        bytes -= Buffer.byteLength(thinking[drop].content, "utf8");
        drop++;
      }
      removed += drop;
      thinking.splice(0, drop);
    }

    data.chunks = [...others, ...thinking];
    if (removed > 0) {
      data.prunedCount += removed;
      this.persist(sessionId, data);
    }
    return removed;
  }

  /** 列出目录下全部冷存储会话 id(去 `.context.json` 后缀,排序) */
  listSessions(): string[] {
    if (!fs.existsSync(this.contextDir)) return [];
    return fs
      .readdirSync(this.contextDir)
      .filter((f) => f.endsWith(".context.json"))
      .map((f) => f.replace(/\.context\.json$/, ""))
      .sort();
  }

  /**
   * 只读跨会话合并视图(基于索引,不读原文):聚合各会话索引条目,
   * 按 `type|role|summary|hash` 去重(保留 ts 最早),每条附 `session` 来源,不写盘。
   * 用于 ContextRecall 跨会话检索 / UI 浏览,避免污染原文件。
   */
  mergeView(sessionIds: string[]): { chunks: Array<ColdIndexEntry & { session: string }>; sessionIds: string[] } {
    const ids = sessionIds.filter((id) => id && id !== "__all__");
    const seen = new Set<string>();
    const chunks: Array<ColdIndexEntry & { session: string }> = [];
    for (const id of ids) {
      for (const c of this.readIndex(id).chunks) {
        const key = dedupeKey(c.type, c.role, c.summary, c.hash);
        if (seen.has(key)) continue;
        seen.add(key);
        chunks.push({ ...c, session: id });
      }
    }
    return { chunks, sessionIds: ids };
  }

  /** 单会话物理去重(内容相同保留 ts 最早);返回删除条数。 */
  dedupe(sessionId: string): number {
    const data = this.read(sessionId);
    const seen = new Set<string>();
    const out: ColdChunk[] = [];
    let removed = 0;
    for (const c of data.chunks) {
      const key = dedupeKey(c.type, c.role, c.summary, contentHash(c.content));
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
      out.push(c);
    }
    if (removed > 0) {
      data.chunks = out;
      this.persist(sessionId, data);
    }
    return removed;
  }

  /**
   * 跨会话物理合并:把 sessionIds(含 target 自身)聚合去重后写入 target,
   * 删除其它源会话文件。返回 { merged: 合并后条数, removed: 去重删除条数 }。
   */
  merge(sessionIds: string[], target: string): { merged: number; removed: number } {
    const ids = sessionIds.filter((id) => id && id !== target);
    const targetData = this.read(target);
    const seen = new Set<string>();
    const chunks: ColdChunk[] = [];
    let removed = 0;
    const collect = (chunksOf: ColdChunk[]): void => {
      for (const c of chunksOf) {
        const key = dedupeKey(c.type, c.role, c.summary, contentHash(c.content));
        if (seen.has(key)) {
          removed++;
          continue;
        }
        seen.add(key);
        chunks.push(c);
      }
    };
    collect(targetData.chunks);
    for (const id of ids) {
      collect(this.read(id).chunks);
    }
    this.persist(target, {
      chunks,
      compactedCount: targetData.compactedCount,
      prunedCount: targetData.prunedCount,
    });
    for (const id of ids) {
      this.delete(id);
    }
    return { merged: chunks.length, removed };
  }

  /** 清空某会话冷存储(保留文件) */
  clear(sessionId: string): void {
    this.persist(sessionId, emptyFile());
  }

  /** 删除某会话冷存储文件(含索引) */
  delete(sessionId: string): void {
    const file = this.fileFor(sessionId);
    if (fs.existsSync(file)) fs.rmSync(file);
    const idx = this.indexFileFor(sessionId);
    if (fs.existsSync(idx)) fs.rmSync(idx);
    this.indexCache.delete(sessionId);
  }

  /** 累计压缩次数(从索引读取,缺失时惰性迁移) */
  stats(sessionId: string): { compacted: number; pruned: number } {
    const idx = this.readIndex(sessionId);
    return { compacted: idx.compacted, pruned: idx.pruned };
  }
}
