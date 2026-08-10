# 会话与持久记忆按项目作用域隔离 — 设计

> 日期:2026-08-06
> 状态:**已实施(2026-08-06)**;实现偏差与验证见文末「§8 实施记录」
> 关联:docs/superpowers/specs/2026-08-04-session-resume-memory-design.md(会话恢复与进度记忆的既有设计)

---

## 1. 背景与问题

用户在多项目间切换使用 DSBAgent 时发现:

- 在项目 B 打开 agent,会话列表与自动恢复的内容全部来自项目 A;
- 系统提示注入的「持久记忆」混有项目 A 的记忆条目(如 CrobotpStudio 的踩坑记录),与当前项目 B 无关;
- 现有实现中 **会话与记忆均为全局存储,无任何项目隔离**:

| 项 | 现状 | 位置 |
|----|------|------|
| 会话文件 | `{globalStorageUri}/sessions` 全局平铺目录 | `extension.ts:303` |
| 上次会话 id | 全局 memento `dsbAgent.lastSessionId` | `sessionUiState.ts` |
| 记忆文件 | `~/.dsb/memory` 全局目录 | `configuration.ts:memoryDir()` |
| 记忆注入 | `MemoryStore.index()` 全量注入,无作用域标记 | `chatViewProvider.ts:313` |
| 会话进度记忆 | 已按 `session-progress-{workspaceSlug}` 命名,但注入不做过滤 | `sessionProgress.ts` |

## 2. 目标与非目标

### 目标

1. **会话(history)严格按项目隔离**:会话文件、列表、上次会话 id 全部按项目 key 区分;切换项目不残留、不误恢复。
2. **持久记忆分两个作用域**:
   - **项目级(project)**:与特定项目强绑定(架构决策、踩坑、本项目约定),按项目隔离;
   - **用户级(user)**:跨项目通用(编码偏好、工具习惯、通用知识),全局共享。
3. **注入采用合并方式**:system prompt 的「持久记忆」段 = 当前项目级 + 用户级,并**标注每条记忆的作用域**。
4. **项目判定按 git remote**:同一仓库的多个 worktree(不同目录)算同一个项目。
5. **记忆作用域自动判断**:MemoryWrite 时用户/agent 无需显式指定,系统按上下文自动归类;同时提供显式 `scope` 参数供需要时覆盖。
6. **记忆管理页面**:在 ⚙ 设置中提供「记忆管理…」入口,打开独立页面,可按项目查看/删除/压缩记忆,解决记忆条目过多、占用存储与注入体积膨胀的问题。

### 非目标

- 不改动技能/规则/DSB.md 的项目级+用户级双轨(该机制已满足需求,作为记忆的参照)。
- 不做"团队共享记忆"(记忆文件入库随仓库走)——留待后续。
- 不改动会话压缩(ContextManager)与记忆内容生成逻辑本身。
- 不解决 system prompt 会话中途热更问题(P0-4 另立条目)。
- 不做记忆自动过期/自动压缩(仅记忆管理页手动触发);自动清理策略(如 N 天未访问自动归档)留待后续版本。

## 3. 核心概念:项目 key(projectKey)

`projectKey` 是隔离的锚点,由 `ProjectScope` 模块计算:

```
projectKey(root: string): Promise<string>
```

**判定优先级**:

1. **git remote 优先**:在 `root` 执行 `git remote get-url origin`;
   - 成功 → 归一化 URL 后取 SHA-1 前 12 位作为 key;
   - 归一化规则:去空白、去尾部 `.git`、统一小写、剥离 `https://`/`http://`/`ssh://`/`git@`/`git://` 前缀、剥离 URL 中的用户信息(`user@`)。
   - **同一仓库多 worktree**:任意 worktree 的 root 执行 `git remote get-url origin` 返回同一 URL → 同一 key。✅
2. **回退:workspace 路径 slug**:非 git 仓库 / 无 origin / git 命令失败 → 复用现有 `workspaceSlug`(小写化路径 slug),与 `sessionProgress.ts` 一致。

