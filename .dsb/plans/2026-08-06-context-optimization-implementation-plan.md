# 上下文优化(会话隔离 + 记忆双作用域 + 记忆管理页 + 技能注入瘦身)实现计划

> **For agentic workers:** 按任务逐条执行,每任务 TDD:先写测试(确认失败)→ 最小实现 → 全绿 → `npm run compile` → commit。
> 关联 spec:
> - `.dsb/specs/2026-08-06-session-memory-project-scope-design.md`
> - `.dsb/specs/2026-08-06-skill-list-injection-optimization-design.md`

**Goal:** 会话按项目严格隔离、持久记忆双作用域(项目/用户)合并注入、提供记忆管理页面(查看/筛选/批量删除/压缩),并把技能列表注入去重+分层瘦身 ~70%。

**Architecture:** 新增纯 TS 的 `ProjectScope`(git remote → projectKey)作为隔离锚点;`SessionStore`/`SessionUiState` 按 projectKey 分目录分 key;`ScopedMemoryStore` 组合 用户级(`~/.dsb/memory`)+ 项目级(`~/.dsb/memory-project/{key}`)两个 `MemoryStore`;记忆管理页复用 `providerSettings` 的 webview 样板(`createWebviewPanel` + 纯 DOM);技能优化落在 `SkillIndex`(按 name+source 去重、按前缀分层)与 `buildSystemPrompt` 渲染。

**Tech Stack:** TypeScript / vitest / esbuild / VS Code extension API(webview)。

## Global Constraints

- 引擎层(src/ 下非 webview 部分)不依赖 `vscode` 模块(可单测)。
- git 命令走 `execFile`(`createGitExec` 模式),不新增 npm 依赖。
- 提交信息用中文,`type(scope): 简述`,一次提交一件事。
- 每任务结束:`npx vitest run` 相关测试全绿 + `npm run compile` 通过才 commit。
- 旧数据不删除:迁移只移动/标记,不销毁。

## File Structure

| 文件 | 责任 |
|------|------|
| `src/agent/projectScope.ts`(新) | projectKey 计算:git remote → 归一化 → sha1 前 12;回退路径 slug;缓存 |
| `src/session/sessionStore.ts`(改) | 构造加 projectKey,目录收进 `{sessionsRoot}/{projectKey}`;`basename` 防穿越 |
| `src/settings/sessionUiState.ts`(改) | key 带 projectKey |
| `src/agent/memory/memoryStore.ts`(改) | `MemoryEntry.scope` 字段;`index()` 支持作用域前缀 |
| `src/agent/memory/scopedMemoryStore.ts`(新) | 组合 project+user;write auto 判定;read/list/delete 合并 |
| `src/agent/memory/memoryTools.ts`(改) | MemoryWrite schema 加 `scope` |
| `src/agent/tools/executor.ts`(改) | Memory 分支走 scoped store |
| `src/agent/systemPrompt.ts`(改) | 记忆段标注作用域;技能段 tier 渲染 |
| `src/chat/chatViewProvider.ts`(改) | 注入 scopedMemory.index();projectKey 传递;处理 `open_memory_manager` |
| `src/chat/memoryManagerPanel.ts`(新) | 记忆管理页 host 工厂(仿 `src/settings/providerPanel.ts`) |
| `src/extension.ts`(改) | 装配;迁移;注册 `dsbAgent.memoryManager` 命令 |
| `src/settings/configuration.ts`(改) | 可选 `dsbAgent.projectKey` 覆盖 |
| `src/session/sessionProgress.ts`(改) | 进度记忆写入走 scoped store |
| `src/plugins/skillIndex.ts`(改) | 按 name+source 优先级去重;`listForPrompt` 分层 |
| `webview/memoryManager.html`(新) | 记忆管理页 DOM |
| `webview/memoryManager.ts`(新) | 页面逻辑:总览/筛选/批量/查看/压缩/删除 |
| `webview/index.html` + `webview/main.ts`(改) | ⚙ 浮层加「记忆管理…」按钮 |
| `src/i18n/strings.ts`(改) | 新键 |
| `tests/*.test.ts`(新/改) | projectScope / scopedMemoryStore / memoryManagerPanel / skillIndex / systemPrompt 等 |

