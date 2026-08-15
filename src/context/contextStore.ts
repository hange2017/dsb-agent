/**
 * ContextStore —— 冷存储:被分轨压缩替换出上下文的原始内容,按会话持久化。
 * 无 vscode 依赖,可单测;主存 NDJSON 追加 + SnapshotQueue 异步批量落盘,fail-open。
 *
 * 文件布局(每会话):
 *   `<contextDir>/<sessionId>.context.ndjson` —— 一行一个紧凑 JSON ColdChunk(主格式)
 *   `<contextDir>/<sessionId>.context.json`  —— 旧格式(只读兼容,首次 append/写时惰性迁移)
 *   `<contextDir>/<sessionId>.index.json`   —— 索引(seq/type/role/summary/ts/hash/offset/length)
 * 检索/统计只读索引,命中后才读原文;旧会话无索引文件时惰性迁移。
 * append 立即更新内存(load/get/index 同步可见),磁盘经队列 debounce 50ms / batch 16 刷入。
 */
import * as fs from "fs";
import * as path from "path";
import { SnapshotQueue } from "./snapshotQueue";

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
  /** chunk JSON 在 .context.ndjson(或旧 .context.json)中的字节偏移 */
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

/** 队列刷盘项:带 writeGen,整文件重写后旧批次作废。 */
interface PendingWrite {
  chunk: ColdChunk;
  gen: number;
}

interface SessionState {
  chunks: ColdChunk[];
  compactedCount: number;
  prunedCount: number;
  /** 已落盘 chunk 的偏移(seq → offset/length) */
  offsets: Map<number, { offset: number; length: number }>;
  /** 整文件重写世代;bump 后旧 flush 批次跳过 */
  writeGen: number;
  queue: SnapshotQueue<PendingWrite>;
  compactScheduled: boolean;
}

function emptyFile(): ContextFileShape {
  return { chunks: [], compactedCount: 0, prunedCount: 0 };
}

/** 压缩触发阈值:条数 */
const kCompactMaxChunks = 500;
/** 压缩触发阈值:内容总字节 */
const kCompactMaxBytes = 8 * 1024 * 1024;
/** thinking 默认字节上限 */
const kDefaultMaxThinkingBytes = 8 * 1024 * 1024;
/** 全量默认字节上限 */
const kDefaultMaxTotalBytes = 50 * 1024 * 1024;

