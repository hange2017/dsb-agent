export interface PluginCandidate {
  name: string;
  source: "marketplace" | "extension" | "skill";
  origin: string;
  description: string;
  skills: string[];
}

export interface RankedCandidate {
  candidate: PluginCandidate;
  score: number;
  reason: string;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);
}

function termFreq(text: string, term: string): number {
  return tokenize(text).filter((t) => t === term).length;
}

export function keywordFilter(query: string, candidates: PluginCandidate[], limit = 30): PluginCandidate[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return candidates.slice(0, limit);
  const scored = candidates.map((c) => {
    const haystack = `${c.name} ${c.description} ${c.skills.join(" ")}`;
    let score = 0;
    for (const t of qTerms) score += termFreq(haystack, t) * (t.length > 1 ? 1 : 0);
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.c);
}

export class Recommender {
  constructor(
    private readonly deps: {
      collectCandidates: () => PluginCandidate[];
      rank: (query: string, candidates: PluginCandidate[]) => Promise<RankedCandidate[]>;
    },
  ) {}

  async recommend(query: string, topN = 8): Promise<RankedCandidate[]> {
    const all = this.deps.collectCandidates();
    const shortlist = keywordFilter(query, all);
    if (shortlist.length === 0) return [];
    // 裸 /plugins(空查询):直接按关键词顺序返回,不调用 LLM 排序(省一次模型往返)。
    if (!query.trim()) {
      return shortlist.slice(0, topN).map((c) => ({ candidate: c, score: 0.5, reason: "关键词匹配" }));
    }
    return (await this.deps.rank(query, shortlist)).slice(0, topN);
  }
}
