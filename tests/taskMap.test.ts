import { describe, it, expect } from "vitest";
import {
  accumulateRecentDemands,
  buildTaskMap,
  extractMapSectionItems,
  isToolResultLedgerLine,
  sanitizeMapLines,
  EARLIER_DEMANDS_TITLE,
  RECENT_DEMANDS_TITLE,
  taskMapLines,
  stripSeq,
  TASK_MAP_HEADING,
} from "../src/agent/taskMap";

describe("taskMap", () => {
  it("stripSeq 去掉行首 seq 编号与项目符号", () => {
    expect(stripSeq("- [r12] 修复压缩")).toBe("修复压缩");
    expect(stripSeq("  - 目标其一")).toBe("目标其一");
    expect(stripSeq("无前缀")).toBe("无前缀");
  });

  it("全空输入返回空串 / 空行数组", () => {
    expect(buildTaskMap({})).toBe("");
    expect(taskMapLines({})).toEqual([]);
  });

  it("生成地图四要素且确定性(同输入同输出)", () => {
    const input = {
      goal: "- [r1] 修复多轮迷失目标",
      did: ["- [r8] 定位 trimTracksToBudget"],
      results: ["- [r9] 需求轨不再被优先删"],
      next: ["- [ ] P2 任务地图"],
    };
    const a = buildTaskMap(input);
    const b = buildTaskMap(input);
    expect(a).toBe(b);
    expect(a.startsWith(TASK_MAP_HEADING)).toBe(true);
    expect(a).toContain("**目标:** 修复多轮迷失目标");
    expect(a).toContain("### 已做");
    expect(a).toContain("### 结果");
    expect(a).toContain("### 下一步");
  });

  it("每节最多 3 条,超长行按 160 字符截断", () => {
    const long = "x".repeat(400);
    const map = buildTaskMap({ next: ["a", "b", "c", "d"], did: [long] });
    const nextIdx = map.indexOf("### 下一步");
    const nextLines = map.slice(nextIdx).split("\n").filter((l) => l.startsWith("- "));
    expect(nextLines.length).toBe(3);
    const didLine = map.split("\n").find((l) => l.includes("x")) ?? "";
    expect(didLine.length).toBeLessThanOrEqual(162);
  });

  it("最新要求与目标不同时常驻一行;相同则去重", () => {
    const withDrift = buildTaskMap({ goal: "- [r1] 修复压缩", latestGoal: "- [r15] 改成保护地图" });
    expect(withDrift).toContain("**目标:** 修复压缩");
    expect(withDrift).toContain("**最新要求:** 改成保护地图");
    const same = buildTaskMap({ goal: "- [r1] 修复压缩", latestGoal: "- [r1] 修复压缩" });
    expect(same).not.toContain("最新要求");
    const empty = buildTaskMap({ latestGoal: "- [r15] 改成保护地图" });
    expect(empty).toContain("**最新要求:** 改成保护地图");
    expect(empty).not.toContain("**目标:**");
  });

  it("taskMapLines 拆分与 buildTaskMap 一致", () => {
    const input = { goal: "目标", next: ["下一步"] };
    expect(taskMapLines(input)).toEqual(buildTaskMap(input).split("\n"));
  });

  it("近期需求:中间澄清纳入常驻段, 且与目标/最新要求去重", () => {
    const map = buildTaskMap({
      goal: "- [r1] 最初目标",
      latestGoal: "- [r20] 最新要求",
      recentDemands: ["- [r15] 澄清:保住地图", "- [r1] 最初目标", "- [r15] 澄清:保住地图"],
    });
    expect(map).toContain("### 近期需求");
    // 澄清进入常驻段(否则中期修正会随中间行被裁 → 目标漂移)
    expect(map).toContain("- 澄清:保住地图");
    // 与 goal 重复的行不得出现在近期需求段
    const recentIdx = map.indexOf("### 近期需求");
    const recentSeg = map.slice(recentIdx, map.indexOf("###", recentIdx + 3) === -1 ? undefined : map.indexOf("###", recentIdx + 3));
    expect(recentSeg).not.toContain("最初目标");
    // 重复行只保留一次
    expect(map.split("澄清:保住地图").length - 1).toBe(1);
  });

  it("近期需求:同输入同输出(确定性, 不破缓存前缀)", () => {
    const input = { goal: "g", recentDemands: ["a", "b", "c"] };
    expect(buildTaskMap(input)).toBe(buildTaskMap(input));
  });

  it("近期需求为空/未传时不输出该段(字节与旧版一致)", () => {
    expect(buildTaskMap({ goal: "g", next: ["n"] })).not.toContain("近期需求");
    expect(buildTaskMap({ goal: "g", recentDemands: [] })).not.toContain("近期需求");
  });

  it("更早的需求: 独立成段, 不与「近期需求」「下一步」混同", () => {
    const map = buildTaskMap({
      goal: "- [r1] 最初目标",
      recentDemands: ["- [r28] 近期澄清"],
      earlierDemands: ["- [r5] 更早的需求甲", "- [r9] 更早的需求乙"],
    });
    expect(map).toContain(`### ${EARLIER_DEMANDS_TITLE}`);
    expect(map).toContain("- 更早的需求甲");
    // 不宣称是待办(否则会把已完成事项显示为下一步)
    expect(map).not.toContain("### 下一步");
    // 段序:近期需求 → 更早的需求 → 已做 → 结果
    expect(map.indexOf("### 近期需求")).toBeLessThan(map.indexOf("### 更早的需求"));
  });

  it("无更早的需求时不输出该段(字节与旧版一致, 不破缓存前缀)", () => {
    expect(buildTaskMap({ goal: "g", earlierDemands: [] })).not.toContain(EARLIER_DEMANDS_TITLE);
    expect(buildTaskMap({ goal: "g" })).not.toContain(EARLIER_DEMANDS_TITLE);
  });

  it("extractMapSectionItems: 兼容 CRLF 行尾(外部编辑的会话块文件)", () => {
    // JS 正则的 `.` 不匹配 `\r`:行尾若不先归一化,`/^\s*-\s+(.*)$/` 对 CRLF 行整条失败
    // → 累积式「近期需求」静默失效(中期澄清不再粘住)。Windows 记事本另存为即 CRLF。
    const crlf = ["## 任务地图\r", `### ${RECENT_DEMANDS_TITLE}\r`, "- 澄清甲\r", "### 已做\r", "- x\r"];
    expect(extractMapSectionItems(crlf, RECENT_DEMANDS_TITLE)).toEqual(["澄清甲"]);
    expect(extractMapSectionItems([`### ${EARLIER_DEMANDS_TITLE}\r`, "- 更早\r"], EARLIER_DEMANDS_TITLE)).toEqual([
      "更早",
    ]);
    // 累积式同样对行尾不敏感
    expect(accumulateRecentDemands([], ["- 甲\r"], 3)).toEqual(["甲"]);
  });

  it("行尾归一化:CRLF 与 LF 输入产出字节相同的地图", () => {
    const lf = { goal: "- [r1] 目标甲", recentDemands: ["- [r2] 近期乙"], earlierDemands: ["- [r3] 更早丙"] };
    const crlf = { goal: "- [r1] 目标甲\r", recentDemands: ["- [r2] 近期乙\r"], earlierDemands: ["- [r3] 更早丙\r"] };
    const b = buildTaskMap(crlf);
    expect(b).not.toContain("\r");
    expect(b).toBe(buildTaskMap(lf));
  });

  it("更早的需求: 每节最多 3 条", () => {
    const map = buildTaskMap({ earlierDemands: ["e1", "e2", "e3", "e4"] });
    const idx = map.indexOf(`### ${EARLIER_DEMANDS_TITLE}`);
    const lines = map.slice(idx).split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(3);
  });
});

