import ExcelJS from "exceljs";

/** 将 exceljs 单元格值转为文本(richText / hyperlink / 公式 / 错误均收敛为可读文本)。 */
function cellToText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      // richText 片段数组
      return value.map((frag) => frag.text ?? "").join("");
    }
    const record = value as unknown as Record<string, unknown>;
    if ("text" in record) {
      return String(record.text ?? "");
    }
    if ("error" in record) {
      return `#${String(record.error)}`;
    }
    if ("result" in record) {
      return cellToText(record.result as ExcelJS.CellValue | undefined);
    }
    return "";
  }
  return String(value);
}

/** CSV 字段转义:含逗号 / 引号 / 换行时加引号并双写引号。 */
function csvEscape(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Row.values 可能为数组或「列号 → 值」稀疏对象,统一归一为数组(1 基,index 0 为空)。 */
function rowValuesToArray(row: ExcelJS.Row): ExcelJS.CellValue[] {
  if (Array.isArray(row.values)) {
    return row.values;
  }
  const keys = Object.keys(row.values).map(Number);
  const maxKey = keys.length > 0 ? Math.max(...keys) : 0;
  const values: ExcelJS.CellValue[] = new Array(maxKey + 1);
  for (const [key, v] of Object.entries(row.values)) {
    values[Number(key)] = v;
  }
  return values;
}

export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 自带的全局类型声明 `interface Buffer extends ArrayBuffer` 与 @types/node 22
  // 的泛型 Buffer 冲突;这里显式取 Buffer 的底层 ArrayBuffer 视图传入(运行时等价)。
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);
  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    parts.push(`# ${sheet.name}`);
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells = rowValuesToArray(row)
        .slice(1)
        .map((v) => csvEscape(cellToText(v)));
      rows.push(cells.join(","));
    });
    parts.push(rows.join("\n"));
  }
  return parts.join("\n").trim();
}
