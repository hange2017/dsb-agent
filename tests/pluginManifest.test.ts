import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parsePluginManifest, parseMarketplaceManifest, scanPluginContent } from "../src/plugins/manifest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dplug-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("plugin manifest", () => {
  it("parses plugin.json", () => {
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "p", description: "d", version: "1.0.0", author: { name: "a" } }));
    const m = parsePluginManifest(root);
    expect(m.name).toBe("p");
    expect(m.version).toBe("1.0.0");
  });
  it("throws on missing fields", () => {
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "p", description: "d" }));
    expect(() => parsePluginManifest(root)).toThrow(/version/);
  });
  it("parses marketplace.json with plugin refs", () => {
    fs.writeFileSync(path.join(root, "marketplace.json"), JSON.stringify({
      name: "mk",
      plugins: [{ name: "a", description: "d", source: "./a" }, { name: "b", description: "d", source: "github.com/x" }],
    }));
    const m = parseMarketplaceManifest(path.join(root, "marketplace.json"));
    expect(m.plugins).toHaveLength(2);
    expect(m.plugins[0].source).toBe("./a");
  });
  it("scans plugin content", () => {
    fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "---\ndescription: x\n---");
    fs.mkdirSync(path.join(root, "commands"));
    fs.writeFileSync(path.join(root, "commands", "fix.md"), "# fix");
    fs.mkdirSync(path.join(root, "hooks"));
    fs.writeFileSync(path.join(root, "hooks", "posttooluse_Write.sh"), "#!/bin/bash\necho hi");
    const c = scanPluginContent(root);
    expect(c.skills).toEqual(["skills/demo/SKILL.md"]);
    expect(c.commands).toEqual(["fix.md"]);
    expect(c.hooks[0].event).toBe("PostToolUse");
    expect(c.hooks[0].matcher).toBe("Write");
    expect(c.tools).toEqual([]);
  });
});
