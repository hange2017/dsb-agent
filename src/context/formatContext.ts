import { baseChipLabel } from "./displayLabel";
import type { ContextChip } from "./types";

export function formatChipLabel(chip: ContextChip): string {
  return chip.displayLabel ?? baseChipLabel(chip);
}

export function formatChipPromptBlock(chip: ContextChip): string {
  switch (chip.kind) {
    case "editor":
      return `[Context: file ${chip.relativePath} lines ${chip.startLine}-${chip.endLine}]\n${chip.text}`;
    case "terminal": {
      const cwd = chip.cwd ? ` cwd=${chip.cwd}` : "";
      return `[Context: terminal ${chip.terminalName}${cwd} at ${chip.capturedAt}]\n${chip.text}`;
    }
    case "file":
      return `[Context: file ${chip.relativePath}]\n${chip.text}`;
    case "skill":
      return `[Context: skill ${chip.name}]\n${chip.text}`;
    case "rule":
      return `[Context: rule ${chip.name}]\n${chip.text}`;
    case "image":
      return "";
    case "document": {
      const trunc = chip.truncated ? " truncated" : "";
      return `[Context: document ${chip.fileName || "document"}${trunc}]\n${chip.text}`;
    }
  }
}
