/**
 * contextCompactor —— 上下文分轨压缩的纯函数(无 vscode 依赖,可单测)。
 *
 * 压缩时把历史消息分成 4 个轨道:
 *  - demands      :用户需求(原始 user 消息,逐条保留,含编号)
 *  - conclusions  :助手结论(结论性内容,保留原文)
 *  - explanations :助手解释(分析性内容,压缩为摘要)
 *  - ledger       :工具履历(每个 tool_use 的参数摘要 + 关键输出行)
 *
 * 压缩产物是一个带 `[compacted]` 标记的结构化 Markdown 块。
 */

/** assistant 文本分类结果 */
export interface AssistantTextParts {
  /** 结论性段落(保留原文) */
  conclusion: string[];
  /** 解释性段落(需摘要) */
  explanation: string[];
}

type BlockType = "heading" | "list" | "code" | "table" | "para";

interface TextBlock {
  type: BlockType;
  text: string;
}

/** 短文本阈值:整条文本小于该值则整体视为结论 */
const SHORT_TEXT = 300;
/** 无工具伴随时,小于该值整体视为结论 */
const SHORT_NO_TOOL = 800;
/** 首/尾段若超过该长度,降级为解释 */
const EDGE_PARA_MAX = 400;

const CONCLUSION_KEYWORDS = [
  "结论",
  "方案",
  "决定",
  "推荐",
  "建议",
  "总结",
  "summary",
  "conclusion",
  "decision",
  "recommend",
];

function isHeadingLine(line: string): boolean {
  return /^#{2,6}\s/.test(line);
}

function isListLine(line: string): boolean {
  return /^(\s*)([-*+]|\d+\.)\s/.test(line);
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

/** 按行把文本切成"块":code 围栏、标题、表格、列表、普通段落(空行分隔) */
export function splitBlocks(text: string): TextBlock[] {
  const lines = text.split("\n");
  const blocks: TextBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // code 围栏
    if (line.trimStart().startsWith("```")) {
      const fence = line.trimStart();
      const collected = [line];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        collected.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        collected.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", text: collected.join("\n") });
      continue;
    }
    // 标题:收集标题行与后续段落直到下一个块边界
    if (isHeadingLine(line)) {
      const collected = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "" || isHeadingLine(l) || isListLine(l) || isTableLine(l)) {
          break;
        }
        collected.push(l);
        i++;
      }
      blocks.push({ type: "heading", text: collected.join("\n") });
      continue;
    }
    // 表格:连续 | 行
    if (isTableLine(line)) {
      const collected = [line];
      i++;
      while (i < lines.length && isTableLine(lines[i])) {
        collected.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", text: collected.join("\n") });
      continue;
    }
    // 列表:连续列表行(含缩进续行)
    if (isListLine(line)) {
      const collected = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !isHeadingLine(lines[i]) && !isTableLine(lines[i])) {
        collected.push(lines[i]);
        i++;
      }
      blocks.push({ type: "list", text: collected.join("\n") });
      continue;
    }
    // 普通段落:连续非空行,空行分隔
    const collected = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      collected.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", text: collected.join("\n") });
  }
  return blocks;
}

/**
 * 分类 assistant 文本:
 *  - **过程轮(伴 tool_use)**:一律判解释 —— 结构块是"取证/分析记录",段落是过渡旁白,
 *    都不是交付物(P0-1 补全);即便含列举/代码也不例外。
 *  - **终答轮(无 tool_use)**:heading/list/code/table 块 → 结论;短文本(整体)→ 结论;
 *    首/尾段(未超长)→ 结论;含结论关键词的段落 → 结论;其余 → 解释。
 */
