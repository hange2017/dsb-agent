# SDD ledger — plan: .dsb/plans/2026-08-14-platform-tools.md

> 适配环境:2026-08-15 复核时仓库为 `/mnt/share/DSBAgent/dsb-agent`(git 仓库,有 node/vitest),测试证据 = 实际运行 vitest + tsc --noEmit。

## 任务状态

<!-- 每任务完成后追加:
Task <N>: complete (实现: <files>; 校验: <result>)
Task <N>: minor (deferred): <one-liner>
Task <N>: parked — <finding> — ruling: <why>
-->

Task 1: complete (实现: `src/agent/tools/types.ts`(ToolDef.platforms + ToolExecContext.platform)、`src/agent/tools/platformGate.ts`、`tests/platformGate.test.ts`、`src/agent/tools/executor.ts`(allToolDefs 经 filterToolDefs 过滤); 校验: vitest platformGate.test.ts 4/4 PASS)

Task 2: complete-with-deviations (实现: `src/util/platformInfo.ts`、`src/agent/systemPrompt.ts`(buildRunEnvSegment「运行环境」段)、`src/chat/chatViewProvider.ts`(platform 传入)、`tests/systemPrompt.test.ts`、`tests/platformMatrix.test.ts`; 偏差: ① 未建独立 `tests/platformInfo.test.ts`,由 platformMatrix 覆盖; ② Grep 描述已于 2026-08-15 晚补「降级为纯 Node」; 校验: systemPrompt + platformMatrix PASS)

Task 3: complete-with-deviation (实现: `src/agent/tools/executor.ts` resolveRgBinary PATH 兜底(`findRgOnPath`); 偏差: 计划要求的 `ripgrepPath.ts: pickRipgrepPathFromEnv` 未落位,改为 executor 内部函数(功能等价); 校验: platformMatrix PATH 场景 PASS)

Task 4: complete (实现: `src/agent/tools/grepFallback.ts`、`tests/grepFallback.test.ts`、`executor.runGrep` 降级; 校验: grepFallback.test.ts PASS)

Task 5: complete-with-deviations (实现: CHANGELOG 平台适配段、CI 三平台矩阵、PowerShell/MCP/插件门禁超出 B1; 校验: 相关测试 + tsc; `_src.txt` 已在 Commit 时删除)

Commit: complete (2026-08-15) — `875174e feat(tools): platform gate, Grep fallback, and OS-aware Bash prompts`

Follow-up (2026-08-15 晚): Grep 描述缺口关闭(`definitions.ts`); bbb 计划 Task2 Step6 已勾选。

Docs migration (2026-08-15): 设计/计划/实现记录/手册/SDD 已迁入 `dsb-agent/.dsb/`(canonical);`bbb/` 为同步副本。计划 checkbox 已全部对齐现状(含接受偏差项)。