describe("accumulateRecentDemands: 中期澄清粘住(不被滑动窗口挤掉)", () => {
  it("extractMapSectionItems 只取指定段条目", () => {
    const map = taskMapLines({
      goal: "- [r1] 最初目标",
      recentDemands: ["- [r15] 澄清甲", "- [r18] 澄清乙"],
      next: ["- [r9] 下一步"],
    });
    expect(extractMapSectionItems(map, RECENT_DEMANDS_TITLE)).toEqual(["澄清甲", "澄清乙"]);
    expect(extractMapSectionItems(map, "不存在段")).toEqual([]);
  });

  it("上一轮地图条目与本次候选合并去重,按 max 保留最近", () => {
    const out = accumulateRecentDemands(["澄清甲", "澄清乙"], ["澄清乙", "澄清丙"], 3);
    expect(out).toEqual(["澄清甲", "澄清乙", "澄清丙"]);
  });

  it("关键:澄清被挤出候选窗口后仍粘在近期需求段", () => {
    // 第 1 轮:澄清进入地图(真实需求轨行为 `- [r15] 文本`)
    const round1 = accumulateRecentDemands([], ["- [r15] 澄清:其实要保住地图"], 3);
    expect(round1).toContain("澄清:其实要保住地图");
    // 第 2 轮:新需求涌入(候选里已无该澄清)→ 累积后仍保留
    const round2 = accumulateRecentDemands(round1, ["- [r30] 新需求A", "- [r31] 新需求B"], 3);
    expect(round2).toContain("澄清:其实要保住地图");
    expect(round2).toContain("新需求A");
    // 第 3 轮:继续涌入,超过 max 后才被更新条目挤出(淘汰最旧)
    const round3 = accumulateRecentDemands(round2, ["- [r40] 新需求C"], 3);
    expect(round3).toEqual(["新需求A", "新需求B", "新需求C"]);
  });

  it("确定性:同输入同输出(地图字节稳定,不破缓存前缀)", () => {
    const a = accumulateRecentDemands(["x", "y"], ["z"], 3);
    const b = accumulateRecentDemands(["x", "y"], ["z"], 3);
    expect(a).toEqual(b);
    // 重复项只保留一次
    expect(accumulateRecentDemands([], ["dup", "dup"], 3)).toEqual(["dup"]);
  });

  it("max<=0 时不保留任何条目", () => {
    expect(accumulateRecentDemands(["a"], ["b"], 0)).toEqual([]);
  });
});