export function classifyAssistantText(text: string, hasToolUse: boolean): AssistantTextParts {
  const conclusion: string[] = [];
  const explanation: string[] = [];

  const trimmed = text.trim();
  if (!trimmed) {
    return { conclusion, explanation };
  }
  const len = trimmed.length;
  const shortThreshold = hasToolUse ? SHORT_TEXT : SHORT_NO_TOOL;
  if (len < shortThreshold) {
    // P0-1(补全):带 tool_use 的短文本一定是「过程旁白」(先取证不臆断 / 继续推进 / 收到),
    // 不是终答 —— **含结构块也一样**。旧逻辑只拦「无结构块」的短文本,漏掉了带代码/列表的
    // 分析片段:它们被判结论 → 进 conclusions 轨 → 地图「结果」段 → 下轮任务锚回喂自身,
    // 形成自我强化循环(实测:过程旁白被判结论,单条 43 字消息跑 20 轮 / 5.3 万输出 token)。
    // 终答轮(无 tool_use)才可能产出结论。
    if (hasToolUse) {
      explanation.push(trimmed);
    } else {
      conclusion.push(trimmed);
    }
    return { conclusion, explanation };
  }

  const blocks = splitBlocks(trimmed);
  const n = blocks.length;
  blocks.forEach((block, idx) => {
    if (block.type !== "para") {
      // P0-1(补全):过程轮(伴 tool_use)的结构块(代码/列表/表格/标题)是「取证/分析记录」,
      // 不是交付物 —— 结构块只在终答轮才算结论。旧逻辑无条件判结论,导致我每轮的分析正文
      // (几乎全是代码块 + 列表)持续灌进 conclusions 轨 → 地图「结果」段 → 下轮锚回喂自己。
      if (hasToolUse) {
        explanation.push(block.text);
      } else {
        conclusion.push(block.text);
      }
      return;
    }
    // P0-1:过程轮(伴 tool_use)的首/尾段落不再自动判结论 —— 那是开场铺垫/过渡旁白;
    // 只有明确含结论关键词的段落才进结论轨。终答轮(无 tool_use)保留首/尾规则。
    const isEdge = !hasToolUse && (idx === 0 || idx === n - 1);
    const hasKeyword = CONCLUSION_KEYWORDS.some((k) => block.text.toLowerCase().includes(k.toLowerCase()));
    if ((isEdge && block.text.length <= EDGE_PARA_MAX) || hasKeyword) {
      conclusion.push(block.text);
    } else {
      explanation.push(block.text);
    }
  });
  return { conclusion, explanation };
}

/** 摘取 tool_use 的输入为单行摘要(≤ ~90 字符) */
export function summarizeToolUse(tool: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + "…" : s);

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
      if (typeof v === "number") {
        return String(v);
      }
    }
    return undefined;
  };

  let detail: string | undefined;
  switch (tool) {
    case "Read":
    case "Write":
    case "StrReplace":
    case "Delete":
      detail = pick("path", "file");
      break;
    case "Bash":
      detail = pick("command");
      break;
    case "Grep":
      detail = [pick("pattern"), pick("path")].filter(Boolean).join(" ") || undefined;
      break;
    case "WebSearch":
      detail = pick("query");
      break;
    case "WebFetch":
      detail = pick("url");
      break;
    case "Agent":
      detail = pick("task");
      break;
    case "Workflow":
      detail = pick("goal");
      break;
    case "MemoryRead":
    case "MemoryWrite":
    case "MemoryDelete":
      detail = pick("name");
      break;
    case "MemoryList":
      detail = "list";
      break;
    case "TodoWrite":
      detail = pick("op");
      break;
    case "ContextRecall":
      detail = pick("seq", "query");
      break;
    case "Skill":
      detail = pick("name");
      break;
    default:
      detail = Object.keys(obj).join(",");
  }
  // 单行化(写前定型):多行参数(如 Bash heredoc / 多段 command)若保留 `\n`,
  // 压缩块 `join("\n")` 序列化后会把**一条轨条目裂成多个物理行**;`parseCompactedBlock`
  // 按行读回时,续行便成了**无前缀碎片行**(现场:地图「已做」出现
  // `- import json, os, datetime, …`)。此处把内部空白(含换行)归一化,
  // 保证「一条工具调用 == 一行」,从源头杜绝裂行。
  const oneLine = (s: string): string =>
    s.replace(/\s*\n+\s*/g, " | ").replace(/[ \t]+/g, " ").trim();
  const body = truncate(oneLine(detail ?? "(no input)"), 80);
  return `${tool}: ${body}`;
}

