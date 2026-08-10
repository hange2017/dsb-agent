/**
 * 内联编辑面板显隐。
 *
 * 只用 HTML `hidden` 属性。若同时保留 CSS class `hidden`
 * (`.hidden { display: none !important }`),切换 `el.hidden` 时面板仍不可见。
 */

export type Hideable = {
  hidden: boolean;
  classList: { remove(...tokens: string[]): void };
};

/** 展开或收起内联面板,并清掉会挡住显示的 CSS class `hidden`。 */
export function setInlinePanelOpen(panel: Hideable, open: boolean): void {
  panel.classList.remove("hidden");
  panel.hidden = !open;
}

/** 切换内联面板显隐。 */
export function toggleInlinePanel(panel: Hideable): void {
  setInlinePanelOpen(panel, panel.hidden);
}
