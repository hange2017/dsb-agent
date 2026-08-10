import type { EditorChip } from "./types";

export function wrapRef(label: string): string {
  return "`" + label + "`";
}

export function removeRefMarker(text: string, label: string): string {
  const token = wrapRef(label);
  const i = text.indexOf(token);
  if (i < 0) {
    return text;
  }
  return text.slice(0, i) + text.slice(i + token.length);
}

export function insertTextsAt(
  text: string,
  caret: number,
  texts: string[],
): { text: string; caret: number } {
  const chunk = texts.join("");
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  return { text: before + chunk + after, caret: caret + chunk.length };
}

export function editorInsertText(
  chip: EditorChip,
  pasteMode: "fullLine" | "multiLine",
): string {
  const label =
    chip.displayLabel ??
    (pasteMode === "multiLine"
      ? `${chip.relativePath} (${chip.startLine}-${chip.endLine})`
      : `${chip.relativePath}:${chip.startLine}`);
  if (pasteMode === "multiLine") {
    return wrapRef(label);
  }
  const body = chip.text.replace(/\n$/, "");
  return `${wrapRef(label)} ${body}`;
}
