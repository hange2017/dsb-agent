import type { RuleEntry } from "../projectContext/rulesReader";

export interface SystemPromptInput {
  workspaceRoot: string;
  projectInstruction?: string;
  skillList?: Array<{ name: string; description: string; compact?: boolean }>;
  memoryIndex?: string;
  /** 规则目录(.dsb/rules/ 等)内容,注入「项目规则」段。 */
  rules?: RuleEntry[];
  /** UI 语言:模型回复跟随该语言。 */
  locale?: "zh" | "en";
  /** 记忆整理提示(SessionStart 检查 dreamDue 后注入,可缺省)。 */
  dreamHint?: string;
  /** 项目框架文档(.dsb/docs/project-overview.md);首次进入项目自动生成。注入时截断,完整内容按需 Read。 */
  projectOverview?: string;
}
export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts = [
    "You are a coding agent running inside a VS Code extension with real local tools.",
    "You MUST use tools to inspect and modify files. Never claim you cannot access the filesystem.",
    `Workspace root: ${input.workspaceRoot}`,
    "Prefer StrReplace for edits. Use Bash to build/test. Verify your work with evidence.",
    input.locale === "zh" ? "Reply in Chinese (中文)." : "Reply in English.",
    [
      "## 工作区约定目录 (.dsb)",
      "项目约定根目录为 `.dsb/`。常用内容:",
      "- 项目指令 → `.dsb/DSB.md`（或仓库根 `DSB.md`）",
      "- 规则 → `.dsb/rules/`；技能 → `.dsb/skills/`",
      "- 斜杠命令 → `.dsb/commands/`；子代理模板 → `.dsb/agents/`",
      "- 实现计划 → `.dsb/plans/`；设计说明 → `.dsb/specs/`；其它文档 → `.dsb/docs/`",
    ].join("\n"),
  ];
  if (input.projectInstruction) parts.push("## 项目指令\n" + input.projectInstruction.trim());
  if (input.skillList?.length) {
    const lines = input.skillList.map((s) => {
      const compact = s.compact ?? false;
      const desc = s.description.replace(/\s+/g, " ").trim();
      if (compact) {
        // 工程包等紧凑技能:短描述已由 SkillIndex 截断,直接呈现
        return `- ${s.name}: ${desc}`;
      }
      const short = desc.length > 120 ? `${desc.slice(0, 117)}...` : desc;
      return `- ${s.name}: ${short}`;
    });
    parts.push(
      "## 可用技能\n" +
        lines.join("\n") +
        "\n(需要完整流程时用 Skill 工具加载对应技能正文;打包技能见 `sp-*` 流程包与 `as-*` 工程包)",
    );
  }
  if (input.rules?.length) {
    const lines = input.rules.map((r) => {
      const label = r.source === "user" ? "用户规则" : "项目规则";
      return `> ${label} ${r.name}\n${r.content.trim()}`;
    });
    parts.push("## 项目规则\n" + lines.join("\n\n"));
  }
  if (input.memoryIndex) {
    parts.push(`## 持久记忆\n${input.memoryIndex}\n(用 MemoryRead 读全文;记忆可能过时,以当前上下文为准)`);
  }
  if (input.projectOverview) {
    // 框架信息:注入摘要,完整文档在 .dsb/docs/project-overview.md,需要时用 Read 读取
    const kMaxOverviewChars = 1500;
    const clipped =
      input.projectOverview.length > kMaxOverviewChars
        ? `${input.projectOverview.slice(0, kMaxOverviewChars)}…`
        : input.projectOverview;
    parts.push(
      `## 项目框架\n${clipped}\n(完整内容见 \`.dsb/docs/project-overview.md\`;模块职责可在工作时补充进该文档)`,
    );
  }
  if (input.dreamHint) {
    parts.push(`## 记忆整理提示\n${input.dreamHint}`);
  }
  return parts.join("\n\n");
}
