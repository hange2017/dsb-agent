# DSBAgent

> An open-source VS Code coding agent based on the **Anthropic Messages-compatible API** (unofficial, independent project).

[中文](README.md)

## Quick Start

1. Press `Ctrl+Shift+P` in VS Code, type `DSBAgent: Open`, and click it — the panel opens.
2. Click the settings icon in the top-right of the agent panel, then "Providers & Models" in the drawer.
3. Under "New provider", pick any name and fill in the two key fields: **Base URL** and **API Key**; click create. Then select "Set as current" in the provider list below and close the settings.
4. Send your first message and start chatting.

> ⚡ **Settings tips (important)** — adjust these two before using for a better experience:
>
> <span style="color: green;">1. **Super permission**: Settings → Super permission, enable it with one click for a smooth ride (tools no longer ask one by one).</span>
>
> <span style="color: green;">2. **Agent settings**: History info total budget must be smaller than the window total length; **64K runs fine**, but try **256K or larger** history info total budget for significantly fewer compaction pauses.</span>

> API Keys are stored in VS Code SecretStorage (never written as plaintext); the built-in provider templates default to a public compatible endpoint, changeable anytime in settings.

## Installation

### Install the `.vsix` from GitHub Releases (currently recommended)

1. Download the latest `dsb-agent-<version>.vsix` from [GitHub Releases](https://github.com/hange2017/dsb-agent/releases), or build it yourself (see "Build from source" below).
2. Open VS Code.
3. Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **Extensions: Install from VSIX…**, then pick the downloaded `.vsix`.
   - **Windows**: you can also double-click the `.vsix` (VS Code will install it); if `code` is not on PATH, run "Shell Command: Install 'code' command in PATH" inside VS Code first.
4. After installation, reload the window (Reload Window), open **DSBAgent** from the Command Palette, and configure a provider and API Key (see "Quick Start" above).

### VS Code Marketplace (in progress)

The extension is being submitted to the VS Code Marketplace. Once approved, you can search **DSBAgent** in the Extensions view (`Ctrl+Shift+X`).
> Marketplace publication goes through Microsoft's Azure DevOps flow; the authoritative status is whatever is on [GitHub Releases](https://github.com/hange2017/dsb-agent/releases).

### Build from source

```bash
npm install
npm run compile          # esbuild → dist/
npx vsce package         # produces .vsix
# or use the one-shot script (compile → package → install, requires code CLI):
npm run install-extension
```

## Overview

A VS Code coding agent (open source, unofficial; operation style follows mainstream coding agent tools) built on the **Anthropic Messages-compatible API**.

Works with any Anthropic Messages-compatible `baseUrl`; the built-in provider templates default to a public compatible endpoint (see Base URL in settings, changeable at any time).

## Unofficial Disclaimer

This extension is an **independent open-source project** with **no official affiliation, certification, or endorsement** from any model vendor. The name **DSBAgent** does not imply that it is published or endorsed by any model vendor.

## Feature Highlights

- **Agent tool loop**: read/edit files, global search (bundled ripgrep), shell commands, web search/fetch, sub-agents (`Agent`), parallel workflows (`Workflow`)
- **Context management**: independent thinking compression, compaction cost monitoring (`CompactionStats` sliding window + agentUI badge/trend chart), adjustable trigger ratio
- **Cold storage & history archive**: full history archived to cold storage, cross-session `ContextRecall`, `dsbAgent.contextBrowse` panel to browse/filter/merge
- **Memory system**: cross-session persistent memory (`~/.dsb/memory/`, project-scoped), `/memory` management and dream consolidation
- **Project conventions**: `.dsb/` (`DSB.md`, settings, skills, rules, commands, agents); read-only fallback for legacy `.cxxxp/` / `.deepseek/` / `.claude/` directories
- **Bundled skill packs** (adapted from MIT upstream): `skills/sp-*` (process) and `skills/as-*` (engineering/docs); seedable into a project on first `.dsb` creation
- **Multiple providers**: presets like DeepSeek + custom endpoints; model capability gating; API keys stored in VS Code SecretStorage
- **Stats & reminders**: event logs (`provider_send` / `compaction` / `message_sent`, per-project), daily wrap-up reminder, cost trend visualization
- **Plugins / MCP / hooks**: plugin marketplace and tool injection, MCP server support (requires explicit trust), lifecycle hooks
- **Session capabilities**: session restore, rewind, session list, permission prompts (default: ask for any rule-miss)

See the full architecture doc [`.dsb/docs/project-overview.md`](.dsb/docs/project-overview.md).

## Supported Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| Linux x64/arm64 | ✅ Primary (verified) | Bundled ripgrep binary |
| Windows x64 | ⚠️ Usable, smoke-test before release | Bundled `rg.exe`; shell via `cmd.exe` |
| macOS | ⚠️ Usable, smoke-test before release | Shell via `/bin/zsh` |
| Web (vscode.dev) | ❌ Not supported | Depends on local filesystem & shell |

> ripgrep binary: bundled in `dist/bin/` (v0.18+, from official release artifacts); the repo root and `node_modules` do not download extra copies.

## Common Commands

| Command | Action |
|---------|--------|
| `DSBAgent: Open` | Open the agent panel |
| `DSBAgent: New Session` | New session |
| `DSBAgent: Set API Key` | Configure API key (SecretStorage) |
| `DSBAgent: Memory` / `Memory Manage` | View/manage cross-session memory |
| `DSBAgent: Browse Cold Storage` | Browse cold-storage archives (historical session chunks) |
| `DSBAgent: Rewind` | Rewind to a historical state |
| `DSBAgent: List Sessions` | Session list |
| `DSBAgent: Plugin Add / Install / Plugins` | Plugin management |
| `DSBAgent: Connect MCP Servers` / `Hooks` | MCP / hooks |
| `DSBAgent: Skill` | Invoke skills |

## Privacy & Data

| Item | Description |
|------|-------------|
| Where data goes | Conversations, code context, and attachments are sent to the **`baseUrl` model service** you configure; WebSearch/WebFetch/plugin sources are additional outbound traffic |
| API Key | Stored in VS Code **SecretStorage**, never written into the repo or provider config as plaintext |
| Local storage | Sessions in extension `globalStorage`; cold-storage archives `<globalStorage>/context/<projectKey>/`; memory defaults to `~/.dsb/memory/`; stats `~/.dsb/stats/<projectKey>/`; conventions & checkpoints in workspace `.dsb/`; cc-switch import is **read-only, local** `~/.cc-switch/cc-switch.db` (never written, backed up, or uploaded) |
| Telemetry | **No** telemetry/analytics/crash reporting sent to the author |
| Your responsibility | Comply with the terms of the APIs and sites you use; do not send secrets to untrusted endpoints |

WebSearch / WebFetch are **development aids only**; please respect the target sites' terms of service.

Full details: [`PRIVACY.md`](./PRIVACY.md).

## Permissions & Risks

- Default permission mode **prompts for any tool not covered by a rule** (including edits); `acceptEdits` only auto-allows edits; `bypassPermissions` / super permission skips most confirmations
- MCP is untrusted by default: set `trusted: true` in `.mcp.json`, or connect explicitly via **DSBAgent: Connect MCP Servers**
- Plugins `tools[]` and MCP have local execution capability — only install trusted sources; there is **no** full network/OS sandbox
- See [`SECURITY.md`](./SECURITY.md)

## Project Convention Directory (`.dsb/`)

- Project instructions → `.dsb/DSB.md` (or repo-root `DSB.md`); rules → `.dsb/rules/`; skills → `.dsb/skills/`
- Slash commands → `.dsb/commands/`; sub-agent templates → `.dsb/agents/`
- Implementation plans → `.dsb/plans/`; design specs → `.dsb/specs/`; other docs → `.dsb/docs/`
- Session checkpoints → `.dsb/checkpoints/` (gitignored, not pushed)

## Open Source License

Source code is released under the [MIT License](./LICENSE).

```
Copyright (c) 2026 ZhaoNingHan
```

Third-party dependency licenses: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) (full production dependency list; run `npm run licenses:inventory` before each release).

