export type ChipView =
  | { kind: "image"; label: string; dataUrl: string }
  | { kind: "text"; label: string };

export function chipViewFromLabel(kind: string, label: string): ChipView {
  return kind === "image"
    ? { kind: "image", label, dataUrl: "" } // dataUrl 由 host 填充
    : { kind: "text", label };
}
