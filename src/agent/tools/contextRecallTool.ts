/**
 * ContextRecall —— 按序号回查冷存储中被压缩前的上下文原文。
 * 压缩块中的行标 `- [r{n}] ...`,`n` 即冷存储 seq;模型看到压缩块后,
 * 需要某条历史细节时可用该工具取回原文。无冷存储时 fail-open 提示。
 */
import type { ToolDef, ToolExecResult } from "./types";
import type { ContextStore } from "../../context/contextStore";
import { contentHash } from "../../stats/providerSendStats";

export const CONTEXT_RECALL_TOOL_DEF: ToolDef = {
  name: "ContextRecall",
  description:
    "回查被压缩前保存的上下文原文(需求/结论/解释/工具履历)。何时该查:看到压缩块中 `- [r{n}] ...` 摘要行且需要完整细节时;需要历史结论、关键决策、错误信息或跨会话经验时;记忆条目模糊需要确认原文时。seq 为压缩块行 [r{n}] 中的数字,只查当前会话;不传 seq 时返回索引(摘要列表,最多 30 条);带 query 关键词过滤,本会话无结果时自动跨会话检索历史会话(行前缀带 [session])。",
  input_schema: {
    type: "object",
    properties: {
      seq: { type: "number", description: "压缩块行 [r{n}] 中的序号(仅当前会话)" },
      query: { type: "string", description: "可选关键词过滤(大小写不敏感,可跨会话检索)" },
    },
  },
};

/** ContextRecall 调用统计(经 statsStore?.record("context_recall", ...) 落盘;总开关关闭时静默跳过)。 */
export interface RecallStat {
  /** 调用路径分类 */
  mode:
    | "seq_hit"
    | "seq_miss"
    | "index_hit"
    | "index_empty"
    | "cross_session"
    | "unavailable";
  /** 回查的 seq(seq 模式) */
  seq?: number;
  /** query 长度(query 模式;不记原文,隐私友好) */
  queryLen?: number;
  /** query 摘要 hash(detailLevel=full 时;basic 不下发,由 executor 丢弃) */
  queryHash?: string;
  /** 返回条目数(粗略) */
  results?: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 无冷存储时的 fail-open 结果(不报错,提示不可用)。 */
export function contextRecallUnavailable(): ToolExecResult {
  return { ok: true, content: "ContextRecall 不可用:本会话未启用冷存储。" };
}

/** 执行回查:命中返回完整内容;未命中返回明确提示。onStat 可选:上报调用统计(供 StatsStore 落盘)。 */
export function contextRecallExecute(
  store: ContextStore,
  sessionId: string,
  input: Record<string, unknown>,
  onStat?: (s: RecallStat) => void,
): ToolExecResult {
  const seqRaw = input.seq;
  const query = typeof input.query === "string" && input.query.trim() ? input.query.trim().toLowerCase() : undefined;

  if (seqRaw !== undefined) {
    if (typeof seqRaw !== "number" || !Number.isFinite(seqRaw)) {
      return { ok: false, content: "seq must be a number" };
    }
    const hits = store.get(sessionId, [seqRaw]);
    onStat?.({
      mode: hits.length > 0 ? "seq_hit" : "seq_miss",
      seq: seqRaw,
      results: hits.length,
    });
    if (hits.length === 0) {
      return { ok: false, content: `ContextRecall: no stored entry for seq=${seqRaw}` };
    }
    const out = hits
      .map((c) => `[r${c.seq}] (${c.type}/${c.role}) ${truncate(c.content, 2000)}`)
      .join("\n\n");
    return { ok: true, content: out };
  }

  // 索引模式:摘要列表,支持关键词过滤
  const entries = store.index(sessionId);
  const filtered = query ? entries.filter((c) => c.summary.toLowerCase().includes(query) || c.type.includes(query)) : entries;
  if (filtered.length === 0) {
    // 本会话无命中且带 query → 跨会话检索历史会话(基于索引聚合去重,行前缀带 [session])
    if (query) {
      const other = store.listSessions().filter((id) => id !== sessionId);
      if (other.length > 0) {
        const { chunks } = store.mergeView(other);
        const hits = chunks.filter(
          (c) => c.summary.toLowerCase().includes(query) || c.type.includes(query),
        );
        if (hits.length > 0) {
          const head = hits.slice(0, 30);
          const lines = head.map((c) => `[${c.session}] [r${c.seq}] (${c.type}/${c.role}) ${truncate(c.summary, 160)}`);
          if (hits.length > head.length) {
            lines.push(`… (${hits.length - head.length} more)`);
          }
          lines.unshift(`(跨会话检索 ${head.length}/${other.length} 个会话命中)`);
          onStat?.({ mode: "cross_session", queryLen: query.length, queryHash: contentHash(query), results: hits.length });
          return { ok: true, content: lines.join("\n") };
        }
      }
    }
    onStat?.({ mode: "index_empty", queryLen: query?.length ?? 0, queryHash: query ? contentHash(query) : undefined, results: 0 });
    return { ok: true, content: query ? `ContextRecall: no entries matching "${query}"` : "ContextRecall: (empty)" };
  }
  const head = filtered.slice(0, 30);
  const lines = head.map((c) => `[r${c.seq}] (${c.type}/${c.role}) ${truncate(c.summary, 160)}`);
  if (filtered.length > head.length) {
    lines.push(`… (${filtered.length - head.length} more)`);
  }
  onStat?.({ mode: "index_hit", queryLen: query?.length ?? 0, queryHash: query ? contentHash(query) : undefined, results: filtered.length });
  return { ok: true, content: lines.join("\n") };
}
