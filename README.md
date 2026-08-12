# DSBAgent

> 基于 **Anthropic Messages 兼容 API** 的开源 VS Code 编码 Agent（非官方独立项目）。

[English](README.en.md)

## 快速开始

1. 在 VS Code 中按下组合键 `Ctrl+Shift+P`，输入 `DSBAgent: Open`，点击之后右侧弹出窗口。
2. 点击 Agent 界面右上角的设置图标，然后点击弹窗左下角的「供应商和模型」。
3. 新建供应商处，名称随意填写，填入两个关键信息：**Base URL** 和 **API Key**，两项填写后点击创建；并在下方供应商列表中选择「设置为当前」，即可关闭设置界面返回使用。
4. 在输入框发送第一条消息，开始对话。

> ⚡ **设置建议(重要)** —— 使用前先在设置里调整这两项,体验更佳:
>
> <span style="color: green;">1. **超级权限**:设置 → 超级权限,一键开启,畅通无阻(工具不再逐个询问)。</span>
>
> <span style="color: green;">2. **参数设置**:历史信息总预算必须小于窗口总长度;64K 即可运行,并不是越大越好。</span>

> API Key 存于 VS Code SecretStorage（不落盘明文）；内置供应商模板默认指向公开兼容端点，可随时在设置中修改。

## 真实编程使用统计数据

> 统计窗口：2026-08-12 10:00 ~ 11:49（本地时间）。数据来自扩展本地统计事件（隐私友好，不落消息内容）。计费口径：命中 ¥0.02/M、未命中 ¥1/M、输出 ¥2/M。

| 指标 | 数值 |
|---|---|
| **平均每次调用费用** | **¥0.0045** |
| 中位数每次调用费用 | ¥0.0022 |
| 总费用 | ¥1.8262 |
| 总调用大模型次数 | 407 次 |
| 输入（命中缓存） | 20,369,280 tokens |
| 输入（未命中） | 1,002,017 tokens |
| 输出 | 208,397 tokens |
| 总消耗（输入 + 输出） | 21,579,694 tokens |
| 输入缓存命中率 | 95.31% |
| 输出 / 未命中输入 | 0.208 |

## 安装

### 从 GitHub Releases 安装 `.vsix`（当前推荐）