**工程约束**:

- 引擎层纯 TS,复用 `createGitExec()`(execFile)模式,不新增依赖;
- **惰性 + 缓存**:`ProjectScope` 构造不触碰文件系统;首次调用计算后缓存,同一会话内不重复 exec git;
- **fail-open**:git 命令失败绝不抛错,回退路径 slug;
- 多根工作区(multi-root):取 `workspaceFolders[0]` 为主 root,文档注明此约定;
- 计算失败(极端情况)回退 `"default"`,保证可用性。

## 4. 设计

### 4.1 会话按项目隔离

**目录布局**(保持平铺、以子目录分项目,`list()` 只扫当前项目目录):

```
{globalStorageUri}/sessions/
  {projectKey}/
    s_xxx.jsonl        # 会话事件
    s_xxx.api.json     # API 历史真相源
    s_xxx.todos.json   # 待办
  legacy/              # 迁移时无法判定归属的旧会话
```

- `SessionStore` 构造参数改为接收 `sessionsRoot` + `projectKey`:
  - `dir = path.join(sessionsRoot, projectKey)`;
  - `list()/create()/load()/saveApiHistory()/saveTodos()/delete()` 全部限定在 `dir` 内;
  - `fileFor(id)` 增加路径穿越防御:`path.basename(id)` 后再拼,拒绝 `../` 类 id。
- `chatViewProvider` 构造时传入由 `ProjectScope` 计算的 projectKey(异步获取,在 `init` 时 resolve,不阻塞 activate)。

### 4.2 上次会话 id 按项目

`VscodeSessionUiState` 的 key 改为带 projectKey:

```
dsbAgent.lastSessionId.{projectKey}
dsbAgent.sessionInterrupted.{projectKey}
```

- `SessionUiState` 接口改为按 projectKey 读写:`getLastSessionId(projectKey)` / `setLastSessionId(projectKey, id)` 等;
- 旧全局 key 不再读取(由迁移章节处理)。

### 4.3 记忆双作用域存储

**目录布局**:

```
~/.dsb/memory/                  # 用户级(与现状完全兼容,无需移动)
  user-preference.json
~/.dsb/memory-project/          # 项目级(新)
  {projectKey}/
    crobotpstudio-xxx.json
```

- `MemoryStore` 改为**双实例**:`MemoryStore` 保持单目录能力不变,新增 `ScopedMemoryStore`(或扩展构造)组合两个实例:
  - `user: MemoryStore(~/.dsb/memory)`(沿用 `configuration.memoryDir()`,兼容自定义配置);
  - `project: MemoryStore(~/.dsb/memory-project/{projectKey})`;
- **不放在工作区 `.dsb/memory`**:因同一仓库多 worktree 目录不同,放工作区会导致"同一项目多份记忆"。

**作用域标记**:`MemoryEntry` 增加 `scope?: "user" | "project"` 字段(写入时落盘,便于迁移与展示);`index()` 输出每行前缀 `(项目)` 或 `(全局)`。

### 4.4 记忆工具扩展 + 自动判断

| 工具 | 变更 |
|------|------|
| `MemoryWrite` | 新增可选参数 `scope?: "user" \| "project" \| "auto"`(默认 `"auto"`) |
| `MemoryRead` | 语义改为"按 name 在 项目级→用户级 依次查找,先命中先返回";命中条目带作用域返回 |
| `MemoryList` | 合并列出 项目级 + 用户级,每行带作用域标记 |
| `MemoryDelete` | 两个作用域都尝试删除,返回删除结果(如 `Deleted (project)` / `Not found`) |

**`auto` 判断规则**(简单可预测,不搞内容启发式):

1. 当前会话存在 projectKey 且非 `"default"` → **写入项目级**;
2. 否则(无 workspace / 非 git / 无法判定)→ **写入用户级**;
3. `MemoryList`/注入的索引**总是合并两个作用域**,与写入规则无关。