export interface KeyLineOptions {
  /** 成功输出保留的头部行数 */
  maxHead?: number;
  /** 保留的尾部行数 */
  maxTail?: number;
  /** 单行最大长度 */
  maxLine?: number;
}

const ERROR_PATTERN = /error|failed|fail|exception|fatal|panic/i;

/**
 * 从 tool_result 输出中提取关键行:
 *  - 输出短 → 原样返回
 *  - 成功且长 → 头 maxHead + 尾 maxTail
 *  - 失败 → 错误行(最多 maxHead)+ 头 2 + 尾 2
 */
export function extractKeyLines(output: string, ok: boolean, opts: KeyLineOptions = {}): string {
  const { maxHead = 6, maxTail = 2, maxLine = 160 } = opts;
  const raw = output ?? "";
  const lines = raw.split("\n").map((l) => (l.length > maxLine ? l.slice(0, maxLine) + "…" : l));
  const total = lines.length;
  if (total === 0) {
    return "";
  }
  const trimmed = lines.filter((l) => l.trim() !== "");
  if (total <= maxHead + maxTail + 2) {
    return trimmed.join("\n");
  }
  if (ok) {
    const head = lines.slice(0, maxHead);
    const tail = lines.slice(total - maxTail);
    return [...head, `… (truncated ${total - maxHead - maxTail} lines)`, ...tail].join("\n");
  }
  const errLines = lines.filter((l) => ERROR_PATTERN.test(l)).slice(0, maxHead);
  const head = lines.slice(0, 2);
  const tail = lines.slice(total - 2);
  const rest = [...head, ...tail];
  return [...errLines, ...rest].join("\n");
}

/** 合并块各轨道(均应为已格式化行) */
export interface CompactBlockParts {
  /**
   * 任务地图(**仅为兼容旧块的只读字段**,T1 起不再写入块内):
   * 目标/最新要求/近期需求/更早的需求/已做/结果;不含「下一步」
   * (块内无法访问 todo,真实待办由 agentLoop 的任务锚注入)。
   *
   * 保留原因:旧会话持久化的压缩块(含块首地图)仍需被 `parseCompactedBlock`
   * 解析出来,以便恢复时用 4 轨重建地图(`seedResidentMap`)。
   * 新块构建时恒为 `undefined`(见 `buildCompactedBlock`),故块字节只由 4 轨决定。
   */
  map?: string[];
  demands: string[];
  conclusions: string[];
  explanations: string[];
  ledger: string[];
}

/** 解析压缩块:把 `## 轨道` 小节下的行提取为轨道数组(供增量压缩合并) */
export function parseCompactedBlock(content: string): CompactBlockParts {
  const parts: CompactBlockParts = { demands: [], conclusions: [], explanations: [], ledger: [] };
  const lines = (content ?? "").split("\n");
  let current: keyof CompactBlockParts | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(需求|结论|说明|工具履历|任务地图)\s*$/);
    if (heading) {
      if (heading[1] === "任务地图") {
        // 地图段含自身标题行,原样收集(含 `**目标:**` 与 `### 已做` 等行),
        // 使 build→parse→build 幂等;`### 子标题` 不匹配上面的 `##` 正则,不会被误判。
        current = "map";
        parts.map = [...(parts.map ?? []), line];
        continue;
      }
      current =
        heading[1] === "需求"
          ? "demands"
          : heading[1] === "结论"
            ? "conclusions"
            : heading[1] === "说明"
              ? "explanations"
              : "ledger";
      continue;
    }
    if (current && line.trim() !== "" && line !== "[compacted]" && line !== "[前文摘要]" && !isRecallHintLine(line)) {
      if (current === "map") {
        parts.map = [...(parts.map ?? []), line];
      } else {
        parts[current].push(line);
      }
    }
  }
  return parts;
}

