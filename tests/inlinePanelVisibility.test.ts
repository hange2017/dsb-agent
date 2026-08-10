import { describe, it, expect } from "vitest";
import { setInlinePanelOpen, toggleInlinePanel } from "../webview/inlinePanelVisibility";

function makePanel(opts: { hiddenAttr: boolean; hasHiddenClass: boolean }) {
  const classes = new Set<string>(opts.hasHiddenClass ? ["hidden"] : []);
  return {
    hidden: opts.hiddenAttr,
    classList: {
      contains: (c: string) => classes.has(c),
      remove: (...cs: string[]) => {
        for (const c of cs) classes.delete(c);
      },
      _classes: classes,
    },
  };
}

/** 与 CSS `.hidden { display:none !important }` 叠加后,面板是否仍被藏住。 */
function effectivelyHidden(panel: ReturnType<typeof makePanel>): boolean {
  return panel.hidden || panel.classList.contains("hidden");
}

describe("inlinePanelVisibility", () => {
  it("toggle shows a panel that started with both HTML hidden and CSS class hidden", () => {
    // 复现供应商设置「编辑 / 配置 API Key」无反应:创建时 class+attr 双隐藏,点击只翻 attr
    const panel = makePanel({ hiddenAttr: true, hasHiddenClass: true });
    toggleInlinePanel(panel);
    expect(effectivelyHidden(panel)).toBe(false);
  });

  it("toggle hides an open panel", () => {
    const panel = makePanel({ hiddenAttr: false, hasHiddenClass: false });
    toggleInlinePanel(panel);
    expect(panel.hidden).toBe(true);
  });

  it("setInlinePanelOpen(false) clears CSS class and sets HTML hidden", () => {
    const panel = makePanel({ hiddenAttr: false, hasHiddenClass: true });
    setInlinePanelOpen(panel, false);
    expect(panel.hidden).toBe(true);
    expect(panel.classList.contains("hidden")).toBe(false);
  });
});
