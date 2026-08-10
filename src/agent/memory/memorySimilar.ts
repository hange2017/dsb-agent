import type { MemoryEntry } from "./memoryStore";

/**
 * 启发式相似记忆检测(MemoryWrite 提示候选):不调 LLM、无网络,纯本地文本相似度。
 * 用于在写入新记忆时提醒"可能已存在相似条目",避免重复记忆堆积。
 */

export interface SimilarMemory {
  name: string;
  description: string;
  score: number; // 0..1,越大越相似
}

/** 归一化:小写 + 非字母/数字/中文转空格(英文按词、中文按整串保留)。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

/** 编辑距离(Levenshtein),用于 name 相似度。 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 0..1 名称相似度:编辑距离归一化(同为 0 长度 → 1,否则 1 - dist/maxLen)。 */
function nameSimilarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - levenshtein(na, nb) / maxLen);
}

/** 0..1 描述相似度:词集 Jaccard(交集 / 并集)。 */
function descSimilarity(a: string, b: string): number {
  const wa = new Set(norm(a).split(" ").filter(Boolean));
  const wb = new Set(norm(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 组合分数:name 占 60%、description 占 40%(name 唯一性强,权重更高)。 */
function combinedScore(a: { name: string; description: string }, b: { name: string; description: string }): number {
  return nameSimilarity(a.name, b.name) * 0.6 + descSimilarity(a.description, b.description) * 0.4;
}

const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * 在既有条目中找与新写入记忆相似的候选(不含同名更新——覆盖已有记忆不算重复)。
 * @param entries 候选池(通常 store.list())
 * @param name 新记忆 name
 * @param description 新记忆 description
 * @param opts.top 返回条数,默认 2
 * @param opts.minScore 相似度阈值,默认 0.35(低于此值视为噪声,不提示)
 */
export function findSimilarMemories(
  entries: MemoryEntry[],
  name: string,
  description: string,
  opts?: { top?: number; minScore?: number },
): SimilarMemory[] {
  const top = opts?.top ?? 2;
  const minScore = opts?.minScore ?? 0.35;
  const targetSlug = slug(name);
  const scored: SimilarMemory[] = [];
  for (const e of entries) {
    if (slug(e.name) === targetSlug) continue; // 同名更新不提示
    const score = combinedScore({ name, description }, { name: e.name, description: e.description });
    if (score >= minScore) scored.push({ name: e.name, description: e.description, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top);
}