/** 合并两套轨道(增量:旧块在前,新段在后);按行去重保持顺序 */
export function mergeCompactedTracks(prev: CompactBlockParts, next: CompactBlockParts): CompactBlockParts {
  const merge = (a: string[], b: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of [...a, ...b]) {
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
    return out;
  };
  return {
    map: next.map && next.map.length > 0 ? next.map : prev.map,
    demands: merge(prev.demands, next.demands),
    conclusions: merge(prev.conclusions, next.conclusions),
    explanations: merge(prev.explanations, next.explanations),
    ledger: merge(prev.ledger, next.ledger),
  };
}

function track(title: string, lines: string[], includeEmptyTitle = true): string[] {
  // 标题恒输出:即使某轨为空也保留标题行,避免「由空变非空」时在块中部插入标题行
  // 导致其后所有行号后移(缓存前缀断裂)。空轨仅含标题,parseCompactedBlock 仍能正确判空。
  // includeEmptyTitle=false 时(thinking 块)保持旧行为:空轨不输出标题。
  if (lines.length === 0 && !includeEmptyTitle) return [];
  // 出口转义内嵌 `## 标题`(t37):历史块中多行条目被 parse 拆成独立元素后,
  // 内嵌的标准轨名会冒充轨起点 → 内容串轨 + build/parse 幂等破坏。
  // 在唯一输出口逐行转义,既防新污染也自愈历史块;转义形态幂等、零信息丢失。
  const safe = lines.map((l) => demoteInnerHeadings(l));
  return [`## ${title}`, ...safe];
}

/**
 * 压缩块尾部固定提示行(恒输出,字节稳定):引导模型对压缩摘要行主动调用 ContextRecall 回查原文,
 * 并显式指向「需求」轨(目标锚),降低「多轮迷失目标」概率。
 * 注意:内容固定不变,否则每次压缩重建都会改变块尾字节 → 缓存前缀断裂。
 */
export const RECALL_HINT_LINE =
  "(hint: 目标见「需求」轨首条;原文→ContextRecall(seq=n))";

/** 旧版提示行(历史会话已落盘的块):解析时同样跳过,避免被当成业务行。 */
export const LEGACY_RECALL_HINT_LINE = "(hint: ContextRecall(seq=n) → [r{n}])";

/** 是否为压缩块提示行(当前或历史版本)。 */
export function isRecallHintLine(line: string): boolean {
  return line === RECALL_HINT_LINE || line === LEGACY_RECALL_HINT_LINE;
}

/** 构建合并压缩块(带 [compacted] 标记) */
export function buildCompactedBlock(parts: CompactBlockParts): string {
  const sections = [
    "[前文摘要]",
    "[compacted]",
    // T1(缓存前缀):任务地图**不再输出到块内**。
    // 块只由 4 轨构成(只追加/只删尾 → 字节稳定);地图含滑动窗口段
    // (已做/结果/更早的需求每轮都在变),若置于块首(最前缀位置),其变化会让
    // 整块(实测中位 1.8 万 tok)全额 miss —— 实测 09-14/09-15 全部「块重建」皆源于此。
    // 地图改由任务锚在**消息尾部**投递(尾部变化不破坏任何前缀)。
    ...track("需求", parts.demands),
    ...track("结论", parts.conclusions),
    ...track("说明", parts.explanations),
    ...track("工具履历", parts.ledger),
    RECALL_HINT_LINE,
  ];
  return sections.join("\n");
}

/** 判断一段内容是否为压缩块 */
export function isCompactedBlock(content: string): boolean {
  if (typeof content !== "string") {
    return false;
  }
  return content.split("\n").some((line) => line === "[compacted]");
}

/** 估算压缩块字符数(与 buildCompactedBlock 产物一致)。 */
export function estimateBlockChars(parts: CompactBlockParts): number {
  return buildCompactedBlock(parts).length;
}

