import type { ContextChip, ImageChip } from "./types";
import { formatChipLabel, formatChipPromptBlock } from "./formatContext";

/**
 * 展开用户输入中的内联引用 `` `label` ``(来自 learn 项目的 promptBuilder 移植,
 * 移除了 agent loop 用不到的 modePolicy 依赖)。被引用的 chip 会内联成
 * prompt block;图片 chip 只保留 `[Image ref: label]` 占位符并放入
 * imageChips(由调用方按 ModelCapabilities.supportsVision 决定是否注入图片内容)。
 */
export function resolveInlineRefs(
  userText: string,
  chips: ContextChip[],
): {
  prompt: string;
  chipsForMessage: ContextChip[];
  imageChips: ImageChip[];
} {
  const remaining = [...chips];
  const chipsForMessage: ContextChip[] = [];
  const imageChips: ImageChip[] = [];
  const bodyParts: string[] = [];

  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(userText)) !== null) {
    bodyParts.push(userText.slice(last, m.index));
    const label = m[1] ?? "";
    const idx = remaining.findIndex((c) => formatChipLabel(c) === label);
    if (idx < 0) {
      bodyParts.push(m[0]);
    } else {
      const [chip] = remaining.splice(idx, 1);
      chipsForMessage.push(chip);
      if (chip.kind === "image") {
        bodyParts.push(`[Image ref: ${label}]`);
        imageChips.push(chip);
      } else {
        const block = formatChipPromptBlock(chip);
        bodyParts.push("`" + label + "`");
        if (block) {
          bodyParts.push("\n\n" + block);
        }
      }
    }
    last = m.index + m[0].length;
  }
  bodyParts.push(userText.slice(last));
  return {
    prompt: bodyParts.join(""),
    chipsForMessage,
    imageChips,
  };
}

export function buildSendPrompt(
  userText: string,
  chips: ContextChip[],
): string {
  return resolveInlineRefs(userText, chips).prompt;
}
