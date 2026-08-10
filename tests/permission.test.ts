import { describe, it, expect, vi } from "vitest";
import { PermissionManager, type PermissionGateway } from "../src/agent/permission";
import { PermissionRules } from "../src/agent/permissionRules";

function makeGateway(decide: (tool: string) => boolean = () => true): PermissionGateway {
  return { request: vi.fn(async (tool: string) => decide(tool)) };
}

describe("PermissionManager", () => {
  it("deny rules win", async () => {
    const rules = new PermissionRules([], ["Bash(rm *)"], []);
    const pm = new PermissionManager({ gateway: makeGateway(), rules });
    const d = await pm.check("Bash", { command: "rm -rf /" });
    expect(d.decision).toBe("deny");
  });
  it("allow rule passes without asking", async () => {
    const rules = new PermissionRules(["Bash(git *)"], [], []);
    const pm = new PermissionManager({ gateway: makeGateway(), rules });
    const d = await pm.check("Bash", { command: "git status" });
    expect(d.decision).toBe("allow");
    if (d.decision !== "allow") throw new Error("expected allow"); // TS 收窄
    expect(d.autoAllow).toBe(true);
  });
  it("unlisted tool asks via gateway", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(() => true), rules: new PermissionRules() });
    const d = await pm.check("WebFetch", { url: "https://x" });
    expect(d.decision).toBe("allow");
    if (d.decision !== "allow") throw new Error("expected allow"); // TS 收窄
    expect(d.autoAllow).toBe(false);
  });
  it("ask denied returns deny", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(() => false), rules: new PermissionRules() });
    const d = await pm.check("WebFetch", { url: "https://x" });
    expect(d.decision).toBe("deny");
  });
  it("bypass mode allows everything", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(), rules: new PermissionRules([], ["Bash(*)"]), sessionMode: "bypassPermissions" });
    const d = await pm.check("Bash", { command: "rm -rf /" });
    expect(d.decision).toBe("allow");
  });
  it("approveOnce allows a tool for the session", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(), rules: new PermissionRules() });
    pm.approveOnce("Bash");
    const d = await pm.check("Bash", { command: "anything" });
    expect(d.decision).toBe("allow");
  });
  it("acceptEdits mode auto-allows edit tools but still asks for others", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(() => true), rules: new PermissionRules(), sessionMode: "acceptEdits" });
    const w = await pm.check("Write", { path: "a.ts" });
    expect(w.decision).toBe("allow");
    // 类型收窄:expect(...).toBe 不构成断言收窄,去掉这行 tsc 会在 .autoAllow 报错
    if (w.decision !== "allow") throw new Error("expected allow");
    expect(w.autoAllow).toBe(true);
    const r = await pm.check("Read", { path: "a.ts" });
    expect(r.decision).toBe("allow");
    // 类型收窄:expect(...).toBe 不构成断言收窄,去掉这行 tsc 会在 .autoAllow 报错
    if (r.decision !== "allow") throw new Error("expected allow");
    expect(r.autoAllow).toBe(false); // Read 走 gateway 询问
  });

  it("bypassPermissions overrides acceptEdits and project deny", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(), rules: new PermissionRules([], ["Bash(*)"]), sessionMode: "acceptEdits" });
    pm.setMode("bypassPermissions");
    const d = await pm.check("Bash", { command: "rm -rf /" });
    expect(d.decision).toBe("allow");
  });

  it("onceApproved overrides project deny", async () => {
    const pm = new PermissionManager({ gateway: makeGateway(), rules: new PermissionRules([], ["Bash(*)"]), sessionMode: "default" });
    pm.approveOnce("Bash");
    const d = await pm.check("Bash", { command: "rm -rf /" });
    expect(d.decision).toBe("allow");
  });
});

describe("PermissionRules arg-prefix matching", () => {
  it("allow Tool(prefix *) only matches argument prefix, not mid-string (sudo npm bypass)", () => {
    const rules = new PermissionRules(["Bash(npm *)"], [], []);
    expect(rules.match("Bash", { command: "sudo npm install" })).toBeUndefined();
  });
  it("deny Tool(prefix *) does not over-block similar words (npm rm foo)", () => {
    const rules = new PermissionRules([], ["Bash(rm *)"], []);
    expect(rules.match("Bash", { command: "npm rm foo" })).toBeUndefined();
  });
  it("no trailing * means EXACT match (Bash(pwd) must not allow pwd; rm -rf /)", () => {
    const rules = new PermissionRules(["Bash(pwd)"], [], []);
    expect(rules.match("Bash", { command: "pwd" })).toBe("allow");
    expect(rules.match("Bash", { command: "pwd; rm -rf /" })).toBeUndefined();
  });
  it("Tool(*) still matches any argument", () => {
    const rules = new PermissionRules(["Bash(*)"], [], []);
    expect(rules.match("Bash", { command: "anything" })).toBe("allow");
  });
});

describe("PermissionManager default unmatched edits", () => {
  it("default mode asks for unmatched edit tools (no auto-allow)", async () => {
    const gateway = makeGateway(() => true);
    const pm = new PermissionManager({ gateway, rules: new PermissionRules(), sessionMode: "default" });
    const d = await pm.check("Write", { path: "a.ts", contents: "x" });
    expect(d.decision).toBe("allow");
    if (d.decision !== "allow") throw new Error("expected allow");
    expect(d.autoAllow).toBe(false);
    expect(gateway.request).toHaveBeenCalled();
  });
});

describe("PermissionManager askUser detail", () => {
  it("passes a short input summary as gateway detail", async () => {
    let detail: string | undefined;
    const gateway: PermissionGateway = { request: async (_tool, d) => { detail = d; return true; } };
    const pm = new PermissionManager({ gateway, rules: new PermissionRules() });
    await pm.check("Bash", { command: "git status" });
    expect(detail).toContain("command=git status");
    expect(detail).toMatch(/^Bash/);
  });

  it("ask detail always includes tool name even when input is empty", async () => {
    let detail: string | undefined;
    const gateway: PermissionGateway = { request: async (_tool, d) => { detail = d; return true; } };
    const pm = new PermissionManager({ gateway, rules: new PermissionRules() });
    await pm.check("Bash", {});
    expect(detail).toMatch(/^Bash/);
  });
});
