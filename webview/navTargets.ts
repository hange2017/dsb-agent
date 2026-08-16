/**
 * ▲▼ 轮次导航的目标选择(纯函数,不依赖 DOM,便于单测)。
 * 语义见 .dsb/specs/2026-08-16-message-scroll-freeze-nav-design.md §3.3。
 */

export interface NavAnchor {
  id: string;
  kind: "user" | "dsb";
  top: number; // 锚点顶部相对 messagesEl 内容顶部
  bottom: number;
}

/** 8px 容差:避免目标恰在视口顶边缘时误判。 */
export const kNavTolerance = 8;

/**
 * 在锚点列表中选择导航目标。
 * @param anchors 按 DOM 序(即 top 升序)排列的锚点
 * @param refTop 基准 = 视口顶部 scrollTop
 * @param dir 方向:"up" 找上一个 user 锚点;"down" 找下一个 dsb 锚点
 * @param stickToBottom 跟随态:down 时直接返回 null(调用方回底部 + 恢复跟随)
 * @returns 目标锚点;无则 null
 */
export function pickNavTarget(
  anchors: NavAnchor[],
  refTop: number,
  dir: "up" | "down",
  stickToBottom: boolean,
): NavAnchor | null {
  if (dir === "up") {
    // refTop 之上(anchor.bottom <= refTop + 8)最近的 kind==="user";
    // 锚点按 top 升序,最后一个满足条件的即最近的。
    let best: NavAnchor | null = null;
    for (const a of anchors) {
      if (a.kind !== "user") continue;
      if (a.bottom <= refTop + kNavTolerance) best = a;
    }
    return best;
  }

  // dir === "down"
  if (stickToBottom) return null;
  // refTop 之下(anchor.top >= refTop - 8)最近的 kind==="dsb";
  // 锚点按 top 升序,第一个满足条件的即最近的。
  for (const a of anchors) {
    if (a.kind !== "dsb") continue;
    if (a.top >= refTop - kNavTolerance) return a;
  }
  return null;
}
