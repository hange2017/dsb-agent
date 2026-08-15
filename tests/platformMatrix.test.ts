import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { platformInfo } from "../src/util/platformInfo";

// 平台矩阵冒烟:全部走真实 process.platform(不注入),在 CI 的 ubuntu/windows/macos
// 三平台 runner 上验证「平台门禁 + Bash 描述 + Bash 执行 + Grep 永远可用」的真实行为。
// 注入式门禁的详细用例见 platformGate.test.ts / tools.test.ts(B3 分组)。

let tmp: string;
let exec: ToolExecutor;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-pmx-"));
  fs.writeFileSync(path.join(tmp, "a.txt"), "alpha beta\ngamma delta\n", "utf8");
  exec = new ToolExecutor(new MemoryStore(path.join(tmp, ".mem")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const isWin = process.platform === "win32";

describe("platform matrix (real process.platform)", () => {
  it("reports platform info for the real OS", () => {
    const info = platformInfo();
    expect(info.os).toBeTruthy();
    expect(info.shell).toBeTruthy();
    expect(info.sep).toBe(isWin ? "\\" : "/");
    if (isWin) expect(info.shell).toContain("cmd");
    else expect(info.shell).toContain("bash");
  });

  it("allToolDefs exposes platform-appropriate tools on the real platform", () => {
    const names = exec.allToolDefs().map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("Grep");
    if (isWin) expect(names).toContain("PowerShell");
    else expect(names).not.toContain("PowerShell");
  });

  it("Bash tool description matches the real platform shell", () => {
    const def = exec.allToolDefs().find((t) => t.name === "Bash");
    expect(def).toBeDefined();
    if (isWin) expect(def!.description).toContain("cmd.exe");
    else expect(def!.description).toContain("/bin/bash");
  });

  it("Bash executes a trivial command on the real platform", async () => {
    const r = await exec.execute("Bash", { command: "echo platform-ok" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("platform-ok");
  });

  it("Grep always returns matches (native rg or pure-Node fallback)", async () => {
    const r = await exec.execute("Grep", { pattern: "alpha" }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("alpha");
  });

  it("Grep case-insensitive search works on the real platform", async () => {
    const r = await exec.execute(
      "Grep",
      { pattern: "GAMMA", case_insensitive: true },
      { workspaceRoot: tmp },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("gamma");
  });
});
