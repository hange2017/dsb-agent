/**
 * 运行时「重复调用」检测(纯函数,无 vscode 依赖)。
 *
 * 动机:工具结果被裁减 + 压缩激进后,agent 常因信息丢失而重跑同一命令 / 重读同一文件,
 * 造成额外的时间与 token 消耗。离线脚本 `scripts/analyze-duplicate-work.py` 已能把这类
 * 浪费从会话 jsonl 里统计出来,但需事后跑;本模块把**同一口径**搬到运行时,让 agentLoop
 * 在工具事件落盘时即时判定「疑似浪费型重复」,经 onToolRepeat 回调进 stats
 * (`tool_repeat` 事件),便于实时观察与调参。
 *
 * 口径与离线脚本严格对齐(便于交叉验证):
 * - 「同一工具 + 同一参数归一化 key」视为同一次调用;
 * - 出现「同 key 再次调用」即计一次重复,间隔 = 本次 ts − 上次 ts;
 * - 间隔 < wasteGapMs(默认 300s)判为「浪费型」;
 * - 写工具出现后,已记录 key 一律标 afterWrite(「改完再看」属合理复查,消费方可据此降噪)。
 *
 * 缓存前缀约束:本模块只读事件、只产出统计对象,**绝不改动 messages / system prompt 字节**;
 * 接入点选在 agentLoop.record() 的旁路,不进入任何发给 provider 的载荷。
 */

import { estimateTokens } from "../stats/providerSendStats";

/** 只读工具:重复调用不改变工作区状态,是「白读」信号。 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "ListDir",
  "Search",
  "MemoryRead",
  "MemoryList",
]);

/** 写工具:其出现会重置「白读」判定(改完再看属于合理复查)。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "StrReplace",
  "Edit",
  "Delete",
  "NotebookEdit",
  "Bash",
]);

/** 「浪费型重复」默认间隔阈值(ms):与脚本 `--gap` 默认值(300s)一致。 */
export const DEFAULT_REPEAT_WASTE_GAP_MS = 300_000;

/** key 表默认上限:长会话防内存膨胀(LRU 淘汰最早插入项)。 */
export const DEFAULT_REPEAT_MAX_KEYS = 4096;

/** 描述文本截断长度(与脚本 describe 的 [:90] 一致)。 */
const DESC_MAX = 90;

/** 确定性序列化(键排序),保证同一 input 的 key 跨轮稳定。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 把工具参数规范化成可比对的键段(与脚本 `norm_input` 同口径)。
 * 语义参数(path / pattern / command / offset / limit …)决定「是否同一件事」;
 * 瞬时大字段(Write.contents 等)不参与 key —— 同一路径的再次写入才是重复信号。
 */
export function normalizeToolInput(name: string, input?: Record<string, unknown>): string[] {
  const inp = input ?? {};
  const s = (v: unknown, fallback = ""): string => (v === undefined || v === null ? fallback : String(v));
  switch (name) {
    case "Read":
      return [name, s(inp.path), s(inp.offset, "0"), s(inp.limit, "0")];
    case "Grep":
      return [name, s(inp.pattern), s(inp.path), s(inp.glob)];
    case "Glob":
    case "LS":
    case "ListDir":
      return [name, s(inp.pattern ?? inp.path)];
    case "Bash":
      // 空白归一化:同一命令的排版差异不算新调用。
      return [name, s(inp.command).split(/\s+/).filter(Boolean).join(" ")];
    case "Write":
    case "Edit":
    case "Delete":
      // 写工具按目标文件聚合:contents 等瞬时大字段不进 key,避免内存无界,
      // 同时让「重复操作同一文件」能被识别为浪费(离线脚本 default 分支含 contents,
      // 反而捕捉不到「重写同一文件」,这是脚本局限而非优点)。
      return [name, s(inp.path)];
    case "StrReplace":
      // 同一文件的反复改写值得关注;old_string/new_string 属瞬时大字段,不进 key。
      return [name, s(inp.path)];
    default:
      return [name, stableStringify(inp)];
  }
}

/** 人类可读的参数摘要(只记语义参数,不落大内容;隐私友好)。 */
export function describeToolInput(parts: string[]): string {
  return parts
    .slice(1)
    .filter((p) => p !== "")
    .join(" | ")
    .slice(0, DESC_MAX);
}

