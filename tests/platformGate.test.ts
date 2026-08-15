import { describe, it, expect } from "vitest";
import { filterToolDefs } from "../src/agent/tools/platformGate";
import type { ToolDef } from "../src/agent/tools/types";

function def(name: string, platforms?: NodeJS.Platform[]): ToolDef {
  return { name, description: name, input_schema: {}, ...(platforms ? { platforms } : {}) };
}

describe("filterToolDefs", () => {
  it("passes through tools without platforms", () => {
    const defs = [def("a"), def("b")];
    expect(filterToolDefs(defs, "win32").map((d) => d.name)).toEqual(["a", "b"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("keeps only matching platform when declared", () => {
    const defs = [def("win-only", ["win32"]), def("all")];
    const win = filterToolDefs(defs, "win32").map((d) => d.name);
    expect(win).toContain("win-only");
    expect(win).toContain("all");
    const linux = filterToolDefs(defs, "linux").map((d) => d.name);
    expect(linux).not.toContain("win-only");
    expect(linux).toContain("all");
  });

  it("empty platforms array means all platforms", () => {
    const defs = [def("e", [])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["e"]);
  });

  it("multi-platform list keeps any match", () => {
    const defs = [def("uni", ["win32", "darwin"])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["uni"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual([]);
  });
});
