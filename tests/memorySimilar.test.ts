import { describe, it, expect } from "vitest";
import { findSimilarMemories, levenshtein } from "../src/agent/memory/memorySimilar";

const entry = (name: string, description: string) => ({ name, description, body: "b", updatedAt: 1 });

describe("findSimilarMemories 启发式相似检测", () => {
  it("返回相似候选并按相似度降序", () => {
    const candidates = [
      entry("user-prefers-vitest", "用户偏好 vitest 测试"),
      entry("build-esbuild", "使用 esbuild 打包"),
      entry("user-likes-jest", "用户偏好 jest 测试框架"),
    ];
    const similar = findSimilarMemories(candidates, "user-prefers-jest", "用户偏好 jest 测试框架");
    expect(similar.length).toBeGreaterThan(0);
    // 最相似的两个都应命中,且高分在前
    expect(similar[0].score).toBeGreaterThanOrEqual(similar[similar.length - 1].score);
    expect(similar.map((s) => s.name)).toContain("user-likes-jest");
    expect(similar.map((s) => s.name)).toContain("user-prefers-vitest");
  });

  it("同名(覆盖更新)不算重复,直接排除", () => {
    const candidates = [entry("my-note", "我的笔记")];
    expect(findSimilarMemories(candidates, "my-note", "我的笔记")).toEqual([]);
  });

  it("差异过大的条目被阈值过滤", () => {
    const candidates = [entry("rust-cargo", "Rust 项目依赖管理")];
    expect(findSimilarMemories(candidates, "python-venv", "Python 虚拟环境")).toEqual([]);
  });

  it("空候选池返回空", () => {
    expect(findSimilarMemories([], "anything", "desc")).toEqual([]);
  });

  it("top 参数控制返回条数", () => {
    const candidates = [
      entry("a-1", "同主题 A"),
      entry("a-2", "同主题 B"),
      entry("a-3", "同主题 C"),
    ];
    const similar = findSimilarMemories(candidates, "a-x", "同主题 X", { top: 2 });
    expect(similar.length).toBeLessThanOrEqual(2);
  });

  it("minScore 阈值可调:降低后召回更多", () => {
    const candidates = [entry("k8s-deploy", "k8s 部署配置")];
    const strict = findSimilarMemories(candidates, "docker", "容器部署");
    const loose = findSimilarMemories(candidates, "docker", "容器部署", { minScore: 0.1 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});

describe("levenshtein", () => {
  it("计算编辑距离", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});
