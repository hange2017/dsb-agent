import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  configureRipgrepPath,
  getConfiguredRipgrepPath,
  pickRipgrepPath,
  resolveRipgrepCandidates,
} from "../src/util/ripgrepPath";

describe("resolveRipgrepCandidates", () => {
  it("lists dist, extension platform package, then appRoot paths", () => {
    const candidates = resolveRipgrepCandidates({
      extensionPath: "/ext",
      appRoot: "/app",
      distDir: "/ext/dist",
      platform: "linux",
      arch: "x64",
    });
    expect(candidates[0]).toBe(path.join("/ext/dist", "bin", "rg"));
    expect(candidates[1]).toBe(path.join("/ext/dist", "bin", "linux-x64-rg.linux"));
    expect(candidates).toContain(
      path.join("/ext", "node_modules", "@vscode/ripgrep-linux-x64", "bin", "rg"),
    );
    expect(candidates).toContain(
      path.join("/app", "node_modules", "@vscode", "ripgrep", "bin", "rg"),
    );
    expect(candidates).toContain(
      path.join("/app", "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", "rg"),
    );
  });

  it("uses rg.exe on win32", () => {
    const candidates = resolveRipgrepCandidates({
      extensionPath: "/ext",
      platform: "win32",
      arch: "x64",
    });
    expect(candidates.some((c) => c.endsWith(`${path.sep}rg.exe`))).toBe(true);
  });

  it("lists multi-platform dist bins (esbuild copies all installed platforms)", () => {
    const win = resolveRipgrepCandidates({
      extensionPath: "/ext",
      distDir: "/ext/dist",
      platform: "win32",
      arch: "x64",
    });
    expect(win).toContain(path.join("/ext/dist", "bin", "rg.exe"));
    const linux = resolveRipgrepCandidates({
      extensionPath: "/ext",
      distDir: "/ext/dist",
      platform: "linux",
      arch: "x64",
    });
    expect(linux).toContain(path.join("/ext/dist", "bin", "linux-x64-rg.linux"));
    const darwin = resolveRipgrepCandidates({
      extensionPath: "/ext",
      distDir: "/ext/dist",
      platform: "darwin",
      arch: "arm64",
    });
    expect(darwin).toContain(path.join("/ext/dist", "bin", "darwin-arm64-rg.darwin"));
  });
});

describe("pickRipgrepPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rgpick-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    configureRipgrepPath(undefined);
  });

  it("returns first existing candidate", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const rg = path.join(bin, "rg");
    fs.writeFileSync(rg, "");
    const picked = pickRipgrepPath({
      extensionPath: "/missing",
      distDir: dir,
      platform: "linux",
      arch: "x64",
    });
    expect(picked).toBe(rg);
  });

  it("returns undefined when none exist", () => {
    expect(
      pickRipgrepPath({
        extensionPath: path.join(dir, "nope"),
        platform: "linux",
        arch: "x64",
      }),
    ).toBeUndefined();
  });
});

describe("configureRipgrepPath", () => {
  afterEach(() => configureRipgrepPath(undefined));

  it("stores absolute path only", () => {
    configureRipgrepPath("/abs/rg");
    expect(getConfiguredRipgrepPath()).toBe("/abs/rg");
    configureRipgrepPath("rg");
    expect(getConfiguredRipgrepPath()).toBeUndefined();
  });
});
