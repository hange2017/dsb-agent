import { PermissionRules, type RuleMatch } from "./permissionRules";

export type PermissionDecision =
  | { decision: "allow"; autoAllow: boolean }
  | { decision: "deny"; reason: string }
  | { decision: "ask" };

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface PermissionGateway {
  request(toolName: string, detail: string): Promise<boolean>;
}

const EDIT_TOOLS = new Set(["Write", "StrReplace", "Delete"]);

export class PermissionManager {
  private readonly onceApproved = new Set<string>();
  private mode: PermissionMode;

  constructor(
    private readonly opts: {
      gateway: PermissionGateway;
      rules: PermissionRules;
      sessionMode?: PermissionMode;
    },
  ) {
    this.mode = opts.sessionMode ?? "default";
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  approveOnce(toolName: string): void {
    this.onceApproved.add(toolName);
  }

  async check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (this.mode === "bypassPermissions") return { decision: "allow", autoAllow: true };
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { decision: "allow", autoAllow: true };
    if (this.onceApproved.has(toolName)) return { decision: "allow", autoAllow: true };

    const rule = this.opts.rules.match(toolName, input);
    if (rule === "deny") return { decision: "deny", reason: `Denied by project rule: ${toolName}` };
    if (rule === "allow") return { decision: "allow", autoAllow: true };
    if (rule === "ask") return (await this.askUser(toolName, input)) ? { decision: "allow", autoAllow: false } : { decision: "deny", reason: "User rejected" };

    // 无规则命中:一律询问(编辑类也不再默认放行;acceptEdits / bypass 见上)
    return (await this.askUser(toolName, input)) ? { decision: "allow", autoAllow: false } : { decision: "deny", reason: "User rejected" };
  }

  private async askUser(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    const summary = summarizeInput(input);
    const detail = summary ? `${toolName}: ${summary}` : `${toolName}: (no args)`;
    return this.opts.gateway.request(toolName, detail);
  }
}

/** 把工具入参压成一行短摘要,作为权限询问的 detail 展示给用户。 */
export function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    const s = raw && raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    if (s) parts.push(`${k}=${s}`);
  }
  return parts.slice(0, 2).join("; ");
}
