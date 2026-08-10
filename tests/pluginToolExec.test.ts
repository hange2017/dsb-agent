import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import type { PluginToolSpec } from "../src/plugins/types";

describe("plugin tool execution", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptexec-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function spec(over: Partial<PluginToolSpec> = {}): PluginToolSpec {
    return {
      pluginName: "demo",
      pluginDir: tmp,
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
      commandPath: path.join(tmp, "echo.sh"),
      ...over,
    };
  }

  it("includes plugin tools in allToolDefs after register", () => {
    const exec = new ToolExecutor(new MemoryStore(path.join(tmp, ".m")));
    exec.registerPluginTools([spec()]);
    const names = exec.allToolDefs().map((t) => t.name);
    expect(names).toContain("plugin__demo__echo");
  });

  it("runs plugin tool via injected runner and returns stdout", async () => {
    const exec = new ToolExecutor(
      new MemoryStore(path.join(tmp, ".m")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (_cmd, _dir, input) => ({
        exit: 0,
        stdout: `got:${String((input as { message?: string }).message ?? "")}`,
        stderr: "",
      }),
    );
    exec.registerPluginTools([spec()]);
    const r = await exec.execute(
      "plugin__demo__echo",
      { message: "hi" },
      { workspaceRoot: tmp },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("got:hi");
  });

  it("returns error on non-zero exit", async () => {
    const exec = new ToolExecutor(
      new MemoryStore(path.join(tmp, ".m")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({ exit: 2, stdout: "", stderr: "boom" }),
    );
    exec.registerPluginTools([spec()]);
    const r = await exec.execute("plugin__demo__echo", {}, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("boom");
  });
});
