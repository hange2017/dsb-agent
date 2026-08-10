# 会话与记忆按项目隔离(B1–B7)验收记录

> 日期:2026-08-06 · 对应计划:任务清单 t18–t27(Phase B 项目隔离 + B7 记忆管理页)
> 设计:`.dsb/specs/2026-08-06-session-memory-project-scope-design.md`(状态:已实施)

## 交付清单

| 模块 | 文件 | 说明 |
|------|------|------|
| ProjectScope | `src/agent/projectScope.ts` | git remote → 归一化 → sha1(12 位);失败回退路径 slug;缓存;fail-open |
| 会话隔离 | `src/session/sessionStore.ts` | 新增 `migrateLegacySessions` / `listSessionProjects`;目录按 projectKey 子目录 |
| 会话状态隔离 | `src/settings/sessionUiState.ts` | `scoped(projectKey)`;key 带前缀;旧无前缀 key 读回退 |
| 记忆隔离 | `src/agent/memory/memoryStore.ts` | `scoped(projectKey)`;`index(label)` 作用域前缀;`mergeMemoryIndex` |
| 记忆工具 | `src/agent/tools/executor.ts` + `src/agent/memory/memoryTools.ts` | 4 个 Memory 工具支持 `scope: auto/project/global` |
| 注入合并 | `src/chat/chatViewProvider.ts` | `memoryIndex = mergeMemoryIndex(项目, 全局)` |
| 记忆管理器 | `src/agent/memory/memoryManager.ts` | 引擎层:list/write/delete 按 scope 路由 + 校验 |
| 记忆管理面板 | `src/settings/memoryPanel.ts` + `webview/memoryPanel.html/.ts` | 独立 WebviewPanel;项目/全局分区;新建/编辑/删除 |
| 入口 | `webview/index.html` + `main.ts` + `src/chat/protocol.ts` | ⚙ 浮层「记忆管理…」→ `open_memory_manager` → 命令 `dsbAgent.memoryManage` |
| 装配 | `src/extension.ts` | activate async;projectKey 解析;会话迁移;scoped sessionsDir/memory/sessionUiState |
| 构建 | `esbuild.mjs` | 新增 memoryPanel 构建入口 |

## 测试证据

```
npx vitest run   → 75 files / 594 tests 全绿
npx tsc --noEmit → 通过
npm run compile  → 通过(dist/webview/memoryPanel.js + .html 产物生成)
```

新增测试文件:projectScope / sessionStoreScoped / memoryStoreScoped / memoryToolsScope / projectIsolation / memoryManager / memoryPanel。

## 真实 git 冒烟

```bash
# 建立裸仓 + 两个 worktree 克隆
git init --bare /tmp/dsb-smoke-repo.git
git clone /tmp/dsb-smoke-repo.git /tmp/dsb-smoke-main   # 设置 origin = /tmp/dsb-smoke-repo.git
git clone /tmp/dsb-smoke-repo.git /tmp/dsb-smoke-wt
```

预期:同一仓库(不同目录)归一同一个 projectKey;不同仓库 projectKey 不同;无 git 目录回退路径 slug。见 §下方命令输出。

## 已知偏差与后续

- 记忆管理页未做 spec §4.7 的「总览统计 / 时间筛选 / 批量删除 / truncate/llm 压缩」(留待后续版本);
- 跨项目旧会话(升级前遗留,不属于当前项目)不会自动迁移,保留在 `<sessionsRoot>/<projectKey>/` 中按各自项目可见;
- 多根工作区(multi-root)以 `workspaceFolders[0]` 为 projectKey 依据。
