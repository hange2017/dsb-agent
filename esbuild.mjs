import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const watch = process.argv.includes("--watch");

const common = { bundle: true, sourcemap: true, logLevel: "info" };

const extensionBuild = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  // @vscode/ripgrep 是 ESM(内含 import.meta.url),esbuild 打成 CJS 会损坏其
  // createRequire 解析,导致 rgPath 崩溃;保持 external,由 Node 运行时加载真实 ESM。
  // better-sqlite3 为 optionalDependency(cc-switch 导入主路径),动态 require + external,
  // 未安装时运行期 require 抛错自动降级读 ~/.claude/settings.json。
  external: ["vscode", "@vscode/ripgrep", "better-sqlite3"],
};

const webviewBuild = {
  ...common,
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview/main.js",
  platform: "browser",
  format: "iife",
};

const providerSettingsBuild = {
  ...common,
  entryPoints: ["webview/providerSettings.ts"],
  outfile: "dist/webview/providerSettings.js",
  platform: "browser",
  format: "iife",
};

const memoryPanelBuild = {
  ...common,
  entryPoints: ["webview/memoryPanel.ts"],
  outfile: "dist/webview/memoryPanel.js",
  platform: "browser",
  format: "iife",
};

const contextPanelBuild = {
  ...common,
  entryPoints: ["webview/contextPanel.ts"],
  outfile: "dist/webview/contextPanel.js",
  platform: "browser",
  format: "iife",
};

const agentSettingsPanelBuild = {
  ...common,
  entryPoints: ["webview/agentSettingsPanel.ts"],
  outfile: "dist/webview/agentSettingsPanel.js",
  platform: "browser",
  format: "iife",
};

function copyRipgrepBinary() {
  const platform = process.platform;
  const arch = process.arch;
  const rgName = platform === "win32" ? "rg.exe" : "rg";
  const src = path.join(
    "node_modules",
    `@vscode/ripgrep-${platform}-${arch}`,
    "bin",
    rgName,
  );
  if (!fs.existsSync(src)) {
    console.warn(`[esbuild] ripgrep binary not found at ${src}; Grep may fail in packaged extension`);
    return;
  }
  const destDir = path.join("dist", "bin");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, rgName);
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Windows 等可不设
  }
}

function copyWebviewStatic() {
  const destDir = path.join("dist", "webview");
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync("webview/index.html", path.join(destDir, "index.html"));
  fs.cpSync("webview/providerSettings.html", path.join(destDir, "providerSettings.html"));
  fs.cpSync("webview/memoryPanel.html", path.join(destDir, "memoryPanel.html"));
  fs.cpSync("webview/contextPanel.html", path.join(destDir, "contextPanel.html"));
  fs.cpSync("webview/agentSettingsPanel.html", path.join(destDir, "agentSettingsPanel.html"));
  fs.cpSync("webview/styles.css", path.join(destDir, "styles.css"));
}

async function run() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionBuild);
    const ctx2 = await esbuild.context({
      ...webviewBuild,
      plugins: [
        {
          name: "copy-webview-static",
          setup(build) {
            build.onEnd(() => {
              copyWebviewStatic();
              copyRipgrepBinary();
            });
          },
        },
      ],
    });
    const ctx3 = await esbuild.context(providerSettingsBuild);
    const ctx4 = await esbuild.context(memoryPanelBuild);
    const ctx5 = await esbuild.context(contextPanelBuild);
    const ctx6 = await esbuild.context(agentSettingsPanelBuild);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch(), ctx4.watch(), ctx5.watch(), ctx6.watch()]);
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(webviewBuild),
      esbuild.build(providerSettingsBuild),
      esbuild.build(memoryPanelBuild),
      esbuild.build(contextPanelBuild),
      esbuild.build(agentSettingsPanelBuild),
    ]);
    copyWebviewStatic();
    copyRipgrepBinary();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