> 理由:绝大多数记忆发生在项目会话内,且项目记忆隔离优先级最高;"非项目会话写用户级"天然形成用户级入口,无需用户感知作用域。需要强制用户级时用显式 `scope: "user"`(供 agent 从规则/DSB.md 得知用户偏好后使用)。

**同名冲突策略**:同名条目在项目级与用户级并存时,`MemoryRead` 项目级优先(更具体);注入索引中两条都列出,标注作用域,由 agent 判断。

### 4.5 注入合并

- `buildSystemPrompt` 的 `memoryIndex` 段改为带作用域标记的合并索引:

```
## 持久记忆
(项目) session-progress-deepseekagent: 会话进度 · 0 待办
(全局) user-preference: 用户偏好:中文回复
(用 MemoryRead 读全文;记忆可能过时,以当前上下文为准)
```

- `chatViewProvider` 构建 prompt 处(`:313`)改为:

```
memoryIndex: scopedMemory.index()  // 内部 = project.index() + user.index(),带作用域
```

- 约定:project 段在前、user 段在后,条目各按 updatedAt 倒序。

### 4.6 迁移(一次性)

在 `extension.activate` 中异步执行,幂等(用标记文件 `~/.dsb/.scope-migration-v1` 控制):

1. **旧会话**:`{globalStorageUri}/sessions/*.jsonl` 平铺文件 → 无法判定归属(SessionEvent 无 workspace 字段)→ 移入 `legacy/` 子目录,不再出现在任何项目列表;不删数据。
2. **旧记忆**:`~/.dsb/memory/*.json`:
   - 默认全部视为**用户级**(保持可读,兼容旧行为);
   - 仅对 `session-progress-{workspaceSlug}` 命名的条目做启发式迁移:由 slug 反查路径,若该路径存在且 `git remote get-url origin` 成功 → 移动到对应 `~/.dsb/memory-project/{projectKey}/`;否则保留用户级。
   - 其余旧条目不动(避免误判);文档提示用户可将通用偏好条目保留在用户级、将项目强相关条目用 `MemoryWrite scope: "project"` 重写。

### 4.7 记忆管理页面

**入口**:仿照「供应商与模型…」按钮模式(`docs/superpowers/specs/2026-08-05-settings-provider-entry-design.md`):

- ⚙ 设置浮层新增按钮「记忆管理…」(英文 `Memories…`);
- 点击 → 关闭浮层 → 发送 `{ type: "open_memory_manager" }` → host 执行命令 `dsbAgent.memoryManager`,打开独立 webview 面板(复用 `providerSettings` 的样板:`createWebviewPanel` + `webview/memoryManager.html` + `webview/memoryManager.ts`,纯 DOM 无框架)。

**页面结构(两级视图)**:

1. **总览列表**:每个作用域一张卡片,显示 名称(用户级 / 项目名)/ 记忆条数 / 总字节数 / 更新时间:
   - 用户级卡片固定置顶(项目级卡片按总字节降序);
   - 项目卡片的可读名称:优先取项目内 `.dsb/DSB.md` 或 git remote URL 的 repo 名;解析失败显示 projectKey 前 8 位。
2. **展开单条记忆**:点击卡片进入条目列表:每条显示 `name` / `description` / `body 字符数` / `updatedAt`(相对时间);
   - 行内操作:**查看全文**(可折叠/弹出)、**压缩**、**删除**;
   - **批量区**(列表顶部工具栏):
     - **时间筛选**:下拉选择更新时间范围 `全部 / 最近 7 天 / 最近 30 天 / 最近 90 天 / 自定义天数`(webview 端按条目 `updatedAt` 本地过滤,host 一次性下发完整 entries,不加协议复杂度);
     - **全选**:勾选当前筛选结果的全部条目(筛选变化时选区重置);
     - **批量操作**:批量删除、批量压缩(**仅 truncate 模式**);
     - 顶部另有 返回总览、清空本作用域(输入 projectKey 首 4 位强确认)。

