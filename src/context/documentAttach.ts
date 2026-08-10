import { stripDataUrlBase64 } from "./imageAttach";
import type { DocumentChip } from "./types";
import { extractDocumentText } from "./extractors";
import type { DocumentExtractKind } from "./extractors/kinds";

export const kMaxDocumentsPerMessage = 10;
export const kMaxDocumentBytes = 10 * 1024 * 1024;
export const kMaxDocumentChars = 64 * 1024;

export type DocumentAttachInput = {
  fileName: string;
  mimeType: string;
  data: string;
};

export type DocumentAttachResult = {
  accepted: DocumentChip[];
  errors: string[];
};

export type { DocumentExtractKind };

export function documentExtractKind(
  fileName: string,
  mimeType: string,
): DocumentExtractKind | undefined {
  const ext = fileName.trim().toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  const mime = mimeType.trim().toLowerCase();
  const byExt: Record<string, DocumentExtractKind> = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".doc": "doc",
    ".xlsx": "xlsx",
    ".xls": "xls",
    ".txt": "text",
    ".md": "text",
    ".markdown": "text",
    ".csv": "text",
    ".json": "text",
    ".xml": "text",
    ".yaml": "text",
    ".yml": "text",
    ".toml": "text",
    ".ini": "text",
    ".log": "text",
    ".ts": "text",
    ".tsx": "text",
    ".js": "text",
    ".jsx": "text",
    ".mjs": "text",
    ".cjs": "text",
    ".py": "text",
    ".java": "text",
    ".go": "text",
    ".rs": "text",
    ".c": "text",
    ".cpp": "text",
    ".h": "text",
    ".hpp": "text",
    ".cs": "text",
    ".rb": "text",
    ".php": "text",
    ".sh": "text",
    ".sql": "text",
    ".html": "text",
    ".htm": "text",
    ".css": "text",
    ".scss": "text",
  };
  if (ext && byExt[ext]) {
    return byExt[ext];
  }
  if (mime === "application/pdf") {
    return "pdf";
  }
  if (
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime === "text/csv" ||
    mime === "application/json" ||
    mime.startsWith("text/")
  ) {
    return "text";
  }
  return undefined;
}

function decodedByteLength(base64: string): number {
  try {
    return Buffer.from(base64, "base64").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Inlined from learn's discover.ts (unported in this task); used to cap
// extracted document text before it enters a prompt.
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n…[truncated ${text.length - maxChars} chars]`;
}

export async function acceptDocuments(
  existingDocumentCount: number,
  inputs: DocumentAttachInput[],
  newId: () => string,
): Promise<DocumentAttachResult> {
  const accepted: DocumentChip[] = [];
  const errors: string[] = [];
  let count = existingDocumentCount;

  for (const input of inputs) {
    if (count >= kMaxDocumentsPerMessage) {
      errors.push(`最多 ${kMaxDocumentsPerMessage} 个文件`);
      break;
    }
    const kind = documentExtractKind(input.fileName, input.mimeType);
    if (!kind) {
      errors.push(`不支持的文件格式: ${input.fileName || input.mimeType || "(empty)"}`);
      continue;
    }
    const data = stripDataUrlBase64(input.data);
    if (!data) {
      errors.push(`${input.fileName || "file"} 数据为空`);
      continue;
    }
    const bytes = decodedByteLength(data);
    if (bytes > kMaxDocumentBytes) {
      errors.push(`${input.fileName || "file"} 超过 10MB 限制`);
      continue;
    }
    const buffer = Buffer.from(data, "base64");
    let rawText = "";
    try {
      rawText = (await extractDocumentText(buffer, kind)).trim();
    } catch {
      if (kind === "doc" || kind === "xls") {
        errors.push(
          `${input.fileName}: 请转换为 .docx / .xlsx 后再附加`,
        );
      } else {
        errors.push(`未能提取文本: ${input.fileName || "file"}`);
      }
      continue;
    }
    if (!rawText) {
      errors.push(`未能提取文本: ${input.fileName || "file"}`);
      continue;
    }
    const truncated = rawText.length > kMaxDocumentChars;
    const text = truncateText(rawText, kMaxDocumentChars);
    const chip: DocumentChip = {
      kind: "document",
      id: newId(),
      fileName: input.fileName || "document",
      mimeType: input.mimeType || "application/octet-stream",
      text,
      byteSize: bytes,
    };
    if (truncated) {
      chip.truncated = true;
    }
    accepted.push(chip);
    count += 1;
  }

  return { accepted, errors };
}
