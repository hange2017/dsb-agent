import type { ContextChip, ImageChip } from "./types";

export const kMaxImagesPerMessage = 5;
export const kMaxImageBytes = 15 * 1024 * 1024;

export const kAllowedImageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof kAllowedImageMimeTypes)[number];

export type ImageAttachInput = {
  mimeType: string;
  data: string;
  fileName?: string;
  width?: number;
  height?: number;
};

export type ImageAttachResult = {
  accepted: ImageChip[];
  errors: string[];
};

export type SdkImagePayload = {
  data: string;
  mimeType: string;
  dimension?: { width: number; height: number };
};

const kAllowedSet = new Set<string>(kAllowedImageMimeTypes);

function normalizeMime(mime: string): ImageMimeType | undefined {
  const m = mime.trim().toLowerCase();
  if (m === "image/jpg") {
    return "image/jpeg";
  }
  if (kAllowedSet.has(m)) {
    return m as ImageMimeType;
  }
  return undefined;
}

/** Strip data-URL prefix if present; return raw base64. */
export function stripDataUrlBase64(data: string): string {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma >= 0) {
    return trimmed.slice(comma + 1);
  }
  return trimmed;
}

function decodedByteLength(base64: string): number {
  try {
    return Buffer.from(base64, "base64").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function acceptImages(
  existingImageCount: number,
  inputs: ImageAttachInput[],
  newId: () => string,
): ImageAttachResult {
  const accepted: ImageChip[] = [];
  const errors: string[] = [];
  let count = existingImageCount;

  for (const input of inputs) {
    if (count >= kMaxImagesPerMessage) {
      errors.push(`最多 ${kMaxImagesPerMessage} 张图片`);
      break;
    }
    const mimeType = normalizeMime(input.mimeType);
    if (!mimeType) {
      errors.push(`不支持的图片格式: ${input.mimeType || "(empty)"}`);
      continue;
    }
    const data = stripDataUrlBase64(input.data);
    if (!data) {
      errors.push("图片数据为空");
      continue;
    }
    const bytes = decodedByteLength(data);
    if (bytes > kMaxImageBytes) {
      const name = input.fileName ?? "image";
      errors.push(`${name} 超过 15MB 限制`);
      continue;
    }
    const chip: ImageChip = {
      kind: "image",
      id: newId(),
      mimeType,
      data,
    };
    if (input.fileName) {
      chip.fileName = input.fileName;
    }
    if (input.width !== undefined && input.height !== undefined) {
      chip.width = input.width;
      chip.height = input.height;
    }
    accepted.push(chip);
    count += 1;
  }

  return { accepted, errors };
}

export function partitionChips(chips: ContextChip[]): {
  textChips: ContextChip[];
  imageChips: ImageChip[];
} {
  const textChips: ContextChip[] = [];
  const imageChips: ImageChip[] = [];
  for (const chip of chips) {
    if (chip.kind === "image") {
      imageChips.push(chip);
    } else {
      textChips.push(chip);
    }
  }
  return { textChips, imageChips };
}

export function toSdkImages(chips: ContextChip[]): SdkImagePayload[] {
  const { imageChips } = partitionChips(chips);
  return imageChips.map((chip) => {
    const out: SdkImagePayload = {
      data: chip.data,
      mimeType: chip.mimeType,
    };
    if (chip.width !== undefined && chip.height !== undefined) {
      out.dimension = { width: chip.width, height: chip.height };
    }
    return out;
  });
}