**host 协议**(`MemoryManagerPanel` 工厂 + webview 双向消息,均仿照 provider 面板):

```
host → webview:
  { type: "state"; scopes: ScopeView[]; locale }   // ScopeView = { kind:"user"|"project"; projectKey?; label; entries; totalBytes }
  { type: "toast"; message; error? }

webview → host:
  { type: "ready" }
  { type: "open_scope"; projectKey? }                       // kind:user 无 key
  { type: "read_memory"; projectKey?; name }                // 返回全文 body
  { type: "delete_memory"; projectKey?; names: string[] }   // 单条/批量共用
  { type: "clear_scope"; projectKey? }
  { type: "compact_memory"; projectKey?; names: string[]; mode: "truncate" | "llm" }
  // truncate 支持批量(names 数组);llm 仅允许单条(names.length === 1)
```

**压缩策略**:

- **truncate(默认,零成本)**:body 超过 `kMemoryCompactChars`(默认 2000 字符)时截断,保留开头结构(标题/要点),末尾追加 `...\n(已压缩:由记忆管理页截断)`;不调模型、不耗 token;**支持批量**(批量时逐条执行,≤2000 的条目跳过并在结果中注明)。
- **llm(可选)**:调用当前 active provider 对 body 做摘要(输入 >800 字符才允许;无 provider/apiKey 时按钮禁用并 toast 提示);摘要结果作为新 body,原 body 丢弃前先写入备份(`.bak` 同名文件,7 天后可被再次压缩时清理)。**仅支持单条**(names 长度必须为 1,批量勾选多条时该按钮禁用),防止误触批量触发巨额 token 消耗。
- 压缩后 `description` 不变,`updatedAt` 刷新;压缩历史不保留多次版本(仅 1 份 `.bak`)。

**存储统计**:`totalBytes` 由 host 端 `fs.statSync` 累加该作用域目录下所有 `.json` 文件大小;`body 字符数` = `body.length`(内存中读取,不额外 IO)。

**边界**:

- 空作用域(目录不存在/无条目):总览不显示该卡片;用户级目录存在但为空时显示「(空)」灰卡片,可整卡隐藏(默认隐藏)。
- 删除/清空操作**不可撤销**:单条删除前二次确认(`confirm()`);**批量删除**额外显示将删除 N 条(含筛选范围说明);**清空**输入 projectKey 首 4 位强校验。
- **批量 llm 压缩禁用**:批量勾选多条时 llm 压缩按钮置灰(工具提示"llm 压缩仅支持单条"),truncate 批量不受限。
- 页面打开期间外部(agent 工具)新增/删除记忆:每次进入 scope 或点击刷新按钮时重新拉取 `state`,不做实时同步。

## 5. 边界与回退

| 场景 | 行为 |
|------|------|
| 非 git 仓库 | projectKey = 路径 slug;隔离仍生效(按目录) |
| 同一目录被不同方式打开(symlink) | 路径 slug 可能不同;文档注明以 `git remote` 为准 |
| git 命令慢/失败 | fail-open 到路径 slug;结果缓存 1 小时 |
| 同一 remote 两个不同项目(罕见,如 monorepo 复用 URL) | 视为同一项目;文档注明可用自定义 `dsbAgent.projectKey` 覆盖 |
| 用户自定义 `dsbAgent.memoryDir` | 用户级目录跟随该配置;项目级仍为 `memory-project` |
| 会话中途切换工作区(打开另一文件夹) | 本期不热更 system prompt(沿用现状);新会话按新 projectKey 起 |

## 6. 影响文件

