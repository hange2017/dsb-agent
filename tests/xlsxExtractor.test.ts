import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractXlsxText } from "../src/context/extractors/xlsx";

/** 用 exceljs 构造一个内存 xlsx,再走真实解析路径。 */
async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("数据");
  ws.addRow(["名称", "价格"]);
  ws.addRow(["苹果", 3.5]);
  ws.addRow(["含,逗号", '含"引号"\n换行']);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as unknown as ArrayBuffer);
}

describe("extractXlsxText (exceljs)", () => {
  it("提取工作表名与 CSV 内容", async () => {
    const text = await extractXlsxText(await makeXlsx());
    expect(text).toContain("# 数据");
    expect(text).toContain("名称,价格");
    expect(text).toContain("苹果,3.5");
  });

  it("对含逗号/引号/换行的单元格做 CSV 转义", async () => {
    const text = await extractXlsxText(await makeXlsx());
    // 含逗号 → 加引号;含引号/换行 → 双写引号
    expect(text).toContain('"含,逗号"');
    expect(text).toContain('"含""引号""\n换行"');
  });

  it("空工作簿不抛异常", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("空表");
    const out = await wb.xlsx.writeBuffer();
    const text = await extractXlsxText(Buffer.from(out as unknown as ArrayBuffer));
    expect(text).toBe("# 空表");
  });
});
