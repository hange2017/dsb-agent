/**
 * 技能描述的标签化压缩(scheme 1):把
 *   "Guides stable API design. Use when designing APIs, module boundaries, or any public interface. Use when ..."
 * 压缩为
 *   "Guides stable API design. #designing-apis #module-boundaries #public-interface"
 *
 * 动机:系统提示里技能列表只做「可发现性」——模型需要判断"这个技能可能相关,
 * 然后调 Skill 工具加载全文"。现状是作用句 + 第一个 Use when 就被 120 字符截断,
 * 后续触发条件全部丢失;标签化把同一预算内的信息密度换成多个短触发标签,
 * 保留更多"何时该用"信号,成本不增。
 *
 * 设计约束:
 * - 纯函数、确定性、无 vscode 依赖(可单测);
 * - 信息可回溯:每个标签的每个词必须来自原始描述(防幻觉标签);
 * - 无 Use when/before 结构的描述返回 null,交由上层走原截断逻辑。
 */

export interface SummarizedSkill {
  /** 作用句(第一个 Use when/before 之前的文本;为空时取首个条件原文)。 */
  lead: string;
  /** 触发标签列表(去停用词后的 kebab-case,最多 MAX_TAGS 个)。 */
  tags: string[];
}

/** 作用句长度上限(字符);超出截断加 `…`。 */
export const MAX_LEAD = 80;
/** 标签个数上限:预算内优先覆盖"前几个"触发条件。 */
export const MAX_TAGS = 3;
/** 每个标签最多实词数:2 词标签(如 #designing-apis)足够有区分度。 */
export const MAX_WORDS_PER_TAG = 2;

/** 虚词/弱词表:只删纯虚词,保留 need/build/test/want 等触发实词。 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "when", "before", "after", "about", "any", "your", "you", "are", "is",
  "was", "were", "be", "being", "been", "that", "this", "it", "its", "at",
  "by", "from", "as", "into", "between", "than", "so", "but", "not", "no",
  "yes", "do", "does", "did", "have", "has", "had", "will", "would", "can",
  "could", "should", "may", "might", "i", "we", "they", "he", "she", "them",
  "their", "my", "me", "us", "our", "who", "whom", "whose", "which", "what",
  "there", "here", "also", "very", "just", "then", "now", "too", "own",
  "same", "such", "both", "each", "few", "more", "most", "other", "some",
  "only", "please", "another",
  // 缩写残留(doesn't 等被拆词后的尾巴)
  "re", "ll", "ve", "d", "t", "s", "doesn", "don", "cant", "wont", "isnt",
  "arent", "werent", "havent", "hasnt", "youre", "youve", "youll",
]);

function splitWords(phrase: string): string[] {
  return phrase.split(/[^a-zA-Z0-9+#-]+/).filter(Boolean);
}

/** 从单个条件子句提取最多 MAX_WORDS_PER_TAG 个实词,生成 kebab 标签(去重)。 */
function tagFromClause(clause: string): string | undefined {
  const words = splitWords(clause)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()))
    .slice(0, MAX_WORDS_PER_TAG);
  if (words.length === 0) return undefined;
  return `#${words.join("-").toLowerCase()}`;
}

/** 把 `Use when A, when B, or C` 这类条件拆成子条件列表。 */
function splitSubClauses(clause: string): string[] {
  return clause.split(/,\s*(?:when\s+)?/i).map((s) => s.trim()).filter(Boolean);
}

/**
 * 标签化压缩技能描述。结构要求:文本包含 `Use when` / `Use before` 触发句式;
 * 否则返回 null(调用方回退原样/原截断逻辑)。
 */
export function summarizeSkillDescription(desc: string): SummarizedSkill | null {
  const text = desc.replace(/\s+/g, " ").trim();
  // 切分点:`Use when X` 与 `Use before X`(as-code-review 用 before 句式);
  // `(?:^|\s)` 兼容描述以 Use when 开头的 sp-* 流程包。
  const segments = text.split(/(?:^|\s)Use\s+(?:when|before)\s+/i);
  if (segments.length < 2) return null; // 无触发条件结构

  const clauses = segments.slice(1).map((s) => s.trim()).filter(Boolean);
  if (clauses.length === 0) return null;

  // 作用句:第一个 Use when 之前的文本;为空(如 sp-* 直接以 Use when 开头)时
  // 用首个条件原文截断充当描述主体,避免渲染成一串孤零零的标签。
  const head = segments[0].trim();
  const lead =
    head.length > 0
      ? (head.length > MAX_LEAD ? `${head.slice(0, MAX_LEAD - 1).trimEnd()}…` : head)
      : (clauses[0].length > MAX_LEAD ? `${clauses[0].slice(0, MAX_LEAD - 1).trimEnd()}…` : clauses[0]);

  const tags: string[] = [];
  for (const clause of clauses) {
    for (const sub of splitSubClauses(clause)) {
      const tag = tagFromClause(sub);
      if (tag !== undefined && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
    if (tags.length >= MAX_TAGS) break;
  }
  if (tags.length === 0) return null;

  return { lead, tags };
}

/** 渲染为一行:作用句 + 空格分隔标签。 */
export function renderSkillSummary(s: SummarizedSkill): string {
  return `${s.lead} ${s.tags.join(" ")}`;
}