/** 一次「疑似重复」判定结果(仅数字与短摘要,不含工具输出内容)。 */
export interface ToolRepeatHit {
  /** 工具名。 */
  tool: string;
  /** 与上次同 key 调用的间隔(ms)。 */
  gapMs: number;
  /** 上次同类调用的输出估算 token:重复调用 = 把同样大的结果再塞进上下文一次的成本。 */
  redundantTokens: number;
  /** 两次调用之间是否发生过写操作(改完再看 = 合理复查,用于降噪)。 */
  afterWrite: boolean;
  /** 该 key 在本会话内的累计出现次数(含本次)。 */
  count: number;
  /** 参数摘要(截断 90 字符)。 */
  keyText: string;
  /** 是否命中「浪费型」阈值(gapMs < wasteGapMs)。 */
  isWaste: boolean;
  /** 是否只读工具(白读;写工具重复的口径解释不同)。 */
  readonly: boolean;
}

export interface ToolRepeatTrackerOpts {
  /** 浪费型重复间隔阈值(ms),缺省 DEFAULT_REPEAT_WASTE_GAP_MS。 */
  wasteGapMs?: number;
  /** key 表上限,缺省 DEFAULT_REPEAT_MAX_KEYS。 */
  maxKeys?: number;
}

/**
 * 会话内重复调用跟踪器。
 *
 * 用法:每次工具事件落盘时调用 observe(tool, input, detail, ts);
 * 返回 undefined 表示该 key 首次出现(无重复),否则返回命中详情。
 * 事件时间戳由调用方传入(与落盘位一致),便于单测确定性验证。
 */
export class ToolRepeatTracker {
  private readonly wasteGapMs: number;
  private readonly maxKeys: number;
  /** LRU 表:key → 上次调用状态(插入序即最近序)。 */
  private readonly last = new Map<
    string,
    { ts: number; detailTokens: number; afterWrite: boolean; count: number }
  >();

  constructor(opts?: ToolRepeatTrackerOpts) {
    this.wasteGapMs = opts?.wasteGapMs ?? DEFAULT_REPEAT_WASTE_GAP_MS;
    this.maxKeys = Math.max(1, opts?.maxKeys ?? DEFAULT_REPEAT_MAX_KEYS);
  }

  /** 已跟踪的 key 数(测试/诊断用)。 */
  size(): number {
    return this.last.size;
  }

  /** 清空会话内状态(换会话 / 强制压缩后需重置时用)。 */
  reset(): void {
    this.last.clear();
  }

  /**
   * 记录一次工具调用,并在同 key 重复时返回命中详情。
   * @param tool 工具名
   * @param input 工具入参
   * @param detail 本次输出(仅用于估算 token,不会被保存)
   * @param ts 本次调用的时间戳(epoch ms,与统计落盘位一致)
   */
  observe(
    tool: string,
    input: Record<string, unknown> | undefined,
    detail: string | undefined,
    ts: number,
  ): ToolRepeatHit | undefined {
    const parts = normalizeToolInput(tool, input);
    const key = parts.join("\u0000");
    const prev = this.last.get(key);

    let hit: ToolRepeatHit | undefined;
    if (prev) {
      const gapMs = Math.max(0, ts - prev.ts);
      const count = prev.count + 1;
      hit = {
        tool,
        gapMs,
        redundantTokens: prev.detailTokens,
        afterWrite: prev.afterWrite,
        count,
        keyText: describeToolInput(parts),
        isWaste: gapMs < this.wasteGapMs,
        readonly: READONLY_TOOLS.has(tool),
      };
    }

    // 写工具出现后,所有已记录 key 标 afterWrite(与脚本语义一致);
    // 注意:写工具自身的 key 随后会以 afterWrite=false 重新登记。
    if (WRITE_TOOLS.has(tool)) {
      for (const entry of this.last.values()) entry.afterWrite = true;
    }

    const detailTokens = estimateTokens(detail ?? "");
    const nextCount = (prev?.count ?? 0) + 1;
    // LRU:touch 到表尾,保证淘汰的是最久未出现的 key。
    this.last.delete(key);
    this.last.set(key, { ts, detailTokens, afterWrite: false, count: nextCount });
    if (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }

    return hit;
  }
}
