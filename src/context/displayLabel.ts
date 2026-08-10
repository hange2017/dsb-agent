import type { ContextChip } from "./types";

export function baseChipLabel(chip: ContextChip): string {
  switch (chip.kind) {
    case "editor":
      if (chip.startLine === chip.endLine) {
        return `${chip.relativePath}:${chip.startLine}`;
      }
      return `${chip.relativePath} (${chip.startLine}-${chip.endLine})`;
    case "terminal":
      return `terminal: ${chip.terminalName}`;
    case "file":
      return chip.relativePath;
    case "skill":
      return `skill: ${chip.name}`;
    case "rule":
      return `rule: ${chip.name}`;
    case "image":
      return chip.fileName ? `image: ${chip.fileName}` : "image";
    case "document":
      return chip.fileName ? `📄 ${chip.fileName}` : "📄 document";
  }
}

function usedLabels(chips: ContextChip[]): Set<string> {
  const s = new Set<string>();
  for (const c of chips) {
    if (c.displayLabel) {
      s.add(c.displayLabel);
    }
  }
  return s;
}

function nextUnnamedImageLabel(used: Set<string>): string {
  let n = 1;
  while (used.has(`image: ${n}`)) {
    n += 1;
  }
  return `image: ${n}`;
}

function nextUnnamedDocumentLabel(used: Set<string>): string {
  let n = 1;
  while (used.has(`📄 document ${n}`)) {
    n += 1;
  }
  return `📄 document ${n}`;
}

function uniquify(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let n = 2;
  while (used.has(`${base} #${n}`)) {
    n += 1;
  }
  return `${base} #${n}`;
}

/** Clone incoming chips with unique displayLabel values. */
export function assignDisplayLabels(
  existing: ContextChip[],
  incoming: ContextChip[],
): ContextChip[] {
  const used = usedLabels(existing);
  const out: ContextChip[] = [];
  for (const chip of incoming) {
    let base = baseChipLabel(chip);
    if (chip.kind === "image" && !chip.fileName) {
      base = nextUnnamedImageLabel(used);
    } else if (chip.kind === "document" && !chip.fileName) {
      base = nextUnnamedDocumentLabel(used);
    } else {
      base = uniquify(base, used);
    }
    used.add(base);
    out.push({ ...chip, displayLabel: base });
  }
  return out;
}