| 文件 | 变更 |
|------|------|
| `src/agent/projectScope.ts`(新) | `ProjectScope`:projectKey 计算(git remote→归一化→hash;回退 slug)+ 缓存 |
| `src/session/sessionStore.ts` | 构造参数加 projectKey,目录收进 `{sessionsRoot}/{projectKey}`;basename 防穿越 |
| `src/settings/sessionUiState.ts` | key 带 projectKey;接口加参数 |
| `src/agent/memory/memoryStore.ts` | `MemoryEntry.scope` 字段;`index(scopeLabel)` 支持作用域前缀 |
| `src/agent/memory/scopedMemoryStore.ts`(新) | 组合 project+user 两实例;write auto 判定;read/list/delete 合并 |
| `src/agent/memory/memoryTools.ts` | 工具 schema 加 `scope`;描述更新 |
| `src/agent/tools/executor.ts` | Memory 分支改走 scoped store,`scope` 参数解析 |
| `src/agent/systemPrompt.ts` | memoryIndex 段标注作用域(数据侧已带标记,格式微调) |
| `src/chat/chatViewProvider.ts` | 注入 scopedMemory.index();projectKey 传递;init 恢复按项目 key;处理 `open_memory_manager` |
| `src/extension.ts` | 装配 ScopedMemoryStore 与 ProjectScope;迁移逻辑;注册 `dsbAgent.memoryManager` 命令 |
| `src/settings/configuration.ts` | 新增 `projectKeyOverride`(可选,`dsbAgent.projectKey`) |
| `src/session/sessionProgress.ts` | 进度记忆写入走 scoped store(自动判项目级) |
| `webview/memoryManager.html`(新) | 记忆管理页 DOM + CSP(复制 providerSettings 样板) |
| `webview/memoryManager.ts`(新) | 页面逻辑:总览/条目列表/查看/压缩/删除/清空,协议同上 |
| `webview/index.html` + `webview/main.ts` | ⚙ 浮层加「记忆管理…」按钮 → `open_memory_manager` |
| `src/i18n/strings.ts` | 新增「记忆管理…」「记忆条数」「总占用」等键(zh/en) |

## 7. 测试计划

- `projectScope` 单测:remote 归一化(https/ssh/带用户/尾部.git/大小写)、无 git 回退、缓存、fail-open;
- `sessionStore` 单测:不同 projectKey 目录互不可见、`../` id 拒绝、legacy 迁移;
- `scopedMemoryStore` 单测:auto 规则(有项目→project、无→user)、同名冲突优先级、index 合并与标记、delete 双删;
- `memoryManagerPanel` 单测:scope 列表统计(条数/字节)、truncate 压缩阈值、llm 模式无 provider 时拒绝且仅允许单条(names>1 拒绝)、批量 truncate 逐条执行并跳过 ≤2000 的条目、删除/清空路由到正确作用域;
- 集成冒烟(manual):两个 git 仓库各开会话,验证列表/恢复/记忆注入互不串扰;同一仓库两个 worktree 验证共享项目记忆与进度;
- UI 冒烟(manual):⚙ →「记忆管理…」→ 总览显示用户级+各项目卡片;进入项目时间筛选(7/30/90 天)与全选;批量删除 N 条确认;批量 truncate 压缩;批量勾选多条时 llm 压缩按钮置灰;中英文案切换;清空强校验生效。

## 8. 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-06 | 初版:按用户确认的方向(history 严格隔离;memory 双作用域合并注入;git remote 判定;auto 判断)编写 |
| 2026-08-06 | 修订:项目级记忆目录定为 `~/.dsb/memory-project/{projectKey}`(方案 A);新增 §4.7 记忆管理页面(⚙ 入口、两级视图、truncate/llm 压缩、host 协议) |
| 2026-08-06 | 修订:确认压缩参数(truncate 阈值 2000、llm 压缩手动选且单条);追加批量能力(时间筛选 全部/7/30/90 天/自定义、全选、批量删除、批量 truncate 压缩;批量 llm 禁用) |
| 2026-08-06 | **实施完成**:B1–B7 全部落地,594 vitest + tsc + esbuild 通过;实现偏差与验证见下 |

