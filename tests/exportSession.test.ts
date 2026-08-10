import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProviderMessage } from "../src/agent/provider/types";
import {
  formatSessionMarkdown,
  formatSessionJson,
  writeExport,
} from "../src/chat/exportSession";

/** 覆盖 user 纯文本、assistant 文本+tool_use、user tool_result、最终 assistant 文本的完整时间线。 */
const fixture: ProviderMessage[] = [
  { role: "user", content: "请阅读 src/foo.ts" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "我来读取该文件。" },
      { type: "tool_use", id: "tu-1", name: "Read", input: { path: "src/foo.ts", limit: 50 } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu-1", content: "const x = 1;\n// hello" },
      { type: "text", text: "继续" },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "文件内容是 `const x = 1;`。" }] },
];

describe("formatSessionMarkdown", () => {
  it("渲染 user 与 assistant 分节与正文", () => {
    const md = formatSessionMarkdown(fixture);
    expect(md).toContain("## 👤 User");
    expect(md).toContain("## 🤖 Assistant");
    expect(md).toContain("请阅读 src/foo.ts");
    expect(md).toContain("我来读取该文件。");
    expect(md).toContain("文件内容是 `const x = 1;`。");
  });

  it("渲染工具调用摘要(name + input)", () => {
    const md = formatSessionMarkdown(fixture);
    expect(md).toContain("**工具调用:**");
    expect(md).toContain("`Read`");
    expect(md).toContain("src/foo.ts");
    // 摘要含完整 JSON 入参
    expect(md).toContain('{"path":"src/foo.ts","limit":50}');
  });

  it("渲染工具结果并关联到工具名", () => {
    const md = formatSessionMarkdown(fixture);
    expect(md).toContain("**工具结果:**");
    expect(md).toContain("- **Read**");
    expect(md).toContain("const x = 1;");
    // 结果用代码围栏包裹,围栏闭合
    const fences = md.match(/```/g)?.length ?? 0;
    expect(fences).toBeGreaterThan(0);
    expect(fences % 2).toBe(0);
  });

  it("跳过 image 块但保留同消息文本块", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          },
        ],
      },
    ];
    const md = formatSessionMarkdown(msgs);
    expect(md).toContain("看图");
    expect(md).not.toContain("aGVsbG8=");
    expect(md).not.toContain("image/png");
  });

  it("时间线按顺序渲染", () => {
    const md = formatSessionMarkdown(fixture);
    expect(md.indexOf("请阅读")).toBeLessThan(md.indexOf("我来读取"));
    expect(md.indexOf("我来读取")).toBeLessThan(md.indexOf("const x = 1;"));
    expect(md.indexOf("const x = 1;")).toBeLessThan(md.indexOf("文件内容是"));
  });
});

describe("formatSessionJson", () => {
  it("输出 2 空格缩进的 pretty JSON 且内容一致", () => {
    const json = formatSessionJson(fixture);
    expect(json).toContain('\n    "role": "user"');
    const parsed = JSON.parse(json) as ProviderMessage[];
    expect(parsed).toEqual(fixture);
    expect(parsed[1].content[1]).toMatchObject({ type: "tool_use", name: "Read" });
  });
});

describe("writeExport", () => {
  it("递归创建目录、写入文件并返回完整路径", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dss-export-"));
    try {
      const baseDir = path.join(dir, "a", "b", "c");
      const content = "hello export";
      const filePath = writeExport(baseDir, "sess-1", content, "md");
      const expected = path.join(baseDir, "sess-1.md");
      expect(filePath).toBe(expected);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("支持 json 扩展名", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dss-export-"));
    try {
      const filePath = writeExport(dir, "sess-2", '{"a":1}', "json");
      expect(filePath).toBe(path.join(dir, "sess-2.json"));
      expect(fs.readFileSync(filePath, "utf8")).toBe('{"a":1}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