## Docs

| Doc | Content |
|-----|---------|
| [Architecture Overview](.dsb/docs/project-overview.md) | Module & feature overview (injected into session context) |
| [Changelog](CHANGELOG.md) | Version history & commit index |
| [Privacy](PRIVACY.md) | Data flow, local storage, no telemetry |
| [Security](SECURITY.md) | Bash / MCP / permission gates & known limits |

## Known Limitations

- **No full sandbox**: tools (Bash, file writes, plugins, MCP) are gated by permissions but not OS-level isolated; do not enable `bypassPermissions` in untrusted projects.
- **Per-session context**: context management & compaction are session-scoped; cross-session recall relies on cold storage (`ContextRecall` / `dsbAgent.contextBrowse`) — do not treat it as your only record.
- **Model-dependent**: compaction quality and tool-call reliability vary by model/endpoint; availability and rate limits of public compatible endpoints are outside this project's control.
- **Web not supported**: depends on local filesystem, shell and SecretStorage; does not work on `vscode.dev`.

## Development

```bash
npm run compile    # esbuild build (dev)
npm run typecheck  # tsc --noEmit
npm test           # vitest full suite (100 files / 973 tests)
npx vsce package   # build .vsix (run licenses:inventory before release)
```

CI (`.github/workflows/ci.yml`): typecheck → vitest → vsce package.

## Trademarks

Anthropic, VS Code and all model-service trademarks mentioned herein belong to their respective owners; this project references them only for factual protocol-compatibility / platform explanation and claims no trademark rights.