## 8.1 实施记录与偏差(2026-08-06)

实现以 §1–§5 目标为准,以下为落地时的具体决策(与文本表述的差异,均以本节约定为准):

| # | 项 | 实现 | 与 spec 文本的差异 |
|---|----|------|--------------------|
| 1 | 记忆目录布局 | 项目级 = `~/.dsb/memory/{projectKey}/`(即 `memoryRoot.scoped(projectKey)`),根目录 `~/.dsb/memory/` 即全局作用域 | spec §4.3 曾定为 `~/.dsb/memory-project/{projectKey}`;实现改为根目录 = 全局,旧全局记忆**零迁移**兼容(所有旧 `~/.dsb/memory/*.json` 天然成为全局记忆,所有项目可见) |
| 2 | 术语 | 用 `project` / `global`(spec 文本用 user/global) | 全局即用户级;工具参数 `scope: "auto" \| "project" \| "global"` |
| 3 | 会话目录 | `<globalStorage>/sessions/{projectKey}/`;旧版根目录平铺会话**迁移到当前项目目录**(`migrateLegacySessions`),会话 id 不变,`lastSessionId` 仍可恢复 | spec §4.6 曾建议移入 `legacy/`;实现改为迁入当前项目(可恢复性更好);跨项目旧会话在后续打开对应项目时不再自动迁移(无归属信息) |
| 4 | lastSessionId | key 带前缀 `dsbAgent.lastSessionId.{projectKey}`;读时**回退旧无前缀 key**(升级兼容) | spec 曾要求"旧 key 不再读取",实现保留回退,升级后自动恢复旧会话 |
| 5 | MemoryDelete | 按 `scope` 删除:auto/project 只删项目,global 显式删全局(防误删全局同名) | spec §4.4 曾写"两个作用域都尝试删除";实现为更安全的按 scope 删除 |
| 6 | MemoryRead auto | 项目优先,未命中回退全局;命中带作用域返回 | 与 spec 一致 |
| 7 | MemoryList / 注入索引 | 合并项目 + 全局,每条带 `(项目)` / `(全局)` 前缀 | 与 spec §4.5 一致 |
| 8 | 入口 | ⚙ 设置浮层「记忆管理…」按钮(`open_memory_manager`)+ 命令 `dsbAgent.memoryManage`(记忆管理面板) | 面板为独立 WebviewPanel(`webview/memoryPanel.html/.ts` + `src/settings/memoryPanel.ts`),协议 host↔webview:`state` / `toast` / `memory_write` / `memory_delete`;未做 spec §4.7 的总览统计与 truncate/llm 压缩(留待后续) |
| 9 | ProjectScope | `git remote get-url origin` → 归一化(去协议/用户信息/尾部 .git/scp-like 冒号转斜杠/小写)→ sha1 前 12 位;失败回退路径 slug;`current()` 无根时回退 `"default"` | 与 spec §3 一致,并支持 https/ssh 同仓库归一同 key |
| 10 | 引擎层约束 | `ProjectScope`/`MemoryManager`/`SessionStore`/`memoryPanel` 均为无 vscode 运行时依赖的纯 TS(仅 `memoryPanel.ts` 引用 `vscode.Uri` 类型,测试用 `vi.mock("vscode")`) | 遵循仓库规则「引擎层不直接依赖 vscode」 |

**验证证据**:
- `npx vitest run`:75 files / **594 tests** 全绿(新增:`projectScope`、`sessionStoreScoped`、`memoryStoreScoped`、`memoryToolsScope`、`projectIsolation`、`memoryManager`、`memoryPanel`);
- `npx tsc --noEmit` 通过;`npm run compile`(esbuild:extension + main + providerSettings + memoryPanel)通过,`dist/webview/memoryPanel.*` 产物生成;
- 真实 git 冒烟:当前仓库无 origin 时 `ProjectScope.current()` 正确回退 slug(`home-hange-projects-deepseekagent`)。
