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
