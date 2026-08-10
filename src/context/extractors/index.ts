import { extractPlainText } from "./text";
import { extractPdfText } from "./pdf";
import { extractDocxText } from "./docx";
import { extractXlsxText } from "./xlsx";
import type { DocumentExtractKind } from "./kinds";

export async function extractDocumentText(
  buffer: Buffer,
  kind: DocumentExtractKind,
): Promise<string> {
  switch (kind) {
    case "text":
      return extractPlainText(buffer);
    case "pdf":
      return extractPdfText(buffer);
    case "docx":
      return extractDocxText(buffer);
    case "xlsx":
      return await extractXlsxText(buffer);
    case "doc":
    case "xls": {
      // Best-effort: try related extractors; empty or throw → convert message
      let text = "";
      try {
        text =
          kind === "doc"
            ? await extractDocxText(buffer)
            : await extractXlsxText(buffer);
      } catch {
        throw new Error(
          kind === "doc" ? "legacy doc unsupported" : "legacy xls unsupported",
        );
      }
      // exceljs may emit only "# SheetN" headers for empty/garbage workbooks.
      const body = text
        .split("\n")
        .filter((line) => !/^#\s/.test(line))
        .join("\n")
        .trim();
      if (!body) {
        throw new Error(
          kind === "doc" ? "legacy doc unsupported" : "legacy xls unsupported",
        );
      }
      return text;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
