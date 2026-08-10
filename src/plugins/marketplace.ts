import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseMarketplaceManifest, parsePluginManifest } from "./manifest";

export interface GitLike {
  clone(url: string, dest: string): Promise<void>;
}

/**
 * 生产 git 后端:shell out 到系统 PATH 的 `git clone`(无新依赖)。
 * 失败时把 stderr 带进错误消息,供命令层展示"git clone 失败: <stderr>"而不是笼统的"git not available"。
 */
export function createGitBackend(): GitLike {
  return {
    clone: async (url: string, dest: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["clone", "--depth", "1", url, dest], { timeout: 120_000 }, (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`git clone 失败: ${(stderr || "").trim() || String(err.message ?? err)}`));
          } else {
            resolve();
          }
        });
      });
    },
  };
}

export interface MarketplaceEntry {
  name: string;
  path: string;
}

/** 市场 manifest 路径:优先根目录 `marketplace.json`,兼容 `.claude-plugin/marketplace.json` 约定。 */
export function marketplaceManifestPath(marketDir: string): string {
  const root = path.join(marketDir, "marketplace.json");
  if (fs.existsSync(root)) return root;
  const claude = path.join(marketDir, ".claude-plugin", "marketplace.json");
  if (fs.existsSync(claude)) return claude;
  return root;
}