/**
 * 把多行条目正文里的**内嵌 Markdown 标题**(`## xxx`)转义,防止它冒充压缩块轨标题。
 *
 * 背景(t37 调查):`classifyAssistantText` 的 heading / 列表 / 表格块会**保留内部换行**,
 * 整段被格式化为单条轨行 `- [rN] <多行文本>`。当多行文本第 2 行起出现 `## 说明` 这类
 * **标准轨名**时,`parseCompactedBlock` 会把它当成新轨起点 → 内容被搬进错误轨
 * → `build(parse(x)) !== x`(幂等破坏 → 缓存前缀断裂 + 信息错位)。
 *
 * 修复采用「写前定型」双保险:
 *  1. `contextManager.stratify` 在**把条目写入轨道前**转义(本轮新增内容不引入污染);
 *  2. `track()`(build 的唯一出口)对**每一行内容**再转义一次 —— 因为 `parseCompactedBlock`
 *     会把历史多行条目拆成独立数组元素,单靠写前定型无法覆盖「已被拆散的历史残片」,
 *     在出口转义才能做到**历史块自愈 + build/parse 幂等**。
 *
 * 转义形态**幂等**(首字符为 `\`,不再匹配 `^##`),且**零信息丢失**(仍按字面 `## xxx` 可读)。
 * 逐行处理:`- [rN] 正文\n## 说明` 拆分后,内嵌行同样被转义。
 */
export function demoteInnerHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(#{1,6})(\s)/, "\\$1$2"))
    .join("\n");
}

/** 从压缩块行 `- [r{n}] ...` 提取序号;无匹配返回 0。 */
export function lineSeq(line: string): number {
  const m = line.match(/\[r(\d+)\]/);
  return m ? Number(m[1]) : 0;
}

/** 收集行数组中的 seq(>0,去重)。 */
function seqSet(lines: string[]): Set<number> {
  const out = new Set<number>();
  for (const l of lines) {
    const s = lineSeq(l);
    if (s > 0) out.add(s);
  }
  return out;
}

/**
 * 增量合并前置断言:旧块(prevLines)与新段(nextLines)的行 seq 不得重叠。
 * seq 重叠说明序号分配/推进有 bug——合并后模型会看到两条同 `[r{n}]` 的不同内容,
 * 造成重复/矛盾信息。断言失败抛错(调用方 compact() 已有 fail-open 兜底,不阻断主循环)。
 * 注:同一消息拆出的多行(结论/工具履历/解释摘要)共享消息级 seq 是既有设计
 * (按 seq 回查返回该消息全部侧面),不在本断言范围内。
 */
export function assertNoSeqOverlap(prevLines: string[], nextLines: string[], label: string): void {
  const prevSeqs = seqSet(prevLines);
  if (prevSeqs.size === 0) return;
  const overlap = new Set<number>();
  for (const l of nextLines) {
    const s = lineSeq(l);
    if (s > 0 && prevSeqs.has(s)) overlap.add(s);
  }
  if (overlap.size > 0) {
    const seqs = [...overlap].sort((a, b) => a - b).join(",");
    throw new Error(`增量合并断言失败(${label}): 新旧 seq 重叠 [${seqs}] — 新段应使用旧块之后的序号`);
  }
}

/**
 * 严格模式工具(默认不接入 compact 主流程):一组行内 seq 必须唯一。
 * 注意:同一消息拆出的多行共享消息级 seq 是既有设计,因此块级唯一性检查
 * 会误伤——本函数仅用于需要严格 seq 唯一化的场景/测试(如未来改造为每行独立 seq)。
 */
export function assertUniqueSeqLines(lines: string[], label: string): void {
  const seen = new Set<number>();
  const dup: number[] = [];
  for (const l of lines) {
    const s = lineSeq(l);
    if (s <= 0) continue;
    if (seen.has(s)) dup.push(s);
    seen.add(s);
  }
  if (dup.length > 0) {
    const seqs = [...new Set(dup)].sort((a, b) => a - b).join(",");
    throw new Error(`合并后断言失败(${label}): seq 重复 [${seqs}]`);
  }
}

/**
 * 按序号把一行轨的行分成"最旧一半"与"最新一半"。
 * 条数 < 2 时全部归 oldest(单条也允许整体再摘要);keep 保持原顺序。
 */
