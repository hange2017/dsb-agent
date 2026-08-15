import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildPluginToolDef,
  parsePluginToolsFromManifest,
  pluginToolQualifiedName,
  resolvePluginCommandPath,
  sanitizePluginId,
} from "../src/plugins/pluginTools";
import { filterToolDefs } from "../src/agent/tools/platformGate";
import { scanPluginContent } from "../src/plugins/manifest";

describe("pluginTools helpers", () => {
  it("builds qualified names with sanitize", () => {
    expect(pluginToolQualifiedName("my plugin", "echo args")).toBe("plugin__my_plugin__echo_args");
    expect(sanitizePluginId("")).toBe("unnamed");
  });

  it("rejects command path escape", () => {
    const dir = "/tmp/plug";
    expect(resolvePluginCommandPath(dir, "../outside.sh")).toBeUndefined();
    expect(resolvePluginCommandPath(dir, "/etc/passwd")).toBeUndefined();
    expect(resolvePluginCommandPath(dir, "bin/ok.sh")).toBe(path.resolve(dir, "bin/ok.sh"));
  });

  it("parses tools and skips bad entries", () => {
    const dir = "/proj/plug";
    const tools = parsePluginToolsFromManifest(dir, "demo", [
      {
        name: "echo",
        description: "Echo",
        input_schema: { type: "object", properties: { m: { type: "string" } } },
        command: "bin/echo.sh",
      },
      { name: "bad" },
      {
        name: "escape",
        description: "x",
        input_schema: { type: "object" },
        command: "../evil.sh",
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].commandPath).toBe(path.resolve(dir, "bin/echo.sh"));
    const def = buildPluginToolDef(tools[0]);
    expect(def.name).toBe("plugin__demo__echo");
    expect(def.description).toContain("[plugin:demo]");
  });
});

describe("scanPluginContent tools", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ptools-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("loads tools from plugin.json", () => {
    fs.writeFileSync(
      path.join(root, "plugin.json"),
      JSON.stringify({
        name: "p",
        description: "d",
        version: "1.0.0",
        tools: [
          {
            name: "hi",
            description: "say hi",
            input_schema: { type: "object", properties: {} },
            command: "scripts/hi.sh",
          },
        ],
      }),
    );
    const c = scanPluginContent(root);
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].pluginName).toBe("p");
    expect(c.tools[0].commandPath).toBe(path.join(root, "scripts/hi.sh"));
  });

  it("returns empty tools when no tools field", () => {
    fs.writeFileSync(
      path.join(root, "plugin.json"),
      JSON.stringify({ name: "p", description: "d", version: "1.0.0" }),
    );
    expect(scanPluginContent(root).tools).toEqual([]);
  });
});

describe("plugin tools platform gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsa-plg-"));
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "t.cmd"), "@echo off", "utf8");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses optional platforms and filters invalid entries", () => {
    const specs = parsePluginToolsFromManifest(dir, "demo", [
      { name: "all", description: "d", command: "bin/t.cmd", input_schema: { type: "object" } },
      { name: "win", description: "d", command: "bin/t.cmd", input_schema: { type: "object" }, platforms: ["win32"] },
      { name: "lin", description: "d", command: "bin/t.cmd", input_schema: { type: "object" }, platforms: ["linux"] },
      { name: "bad", description: "d", command: "bin/t.cmd", input_schema: { type: "object" }, platforms: ["win32", "nonsense"] },
    ]);
    expect(specs).toHaveLength(4);
    expect(specs[0].platforms).toBeUndefined();
    expect(specs[1].platforms).toEqual(["win32"]);
    expect(specs[2].platforms).toEqual(["linux"]);
    expect(specs[3].platforms).toEqual(["win32"]);
  });

  it("buildPluginToolDef passes platforms through", () => {
    const def = buildPluginToolDef({
      pluginName: "demo",
      pluginDir: dir,
      name: "win",
      description: "d",
      inputSchema: {},
      commandPath: path.join(dir, "bin", "t.cmd"),
      platforms: ["win32"],
    });
    expect(def.platforms).toEqual(["win32"]);
    expect(def.name).toBe("plugin__demo__win");
  });

  it("filterToolDefs hides plugin tools excluded from the platform", () => {
    const specs = parsePluginToolsFromManifest(dir, "demo", [
      { name: "all", description: "d", command: "bin/t.cmd", input_schema: { type: "object" } },
      { name: "win", description: "d", command: "bin/t.cmd", input_schema: { type: "object" }, platforms: ["win32"] },
    ]);
    const defs = specs.map(buildPluginToolDef);
    expect(filterToolDefs(defs, "win32").map((d) => d.name)).toEqual(["plugin__demo__all", "plugin__demo__win"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual(["plugin__demo__all"]);
  });
});
