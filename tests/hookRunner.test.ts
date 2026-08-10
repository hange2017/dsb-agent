import { describe, it, expect, vi } from "vitest";
import { HookRunner } from "../src/hooks/hookRunner";
import { parseSettingsHooks } from "../src/projectContext/settingsReader";

describe("HookRunner", () => {
  it("runs matching PreToolUse hooks", async () => {
    const run = vi.fn(async () => "");
    const hr = new HookRunner([{ event: "PreToolUse", matcher: "Write", command: "log" }], { run });
    await hr.run("PreToolUse", "Write", { path: "a" });
    expect(run).toHaveBeenCalledWith("log", expect.objectContaining({ tool_name: "Write" }));
  });
  it("skips non-matching tools", async () => {
    const run = vi.fn(async () => "");
    const hr = new HookRunner([{ event: "PreToolUse", matcher: "Write", command: "log" }], { run });
    await hr.run("PreToolUse", "Bash", { command: "x" });
    expect(run).not.toHaveBeenCalled();
  });
  it("matches glob-style matchers", async () => {
    const run = vi.fn(async () => "");
    const hr = new HookRunner([{ event: "PostToolUse", matcher: "Bash|Write", command: "log" }], { run });
    await hr.run("PostToolUse", "Write", {});
    expect(run).toHaveBeenCalled();
  });
  it("matches *-suffix prefix matchers", async () => {
    const run = vi.fn(async () => "");
    const hr = new HookRunner([{ event: "PreToolUse", matcher: "Web*", command: "log" }], { run });
    await hr.run("PreToolUse", "WebFetch", {});
    await hr.run("PreToolUse", "WebSearch", {});
    await hr.run("PreToolUse", "Write", {}); // 不以 Web 开头,不匹配
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs Stop/SessionStart hooks without a matcher filter", async () => {
    const run = vi.fn(async (_c: string, _i: unknown) => "");
    const hr = new HookRunner(
      [
        { event: "SessionStart", matcher: "*", command: "s" },
        { event: "Stop", matcher: "", command: "t" },
      ],
      { run },
    );
    await hr.run("SessionStart", "ignored", {});
    await hr.run("Stop", "ignored", {});
    expect(run.mock.calls.map((c) => c[0])).toEqual(["s", "t"]);
  });

  it("adds plugin hooks via addPluginHooks", async () => {
    const run = vi.fn(async () => "");
    const hr = new HookRunner([], { run });
    hr.addPluginHooks({ hooks: [{ event: "PreToolUse", matcher: "Grep", command: "p" }] });
    await hr.run("PreToolUse", "Grep", {});
    await hr.run("PreToolUse", "Write", {});
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("p", expect.objectContaining({ tool_name: "Grep" }));
  });

  it("all() returns a snapshot of the rules", () => {
    const hr = new HookRunner([{ event: "Stop", matcher: "", command: "x" }], { run: async () => "" });
    expect(hr.all()).toEqual([{ event: "Stop", matcher: "", command: "x" }]);
  });
});

describe("parseSettingsHooks", () => {
  it("parses command-type settings hooks; matcher defaults to *", () => {
    const hooks = {
      PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo pre" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }],
    };
    expect(parseSettingsHooks(hooks)).toEqual([
      { event: "PreToolUse", matcher: "Write", command: "echo pre" },
      { event: "Stop", matcher: "*", command: "echo bye" },
    ]);
  });

  it("skips malformed / non-command entries and unknown events", () => {
    const hooks = {
      Nope: [{ hooks: [{ type: "command", command: "x" }] }],
      PreToolUse: "not-an-array",
      Stop: [
        null,
        { hooks: [{ type: "stdout", command: "y" }] },
        { hooks: "bad" },
        { hooks: [{ type: "command" }] },
        { hooks: [{ type: "command", command: "" }] },
      ],
    };
    expect(parseSettingsHooks(hooks)).toEqual([]);
  });

  it("returns [] for non-object input", () => {
    expect(parseSettingsHooks(undefined)).toEqual([]);
    expect(parseSettingsHooks("hooks")).toEqual([]);
    expect(parseSettingsHooks([])).toEqual([]);
  });
});
