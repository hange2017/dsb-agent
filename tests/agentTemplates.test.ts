import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseAgentMd, loadAgentTemplates } from "../src/agent/agentTemplates";

describe("parseAgentMd", () => {
  it("reads description, tools and system", () => {
    const raw = "---\ndescription: 代码审查\n---\n你是资深代码审查者。";
    const t = parseAgentMd("reviewer", raw);
    expect(t.name).toBe("reviewer");
    expect(t.description).toBe("代码审查");
    expect(t.system).toBe("你是资深代码审查者。");
  });
  it("handles CRLF line endings", () => {
    const t = parseAgentMd("reviewer", "---\r\ndescription: 审查\r\n---\r\n你是审查者。");
    expect(t.description).toBe("审查");
    expect(t.system).toBe("你是审查者。");
  });
});

describe("loadAgentTemplates", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join("/tmp", "dagt-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("loads project + user + plugin agents", () => {
    fs.mkdirSync(path.join(root, ".dsb", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "agents", "reviewer.md"), "---\ndescription: 审查\n---\n你是审查者。", "utf8");
    const pluginDir = path.join(root, "plugin1", ".agents");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "tester.md"), "---\ndescription: 测试\n---\n你是测试者。", "utf8");
    const ts = loadAgentTemplates(root, path.join(root, "home"), [path.join(root, "plugin1")]);
    const names = ts.map((t) => t.name);
    expect(names).toContain("reviewer");
    expect(names).toContain("tester");
  });
  it("is fail-open on missing dirs", () => {
    expect(loadAgentTemplates(root, path.join(root, "home"), [])).toEqual([]);
  });
  it("is fail-open when a plugin .agents is a file (ENOTDIR)", () => {
    fs.writeFileSync(path.join(root, ".agents"), "not a dir", "utf8");
    expect(loadAgentTemplates(root, path.join(root, "home"), [root])).toEqual([]);
  });
});
