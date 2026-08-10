export type AttachKind = "image" | "document" | "unsupported";

const kImageExt = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

const kDocumentExt = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
]);

function extOf(fileName: string): string {
  const base = fileName.trim().toLowerCase();
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i) : "";
}

export function classifyAttachFile(
  fileName: string,
  mimeType: string,
): AttachKind {
  const mime = mimeType.trim().toLowerCase();
  const ext = extOf(fileName);

  if (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    mime === "image/gif" ||
    mime === "image/webp" ||
    kImageExt.has(ext)
  ) {
    return "image";
  }
  if (mime.startsWith("image/")) {
    return "unsupported";
  }
  if (kDocumentExt.has(ext)) {
    return "document";
  }
  if (
    mime === "application/pdf" ||
    mime === "application/json" ||
    mime === "text/csv" ||
    mime === "text/markdown" ||
    mime === "text/plain" ||
    (mime.startsWith("text/") && ext === "")
  ) {
    return "document";
  }
  return "unsupported";
}
