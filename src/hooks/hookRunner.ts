import type { PluginContent } from "../plugins/types";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "SessionStart";

export interface HookRule {
  event: HookEvent;
  matcher: string;
  command: string;
}

function matches(matcher: string, toolName: string): boolean {
  return matcher.split("|").some((m) => {
    const t = m.trim();
    if (t === toolName) return true;
    if (t.endsWith("*") && toolName.startsWith(t.slice(0, -1))) return true;
    return false;
  });
}

export class HookRunner {
  constructor(
    private readonly rules: HookRule[],
    private readonly opts: { run: (command: string, input: unknown) => Promise<string> },
  ) {}

  addPluginHooks(content: Pick<PluginContent, "hooks">): void {
    this.rules.push(...content.hooks.map((h) => ({ event: h.event as HookEvent, matcher: h.matcher, command: h.command })));
  }

  async run(event: HookEvent, toolName: string, input: unknown): Promise<void> {
    for (const rule of this.rules) {
      if (rule.event !== event) continue;
      if (event === "PreToolUse" || event === "PostToolUse") {
        if (!matches(rule.matcher, toolName)) continue;
      }
      await this.opts.run(rule.command, { tool_name: toolName, tool_input: input });
    }
  }

  /** 当前生效的 hook 规则快照(副本),供诊断命令展示配置。 */
  all(): HookRule[] {
    return [...this.rules];
  }
}

/**
 * 触发一次 hook(executor 的 Pre/PostToolUse 与 AgentSession 的 SessionStart/Stop 共用)。
 * hooks 未注入或触发失败一律仅告警,不阻断调用方路径(fail-open)。
 */
export async function fireHook(
  hooks: HookRunner | undefined,
  event: HookEvent,
  toolName: string,
  input: unknown,
): Promise<void> {
  if (!hooks) return;
  try {
    await hooks.run(event, toolName, input);
  } catch (err) {
    // toolName 为空(SessionStart/Stop)时省略,避免 "hook SessionStart  failed" 的双空格
    const where = toolName ? ` ${toolName}` : "";
    console.warn(`hook ${event}${where} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
