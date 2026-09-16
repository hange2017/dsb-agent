/**
 * taskMap —— 任务地图(纯函数,无 vscode 依赖)。
 *
 * 目的:多轮压缩后仍能稳定回答「目标是什么 / 干了什么 / 得到什么 / 下一步」,
 * 让 agent 不迷失目标。
 *
 * T1(缓存前缀稳定性)后地图**只进入一处**:
 *  每轮任务锚尾部(agentLoop 注入)—— 带最新清单的实时地图。
 * 此前地图另有一份落在**压缩块首段**(块内最前缀位置):其「已做/结果/更早的需求」
 * 是滑动窗口(latest N),每轮重建都变 → 压缩块(单条消息,atomic)整块 hash 变化 →
 * 全额 miss(实测 09-14/09-15 的全部「块重建」皆源于此)。
 * 现在块只由 4 轨构成(只追加/只删尾 → 字节跨轮恒定),
 * 地图的变化被限制在消息**尾部**,不破坏任何前缀。
 *
 * 同输入同输出(确定性),保证锚尾部字节可预测、压缩块骨架稳定。
 */

export const TASK_MAP_HEADING = "## 任务地图";

/** 去掉行首编号前缀 `- [rN] `,便于在别处复用原文。 */
export function stripSeq(line: string): string {
  return line.replace(/^\s*[-*]\s*(\[r\d+\]\s*)?/, "").trim();
}

export interface TaskMapInput {
  /** 目标:最初需求(通常取「需求」轨首条)。 */
  goal?: string;
  /**
   * 最新要求:最近一条需求。多轮对话里目标常被「澄清/修正」(落在需求轨中间),
   * 既可能进不了「目标」,又可能被压缩裁掉;单独常驻一行可避免「目标漂移」。
   * 与 goal 去重(clip 后相同则不输出)。
   */
  latestGoal?: string;
  /**
   * 近期需求(需求轨中间**最近 N 条**,排除已单列的 goal/latestGoal):
   * 中期「目标澄清/修正」常落在需求轨中间——既不等于首条(goal)、也不等于末条(latestGoal),
   * 若只靠这两条兜底,第 15 轮的澄清一旦被压缩裁掉就会「目标漂移」。
   * 这里把最近 N 条中间需求**纳入地图**(地图永不参与裁剪)→ 澄清一旦进来即常驻。
   */
  recentDemands?: string[];
  /** 已做:最近的执行动作(工具履历)。 */
  did?: string[];
  /** 结果:最近的结论。 */
  results?: string[];
  /**
   * 下一步:**真实的未完成事项**(任务锚里由 TodoManager 的 pending 项生成)。
   * 注意:不要拿"较老的历史需求"充当本段 —— 历史需求若无完成度判定,会把**已完成**
   * 的事项显示为"下一步",诱导模型重复劳动(现场:地图把已实现的建议列为下一步)。
   * 压缩时无法访问 todo,故**不输出本段**,改由「更早的需求」承载信息。
   */
  next?: string[];
  /**
   * 更早的需求:需求轨里较早、且未单列进「目标/最新要求/近期需求」的中间需求。
   * 语义是"更早的需求",**不宣称是待办**;不含任何完成度暗示。
   */
  earlierDemands?: string[];
}

const MAX_ITEMS = 3;
const MAX_LINE = 160;

/**
 * 判断某条「工具履历」行是否为**工具输出行**(而非工具调用行)。
 * 履约轨同时存两类行:
 *  - 工具调用行:`- [rN] Bash: cd …`(summarizeToolUse 生成,描述"做了什么")
 *  - 工具输出行:`- [rN] ⤷ exit=0 | …`(extractKeyLines 生成,描述"输出是什么")
 * 地图「已做」段语义是"做了什么",输出行会把地图撑长并稀释注意力(现场:一行原始
 * 输出占据整个「已做」条目);输出细节需要时走 ContextRecall 回查。故建图时剔除。
 */
export function isToolResultLedgerLine(line: string): boolean {
  return stripSeq(line).startsWith("⤷");
}

/**
 * 把任务地图「退化为只读上下文」(P0-3):无未完成待办时使用。
 *
 * 背景:地图原措辞(`**目标:**` / `**最新要求:**` / `### 近期需求`)带**行动暗示**,
 * 与锚首句"当前没有未完成的待办,不要自行继续历史任务"直接矛盾 —— 模型会取后者
 * 继续干活(现场:纯状态汇报消息被读成"继续未竟任务")。这里只改**标题措辞**,
 * 把一切暗示"待办/目标"的标签改写为**历史记录**语义,信息量不减、字节稳定。
 * 注意:不改条目正文(正文是原始消息,用户原话必须保真)。
 */
