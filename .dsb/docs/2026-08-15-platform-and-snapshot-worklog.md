# 工作记录：2026-08-14 20:00 → 2026-08-15（平台工具 + Snapshot Store）

> 范围对照：`bbb/` 计划与 SDD、`dsb-agent/.dsb` 设计/计划、仓库根 `.dsb` checkpoints、以及 `dsb-agent` 源码。
> 状态：功能已实现；本文档为交付与审计备忘。

## 1. 功能线 A — 平台感知与工具门禁（B1 + B3）

### 文档

| 路径 | 角色 |
|------|------|
| `bbb/plans/2026-08-14-platform-tools.md` | 实现计划（Task 1–5） |
| `bbb/sdd/platform-tools/progress.md` | SDD 进度账本 |
| `bbb/docs/toolchain-instability-handbook.md` | Windows 工具链不稳定手册 |
| `dsb-agent/.dsb/docs/toolchain-issues.md` | 工具链问题日志（过程） |

### 实现要点

- `ToolDef.platforms` + `filterToolDefs`；`allToolDefs` 按平台过滤
- `platformInfo` + 系统提示「运行环境」段；Bash 描述平台化
- Grep：`findRgOnPath` PATH 兜底；`grepFallback` 纯 Node 降级
- **Grep 描述已补**：「rg 不可用时自动降级为纯 Node 行扫描」
- B3：PowerShell 专用工具、MCP/插件 `platforms`、CI 三平台矩阵
- Git：`875174e feat(tools): platform gate, Grep fallback, and OS-aware Bash prompts`

### 已知可接受偏差

- PATH 兜底落在 `executor.findRgOnPath`（非计划中的 `ripgrepPath.pickRipgrepPathFromEnv`）
- 无独立 `platformInfo.test.ts`（`platformMatrix` 覆盖）

## 2. 功能线 B — Snapshot Store（统一裁剪切点归档）

### 文档

| 路径 | 角色 |
|------|------|
| `.dsb/specs/2026-08-14-snapshot-store-design.md` | 已批准设计 |
| `.dsb/plans/2026-08-14-snapshot-store.md` | Step 1–8 实现计划 |
| `.dsb/sdd/snapshot-store/progress.md` | SDD 进度账本 |

### 实现要点

- `ContextStore`：`*.context.ndjson` 追加 + 索引偏移；旧 `*.context.json` 惰性迁移
- `SnapshotQueue`：debounce 50ms / batch 16 / 重试 / **flushNow 串行化**（防并发偏移错乱）
- 上限：全量 50MB、thinking 8MB；compact 触发：>500 条或内容 >8MB
- 裁切归档：thinking / toolResult / `StrReplace.old_string` → append + `[r{seq}]`；回合结束 `flush`
- **注入**：`ChatViewProvider` 创建 **一个** `sharedContextStore`，同时交给 `ChatController`、`ToolExecutor`、`AgentSession`（ContextRecall 可用）
- 测试：store/queue/offsets/policy helpers + **agentLoop 全链**（trim→archive→flush→get/ContextRecall）
- CHANGELOG：`[Unreleased]` Snapshot Store 条目

### 已知可接受偏差

- thinking 标记 = 既有精简文案 + `[r{seq}]`（非纯替换）
- flush 失败后磁盘批次 drop；内存 chunks 仍在

## 3. 硬缺口收尾（2026-08-15 晚）

| # | 缺口 | 处理 |
|---|------|------|
| 1 | Grep 描述未写降级 | 已改 `definitions.ts`；bbb 计划 Step6 勾选 |
| 2 | Snapshot 未提交 | 本批次 commit |
| 3 | 无 Snapshot SDD 账本 | 新增 `.dsb/sdd/snapshot-store/progress.md` |
| 4 | 无 agentLoop 全链集成测 | 新增 `tests/agentLoop.test.ts` 分组 |
| 5 | Controller / Session 双 ContextStore | 改为 Provider 级 `sharedContextStore` |

## 4. 非功能交付

- 仓库根 `.dsb/checkpoints`：会话恢复现场，非产品交付物
- `toolchain-issues.md` / handbook：开发体验文档

## 5. 验证命令（本机）

```bash
cd dsb-agent
npx vitest run tests/snapshotQueue.test.ts tests/contextStore.test.ts tests/contextStoreOffsets.test.ts \
  tests/thinkingPolicy.test.ts tests/toolResultPolicy.test.ts tests/toolUsePolicy.test.ts \
  tests/contextRecall.test.ts tests/agentLoop.test.ts
npx tsc --noEmit
```
