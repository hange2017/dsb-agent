# 消息区滚动跟随冻结 + ▲▼ 轮次导航 — 实现计划

> 生成时间:2026-08-16
> 设计:`.dsb/specs/2026-08-16-message-scroll-freeze-nav-design.md`
> 涉及文件:
> - 新增 `webview/navTargets.ts`(纯函数)
> - 新增 `tests/navTargets.test.ts`
> - 修改 `webview/index.html`(#chatArea 包裹 + #timelineNav)
> - 修改 `webview/styles.css`(#timelineNav / .nav-flash / 动画)
> - 修改 `webview/main.ts`(stickToBottom 状态机 + 6 处 scrollBottom 改造 + 导航事件)

## API 契约(navTargets.ts)

```ts
export interface NavAnchor {
  id: string;
  kind: "user" | "dsb";
  top: number;    // 锚点顶部相对 messagesEl 内容顶部
  bottom: number;
}
export function pickNavTarget(
  anchors: NavAnchor[],   // 按 DOM 序(即位置序)排列
  refTop: number,         // 基准 = 视口顶部 scrollTop
  dir: "up" | "down",
  stickToBottom: boolean,
): NavAnchor | null;
```

- up:refTop 之上(anchor.bottom <= refTop + 8)最近的 kind==="user";无 → null
- down:stickToBottom===true → null;否则 refTop 之下(anchor.top >= refTop - 8)最近的 kind==="dsb";无 → null
- 8px 容差:避免目标恰在视口顶边缘时误判

## 任务拆分

### T1(可并行·子代理):navTargets.ts + 单测
- 实现 `pickNavTarget`(如上契约)
- `tests/navTargets.test.ts` 覆盖:连续 USER 逐个跳、up 无目标、down 跟随态返回 null、down 非跟随态找 DSB、refTop 边界(恰在锚点之间 / 容差)、空数组

### T2(主):index.html + styles.css
- `#messages` 外包 `<div id="chatArea">`(main.ts 顶部 `messagesEl` 仍指向 `#messages`,查询方式不变)
- `#timelineNav` 两按钮:▲ id=navUp / ▼ id=navDown
- CSS:
  - `#chatArea { position:relative; flex:1; min-height:0; display:flex; }`(flex 列下替换 #messages 的原 flex:1)
  - `#messages { flex:1; }`(移除原 flex:1?原 #messages 是 flex:1 + overflow-y:auto;改为 #chatArea 承担 flex:1,`#messages { flex:1; min-height:0; }` 保持滚动)
  - `#timelineNav { position:absolute; left:6px; top:50%; transform:translateY(-50%); z-index:20; display:flex; flex-direction:column; gap:6px; opacity:.45; transition:opacity .15s; }`
  - `#timelineNav:hover { opacity:1; }`
  - `#timelineNav button { width:22px; height:22px; font-size:10px; line-height:1; border-radius:6px; background:var(--bg, rgba(127,127,127,.15)); border:1px solid var(--border, rgba(127,127,127,.3)); cursor:pointer; color:inherit; }`
  - `#timelineNav button:active { transform:scale(.92); }`
  - `.nav-flash { animation: navFlash .9s ease-out; }`
  - `@keyframes navFlash { 0%{ box-shadow:0 0 0 2px rgba(59,130,246,.7); } 100%{ box-shadow:0 0 0 2px transparent; } }`
  - 注意 `#messages` 是滚动容器,#timelineNav 需相对 `#chatArea` 定位且不被滚动带跑

### T3(主):main.ts 集成
1. 状态:顶部加 `let stickToBottom = true; let suppressStickCheck = false; let scrollRaf = 0;`
2. `scrollBottom()` 内部改为 `if (!stickToBottom) return;`(或调用点包条件;选调用点统一改,保留 scrollBottom 原样用于强制场景?→ 设计为:新增 `scrollBottomIfSticky()`,6 处调用点替换;程序滚动强制用 `scrollBottom()` 原名)
   - 简单起见:`scrollBottom()` 加参数?不,新增独立函数,6 处替换,导航/懒加载强制滚底处用 `forceScrollBottom()`(原实现)
3. scroll 监听:在现有 `messagesEl.addEventListener("scroll", ...)`(懒加载)前加一个监听器,`suppressStickCheck` 时不重算;否则 rAF 节流计算距底 → 更新 stickToBottom
4. 收集锚点:`collectAnchors(): NavAnchor[]` —— 遍历 `messagesEl` 直接子元素:
   - `.msg.user` → kind=user,top/bottom 用 `offsetTop/offsetHeight` 累加(messagesEl 无 offsetParent 问题?messagesEl 是滚动容器,子元素 offsetTop 相对它;DSB 框在 .msg.assistant 内部 → 用 `.tl-step.tl-text.final` 的 offsetTop + .msg.assistant 的 offsetTop 叠加,或用 getBoundingClientRect 相对 messagesEl 计算)
   - 推荐:`rect = anchorEl.getBoundingClientRect(); base = messagesEl.getBoundingClientRect(); top = rect.top - base.top + messagesEl.scrollTop;`(稳)
5. 导航跳转 `jumpTo(anchor, dir)`:
   - `suppressStickCheck = true; messagesEl.scrollTo({ top: anchor.top - 16, behavior: "smooth" });`
   - 高亮:锚点元素加 `.nav-flash`,`animationend` 移除
   - up 后 `stickToBottom = false`;down 跟随态 → `forceScrollBottom()` + `stickToBottom = true`
   - smooth 滚动结束恢复 `suppressStickCheck=false`(setTimeout ~400ms 或 scrollend 事件;webview 支持 scrollend?用 setTimeout 兜底)
6. up 导航 + 历史懒加载协同:点击 ▲ 若 `pickNavTarget` 返回 null 且 `pendingRounds.length>0`,循环 `loadMoreHistoryRounds()`(最多到 pendingRounds 空),再收集重试;仍 null 则忽略
7. 按钮绑定:`navUp.addEventListener("click", ...)` / `navDown.addEventListener("click", ...)`(按钮元素在 DOM ready 后获取;main.ts 现有模式用 getElementById)
8. reset case:`stickToBottom = true` 复位

### T4(主):验证
- `npx tsc --noEmit` 全绿
- `npm test` 全绿(含新增 navTargets.test.ts)
- 手工验证清单见设计文档 §5

## 提交
- 一个提交:`feat(chat): 消息区滚动冻结跟随与 ▲▼ 轮次导航`
- 提交前 git status 核对只含本功能文件
