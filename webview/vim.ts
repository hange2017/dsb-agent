import { t } from "../src/i18n/strings";

export class VimInput {
  private m: "normal" | "insert" = "normal";
  private pending = "";

  private locale: "zh" | "en" = "zh";

  constructor(
    private readonly el: HTMLTextAreaElement,
    private readonly opts: { enabled: () => boolean },
  ) {}

  /** 语言切换时由外部刷新提示文案。 */
  setLocale(locale: "zh" | "en"): void {
    this.locale = locale;
    this.updateHint();
  }

  get mode(): "normal" | "insert" {
    return this.m;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.opts.enabled()) return false;
    if (this.m === "insert") {
      if (e.key === "Escape") {
        this.m = "normal";
        this.pending = "";
        this.updateHint();
        e.preventDefault();
        return true;
      }
      return false;
    }
    // normal 模式
    e.preventDefault();
    const k = e.key;
    const seq = this.pending + k;
    if (k === "i" || k === "a") {
      this.m = "insert";
      this.pending = "";
      if (k === "a") this.moveCaret(1);
      this.updateHint();
      return true;
    }
    switch (seq) {
      case "dd": {
        this.deleteLine();
        this.pending = "";
        return true;
      }
      case "gg": {
        this.moveLineStart();
        this.pending = "";
        return true;
      }
    }
    switch (k) {
      case "j": this.moveLine(1); this.pending = ""; return true;
      case "k": this.moveLine(-1); this.pending = ""; return true;
      case "h": this.moveCaret(-1); this.pending = ""; return true;
      case "l": this.moveCaret(1); this.pending = ""; return true;
      case "x": this.deleteChar(); this.pending = ""; return true;
      case "0": this.moveCol(0); this.pending = ""; return true;
      case "$": this.moveCol(Infinity); this.pending = ""; return true;
      case "G": this.moveLine(Infinity); this.pending = ""; return true;
      case "d": this.pending = "d"; return true;
      case "g": this.pending = "g"; return true;
      default: this.pending = ""; return true;
    }
  }

  private updateHint(): void {
    this.el.title = this.m === "normal" ? t("Vim: Normal(按 i 进入编辑)", this.locale) : "";
  }

  private moveCaret(offset: number): void {
    const pos = (this.el.selectionStart ?? 0) + offset;
    const next = Math.max(0, Math.min(pos, this.el.value.length));
    this.el.setSelectionRange(next, next);
  }
  private moveCol(col: number): void {
    const lineStart = this.el.value.lastIndexOf("\n", (this.el.selectionStart ?? 0) - 1) + 1;
    const lineEnd = this.el.value.indexOf("\n", this.el.selectionStart ?? 0);
    const end = lineEnd === -1 ? this.el.value.length : lineEnd;
    const pos = col === 0 ? lineStart : end;
    this.el.setSelectionRange(pos, pos);
  }
  private moveLine(delta: number): void {
    const pos = this.el.selectionStart ?? 0;
    // G(Infinity):直接跳到末行行首(末行起始 = 最后一个换行符之后;无换行则位置 0)。
    if (delta === Infinity) {
      const lastStart = this.el.value.lastIndexOf("\n") + 1;
      this.el.setSelectionRange(lastStart, lastStart);
      return;
    }
    const up = this.el.value.lastIndexOf("\n", pos - 1);
    const prevLine = up === -1 ? -1 : this.el.value.lastIndexOf("\n", up - 1);
    const lineStart = up + 1;
    const col = pos - lineStart;
    if (delta > 0) {
      const nextLineEnd = this.el.value.indexOf("\n", pos);
      if (nextLineEnd === -1) return;
      const nextLineStart = nextLineEnd + 1;
      const nextEnd = this.el.value.indexOf("\n", nextLineStart);
      const target = Math.min(col, (nextEnd === -1 ? this.el.value.length : nextEnd) - nextLineStart);
      this.el.setSelectionRange(nextLineStart + target, nextLineStart + target);
    } else {
      if (prevLine === -1) return;
      const prevEnd = prevLine;
      const prevStart = this.el.value.lastIndexOf("\n", prevLine - 1) + 1;
      const target = Math.min(col, prevEnd - prevStart);
      this.el.setSelectionRange(prevStart + target, prevStart + target);
    }
  }
  /** gg:回到首行(首行起始即缓冲区位置 0)。 */
  private moveLineStart(): void {
    this.el.setSelectionRange(0, 0);
  }
  private deleteLine(): void {
    const pos = this.el.selectionStart ?? 0;
    const start = this.el.value.lastIndexOf("\n", pos - 1) + 1;
    const end = this.el.value.indexOf("\n", pos);
    const removeEnd = end === -1 ? this.el.value.length : end + 1;
    this.el.value = this.el.value.slice(0, start) + this.el.value.slice(removeEnd);
    this.el.setSelectionRange(start, start);
    this.el.dispatchEvent(new Event("input"));
  }
  private deleteChar(): void {
    const pos = this.el.selectionStart ?? 0;
    if (pos >= this.el.value.length) return;
    this.el.value = this.el.value.slice(0, pos) + this.el.value.slice(pos + 1);
    this.el.setSelectionRange(pos, pos);
    this.el.dispatchEvent(new Event("input"));
  }
}