/**
 * 手工序列化 ContextFileShape 为紧凑 JSON,同时记录每个 chunk 对象的字节偏移。
 * 偏移随索引落盘后,ContextRecall 按 seq 回查可只读对应字节区间(fs.readSync),
 * 避免大文件(数十 MB)每次回查都整文件 JSON.parse。
 * 产物仍是合法 JSON:chunk 序列化自身合法,拼接处为逗号/括号。
 * (旧 JSON 格式 / 测试仍用;NDJSON 主路径用 lineOffsets。)
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

/** 将 chunks 序列化为 NDJSON,并记录每行 JSON 的字节偏移(不含换行)。 */
function serializeNdjson(
  chunks: ColdChunk[],
): { text: string; offsets: Array<{ offset: number; length: number }> } {
  const offsets: Array<{ offset: number; length: number }> = [];
  let text = "";
  for (const c of chunks) {
    const chunkJson = JSON.stringify(c);
    const length = Buffer.byteLength(chunkJson, "utf8");
    offsets.push({ offset: Buffer.byteLength(text, "utf8"), length });
    text += chunkJson + "\n";
  }
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

function contentBytes(chunks: ColdChunk[]): number {
  return chunks.reduce((s, c) => s + Buffer.byteLength(c.content, "utf8"), 0);
}

export interface ContextStoreOptions {
  /** 单会话冷存储块上限(不含 thinking),超出部分在 prune 时淘汰最旧 */
  maxChunks?: number;
  /** thinking 块按字节独立限额(默认 8MB),超出部分在 prune 时淘汰最旧(至少保留一条) */
  maxThinkingBytes?: number;
  /** 全量(含 thinking)总字节上限(默认 50MB),超出按 ts 淘汰最旧、保留最新 */
  maxTotalBytes?: number;
}

export class ContextStore {
  private readonly maxChunks: number;
  private readonly maxThinkingBytes: number;
  private readonly maxTotalBytes: number;
  /** 索引内存缓存:会话 → { mtimeMs, size, data },读盘前先比 mtime+size。 */
  private readonly indexCache = new Map<string, { mtimeMs: number; size: number; data: IndexFileShape }>();
  /** 会话内存态(append 后同步可见;落盘异步)。 */
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly contextDir: string,
    opts: ContextStoreOptions = {},
  ) {
    this.maxChunks = opts.maxChunks ?? 80;
    this.maxThinkingBytes = opts.maxThinkingBytes ?? kDefaultMaxThinkingBytes;
    this.maxTotalBytes = opts.maxTotalBytes ?? kDefaultMaxTotalBytes;
    fs.mkdirSync(this.contextDir, { recursive: true });
  }

  private jsonFileFor(sessionId: string): string {
    return path.join(this.contextDir, `${sessionId}.context.json`);
  }

  private ndjsonFileFor(sessionId: string): string {
    return path.join(this.contextDir, `${sessionId}.context.ndjson`);
  }

  private indexFileFor(sessionId: string): string {
    return path.join(this.contextDir, `${sessionId}.index.json`);
  }

  /** 兼容旧 API 名:旧 JSON 路径。 */
  private fileFor(sessionId: string): string {
    return this.jsonFileFor(sessionId);
  }

  private readJsonFile(sessionId: string): ContextFileShape {
    const file = this.jsonFileFor(sessionId);
    if (!fs.existsSync(file)) return emptyFile();
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

  private readNdjsonFile(sessionId: string): ColdChunk[] {
    const file = this.ndjsonFileFor(sessionId);
    if (!fs.existsSync(file)) return [];
    try {
      const text = fs.readFileSync(file, "utf8");
      const chunks: ColdChunk[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isColdChunk(parsed)) chunks.push(parsed);
        } catch {
          // 损坏行跳过(fail-open)
        }
      }
      return chunks;
    } catch {
      return [];
    }
  }

  /**
   * 读原文:优先会话内存 → NDJSON → 旧 JSON。
   * 不入内存缓存(由 ensureSession 负责)。
   */
  private readFromDisk(sessionId: string): ContextFileShape {
    const ndjson = this.ndjsonFileFor(sessionId);
    if (fs.existsSync(ndjson)) {
      const idx = this.tryReadIndexRaw(sessionId);
      return {
        chunks: this.readNdjsonFile(sessionId),
        compactedCount: idx?.compacted ?? 0,
        prunedCount: idx?.pruned ?? 0,
      };
    }
    return this.readJsonFile(sessionId);
  }

  private read(sessionId: string): ContextFileShape {
    const state = this.sessions.get(sessionId);
    if (state) {
      return {
        chunks: state.chunks,
        compactedCount: state.compactedCount,
        prunedCount: state.prunedCount,
      };
    }
    return this.readFromDisk(sessionId);
  }

  /** 尝试读索引文件(不重建、不写盘);损坏/缺失 → undefined。 */
  private tryReadIndexRaw(sessionId: string): IndexFileShape | undefined {
    const file = this.indexFileFor(sessionId);
    if (!fs.existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") return undefined;
      const shape = parsed as Partial<IndexFileShape>;
      const chunks = Array.isArray(shape.chunks) ? shape.chunks.filter(isColdIndexEntry) : [];
      return {
        version: 1,
        compacted: typeof shape.compacted === "number" ? shape.compacted : 0,
        pruned: typeof shape.pruned === "number" ? shape.pruned : 0,
        chunks,
      };
    } catch {
      return undefined;
    }
  }

  /** 旧 JSON → NDJSON 惰性迁移(仅在写路径调用);失败保留旧文件。 */
  private migrateJsonToNdjson(sessionId: string): void {
    const ndjson = this.ndjsonFileFor(sessionId);
    const json = this.jsonFileFor(sessionId);
    if (fs.existsSync(ndjson) || !fs.existsSync(json)) return;
    try {
      const data = this.readJsonFile(sessionId);
      this.writeNdjsonAndIndex(sessionId, data);
      fs.rmSync(json);
    } catch {
      // 迁移失败保留旧 JSON(fail-open)
    }
  }

  /** 原子写整份 NDJSON + 带偏移索引。 */
  private writeNdjsonAndIndex(sessionId: string, data: ContextFileShape): void {
    const file = this.ndjsonFileFor(sessionId);
    const { text, offsets } = serializeNdjson(data.chunks);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    const index = this.indexFromChunks(data);
    index.chunks.forEach((c, i) => {
      const off = offsets[i];
      if (off) {
        c.offset = off.offset;
        c.length = off.length;
      }
    });
    this.writeIndex(sessionId, index);
    const state = this.sessions.get(sessionId);
    if (state) {
      state.offsets.clear();
      index.chunks.forEach((c) => {
        if (typeof c.offset === "number" && typeof c.length === "number") {
          state.offsets.set(c.seq, { offset: c.offset, length: c.length });
        }
      });
    }
  }

  /** 由原文构建索引文件内容。 */
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

  private indexFromState(state: SessionState): IndexFileShape {
    return {
      version: 1,
      compacted: state.compactedCount,
      pruned: state.prunedCount,
      chunks: state.chunks.map((c) => {
        const off = state.offsets.get(c.seq);
        return {
          seq: c.seq,
          type: c.type,
          role: c.role,
          summary: c.summary,
          ts: c.ts,
          hash: contentHash(c.content),
          ...(off ? { offset: off.offset, length: off.length } : {}),
        };
      }),
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
   * 读索引(含 mtime 缓存)。有会话内存时直接从内存构建。
   * 索引缺失/损坏 → 从原文惰性构建并写盘(fail-open);会话不存在时不创建任何文件。
   */
  private readIndex(sessionId: string): IndexFileShape {
    const state = this.sessions.get(sessionId);
    if (state) return this.indexFromState(state);

    const file = this.indexFileFor(sessionId);
    if (!fs.existsSync(file)) {
      const data = this.indexFromChunks(this.readFromDisk(sessionId));
      if (fs.existsSync(this.ndjsonFileFor(sessionId)) || fs.existsSync(this.jsonFileFor(sessionId))) {
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
      const data = this.indexFromChunks(this.readFromDisk(sessionId));
      this.writeIndex(sessionId, data);
      return data;
    }
  }

  /** 加载或创建会话内存态(含队列)。 */
  private ensureSession(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const disk = this.readFromDisk(sessionId);
    const offsets = new Map<number, { offset: number; length: number }>();
    const idx = this.tryReadIndexRaw(sessionId);
    if (idx) {
      for (const e of idx.chunks) {
        if (typeof e.offset === "number" && typeof e.length === "number") {
          offsets.set(e.seq, { offset: e.offset, length: e.length });
        }
      }
    }

    const state: SessionState = {
      chunks: disk.chunks.slice(),
      compactedCount: disk.compactedCount,
      prunedCount: disk.prunedCount,
      offsets,
      writeGen: 0,
      queue: null as unknown as SnapshotQueue<PendingWrite>,
      compactScheduled: false,
    };

    state.queue = new SnapshotQueue<PendingWrite>({
      debounceMs: 50,
      batchSize: 16,
      flush: (batch) => this.flushBatch(sessionId, batch),
      onDrop: (err) => {
        try {
          console.warn(`[ContextStore] flush dropped for ${sessionId}:`, err);
        } catch {
          // ignore
        }
      },
    });

    this.sessions.set(sessionId, state);
    return state;
  }

  /** 异步批量追加 NDJSON 行并更新索引偏移。 */
  private async flushBatch(sessionId: string, batch: PendingWrite[]): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const live = batch.filter((b) => b.gen === state.writeGen);
    if (live.length === 0) return;
    // 测试 afterEach 已删目录 / 会话已销毁时静默跳过
    if (!fs.existsSync(this.contextDir)) return;

    this.migrateJsonToNdjson(sessionId);

    const file = this.ndjsonFileFor(sessionId);
    let offset = 0;
    try {
      if (fs.existsSync(file)) offset = fs.statSync(file).size;
    } catch {
      offset = 0;
    }

    const lines: string[] = [];
    for (const { chunk } of live) {
      const chunkJson = JSON.stringify(chunk);
      const length = Buffer.byteLength(chunkJson, "utf8");
      state.offsets.set(chunk.seq, { offset, length });
      offset += length + 1;
      lines.push(chunkJson);
    }
    await fs.promises.appendFile(file, lines.join("\n") + "\n", "utf8");
    this.writeIndex(sessionId, this.indexFromState(state));
  }

  /**
   * 整文件重写路径:废弃未刷队列,bump writeGen,原子替换 NDJSON + 索引。
   * 用于 prune/clear/dedupe/merge/updateSummaries/compact。
   */
  private rewriteSession(sessionId: string, data: ContextFileShape): void {
    const state = this.ensureSession(sessionId);
    state.writeGen += 1;
    state.queue.discardPending();
    state.chunks = data.chunks;
    state.compactedCount = data.compactedCount;
    state.prunedCount = data.prunedCount;
    try {
      this.migrateJsonToNdjson(sessionId);
      // 若仍仅有旧 JSON(迁移失败),仍尝试写 NDJSON
      this.writeNdjsonAndIndex(sessionId, data);
      // 迁移成功后清理可能残留的旧 JSON
      const json = this.jsonFileFor(sessionId);
      if (fs.existsSync(this.ndjsonFileFor(sessionId)) && fs.existsSync(json)) {
        try {
          fs.rmSync(json);
        } catch {
          // ignore
        }
      }
    } catch {
      // fail-open
    }
  }

  /** 统一写路径(整文件):原文 NDJSON + 索引。 */
  private persist(sessionId: string, data: ContextFileShape): void {
    this.rewriteSession(sessionId, data);
  }

  /** 仅重建索引:从已解析数据恢复带偏移索引(旧格式惰性升级 / get 回退)。 */
  private rebuildIndexWithOffsets(sessionId: string, data: ContextFileShape): void {
    try {
      this.migrateJsonToNdjson(sessionId);
      this.writeNdjsonAndIndex(sessionId, data);
      const state = this.sessions.get(sessionId);
      if (state) {
        state.chunks = data.chunks;
        state.compactedCount = data.compactedCount;
        state.prunedCount = data.prunedCount;
      }
    } catch {
      // 重建失败不影响既有数据与本次结果(fail-open)
    }
  }

  /**
   * 追加冷存储块:立即更新内存(load/get/index 同步可见),入队异步落盘。
   * @returns 追加块的 seq 列表(已有 seq 保持不变;缺省则分配 max+1…)
   */
  append(sessionId: string, chunks: ColdChunk[]): number[] {
    if (!chunks || chunks.length === 0) return [];
    this.migrateJsonToNdjson(sessionId);
    const state = this.ensureSession(sessionId);

    let nextSeq = 0;
    for (const c of state.chunks) {
      if (c.seq > nextSeq) nextSeq = c.seq;
    }

    const seqs: number[] = [];
    for (const raw of chunks) {
      const chunk: ColdChunk = { ...raw };
      if (typeof chunk.seq !== "number" || Number.isNaN(chunk.seq)) {
        nextSeq += 1;
        chunk.seq = nextSeq;
      } else if (chunk.seq > nextSeq) {
        nextSeq = chunk.seq;
      }
      state.chunks.push(chunk);
      seqs.push(chunk.seq);
      state.queue.enqueue({ chunk, gen: state.writeGen });
    }
    state.compactedCount += 1;
    // 内存索引立即可见(无 offset,flush 后补)
    this.indexCache.delete(sessionId);
    this.compact(sessionId);
    return seqs;
  }

  /** 冲刷指定会话(或全部)未落盘队列。 */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      const state = this.sessions.get(sessionId);
      if (state) await state.queue.flushNow();
      return;
    }
    const tasks: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      tasks.push(s.queue.flushNow());
    }
    await Promise.all(tasks);
  }

  /** 等待全部会话 in-flight + pending 结束(测试 / dispose)。 */
  async drain(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      tasks.push(s.queue.drain());
    }
    await Promise.all(tasks);
  }

  /**
   * 空闲压缩:条数 > 500 或内容字节 > 8MB 时,setImmediate 跑 prune + 整文件重写。
   * 失败跳过本轮(fail-open)。
   */
  compact(sessionId: string): void {
    const state = this.sessions.get(sessionId) ?? this.ensureSession(sessionId);
    const bytes = contentBytes(state.chunks);
    if (state.chunks.length <= kCompactMaxChunks && bytes <= kCompactMaxBytes) return;
    if (state.compactScheduled) return;
    state.compactScheduled = true;
    setImmediate(() => {
      state.compactScheduled = false;
      try {
        this.prune(sessionId);
        const data = this.read(sessionId);
        this.rewriteSession(sessionId, data);
      } catch {
        // fail-open
      }
    });
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
    const ndjson = this.ndjsonFileFor(sessionId);
    const json = this.jsonFileFor(sessionId);
    const file = fs.existsSync(ndjson) ? ndjson : json;
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
   * 优先内存(未 flush 也可读);否则偏移直读 NDJSON;失败回退全量。
   */
  get(sessionId: string, seqs: number[]): ColdChunk[] {
    const set = new Set(seqs);
    if (set.size === 0) return [];

    const state = this.sessions.get(sessionId);
    if (state) {
      return state.chunks.filter((c) => set.has(c.seq));
    }

    const idx = this.readIndex(sessionId);
    const wanted: ColdIndexEntry[] = [];
    for (const e of idx.chunks) {
      if (set.has(e.seq)) wanted.push(e);
    }
    if (wanted.length === 0) return [];
    if (wanted.every((e) => typeof e.offset === "number" && typeof e.length === "number")) {
      const out: ColdChunk[] = [];
      let fallback = false;
      for (const e of wanted) {
        const c = this.readAt(sessionId, e.offset as number, e.length as number);
        if (c && c.seq === e.seq) {
          out.push(c);
        } else {
          fallback = true;
          break;
        }
      }
      if (!fallback) return out;
    }
    const all = this.readFromDisk(sessionId);
    const hits = all.chunks.filter((c) => set.has(c.seq));
    this.rebuildIndexWithOffsets(sessionId, all);
    return hits;
  }

  /**
   * 按 seq 更新 chunk 摘要(thinking 脉络行回写;只改 summary,不覆盖 content/ts)。
   * 返回实际更新的条数;无匹配或未变化不写盘。
   */
  updateSummaries(sessionId: string, updates: Array<{ seq: number; summary: string }>): number {
    if (!updates || updates.length === 0) return 0;
    const state = this.ensureSession(sessionId);
    const bySeq = new Map(updates.map((u) => [u.seq, u.summary]));
    let n = 0;
    for (const c of state.chunks) {
      const summary = bySeq.get(c.seq);
      if (summary !== undefined && summary !== "" && c.summary !== summary) {
        c.summary = summary;
        n++;
      }
    }
    if (n > 0) {
      this.rewriteSession(sessionId, {
        chunks: state.chunks,
        compactedCount: state.compactedCount,
        prunedCount: state.prunedCount,
      });
    }
    return n;
  }

  /**
   * 淘汰最旧块至限额以内,返回被淘汰条数:
   *  - 非 thinking 块按条数(maxChunks)淘汰最旧;
   *  - thinking 块独立按字节(maxThinkingBytes)淘汰最旧,至少保留一条;
   *  - 全量总字节(maxTotalBytes)按 ts 淘汰最旧、保留最新。
   */
  prune(sessionId: string): number {
    const state = this.ensureSession(sessionId);
    let removed = 0;

    const thinking = state.chunks
      .filter((c) => c.type === "thinking")
      .sort((a, b) => a.ts - b.ts);
    const others = state.chunks
      .filter((c) => c.type !== "thinking")
      .sort((a, b) => a.ts - b.ts);

    if (others.length > this.maxChunks) {
      removed += others.length - this.maxChunks;
      others.splice(0, others.length - this.maxChunks);
    }

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

    let kept = [...others, ...thinking];

    // 3) 全量总字节上限:按 ts 淘汰最旧
    if (this.maxTotalBytes > 0 && kept.length > 0) {
      kept.sort((a, b) => a.ts - b.ts);
      let bytes = contentBytes(kept);
      let drop = 0;
      while (bytes > this.maxTotalBytes && drop < kept.length) {
        bytes -= Buffer.byteLength(kept[drop].content, "utf8");
        drop++;
      }
      if (drop > 0) {
        removed += drop;
        kept = kept.slice(drop);
      }
    }

    if (removed > 0) {
      this.rewriteSession(sessionId, {
        chunks: kept,
        compactedCount: state.compactedCount,
        prunedCount: state.prunedCount + removed,
      });
    }
    return removed;
  }

  /** 列出目录下全部冷存储会话 id(兼容 .ndjson / .json + 内存未刷盘会话,去重排序) */
  listSessions(): string[] {
    const ids = new Set<string>();
    if (fs.existsSync(this.contextDir)) {
      for (const f of fs.readdirSync(this.contextDir)) {
        if (f.endsWith(".context.ndjson")) {
          ids.add(f.slice(0, -".context.ndjson".length));
        } else if (f.endsWith(".context.json")) {
          ids.add(f.slice(0, -".context.json".length));
        }
      }
    }
    for (const [id, state] of this.sessions) {
      if (state.chunks.length > 0) ids.add(id);
    }
    return [...ids].sort();
  }

  /**
   * 只读跨会话合并视图(基于索引,不读原文):聚合各会话索引条目,
   * 按 `type|role|summary|hash` 去重(保留 ts 最早),每条附 `session` 来源,不写盘。
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
    const state = this.ensureSession(sessionId);
    const seen = new Set<string>();
    const out: ColdChunk[] = [];
    let removed = 0;
    for (const c of state.chunks) {
      const key = dedupeKey(c.type, c.role, c.summary, contentHash(c.content));
      if (seen.has(key)) {
        removed++;
        continue;
      }
      seen.add(key);
      out.push(c);
    }
    if (removed > 0) {
      this.rewriteSession(sessionId, {
        chunks: out,
        compactedCount: state.compactedCount,
        prunedCount: state.prunedCount,
      });
    }
    return removed;
  }

  /**
   * 跨会话物理合并:把 sessionIds(含 target 自身)聚合去重后写入 target,
   * 删除其它源会话文件。返回 { merged: 合并后条数, removed: 去重删除条数 }。
   */
  merge(sessionIds: string[], target: string): { merged: number; removed: number } {
    const ids = sessionIds.filter((id) => id && id !== target);
    const targetState = this.ensureSession(target);
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
    collect(targetState.chunks);
    for (const id of ids) {
      collect(this.ensureSession(id).chunks);
    }
    this.rewriteSession(target, {
      chunks,
      compactedCount: targetState.compactedCount,
      prunedCount: targetState.prunedCount,
    });
    for (const id of ids) {
      this.delete(id);
    }
    return { merged: chunks.length, removed };
  }

  /** 清空某会话冷存储(保留文件) */
  clear(sessionId: string): void {
    this.rewriteSession(sessionId, emptyFile());
  }

  /** 删除某会话冷存储文件(含索引 / ndjson / 旧 json) */
  delete(sessionId: string): void {
    for (const file of [this.ndjsonFileFor(sessionId), this.jsonFileFor(sessionId), this.indexFileFor(sessionId)]) {
      if (fs.existsSync(file)) {
        try {
          fs.rmSync(file);
        } catch {
          // fail-open
        }
      }
    }
    this.indexCache.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  /** 累计压缩次数(从索引读取,缺失时惰性迁移) */
  stats(sessionId: string): { compacted: number; pruned: number } {
    const idx = this.readIndex(sessionId);
    return { compacted: idx.compacted, pruned: idx.pruned };
  }
}
