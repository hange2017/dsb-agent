import * as fs from "fs";
import * as path from "path";
import type { SkillInfo } from "../projectContext/skillsScan";
import { renderSkillSummary, summarizeSkillDescription } from "./skillDescription";

/**
 * 技能索引:把 4 层(项目/用户/VSCode 扩展/插件)扫描出的技能合并去重。
 * 纯 TS,无 vscode 依赖;扩展/插件层由 chatViewProvider 注入扫描结果。
 *
 * 去重规则:按 name 合并(不区分路径),冲突时保留高优先级层:
 * project(4) > user(3) > extension(2) > plugin(1)。同名不同路径(如项目
 * scaffold seed 的技能与扩展内置同款)只保留一层,避免 system prompt 技能
 * 列表重复注入;同时允许用户在项目/用户层有意覆盖扩展版。
 */
const SOURCE_PRIORITY: Record<SkillInfo["source"], number> = {
  project: 4,
  user: 3,
  extension: 2,
  plugin: 1,
};

/** 紧凑描述上限(字符),超出截断并加 `…`。 */
const COMPACT_DESC_MAX = 40;

/** 分层:tier=full 注入完整描述;tier=compact 注入 ≤40 字。 */
function tierFor(s: SkillInfo): "full" | "compact" {
  // 用户/项目自定义技能:尊重内容,不折叠
  if (s.source === "project" || s.source === "user") return "full";
  // 流程包(sp-* 前缀)与技能使用指南(using-* 前缀):流程纪律,不折叠
  if (s.name.startsWith("sp-") || s.name.startsWith("using-")) return "full";
  return "compact";
}

export class SkillIndex {
  private skills: SkillInfo[] = [];

  /** 按 name 去重后追加一个技能;同名冲突保留高优先级 source。 */
  add(info: SkillInfo): void {
    const i = this.skills.findIndex((s) => s.name === info.name);
    if (i < 0) {
      this.skills.push(info);
      return;
    }
    if (SOURCE_PRIORITY[info.source] > SOURCE_PRIORITY[this.skills[i].source]) {
      this.skills[i] = info;
    }
  }

  all(): SkillInfo[] {
    return [...this.skills];
  }

  /**
   * 供系统提示词渲染 `## 可用技能` 清单。分层:
   * - compact tier(扩展/插件层的非流程包技能):折叠为一行 ≤40 字,节省每轮固定注入 token;
   * - full tier(项目/用户自定义与 sp-*、using-* 流程包):优先标签化压缩
   *   (作用句 + `#触发标签`,如 "Guides stable API design. #designing-apis #module-boundaries"),
   *   同一预算内覆盖更多"何时该用"的触发条件;无 Use when/before 结构时回退原样,
   *   由渲染层 120 字符兜底截断。完整正文仍由 Skill 工具按需加载。
   */
  listForPrompt(): Array<{ name: string; description: string; compact: boolean }> {
    return this.skills.map((s) => {
      if (tierFor(s) === "compact") {
        return {
          name: s.name,
          description: `${s.description.replace(/\s+/g, " ").trim().slice(0, COMPACT_DESC_MAX)}…`,
          compact: true,
        };
      }
      const summarized = summarizeSkillDescription(s.description);
      if (summarized) {
        return { name: s.name, description: renderSkillSummary(summarized), compact: true };
      }
      return { name: s.name, description: s.description, compact: false };
    });
  }

  /** 读取指定技能 SKILL.md 全文;未找到或文件缺失返回 undefined。 */
  loadSkill(name: string): string | undefined {
    const info = this.skills.find((s) => s.name === name);
    if (!info) return undefined;
    const file = path.join(info.path, "SKILL.md");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  }

  /** 调用技能:读取 SKILL.md 全文并拼上"按以下技能执行:"指令,供注入本次 user 消息。 */
  async invokeSkill(name: string): Promise<{ ok: boolean; content: string }> {
    const text = this.loadSkill(name);
    if (text === undefined) return { ok: false, content: `未找到技能: ${name}` };
    return { ok: true, content: `按以下技能执行:\n\n${text}` };
  }
}
