import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  activeSettingsRoot,
  firstExistingDir,
  firstExistingFile,
  projectInstructionCandidates,
  projectRulesDirCandidates,
  projectSkillDirCandidates,
  userRulesDirCandidates,
  userSkillDirCandidates,
} from "../src/projectContext/convention";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dconv-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("convention", () => {
  it("prefers .dsb root when it exists", () => {
    fs.mkdirSync(path.join(root, ".dsb"));
    fs.mkdirSync(path.join(root, ".cxxxp"));
    fs.mkdirSync(path.join(root, ".deepseek"));
    fs.mkdirSync(path.join(root, ".claude"));
    expect(activeSettingsRoot(root)).toBe(".dsb");
  });
  it("falls back to .cxxxp then .deepseek then .claude", () => {
    fs.mkdirSync(path.join(root, ".cxxxp"));
    expect(activeSettingsRoot(root)).toBe(".cxxxp");
    fs.rmSync(path.join(root, ".cxxxp"), { recursive: true });
    fs.mkdirSync(path.join(root, ".deepseek"));
    expect(activeSettingsRoot(root)).toBe(".deepseek");
    fs.rmSync(path.join(root, ".deepseek"), { recursive: true });
    fs.mkdirSync(path.join(root, ".claude"));
    expect(activeSettingsRoot(root)).toBe(".claude");
  });
  it("returns .dsb default when neither root exists", () => {
    expect(activeSettingsRoot(root)).toBe(".dsb");
  });
  it("orders instruction candidates dsb then legacy then claude", () => {
    const c = projectInstructionCandidates(root);
    expect(c[0]).toBe(path.join(root, "DSB.md"));
    expect(c[1]).toBe(path.join(root, ".dsb", "DSB.md"));
    expect(c[2]).toBe(path.join(root, "CXXXP.md"));
    expect(c[3]).toBe(path.join(root, ".cxxxp", "CXXXP.md"));
    expect(c[4]).toBe(path.join(root, "DEEPSEEK.md"));
    expect(c[5]).toBe(path.join(root, ".deepseek", "DEEPSEEK.md"));
    expect(c[6]).toBe(path.join(root, "CLAUDE.md"));
    expect(c[7]).toBe(path.join(root, ".claude", "CLAUDE.md"));
  });
  it("skill dir candidates are dsb-first", () => {
    expect(projectSkillDirCandidates(root)[0]).toBe(path.join(root, ".dsb", "skills"));
    expect(projectSkillDirCandidates(root)[1]).toBe(path.join(root, ".cxxxp", "skills"));
    expect(userSkillDirCandidates()[0]).toBe(path.join(os.homedir(), ".dsb", "skills"));
  });
  it("rules dir candidates are dsb-first", () => {
    expect(projectRulesDirCandidates(root)[0]).toBe(path.join(root, ".dsb", "rules"));
    expect(projectRulesDirCandidates(root)[3]).toBe(path.join(root, ".claude", "rules"));
    expect(userRulesDirCandidates()[0]).toBe(path.join(os.homedir(), ".dsb", "rules"));
  });
  it("firstExistingFile returns the first existing path", () => {
    fs.mkdirSync(path.join(root, ".dsb"), { recursive: true });
    fs.writeFileSync(path.join(root, ".dsb", "settings.json"), "{}", "utf8");
    const candidates = [path.join(root, ".dsb", "settings.json"), path.join(root, ".claude", "settings.json")];
    expect(firstExistingFile(candidates)).toBe(path.join(root, ".dsb", "settings.json"));
  });
  it("firstExistingFile returns undefined when none exist", () => {
    expect(firstExistingFile([path.join(root, "nope.md")])).toBeUndefined();
  });
  it("firstExistingFile skips a directory with a file-like name", () => {
    fs.mkdirSync(path.join(root, "DSB.md"), { recursive: true });
    expect(firstExistingFile([path.join(root, "DSB.md")])).toBeUndefined();
  });
  it("firstExistingDir returns the first existing dir", () => {
    fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    expect(firstExistingDir(projectSkillDirCandidates(root))).toBe(path.join(root, ".claude", "skills"));
  });
  it("firstExistingDir returns undefined when none exist", () => {
    expect(firstExistingDir(projectSkillDirCandidates(root))).toBeUndefined();
  });
});