1. 从 [GitHub Releases](https://github.com/hange2017/dsb-agent/releases) 下载最新 `dsb-agent-<版本>.vsix`，或自行打包（见下文「从源码构建」）。
2. 打开 VS Code。
3. 命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）→ **Extensions: Install from VSIX…**，选择下载的 `.vsix`。
   - **Windows** 也可直接双击 `.vsix`（会自动用 VS Code 打开安装）；若 `code` 不在 PATH，请先运行 VS Code 内「Shell Command: Install 'code' command in PATH」。
4. 安装后重载窗口（Reload Window），从命令面板打开 **DSBAgent**，按提示配置供应商与 API Key（见上文「快速开始」）。

### VS Code 官方扩展市场（发布中）

扩展正在向 VS Code 官方扩展市场提交，审核通过后可直接在扩展面板（`Ctrl+Shift+X`）搜索 **DSBAgent** 安装。
> 官方市场收录需走微软 Azure DevOps 发布流程，当前扩展的发布状态以 [GitHub Releases](https://github.com/hange2017/dsb-agent/releases) 为准。

### 从源码构建

```bash
npm install
npm run compile          # esbuild → dist/
npx vsce package         # 产出 .vsix
# 或用一键脚本(自动 编译→打包→安装,需 code CLI):
npm run install-extension
```

## 概述

基于 **Anthropic Messages 兼容 API** 的 VS Code 编码 Agent（开源，非官方；操作方式参考主流编码 Agent 工具）。

可对接任意 Anthropic Messages 兼容 `baseUrl`；内置模板默认指向公开兼容端点（技术地址见设置中的 Base URL，可随时改掉）。

## 非官方声明

本扩展为**独立开源项目**，与任何模型厂商**无官方从属、无官方认证、非官方插件**。扩展名 **DSBAgent** 不表示由任一模型厂商发行或背书。

## 功能概览

- **Agent 工具循环**：读改文件、全局搜索（内置 ripgrep）、终端命令、联网搜索/抓取、子代理（`Agent`）、并行工作流（`Workflow`）
- **上下文管理**：thinking 独立压缩、压缩成本监控（`CompactionStats` 滑动窗口 + agentUI 徽章/趋势柱状图）、触发阈值可调
- **冷存储与历史归档**：老会话完整历史归档到冷存储，跨会话 `ContextRecall` 回查，`dsbAgent.contextBrowse` 面板浏览/过滤/合并
- **记忆系统**：跨会话持久记忆（`~/.dsb/memory/`，项目隔离），`/memory` 管理与 dream 整合
- **项目约定**：`.dsb/`（`DSB.md`、settings、skills、rules、commands、agents）；旧 `.cxxxp/` / `.deepseek/` / `.claude/` 只读回退
- **内置技能包**（适配自 MIT 上游）：`skills/sp-*`（流程）与 `skills/as-*`（工程/文档）；首次创建 `.dsb` 时可种子化到项目
- **多供应商**：DeepSeek 等预设 + 自定义端点；模型能力门控；密钥存 VS Code SecretStorage
- **统计与提醒**：事件日志（`provider_send` / `compaction` / `message_sent`，按项目隔离），每日收工总结提醒，成本趋势可视化
- **插件 / MCP / 钩子**：插件市场与工具注入、MCP 服务器接入（需显式信任）、生命周期钩子
- **会话能力**：会话恢复、回退（`rewind`）、会话列表、权限询问（默认未命中规则一律询问）

详见总体框架文档 [`.dsb/docs/project-overview.md`](.dsb/docs/project-overview.md)。

## 支持平台

| 平台 | 状态 | 说明 |
|------|------|------|
| Linux x64/arm64 | ✅ 主力验证 | 打包内置 ripgrep 二进制 |
| Windows x64 | ⚠️ 可用,发布前需冒烟 | 内置 `rg.exe`；终端走 `cmd.exe` 分流 |
| macOS | ⚠️ 可用,发布前需冒烟 | 终端走 `/bin/zsh` |
| Web (vscode.dev) | ❌ 不支持 | 依赖本地文件系统与终端 |

> ripgrep 二进制：`dist/bin/` 随包内置（v0.18+，来自官方发布产物），仓库根与 `node_modules` 不额外下载。

## 常用命令

| 命令 | 作用 |
|------|------|
| `DSBAgent: Open` | 打开 Agent 面板 |
| `DSBAgent: New Session` | 新会话 |
| `DSBAgent: Set API Key` | 配置密钥（SecretStorage） |
| `DSBAgent: Memory` / `Memory Manage` | 跨会话记忆查看/管理 |
| `DSBAgent: Browse Cold Storage` | 冷存储归档浏览（历史会话块） |
| `DSBAgent: Rewind` | 回退到历史状态 |
| `DSBAgent: List Sessions` | 会话列表 |
| `DSBAgent: Plugin Add / Install / Plugins` | 插件管理 |
| `DSBAgent: Connect MCP Servers` / `Hooks` | MCP 接入 / 钩子 |
| `DSBAgent: Skill` | 技能调用 |

## 隐私与数据

| 项 | 说明 |
|----|------|
| 发往何处 | 对话、代码上下文、附件会发送到你配置的 **`baseUrl` 模型服务**；WebSearch/WebFetch/插件源为额外出站 |
| API Key | 使用 VS Code **SecretStorage**，不写入仓库或供应商配置明文 |
| 本地存储 | 会话在扩展 `globalStorage`；冷存储归档 `<globalStorage>/context/<projectKey>/`；记忆默认 `~/.dsb/memory/`；统计 `~/.dsb/stats/<projectKey>/`；约定与检查点在工作区 `.dsb/`；cc-switch 导入仅**本机只读** `~/.cc-switch/cc-switch.db`，不写入、不备份、不上传 |
| 遥测 | **无**发往扩展作者的遥测 / 分析 / 崩溃上报 |
| 你的责任 | 自行遵守所选 API 与站点条款；勿向不可信端点发送机密 |

WebSearch / WebFetch 仅供**开发辅助**；请遵守目标站点服务条款。

完整说明见 [`PRIVACY.md`](./PRIVACY.md)。

## 权限与风险

- 默认权限模式对**未命中规则的工具一律询问**（含编辑类）；`acceptEdits` 仅自动放行编辑；`bypassPermissions` / 超级权限会跳过多数确认
- MCP 默认未信任：需在 `.mcp.json` 设 `trusted: true`，或运行 **DSBAgent: Connect MCP Servers** 显式连接
- 插件 `tools[]` 与 MCP 具有本地执行能力，只安装信任来源；**无**完整网络/OS 沙箱
- 详见 [`SECURITY.md`](./SECURITY.md)

## 项目约定目录（`.dsb/`）

- 项目指令 → `.dsb/DSB.md`（或仓库根 `DSB.md`）；规则 → `.dsb/rules/`；技能 → `.dsb/skills/`
- 斜杠命令 → `.dsb/commands/`；子代理模板 → `.dsb/agents/`
- 实现计划 → `.dsb/plans/`；设计说明 → `.dsb/specs/`；其它文档 → `.dsb/docs/`
- 会话检查点 → `.dsb/checkpoints/`（gitignore，不推送）

## 开源许可

本仓库源代码以 [MIT License](./LICENSE) 发布。

```
Copyright (c) 2026 ZhaoNingHan
```

第三方依赖许可证见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)（生产依赖全量清单；发版前执行 `npm run licenses:inventory` 刷新）。

## 文档

| 文档 | 内容 |
|------|------|
| [总体框架](.dsb/docs/project-overview.md) | 模块与功能总览（自动注入会话上下文） |
| [变更记录](CHANGELOG.md) | 版本演进与 commit 索引 |
| [隐私说明](PRIVACY.md) | 数据流、本地存储、无遥测 |
| [安全说明](SECURITY.md) | Bash / MCP / 权限门禁与已知限制 |
| [打榜路线](.dsb/docs/benchmark/benchmark-roadmap.md) | 三个梯队打榜路线与执行阶段（SWE-bench-Live / Terminal-Bench 等） |
| [打榜执行计划](.dsb/plans/2026-08-12-benchmark-execution-plan.md) | SWE-bench-Live Lite + Terminal-Bench 2.0 落地计划与 wrapper 架构 |

## 已知限制

- **无完整沙箱**：工具（Bash、文件写入、插件、MCP）按权限门禁放行，但无系统级隔离；请勿在不可信项目中启用 `bypassPermissions`。
- **单会话上下文**：上下文管理与压缩为会话内设计；跨会话回查依赖冷存储（`ContextRecall` / `dsbAgent.contextBrowse`），请勿依赖其作为唯一记录源。
- **模型依赖**：压缩质量、工具调用可靠性随所选模型/端点而异；公共兼容端点的可用性与速率限制不受本项目控制。
- **Web 端不可用**：依赖本地文件系统、终端与 SecretStorage，不支持 `vscode.dev`。

## 开发

```bash
npm run compile    # esbuild 构建(dev)
npm run typecheck  # tsc --noEmit
npm test           # vitest 全量(100 文件 / 973 tests)
npx vsce package   # 打 .vsix(发布前执行 licenses:inventory 刷新第三方清单)
```

CI（`.github/workflows/ci.yml`）：typecheck → vitest → vsce package。

## 商标

文中提及的 Anthropic、VS Code 及各模型服务商标归各自权利人所有；本项目仅作事实性协议兼容 / 平台说明，不主张相关商标权利。
