import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MarketplaceManager, type GitLike } from "../src/plugins/marketplace";

let cache: string;
let manager: MarketplaceManager;
beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-"));
  manager = new MarketplaceManager({ cacheDir: cache });
});
afterEach(() => fs.rmSync(cache, { recursive: true, force: true }));

describe("MarketplaceManager", () => {
  it("adds a local marketplace and lists it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlocal-"));
    fs.writeFileSync(path.join(dir, "marketplace.json"), JSON.stringify({ name: "mk1", plugins: [{ name: "p", description: "d", source: "./p" }] }));
    const entry = await manager.add(dir);
    expect(entry.name).toBe("mk1");
    expect(manager.list().map((m) => m.name)).toContain("mk1");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("installs a local plugin", async () => {
    const mk = fs.mkdtempSync(path.join(os.tmpdir(), "dloc2-"));
    const pluginDir = path.join(mk, "p");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "p", description: "d", version: "1" }));
    fs.writeFileSync(path.join(mk, "marketplace.json"), JSON.stringify({ name: "mk2", plugins: [{ name: "p", description: "d", source: "./p" }] }));
    await manager.add(mk);
    const dest = await manager.install("mk2", "p");
    expect(fs.existsSync(path.join(dest, "plugin.json"))).toBe(true);
    fs.rmSync(mk, { recursive: true, force: true });
  });
  it("clones a github marketplace via git stub", async () => {
    const git: GitLike = {
      clone: async (_url, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "marketplace.json"), JSON.stringify({ name: "gh", plugins: [] }));
      },
    };
    const mgr = new MarketplaceManager({ cacheDir: cache, git });
    const e = await mgr.add("owner/repo");
    expect(e.name).toBe("repo");
  });

  it("accepts a github marketplace with .claude-plugin/marketplace.json layout", async () => {
    const git: GitLike = {
      clone: async (_url, dest) => {
        fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
        fs.writeFileSync(
          path.join(dest, ".claude-plugin", "marketplace.json"),
          JSON.stringify({ name: "superpowers", plugins: [] }),
        );
      },
    };
    const mgr = new MarketplaceManager({ cacheDir: cache, git });
    const e = await mgr.add("obra/superpowers-marketplace");
    expect(e.name).toBe("superpowers-marketplace");
    expect(mgr.list().map((m) => m.name)).toContain("superpowers-marketplace");
  });

  it("normalizes url-source plugins and plugin manifests under .claude-plugin/", async () => {
    const mk = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-"));
    try {
      fs.mkdirSync(path.join(mk, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(mk, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "sp",
          plugins: [
            { name: "superpowers", description: "d", source: { source: "url", url: "https://github.com/obra/superpowers.git" } },
          ],
        }),
      );
      let clonedUrl: string | undefined;
      const git: GitLike = {
        clone: async (url, dest) => {
          clonedUrl = url;
          fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
          fs.writeFileSync(
            path.join(dest, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "superpowers", description: "d", version: "1" }),
          );
        },
      };
      const mgr = new MarketplaceManager({ cacheDir: cache, git });
      await mgr.add(mk);
      const dest = await mgr.install("sp", "superpowers");
      expect(clonedUrl).toBe("https://github.com/obra/superpowers.git");
      expect(fs.existsSync(path.join(dest, ".claude-plugin", "plugin.json"))).toBe(true);
    } finally {
      fs.rmSync(mk, { recursive: true, force: true });
    }
  });

  it("creates the destination parent dir before invoking clone (fresh cache)", async () => {
    // 回归:git clone 不自动建父目录,首次 pluginAdd owner/repo 若先建父目录会以
    // "Cloning into ..." 的误导 stderr 失败。断言 clone 被调用时 dest 的父目录已存在。
    let parentExisted = false;
    let clonedDest = "";
    const git: GitLike = {
      clone: async (_url, dest) => {
        parentExisted = fs.existsSync(path.dirname(dest));
        clonedDest = dest;
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "marketplace.json"), JSON.stringify({ name: "gh", plugins: [] }));
      },
    };
    const mgr = new MarketplaceManager({ cacheDir: cache, git });
    const e = await mgr.add("owner/repo");
    expect(e.name).toBe("repo");
    expect(clonedDest).toBe(path.join(cache, "marketplaces", "repo"));
    expect(parentExisted).toBe(true);
  });

  it("creates the destination parent dir before cloning a github-sourced plugin install", async () => {
    let parentExisted = false;
    const git: GitLike = {
      clone: async (_url, dest) => {
        parentExisted = fs.existsSync(path.dirname(dest));
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "plugin.json"), JSON.stringify({ name: "p", description: "d", version: "1" }));
      },
    };
    const mgr = new MarketplaceManager({ cacheDir: cache, git });
    const mk = fs.mkdtempSync(path.join(os.tmpdir(), "dloc4-"));
    fs.writeFileSync(path.join(mk, "marketplace.json"), JSON.stringify({ name: "mk4", plugins: [{ name: "p", description: "d", source: "owner/p" }] }));
    await mgr.add(mk);
    await mgr.install("mk4", "p");
    expect(parentExisted).toBe(true);
    expect(fs.existsSync(path.join(cache, "plugins", "mk4", "p", "plugin.json"))).toBe(true);
    fs.rmSync(mk, { recursive: true, force: true });
  });

  it("rejects a plugin source escaping the marketplace dir (path traversal)", async () => {
    const mk = fs.mkdtempSync(path.join(os.tmpdir(), "dloc3-"));
    fs.writeFileSync(path.join(cache, "secret.txt"), "should not be copied", "utf8");
    const pluginDir = path.join(mk, "p");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "p", description: "d", version: "1" }));
    fs.writeFileSync(
      path.join(mk, "marketplace.json"),
      JSON.stringify({ name: "mk3", plugins: [{ name: "p", description: "d", source: "../../secret.txt" }] }),
    );
    await manager.add(mk);
    // marketplace 落在 cache/marketplaces/mk3,`../../` 逃逸到 cache 根 → 必须拒绝且不落盘
    await expect(manager.install("mk3", "p")).rejects.toThrow(/escapes marketplace directory/);
    expect(fs.existsSync(path.join(cache, "plugins", "mk3", "p"))).toBe(false);
    expect(fs.readFileSync(path.join(cache, "secret.txt"), "utf8")).toBe("should not be copied");
    fs.rmSync(mk, { recursive: true, force: true });
  });

  it("rejects a URL marketplace whose body is not a valid manifest (add-time validation)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, text: async () => "this is not JSON" }) as Response);
    try {
      await expect(manager.add("https://example.com/garbage/marketplace.json")).rejects.toThrow(/valid JSON|Invalid JSON/);
      // 校验失败清理残留,不污染 list()
      expect(manager.list().some((m) => m.name === "marketplace")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