const npmFetch = async (pkg: string, dest: string): Promise<void> => {
  // 最小实现:用 npm pack 拉到临时目录再解包出 package 内容
  const { execFileSync } = require("child_process") as typeof import("child_process");
  // 每次调用独立临时目录(mkdtemp),避免并发操作争用同一个固定 npm-tmp,失败也不残留共享目录。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-npm-"));
  try {
    execFileSync("npm", ["pack", pkg, "--pack-destination", tmp], { stdio: "pipe" });
    const tarball = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error(`npm pack failed for ${pkg}`);
    execFileSync("tar", ["-xzf", path.join(tmp, tarball), "-C", tmp], { stdio: "pipe" });
    const dir = fs.readdirSync(tmp).find((f) => f.startsWith("package") && fs.statSync(path.join(tmp, f)).isDirectory());
    if (!dir) throw new Error(`npm package has no package dir: ${pkg}`);
    fs.cpSync(path.join(tmp, dir), dest, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

export class MarketplaceManager {
  constructor(private readonly opts: { cacheDir: string; git?: GitLike }) {}

  private marketDir(name: string): string {
    return path.join(this.opts.cacheDir, "marketplaces", name);
  }

  /** git clone 不自动建父目录;先保证 dest 的父目录存在(与 cpSync/URL 分支的建目录行为一致)。 */
  private ensureDestParent(dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  }

  /** git 克隆出的市场同样在 add() 时校验 marketplace.json(镜像 URL/本地分支);校验失败清理残留。 */
  private validateGitMarketplace(dest: string): void {
    try {
      parseMarketplaceManifest(marketplaceManifestPath(dest));
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw err;
    }
  }

  async add(source: string): Promise<MarketplaceEntry> {
    if (source.startsWith("./") || source.startsWith("/")) {
      return this.addLocal(source);
    }
    if (source.startsWith("npm:")) {
      const name = source.slice(4);
      const dest = this.marketDir(name);
      await npmFetch(name, dest);
      return { name, path: dest };
    }
    if (source.includes("/") && !source.startsWith("http")) {
      const name = source.split("/").pop() ?? "github";
      const dest = this.marketDir(name);
      if (!this.opts.git) throw new Error("git not available");
      this.ensureDestParent(dest);
      await this.opts.git.clone(`https://github.com/${source}.git`, dest);
      this.validateGitMarketplace(dest);
      return { name, path: dest };
    }
    if (source.startsWith("http") && !source.endsWith(".git")) {
      // 远程 URL marketplace.json → 下载到缓存,再本地校验清单(与本地分支一致),垃圾内容 add() 时就报错
      const name = new URL(source).pathname.split("/").pop()?.replace(".json", "") ?? "remote";
      const dest = this.marketDir(name);
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch marketplace: HTTP ${res.status}`);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "marketplace.json"), await res.text(), "utf8");
      try {
        parseMarketplaceManifest(path.join(dest, "marketplace.json"));
      } catch (err) {
        fs.rmSync(dest, { recursive: true, force: true }); // 校验失败不残留垃圾市场
        throw err;
      }
      return { name, path: dest };
    }
    if (source.endsWith(".git") || source.startsWith("http")) {
      const name = (source.split("/").pop() ?? "git").replace(/\.git$/, "");
      const dest = this.marketDir(name);
      if (!this.opts.git) throw new Error("git not available");
      this.ensureDestParent(dest);
      await this.opts.git.clone(source, dest);
      this.validateGitMarketplace(dest);
      return { name, path: dest };
    }
    throw new Error(`Unsupported marketplace source: ${source}`);
  }

  private async addLocal(source: string): Promise<MarketplaceEntry> {
    const abs = path.resolve(source);
    const stat = fs.statSync(abs);
    const manifest = parseMarketplaceManifest(stat.isFile() ? abs : marketplaceManifestPath(abs));
    const dest = this.marketDir(manifest.name);
    fs.mkdirSync(dest, { recursive: true });
    if (stat.isDirectory()) fs.cpSync(abs, dest, { recursive: true });
    else fs.copyFileSync(abs, path.join(dest, "marketplace.json"));
    return { name: manifest.name, path: dest };
  }

  list(): MarketplaceEntry[] {
    const dir = path.join(this.opts.cacheDir, "marketplaces");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(marketplaceManifestPath(path.join(dir, e.name))))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  }

  async install(marketplaceName: string, pluginName: string, onProgress?: (stage: string) => void): Promise<string> {
    const mp = this.list().find((m) => m.name === marketplaceName);
    if (!mp) throw new Error(`Marketplace not installed: ${marketplaceName}`);
    onProgress?.("读取市场清单…");
    const manifest = parseMarketplaceManifest(marketplaceManifestPath(mp.path));
    const ref = manifest.plugins.find((p) => p.name === pluginName);
    if (!ref) throw new Error(`Plugin not in marketplace: ${pluginName}`);
    const dest = path.join(this.opts.cacheDir, "plugins", marketplaceName, pluginName);
    const source = ref.source;
    if (source.startsWith("./") || source.startsWith("../")) {
      // 供应链防护:市场来自远端,source 解析后必须落在市场目录内,`../` 逃逸禁止(否则可把
      // 任意本地文件拷进插件缓存,其中的 hooks/*.sh 会被当作可执行 bash)。
      const base = path.resolve(mp.path);
      const resolved = path.resolve(mp.path, source);
      if (resolved === base || !resolved.startsWith(base + path.sep)) {
        throw new Error(`Plugin source escapes marketplace directory: ${source}`);
      }
      onProgress?.("复制插件到缓存…");
      fs.cpSync(resolved, dest, { recursive: true });
    } else if (source.includes("/") && !source.startsWith("http")) {
      if (!this.opts.git) throw new Error("git not available");
      this.ensureDestParent(dest);
      onProgress?.(`克隆插件仓库 ${source}…`);
      await this.opts.git.clone(`https://github.com/${source}.git`, dest);
    } else if (source.startsWith("npm:")) {
      onProgress?.("下载 npm 包…");
      await npmFetch(source.slice(4), dest);
    } else if (source.endsWith(".git") || source.startsWith("http")) {
      // 完整 git URL(如市场清单里 {source:"url", url:"https://…/repo.git"})
      if (!this.opts.git) throw new Error("git not available");
      this.ensureDestParent(dest);
      onProgress?.("克隆插件仓库…");
      await this.opts.git.clone(source, dest);
    } else {
      throw new Error(`Unsupported plugin source: ${source}`);
    }
    onProgress?.("校验插件清单…");
    parsePluginManifest(dest); // 校验存在
    return dest;
  }

  remove(name: string): void {
    fs.rmSync(this.marketDir(name), { recursive: true, force: true });
  }
}
