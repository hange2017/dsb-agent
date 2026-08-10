export type RuleMatch = "allow" | "deny" | "ask" | undefined;

function matchesPattern(toolName: string, input: Record<string, unknown>, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (pattern === `${toolName}(*)`) return true;
  if (pattern.startsWith(`${toolName}(`) && pattern.endsWith(")")) {
    const inner = pattern.slice(toolName.length + 1, -1);
    // 带尾随 * 才做前缀匹配,否则精确匹配参数 —— 避免 Bash(pwd) 放行 "pwd; rm -rf /"
    if (inner.endsWith("*")) {
      const argPrefix = inner.slice(0, -1);
      if (argPrefix === "") return true;
      return Object.values(input).some((v) => typeof v === "string" && v.startsWith(argPrefix));
    }
    return Object.values(input).some((v) => typeof v === "string" && v === inner);
  }
  return false;
}

export class PermissionRules {
  constructor(
    private readonly allow: string[] = [],
    private readonly deny: string[] = [],
    private readonly ask: string[] = [],
  ) {}

  match(toolName: string, input: Record<string, unknown>): RuleMatch {
    if (this.deny.some((p) => matchesPattern(toolName, input, p))) return "deny";
    if (this.ask.some((p) => matchesPattern(toolName, input, p))) return "ask";
    if (this.allow.some((p) => matchesPattern(toolName, input, p))) return "allow";
    return undefined;
  }

  static parseSettings(s: Record<string, unknown>): PermissionRules {
    const p = (s.permissions ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return new PermissionRules(arr(p.allow), arr(p.deny), arr(p.ask));
  }
}