export function splitByAge(lines: string[]): { oldest: string[]; newest: string[] } {
  if (lines.length === 0) return { oldest: [], newest: [] };
  const sorted = [...lines].sort((a, b) => lineSeq(a) - lineSeq(b));
  const oldestCount = Math.max(1, Math.ceil(sorted.length / 2));
  return {
    oldest: sorted.slice(0, oldestCount),
    newest: sorted.slice(oldestCount),
  };
}

/**
 * 把最旧解释行合并为纯文本(去掉 `- [r{n}] ` 前缀),供再次 summarize;
 * keep 为最新的行(原样保留)。返回 oldestText 与 oldestSeq(合并段的起始序号)。
 */
export function collapseOldestExplanations(
  lines: string[],
): { keep: string[]; oldestText: string; oldestSeq: number } {
  const { oldest, newest } = splitByAge(lines);
  if (oldest.length === 0) {
    return { keep: newest, oldestText: "", oldestSeq: 0 };
  }
  const strip = (line: string): string => line.replace(/^-\s*\[r\d+\]\s*/, "");
  const oldestSeq = lineSeq(oldest[0]);
  return {
    keep: newest,
    oldestText: oldest.map(strip).join("\n\n"),
    oldestSeq,
  };
}

/**
 * 把「最新一半」解释行(即尾部/该次新增部分)合并为纯文本,供再次 summarize。
 * 返回 keep 为最旧一半(稳定段,原样保留);拼接时旧行位置不变,仅块尾被压缩,
 * 跨压缩轮次前缀字节稳定(只增尾部/只删尾部)。适用于增量压缩场景。
 */
export function collapseTailExplanations(
  lines: string[],
): { keep: string[]; tailText: string; tailSeq: number } {
  const { oldest, newest } = splitByAge(lines);
  if (newest.length === 0) {
    // 解释轨只有最旧一段(无区分度,如首次压缩或整组同 seq):视整组即「尾部」
    // (该次新增),压缩全部以让块可收敛;此时无历史稳定行可保,不破坏前缀稳定。
    const strip = (line: string): string => line.replace(/^-\s*\[r\d+\]\s*/, "");
    const tailSeq = oldest.length > 0 ? lineSeq(oldest[0]) : 0;
    return { keep: [], tailText: oldest.map(strip).join("\n\n"), tailSeq };
  }
  const strip = (line: string): string => line.replace(/^-\s*\[r\d+\]\s*/, "");
  const tailSeq = lineSeq(newest[0]);
  return {
    keep: oldest,
    tailText: newest.map(strip).join("\n\n"),
    tailSeq,
  };
}

/** 超长行截断至 maxLine(逐行,不合并)。 */
export function truncateLongLines(lines: string[], maxLine = 240): string[] {
  return lines.map((l) => (l.length > maxLine ? l.slice(0, maxLine) + "…" : l));
}

/** 把多轨行统一截断(供块超限时的兜底)。 */
export function truncateParts(parts: CompactBlockParts, maxLine = 240): CompactBlockParts {
  return {
    // 任务地图原样保留(行已由 taskMap 裁剪到 ≤160),不参与截断/裁剪。
    ...(parts.map ? { map: parts.map } : {}),
    demands: truncateLongLines(parts.demands, maxLine),
    conclusions: truncateLongLines(parts.conclusions, maxLine),
    explanations: truncateLongLines(parts.explanations, maxLine),
    ledger: truncateLongLines(parts.ledger, maxLine),
  };
}

/* ------------------------------------------------------------------ */
/* thinking 独立压缩块                                                 */
/* ------------------------------------------------------------------ */

/** 注入 thinking 摘要调用时的 system 规则(与压缩块解耦的独立轨道)。 */
export const THINKING_COMPACTION_RULES = `你正在把一段"思考过程(thinking)"压缩成结构化摘要。
要求:
1. 只输出下面的 markdown 块,不要任何其它解释或前后缀。
2. 块格式(小节顺序固定,内容不足的小节整体省略):
[thinking]
## 正确
- [r{n}] 保留的正确推理链路/事实,一句一条
## 错误
- [r{n}] 走偏方向 | 结论:为什么错
## 中性
- [r{n}] 尚未定论的分析/概要
3. n 从给定序号开始连续编号;每条一行,尽量保留关键结论与文件名。
4. 只压缩原文内容,不要编造原文没有的信息。`;