describe("地图降噪与只读化(P0-3 补全)", () => {
  it("isToolResultLedgerLine: 识别『⤷ 工具输出行』, 放过工具调用行", async () => {
    const { isToolResultLedgerLine } = await import("../src/agent/taskMap");
    // 现场:`### 已做` 里混进 `- [rN] ⤷ exit=0 | …` 原始输出,单条顶掉整段
    expect(isToolResultLedgerLine("- [r4678] ⤷ [tool-result-trimmed] | exit=0 | …")).toBe(true);
    expect(isToolResultLedgerLine("- [r9] ⤷ exit=0 | ok")).toBe(true);
    // 工具调用行(summarizeToolUse 生成)必须保留
    expect(isToolResultLedgerLine("- [r8] Read: src/agent/taskMap.ts")).toBe(false);
    expect(isToolResultLedgerLine("- [r8] Bash: npm test")).toBe(false);
    // 需求/结论行也不能被误判
    expect(isToolResultLedgerLine("- [r1] 修复压缩")).toBe(false);
  });

  it("toReadOnlyMapLines: 标题降为历史语义, 条目正文保真", async () => {
    const { toReadOnlyMapLines } = await import("../src/agent/taskMap");
    const out = toReadOnlyMapLines([
      "## 任务地图",
      "**目标:** 完成git处理",
      "**最新要求:** 按照你的建议做",
      "### 近期需求",
      "- [r1] 压缩一下",
      "### 已做",
      "### 结果",
      "### 更早的需求",
      "### 下一步",
    ]);
    const joined = out.join("\n");
    // 行动暗示措辞全部消除
    expect(joined).not.toContain("**目标:**");
    expect(joined).not.toContain("**最新要求:**");
    expect(joined).not.toContain("### 近期需求");
    expect(joined).not.toContain("### 更早的需求");
    // 历史语义替代
    expect(joined).toContain("**历史目标:** 完成git处理");
    expect(joined).toContain("**最近一条用户消息:** 按照你的建议做");
    expect(joined).toContain("### 近期历史消息");
    expect(joined).toContain("### 更早的历史消息");
    // 条目正文(用户原话)必须逐字保真,且不得被改写
    expect(joined).toContain("- [r1] 压缩一下");
  });

  it("toReadOnlyMapLines: 空输入安全, 未知行原样透传(确定性)", async () => {
    const { toReadOnlyMapLines } = await import("../src/agent/taskMap");
    expect(toReadOnlyMapLines([])).toEqual([]);
    expect(toReadOnlyMapLines(["## 任务地图", "### 未知段", "- x"])).toEqual([
      "## 任务地图",
      "### 未知段",
      "- x",
    ]);
    // 同输入同输出(字节稳定,不破缓存前缀)
    const a = toReadOnlyMapLines(["**目标:** g"]);
    const b = toReadOnlyMapLines(["**目标:** g"]);
    expect(a).toEqual(b);
  });
});

describe("isToolResultLedgerLine (P0-4: 工具输出行识别)", () => {
  it("识别 ⤷ 输出行(含带 seq 前缀形态)", async () => {
    const { isToolResultLedgerLine: f } = await import("../src/agent/taskMap");
    expect(f("- [r464] ⤷ ERROR: path must be a non-empty string")).toBe(true);
    expect(f("- [r556] ⤷ exit=0 | src/a.ts(1,2): error TS2802")).toBe(true);
    expect(f("⤷ 裸开头也判输出行")).toBe(true);
  });

  it("放过工具调用行 / 需求行 / 结论行", () => {
    expect(isToolResultLedgerLine("- [r4678] Bash: cd /x && python3 - <<'PY'")).toBe(false);
    expect(isToolResultLedgerLine("- [r1] 修复多轮迷失目标")).toBe(false);
    expect(isToolResultLedgerLine("- [r3] 结论段")).toBe(false);
  });
});