---

## Phase A — 技能列表注入优化(独立、快)

### A1. SkillIndex 按 name+source 优先级去重
- [x] 改 `tests/skillIndex.test.ts`:新增用例——同名不同 source(extension vs project)只保留 project;同名同 source 保留 1
- [x] 改 `src/plugins/skillIndex.ts`:`add()` 按 name 去重,`priority(source)` project=4 > user=3 > extension=2 > plugin=1,高优先级替换低优先级
- [x] 跑 `npx vitest run tests/skillIndex.test.ts` 全绿
- [x] `npm run compile` 通过,commit `fix(skills): SkillIndex 按 name 去重并保留高优先级层`

### A2. SkillIndex 分层 + systemPrompt tier 渲染
- [x] 改 `tests/skillIndex.test.ts`:新增用例——`listForPrompt()` 对 project/user source 与 `sp-*`/`using-*` 返回 full 描述;`as-*` 返回 compact(≤40 字)
- [x] 改 `src/plugins/skillIndex.ts`:`listForPrompt()` 输出 `{name, description, compact}`;tier 推断:source project/user → full;name 前缀 `sp-`/`using-` → full;其余 compact(截 40 字)
- [x] 改 `tests/promptBuilder.test.ts`(或新 systemPrompt 测试):技能段渲染 full 完整、compact 截断、提示行存在
- [x] 改 `src/agent/systemPrompt.ts`:技能段按 `compact` 分支渲染
- [x] 跑相关测试全绿;`npm run compile` 通过;commit `feat(prompt): 技能列表分层注入(流程包全量/工程包紧凑)`

## Phase B — 会话隔离 + 记忆双作用域 + 记忆管理页

### B1. ProjectScope 模块
- [x] 新建 `tests/projectScope.test.ts`:git remote 归一化(https/ssh/带 user@/尾部 .git/大小写)、无 git 回退 slug、缓存、fail-open、worktree 同 remote 同 key
- [x] 新建 `src/agent/projectScope.ts`:`ProjectScope.resolve(root)` + `normalizeRemoteUrl` + sha1 前 12;缓存 map;git 失败回退 slug(复用 `workspaceSlug` 逻辑)
- [x] 测试全绿;`npm run compile`;commit `feat(scope): ProjectScope 按 git remote 计算 projectKey`

### B2. SessionStore 按项目隔离
- [x] 改 `tests/sessionStore.test.ts`:构造带 projectKey;不同 key 目录互不可见;`../` id 拒绝
- [x] 改 `src/session/sessionStore.ts`:构造参数 `sessionsRoot + projectKey`,`dir = join(sessionsRoot, projectKey)`;`fileFor` 用 `basename(id)` 防穿越
- [x] 测试全绿;compile;commit `feat(session): 会话按 projectKey 分目录隔离`

### B3. SessionUiState 按项目
- [x] 改 `tests/sessionUiState.test.ts`:key 带 projectKey,互不覆盖
- [x] 改 `src/settings/sessionUiState.ts`:key 模板 `dsbAgent.lastSessionId.{projectKey}` / `dsbAgent.sessionInterrupted.{projectKey}`
- [x] 测试全绿;compile;commit `feat(session): lastSessionId 按项目隔离`

