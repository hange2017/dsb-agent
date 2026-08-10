import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureProjectOverview,
  hasProjectFrameworkDocs,
  readProjectOverview,
  buildProjectOverview,
} from "../src/projectContext/projectOverview";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pov-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeProject(): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "demo-app",
      version: "1.0.0",
      main: "src/index.ts",
      scripts: { build: "tsc", test: "vitest" },
      dependencies: { express: "^4", react: "^18" },
      devDependencies: { vitest: "^1", typescript: "^5" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# demo-app\n\n一个示例项目,用于测试。\n", "utf8");
  fs.mkdirSync(path.join(dir, "src", "api"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "core"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "core", "engine.ts"), "// engine\n", "utf8");
  fs.mkdirSync(path.join(dir, "node_modules", "express"), { recursive: true });
}

describe("ensureProjectOverview", () => {
  it("generates overview for a fresh project and skips on second run", () => {
    makeProject();
    const first = ensureProjectOverview(dir);
    expect(first.wrote).toBe(true);
    const dest = path.join(dir, ".dsb", "docs", "project-overview.md");
    expect(fs.existsSync(dest)).toBe(true);
    const md = fs.readFileSync(dest, "utf8");
    expect(md).toContain("demo-app");
    expect(md).toContain("express");
    expect(md).toContain("## 技术栈");
    expect(md).toContain("## 目录结构");
    expect(md).toContain("## 源码模块");
    expect(md).toContain("api");
    expect(md).toContain("core");
    expect(md).toContain("README"); // 简介取自 README
    // 二次调用幂等:不再写入
    const second = ensureProjectOverview(dir);
    expect(second.wrote).toBe(false);
    if (!("skipped" in second)) throw new Error("expected skipped");
    expect(second.skipped).toBe("exists");
  });

  it("skips when the project already has framework docs under docs/", () => {
    makeProject();
    fs.mkdirSync(path.join(dir, "docs", "architecture"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "architecture", "overview.md"), "# 架构\n", "utf8");
    const res = ensureProjectOverview(dir);
    expect(res.wrote).toBe(false);
    if (!("skipped" in res)) throw new Error("expected skipped");
    expect(res.skipped).toBe("has-docs");
    expect(fs.existsSync(path.join(dir, ".dsb", "docs", "project-overview.md"))).toBe(false);
  });

  it("does not count unrelated docs as framework docs", () => {
    makeProject();
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "changelog.md"), "# changelog\n", "utf8");
    expect(hasProjectFrameworkDocs(dir)).toBe(false);
    const res = ensureProjectOverview(dir);
    expect(res.wrote).toBe(true);
  });

  it("buildProjectOverview lists module skeleton and skips noise dirs", () => {
    makeProject();
    const md = buildProjectOverview(dir);
    expect(md).not.toContain("node_modules");
    expect(md).not.toContain("express/"); // 子目录树不展开 node_modules
    expect(md).toContain("src/");
    expect(md).toContain("### src/");
    expect(md).toContain("core"); // 模块骨架列出子模块名
    expect(md).toContain("index.ts");
  });

  it("readProjectOverview returns content or empty", () => {
    expect(readProjectOverview(dir)).toBe("");
    makeProject();
    ensureProjectOverview(dir);
    expect(readProjectOverview(dir)).toContain("demo-app");
  });
});