export function toReadOnlyMapLines(lines: string[]): string[] {
  const rename: Array<[RegExp, string]> = [
    [/^\*\*目标:\*\*\s*/, "**历史目标:** "],
    [/^\*\*最新要求:\*\*\s*/, "**最近一条用户消息:** "],
    [/^###\s*近期需求\s*$/, "### 近期历史消息"],
    [/^###\s*更早的需求\s*$/, "### 更早的历史消息"],
    [/^###\s*已做\s*$/, "### 已执行的工具"],
    [/^###\s*结果\s*$/, "### 历史结论"],
  ];
  return (lines ?? []).map((raw) => {
    for (const [re, to] of rename) {
      if (re.test(raw)) return raw.replace(re, to);
    }
    return raw;
  });
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + "…" : t;
}

function section(title: string, items: string[]): string[] {
  const list = items
    .map((x) => clip(stripSeq(x)))
    .filter((x) => x !== "")
    .slice(0, MAX_ITEMS)
    .map((x) => `- ${x}`);
  return list.length === 0 ? [] : [`### ${title}`, ...list];
}

/** 生成任务地图文本(确定性);全空输入返回空串。 */
export function buildTaskMap(input: TaskMapInput): string {
  const goal = input.goal ? clip(stripSeq(input.goal)) : "";
  const latest = input.latestGoal ? clip(stripSeq(input.latestGoal)) : "";
  // 近期需求:剔除与「目标」「最新要求」重复的行(去重后再截断,避免有效行被重复行挤掉)。
  const seen = new Set([goal, latest].filter((x) => x !== ""));
  const recent = (input.recentDemands ?? [])
    .map((x) => clip(stripSeq(x)))
    .filter((x) => x !== "" && !seen.has(x))
    // 去重(同一行多次出现只留一次,保持确定性)
    .filter((x, i, arr) => arr.indexOf(x) === i);
  const body = [
    ...(goal ? [`**目标:** ${goal}`] : []),
    ...(latest && latest !== goal ? [`**最新要求:** ${latest}`] : []),
    ...section("近期需求", recent),
    ...section("已做", input.did ?? []),
    ...section("结果", input.results ?? []),
    ...section("更早的需求", input.earlierDemands ?? []),
    ...section("下一步", input.next ?? []),
  ];
  return body.length === 0 ? "" : [TASK_MAP_HEADING, ...body].join("\n");
}

/** 地图行数组(供压缩块轨存储);空输入返回 []。 */
export function taskMapLines(input: TaskMapInput): string[] {
  const text = buildTaskMap(input);
  return text === "" ? [] : text.split("\n");
}

/** 地图内「近期需求」段标题(与 section() 生成的一致)。 */
export const RECENT_DEMANDS_TITLE = "近期需求";

/** 地图内「更早的需求」段标题(与 section() 生成的一致)。 */
export const EARLIER_DEMANDS_TITLE = "更早的需求";

/**
 * 从已落盘的地图行中提取某个 `### 标题` 段的条目(去掉 `- ` 前缀)。
 * 用途:地图每轮「重建」时把上一轮进了地图的条目**累积**进来,避免中期澄清
 * 被后续新需求挤出滑动窗口后永久消失(T1 起地图只走消息尾部锚,不再随块持久化,
 * 但恢复时用 `seedResidentMap` 从 4 轨重建,累积语义仍需保住)。
 */
export function extractMapSectionItems(mapLines: string[], title: string): string[] {
  const out: string[] = [];
  const heading = `### ${title}`;
  let inSection = false;
  for (const raw of mapLines ?? []) {
    // 行尾归一化:JS 正则的 `.` **不匹配 `\r`**(line terminator),
    // 若不先剥掉,`/^\s*-\s+(.*)$/` 对 CRLF 行会整条匹配失败 → 累积式「近期需求」静默失效。
    // 内部生成一律 `\n`(工程内无 os.EOL),但外部编辑的会话块(*.block.json,
    // Windows 记事本另存为 CRLF)会带 `\r`;与 agentTemplates/slashCommands 的 CRLF 归一化保持一致。
    const line = typeof raw === "string" ? raw.replace(/\r+$/, "") : "";
    if (line.startsWith("### ")) {
      inSection = line.trim() === heading;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*-\s+(.*)$/);
    if (m && m[1].trim() !== "") out.push(m[1].trim());
  }
  return out;
}

/**
 * 累积式「近期需求」:把上一轮地图中已有的条目(prevRecent)与本次候选合并去重,
 * 只保留最近 max 条。确定性:同 (prevRecent, candidates) 必得同结果 → 地图字节稳定。
 * 语义:条目一旦进入地图即「粘住」,直到被更新的 max 条挤出——远强于纯滑动窗口。
 */
export function accumulateRecentDemands(
  prevRecent: string[],
  candidates: string[],
  max: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...prevRecent, ...candidates]) {
    const t = clip(stripSeq(raw));
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return max <= 0 ? [] : out.slice(-max);
}