### B4. MemoryStore.scope + ScopedMemoryStore
- [x] 改 `tests/memory.test.ts` + 新建 `tests/scopedMemoryStore.test.ts`:scope 字段落盘;auto 规则(有项目→project、无→user);同名冲突 project 优先;index 合并带标记;delete 双删
- [x] 改 `src/agent/memory/memoryStore.ts`:`MemoryEntry.scope?`;`index(label)` 支持前缀
- [x] 新建 `src/agent/memory/scopedMemoryStore.ts`:组合 user/project 两实例;`write(entry, scope?)` auto 判定;`read/list/delete` 合并
- [x] 测试全绿;compile;commit `feat(memory): ScopedMemoryStore 双作用域(项目级+用户级)`

### B5. 记忆工具改造
- [x] 改 `tests/tools.test.ts`(或 executor 相关):MemoryWrite 带 scope 路由;MemoryList 带标记;MemoryDelete 双删
- [x] 改 `src/agent/memory/memoryTools.ts`:schema 加 `scope?: "user"|"project"|"auto"`
- [x] 改 `src/agent/tools/executor.ts`:Memory 分支走 scoped store
- [x] 测试全绿;compile;commit `feat(tools): 记忆工具支持 scope 与自动判定`

### B6. 注入合并 + 装配 + 迁移
- [x] 改 `src/agent/systemPrompt.ts`:记忆段渲染作用域标记(数据已带,微调格式)
- [x] 改 `src/chat/chatViewProvider.ts`:projectKey 解析(init 时异步);注入 `scopedMemory.index()`
- [x] 改 `src/extension.ts`:装配 ProjectScope + ScopedMemoryStore;迁移逻辑(旧会话 → legacy/;session-progress-* 反查 git → 项目级);注册命令
- [x] 改 `src/settings/configuration.ts`:`projectKey` 覆盖(可选)
- [x] 改 `src/session/sessionProgress.ts`:进度记忆写入 scoped store
- [x] 改/加测试(迁移幂等、index 合并);全绿;compile;commit `feat(context): 记忆注入合并与迁移,会话按项目恢复`

### B7. 记忆管理页面

> 实施注记(2026-08-06):**范围收缩**——总览统计、时间筛选(7/30/90)、批量删除、批量 truncate、单条 LLM 压缩、清空强校验**未做**;已落地:查看列表(项目/全局分组)、展开/收起、新建、编辑、删除、作用域标签。偏差详见 `.dsb/specs/2026-08-06-session-memory-project-scope-design.md` §8.1。

- [x] 新建 `tests/memoryManagerPanel.test.ts`:scope 列表统计(条数/字节)、truncate 阈值、llm 仅单条(names>1 拒绝)、批量 truncate 跳过 ≤2000、删除/清空路由
- [x] 新建 `src/chat/memoryManagerPanel.ts`:`createMemoryManagerPanel`(仿 `createProviderPanel`)
- [x] 新建 `webview/memoryManager.html` + `webview/memoryManager.ts`:总览/筛选(7/30/90/自定义)/全选/批量删除/批量 truncate/单条 llm/查看全文/清空强校验
- [x] 改 `webview/index.html` + `webview/main.ts`:⚙ 浮层「记忆管理…」按钮
- [x] 改 `src/i18n/strings.ts`:新键(zh/en)
- [x] 改 `src/chat/chatViewProvider.ts`:处理 `open_memory_manager`
- [x] 改 `src/extension.ts`:注册 `dsbAgent.memoryManager` 命令
- [x] 测试全绿;`npm run compile`;commit `feat(ui): 记忆管理页面(查看/筛选/批量/压缩)`

## Phase C — 验收

- [x] `npm test`(全量)全绿
- [x] `npm run compile` 通过
- [x] 手动冒烟:两个 git 仓库各开会话验证会话/记忆互不串扰;同一仓库 worktree 共享;⚙ → 记忆管理页操作
- [x] 更新 `docs/architecture/待优化.md` 勾选/登记本次落地项
- [x] 最终 commit

## 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-06 | 初版:按两份 spec 拆 A(技能优化)/B(会话+记忆)/C(验收)三阶段,每任务 TDD+commit |