/** thinking 块的分组结构(行均为已格式化行,形如 `- [r9] ...`)。 */
export interface ThinkingBlockParts {
  /** 正确推理链路 */
  correct: string[];
  /** 错误方向与结论 */
  wrong: string[];
  /** 中性分析 */
  neutral: string[];
}

const THINKING_GROUPS: readonly (keyof ThinkingBlockParts)[] = ["correct", "wrong", "neutral"] as const;

interface ThinkingEntry {
  group: keyof ThinkingBlockParts;
  line: string;
  seq: number;
}

/** 构建 thinking 块(带 [thinking] 标记)。 */
export function buildThinkingBlock(parts: ThinkingBlockParts): string {
  const sections = [
    "[thinking]",
    ...track("正确", parts.correct, false),
    ...track("错误", parts.wrong, false),
    ...track("中性", parts.neutral, false),
  ];
  return sections.join("\n");
}

/** 判断一段内容是否为 thinking 块。 */
export function isThinkingBlock(content: string): boolean {
  if (typeof content !== "string") {
    return false;
  }
  return content.split("\n").some((line) => line === "[thinking]");
}

/** 解析 thinking 块:把 `## 正确/错误/中性` 小节下的行提取为分组数组。 */
export function parseThinkingBlock(content: string): ThinkingBlockParts {
  const parts: ThinkingBlockParts = { correct: [], wrong: [], neutral: [] };
  const lines = (content ?? "").split("\n");
  let current: keyof ThinkingBlockParts | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(正确|错误|中性)\s*$/);
    if (heading) {
      current = heading[1] === "正确" ? "correct" : heading[1] === "错误" ? "wrong" : "neutral";
      continue;
    }
    if (current && line.trim() !== "" && line !== "[thinking]" && line !== "[前文摘要]") {
      parts[current].push(line);
    }
  }
  return parts;
}

/** 合并两套 thinking 分组(旧在前,新在后);按行去重保持顺序。 */
export function mergeThinkingBlocks(prev: ThinkingBlockParts, next: ThinkingBlockParts): ThinkingBlockParts {
  const merge = (a: string[], b: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of [...a, ...b]) {
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
    return out;
  };
  return {
    correct: merge(prev.correct, next.correct),
    wrong: merge(prev.wrong, next.wrong),
    neutral: merge(prev.neutral, next.neutral),
  };
}

/** 估算 thinking 块字符数(与 buildThinkingBlock 产物一致)。 */
export function estimateThinkingChars(parts: ThinkingBlockParts): number {
  return buildThinkingBlock(parts).length;
}

/**
 * 滚动收缩:按行序号从小到大丢"最旧"行,直至块字符 ≤ maxChars;
 * 始终至少保留最新一行;maxChars ≤ 0 时返回空分组。
 */
export function trimThinkingBlock(parts: ThinkingBlockParts, maxChars: number): ThinkingBlockParts {
  if (maxChars <= 0) {
    return { correct: [], wrong: [], neutral: [] };
  }
  const entries: ThinkingEntry[] = [];
  for (const group of THINKING_GROUPS) {
    for (const line of parts[group]) {
      entries.push({ group, line, seq: lineSeq(line) });
    }
  }
  if (entries.length === 0) {
    return { correct: [], wrong: [], neutral: [] };
  }
  entries.sort((a, b) => a.seq - b.seq);
  const toParts = (list: ThinkingEntry[]): ThinkingBlockParts => {
    const out: ThinkingBlockParts = { correct: [], wrong: [], neutral: [] };
    for (const e of list) {
      out[e.group].push(e.line);
    }
    return out;
  };
  let kept = entries;
  while (buildThinkingBlock(toParts(kept)).length > maxChars && kept.length > 1) {
    kept = kept.slice(1); // 丢最旧一行(seq 最小)
  }
  return toParts(kept);
}
