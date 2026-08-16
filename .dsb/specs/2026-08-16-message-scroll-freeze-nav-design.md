# 消息区滚动跟随冻结 + ▲▼ 轮次导航 — 设计说明

> 生成时间:2026-08-16
> 状态:已批准(方案一)
> 涉及文件:`webview/main.ts`、`webview/styles.css`、`webview/index.html`、新增 `webview/navTargets.ts` + `tests/navTargets.test.ts`

## 1. 背景与问题

Agent 处理任务时,消息区会随时间线持续刷新(流式文本、工具调用状态、新消息),现有 `scrollBottom()` 无条件滚底,导致用户在查看历史内容时被新内容"拽回底部",无法稳定查看/分析中间某条内容。

### 现有实现要点(探索结论)

- `webview/main.ts:132` `scrollBottom()` 在 **6 处**调用:流式每个 chunk(`stream` case)、新消息(`message` case)、工具状态(`renderTimelineStep`)、用户消息、权限条、历史窗口打开。
- 已有历史懒加载 `loadMoreHistoryRounds`(上滚到 `scrollTop<=48` 时往顶部插入旧轮次,并用 `prevScrollTop + (scrollHeight - prevHeight)` 保持视口位置),是本设计可复用的基础。
- DOM 锚点:
  - **USER 框**(用户输入)= `.msg.user`
  - **DSB 框**(助手最终回复)= `.msg.assistant .timeline .tl-step.tl-text.final .tl-text-body`
  - 布局:`body` 为 flex column,`#messages` 是唯一滚动容器(`flex:1; overflow-y:auto`)。

## 2. 目标

1. **冻结跟随**:用户上滚查看历史时,新内容不再把视口拽回底部;滚回底部附近自动恢复跟随。
2. **▲▼ 轮次导航**:消息区左缘悬浮两个三角按钮——▲ 跳到上一个 USER 框,▼ 在跟随态回底部/非跟随态跳到下一个 DSB 框。
3. **动画**:平滑滚动 + 目标框短暂高亮 + 按钮按压反馈。
4. **健壮性**:连续多个 USER 框不卡死;无目标时有明确兜底。

## 3. 设计

### 3.1 冻结跟随(stick-to-bottom)

状态机:

```
stickToBottom = true(默认跟随)
距底距离 d = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
scroll 事件(rAF 节流):
  d > 64px  → stickToBottom = false(冻结)
  d <= 64px → stickToBottom = true(恢复)
```

- 现有全部 `scrollBottom()` 调用点改为 `if (stickToBottom) scrollBottom()`。
- 程序性滚动(导航跳转 / 历史懒加载)期间用 `suppressStickCheck` 标志屏蔽 scroll 事件的状态重算,防止误判。
- 阈值 64px:普通滚轮一格的行进距离,留出"接近底部"缓冲,避免用户滚到底部前被反复冻结/恢复抖动。

### 3.2 ▲▼ 导航按钮

DOM 结构(index.html):

```html
<main id="messages"></main>
<div id="timelineNav">
  <button id="navUp" title="上一个用户输入" aria-label="上一个用户输入">▲</button>
  <button id="navDown" title="下一个回复 / 回到最新" aria-label="下一个回复 / 回到最新">▼</button>
</div>
```

- `#timelineNav` 绝对定位于 `#messages` 左缘垂直居中(`position:absolute; left:6px; top:50%; transform:translateY(-50%); z-index:20`),半透明,`hover` 加深。
- `#messages` 外包一层 `#chatArea`(`position:relative; flex:1; min-height:0`),`#messages` 高度由 `#chatArea` 撑起。
- **常驻可见**(半透明),符合"看到就能点"。

行为表:

| 状态 | ▲ 上 | ▼ 下 |
|---|---|---|
| 跟随中(底部) | 跳到上一个 USER 框,冻结跟随(`stickToBottom=false`) | 回到底部 + 恢复跟随(`stickToBottom=true`) |
| 已上滚(查看历史) | 跳到上一个 USER 框 | 跳到下一个 DSB 框;若下方无 DSB → 兜底回底部 + 恢复跟随 |

### 3.3 导航目标选择(纯函数)

抽成 `webview/navTargets.ts`,不依赖 DOM,便于单测:

```ts
export interface NavAnchor { id: string; kind: "user" | "dsb"; top: number; bottom: number; }
export function pickNavTarget(
  anchors: NavAnchor[],      // 按 DOM 序排列
  refTop: number,            // 基准 = 视口顶部(或当前可视区中心)
  dir: "up" | "down",
  stickToBottom: boolean,
): NavAnchor | null
```

语义:

- **▲(up)**:在 `refTop` 之上找**最近**的 `kind==="user"` 锚点。
- **▼(down)**:
  - `stickToBottom === true` → 返回 null(由调用方处理为"回底部+恢复跟随")
  - `stickToBottom === false` → 在 `refTop` 之下找**最近**的 `kind==="dsb"` 锚点;找不到 → 返回 null(调用方兜底回底部)
- **连续 USER 框**:不缓存锚点列表,每次点击实时从 DOM 收集;「上一个 USER」按位置严格取最近,连续 USER 逐个跳,天然健壮。

### 3.4 动画

- 跳转:`messagesEl.scrollTo({ top: targetTop - 16, behavior: "smooth" })`(目标框顶部对齐视口顶部上方 16px)。
- 目标框高亮:加 `.nav-flash` class(淡蓝描边闪烁,`animation: navFlash 0.9s ease-out`),`animationend` 后移除。
- 按钮按压:`:active { transform: scale(0.92); }` + 颜色加深。

### 3.5 与历史懒加载的协同

- 目标可能在未渲染历史中(`pendingRounds`):▲ 导航时,若 `pendingRounds.length>0` 且当前无可跳 USER,循环调用 `loadMoreHistoryRounds()` 直到目标 USER 渲染或缓存耗尽,再执行跳转(最多一次性加载全部剩余轮次)。
- 历史懒加载的视口保持逻辑不变(程序滚动期间 `suppressStickCheck=true`)。

## 4. 测试策略

- `tests/navTargets.test.ts`:纯函数 `pickNavTarget` 单测——连续 USER、无目标、上下方向、跟随态 ▼、边界(最早/最晚)、refTop 恰在锚点之间。
- 全量 `npm test` + `npx tsc --noEmit` 必须通过。
- DOM 集成(滚动冻结、按钮、动画)手工验证:`npm run build` 后起扩展人工操作。

## 5. 验收标准

- [ ] 运行中上滚 → 新流式内容不再拽动视口;滚回底部 → 恢复跟随。
- [ ] ▲ 在任意状态跳到上一个 USER 框(连续 USER 逐跳不卡死)。
- [ ] 跟随态 ▼ 回底部并恢复跟随;非跟随态 ▼ 跳到下一个 DSB 框,无目标时兜底回底部。
- [ ] 跳转有平滑滚动 + 目标框高亮动画。
- [ ] 历史懒加载(上滚到顶加载旧轮次)与导航协同正常,视口不跳。
- [ ] 全量测试与编译通过。

## 6. 非目标(本次不做)

- 不改变消息渲染 / 历史重放 / 懒加载既有逻辑。
- 不做"回到最新"悬浮气泡(▼ 按钮已覆盖该场景)。
- 不做工具栏图标、快捷键绑定。
