import * as fs from "fs";
import * as path from "path";

export type RipgrepPlatform = NodeJS.Platform;

export type ResolveRipgrepCandidatesOptions = {
  /** 扩展安装根(含 package.json / node_modules),或 dist 的父目录。 */
  extensionPath: string;
  /** 宿主 appRoot(内置 @vscode/ripgrep,兼容 VS Code 内核宿主)。 */
  appRoot?: string;
  /** 打包进 dist/bin 的目录(通常为 extensionPath/dist 或 __dirname)。 */
  distDir?: string;
  platform?: RipgrepPlatform;
  arch?: string;
};

/**
 * 按优先级列出可能的 rg 绝对路径(不检查是否存在)。
 * 扩展宿主 PATH 通常没有 `rg`,必须用绝对路径 spawn。
 */
export function resolveRipgrepCandidates(
  options: ResolveRipgrepCandidatesOptions,
): string[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const rgName = platform === "win32" ? "rg.exe" : "rg";
  const out: string[] = [];

  if (options.distDir) {
    out.push(path.join(options.distDir, "bin", rgName));
    // 多平台打包产物(esbuild.mjs 复制):dist/bin/rg.exe / linux-rg.linux / darwin-rg.darwin
    if (platform !== "win32") {
      out.push(path.join(options.distDir, "bin", `${platform}-${rgName}.${platform}`));
    }
  }

  out.push(
    path.join(
      options.extensionPath,
      "node_modules",
      `@vscode/ripgrep-${platform}-${arch}`,
      "bin",
      rgName,
    ),
    path.join(options.extensionPath, "node_modules", "@vscode", "ripgrep", "bin", rgName),
  );

  if (options.appRoot) {
    out.push(
      path.join(options.appRoot, "node_modules", "@vscode", "ripgrep", "bin", rgName),
      path.join(
        options.appRoot,
        "node_modules.asar.unpacked",
        "@vscode",
        "ripgrep",
        "bin",
        rgName,
      ),
    );
  }

  return out;
}

function pathExists(filePath: string, existsSync: (p: string) => boolean): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/** 返回第一个存在的候选;都没有则 undefined。 */
export function pickRipgrepPath(
  options: ResolveRipgrepCandidatesOptions,
  existsSync: (p: string) => boolean = fs.existsSync,
): string | undefined {
  for (const candidate of resolveRipgrepCandidates(options)) {
    if (pathExists(candidate, existsSync)) return candidate;
  }
  return undefined;
}

let configuredRipgrepPath: string | undefined;

/** 扩展 activate 时注入已解析的绝对路径。 */
export function configureRipgrepPath(rgPath: string | undefined): void {
  configuredRipgrepPath = rgPath && path.isAbsolute(rgPath) ? rgPath : undefined;
}

export function getConfiguredRipgrepPath(): string | undefined {
  return configuredRipgrepPath;
}
