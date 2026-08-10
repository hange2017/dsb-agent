export type EditorPasteMode = "partialLine" | "fullLine" | "multiLine";

export function classifyEditorPasteMode(args: {
  startLine: number;
  endLine: number;
  selectedText: string;
  fullLineText: string;
}): EditorPasteMode {
  if (args.startLine !== args.endLine) {
    return "multiLine";
  }
  const selected = args.selectedText.replace(/\n$/, "").trimEnd();
  const full = args.fullLineText.trimEnd();
  if (selected === full) {
    return "fullLine";
  }
  return "partialLine";
}