describe("sanitizeMapLines (P0-5: 注入侧存量地图兜底过滤)", () => {
  it("剔除「已做」段内的裂行碎片与 ⤷ 输出行, 保留合法调用行", () => {
    const lines = [
      "## 任务地图",
      "**目标:** 完成git处理",
      "### 已做",
      "- import glob, json, os, coll…",
      "- [r4678] Bash: cd /home/hange/projects/DSBAgent && python3 - <<'PY'",
      "- import json, os, datetime, …",
      "- [r464] ⤷ ERROR: path must be a non-empty string",
      "- Read: src/agent/taskMap.ts",
      "### 结果",
      "- 先查看当前工作区改动详情。",
    ];
    expect(sanitizeMapLines(lines)).toEqual([
      "## 任务地图",
      "**目标:** 完成git处理",
      "### 已做",
      "- [r4678] Bash: cd /home/hange/projects/DSBAgent && python3 - <<'PY'",
      "- Read: src/agent/taskMap.ts",
      "### 结果",
      "- 先查看当前工作区改动详情。",
    ]);
  });

  it("只作用「已做」段:其它段内以中文/代码开头的条目原样保留", () => {
    const lines = [
      "### 结果",
      "- 先查看当前工作区改动详情。",
      "- import json, os",
      "### 近期需求",
      "- import 也是用户原话",
    ];
    expect(sanitizeMapLines(lines)).toEqual(lines);
  });

  it("兼容只读态标题「### 已执行的工具」", () => {
    const lines = ["### 已执行的工具", "- import x", "- Bash: npm test"];
    expect(sanitizeMapLines(lines)).toEqual(["### 已执行的工具", "- Bash: npm test"]);
  });

  it("空输入安全 + 确定性(同输入同输出)", () => {
    expect(sanitizeMapLines([])).toEqual([]);
    const a = sanitizeMapLines(["### 已做", "- import x", "- Read: a.ts"]);
    const b = sanitizeMapLines(["### 已做", "- import x", "- Read: a.ts"]);
    expect(a).toEqual(b);
  });

  // P0-6-C:结果段剔除「结构碎片」与「元叙述」——回喂会自我强化(闭环)
  it("P0-6-C: 剔除「结果」段内的结构碎片(降级标题/压平表格)", () => {
    const lines = [
      "### 结果",
      "- \\## 一句话",
      "- | 问题 | 答案 | |---|---| | 下一个任务生效？ | ❌ |",
      "- 所以你要让 70K 立刻生效,**开个新会话**即可。",
    ];
    expect(sanitizeMapLines(lines)).toEqual([
      "### 结果",
      "- 所以你要让 70K 立刻生效,**开个新会话**即可。",
    ]);
  });

  it("P0-6-C: 剔除「结果」段内的过程旁白/客套收尾(元叙述)", () => {
    const lines = [
      "### 结果",
      "- 我继续查完再答。",
      "- 需要精确核对某段行为时,我可以跑测试…要我做只读诊断也随时说。",
      "- 缓存命中率从 68% 提升到 97%(见 provider_round 统计)。",
    ];
    expect(sanitizeMapLines(lines)).toEqual([
      "### 结果",
      "- 缓存命中率从 68% 提升到 97%(见 provider_round 统计)。",
    ]);
  });

  it("P0-6-C: 兼容只读态标题「### 历史结论」,且不误伤其它段", () => {
    const lines = [
      "### 历史结论",
      "- 我继续查完再答。",
      "### 近期历史消息",
      "- 我继续查完再答。",
    ];
    // 「历史结论」段过滤元叙述;「近期历史消息」段是用户原话,必须保真
    expect(sanitizeMapLines(lines)).toEqual([
      "### 历史结论",
      "### 近期历史消息",
      "- 我继续查完再答。",
    ]);
  });

  it("P0-6-C: 实质结论(含数字/文件/结论词)不被元叙述规则误伤", () => {
    const lines = [
      "### 结果",
      "- 我把历史预算从 70K 提到 150K 会影响压缩频率。",
      "- 我需要确认 0.3.0 是否发布到 Marketplace。",
      "- 我需要的不是更高预算,而是更稳的前缀。",
    ];
    // 三条虽以「我…」开头但都是**陈述既有事实/需求**,非旁白句式 → 全部保留
    expect(sanitizeMapLines(lines)).toEqual([
      "### 结果",
      "- 我把历史预算从 70K 提到 150K 会影响压缩频率。",
      "- 我需要确认 0.3.0 是否发布到 Marketplace。",
      "- 我需要的不是更高预算,而是更稳的前缀。",
    ]);
  });

  it("P0-6-C: 未来意图旁白(我继续/我接着)仍按元叙述剔除", () => {
    const lines = ["### 结果", "- 我继续跟踪 provider_round 数据。"];
    // 「我继续跟踪 X」是对**自身后续动作**的旁白(无结论),与「我把 X 改成 Y」不同 → 剔除
    expect(sanitizeMapLines(lines)).toEqual(["### 结果"]);
  });
});
