#!/usr/bin/env bash
# 一键编译并安装 DSBAgent 扩展到 VS Code:
#   1. esbuild 编译(src + webview → dist/)
#   2. vsce 打包为 .vsix
#   3. code --install-extension 安装(覆盖旧版本)
# 用法:bash scripts/install-extension.sh  或  npm run install-extension
# 安装后需重载 VS Code 窗口(Ctrl+Shift+P → Reload Window)使扩展生效。
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- 1. 编译(esbuild → dist/extension.js + dist/webview/) ----
echo "==> 编译(esbuild)"
npm run compile

# ---- 2. 定位 code CLI(macOS/Linux:code;Windows:code.cmd;可用 CODE 环境变量覆盖) ----
CODE_BIN="${CODE:-}"
if [[ -z "$CODE_BIN" ]]; then
  if command -v code >/dev/null 2>&1; then
    CODE_BIN="code"
  elif command -v code.cmd >/dev/null 2>&1; then
    CODE_BIN="code.cmd"
  else
    echo "错误:未找到 code CLI。请先在 VS Code 里执行 Command Palette → 'Shell Command: Install 'code' command in PATH'。" >&2
    exit 1
  fi
fi

# ---- 3. 打包 .vsix 到临时目录(退出时清理) ----
VSIX="$(mktemp -t dsb-agent-XXXXXX.vsix)"
trap 'rm -f "$VSIX"' EXIT
echo "==> 打包 vsix"
# 检测 package.json 是否已配置 repository(正式发布前必须补)。已配置 → 走标准打包
# (README 相对链接会被 vsce 重写为仓库绝对链接,供 Marketplace 页面渲染);
# 未配置 → 加 --no-rewrite-relative-links 与 --allow-missing-repository,本地安装可用。
# vsce 在 stdin 为 TTY 时会交互提问(repository/LICENSE 缺失);printf 'y\n' | 让 stdin
# 变管道(非 TTY)并给出答案 → 任何提示都不卡,无人值守。
VSCE_OPTS=(--out "$VSIX")
if python3 -c 'import json,sys; d=json.load(open("package.json")); sys.exit(0 if d.get("repository") else 1)' 2>/dev/null; then
  echo "==> package.json 已配置 repository → 标准打包"
else
  echo "==> package.json 未配置 repository → 本地打包(跳过相对链接重写)"
  VSCE_OPTS+=(--allow-missing-repository --no-rewrite-relative-links)
fi
printf 'y\n' | npx vsce package "${VSCE_OPTS[@]}" 

# ---- 4. 安装到 VS Code(--force 覆盖已装的同名扩展) ----
echo "==> 安装到 VS Code"
"$CODE_BIN" --install-extension "$VSIX" --force

echo "==> 完成。请重载 VS Code 窗口使扩展生效。"
