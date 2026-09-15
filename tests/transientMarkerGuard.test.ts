import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { CheckpointStore } from "../src/agent/checkpoint";
import type { StatsStore } from "../src/stats/statsStore";

/** 单行形态的瞬时参数占位标记(真实事故里被写进文件的就是这个形状)。 */
const MARKER_LINE =
  "[瞬时参数已省略:new_string 500 字符;内容已在文件系统/执行状态中,如需可重新调用工具]";

/** 整段本身就是标记(写前守卫应拦下的形状)。 */
const WHOLE_MARKER = "[TRANSIENT-SUMMARY field=contents chars=999] 瞬时参数省略标记:禁止写入文件";

let tmp: string;

function makeExec(opts?: { checkpoints?: CheckpointStore }) {
  const rec = vi.fn();
  const fakeStats = { record: rec } as unknown as StatsStore;
  const exec = new ToolExecutor(
    new MemoryStore(path.join(tmp, ".mem")),
    undefined,
    undefined,
    undefined,
    0,
    opts?.checkpoints,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fakeStats,
  );
  return { exec, rec };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-marker-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("写后自检 + 回滚(夹带标记行的漏网写入)", () => {
  it("Write:长内容夹带标记行 → 回滚且不留脏文件", async () => {
    const { exec, rec } = makeExec();
    // 整段 > 320 字符且首行非标记 → 写前守卫放行(这正是「漏网」的形状)
    const contents =
      "正常正文第一行\n" +
      "这是一段足够长的正常内容,用于让整段长度超过 320 字符从而绕过写前守卫。".repeat(8) +
      "\n" +
      MARKER_LINE +
      "\n正常结尾";
    expect(contents.length).toBeGreaterThan(320);

    const r = await exec.execute("Write", { path: "dirty.txt", contents }, { workspaceRoot: tmp });

    expect(r.ok).toBe(false);
    expect(r.content).toContain("ROLLED BACK");
    expect(r.content).toContain("Read");
    expect(fs.existsSync(path.join(tmp, "dirty.txt"))).toBe(false); // 无快照+新文件 → 删除
    expect(rec).toHaveBeenCalledWith(
      "transient_marker_rollback",
      expect.objectContaining({ op: "Write", lines: 1 }),
    );
  });

  it("StrReplace:回滚到编辑前字节(无快照时用编辑前内容复原)", async () => {
    const { exec } = makeExec();
    const p = path.join(tmp, "a.txt");
    fs.writeFileSync(p, "原始内容\n第二行\n", "utf8");

    const r = await exec.execute(
      "StrReplace",
      { path: "a.txt", old_string: "第二行", new_string: `第二行\n${MARKER_LINE}` },
      { workspaceRoot: tmp },
    );

    expect(r.ok).toBe(false);
    expect(r.content).toContain("ROLLED BACK");
    expect(fs.readFileSync(p, "utf8")).toBe("原始内容\n第二行\n");
  });

  it("StrReplace:有快照时经 checkpoint 回滚(撤销本次编辑)", async () => {
    const store = new CheckpointStore(tmp, "s1");
    const { exec } = makeExec({ checkpoints: store });
    const p = path.join(tmp, "b.txt");
    fs.writeFileSync(p, "编辑前\n", "utf8");

    const r = await exec.execute(
      "StrReplace",
      { path: "b.txt", old_string: "编辑前", new_string: `编辑前\n${MARKER_LINE}` },
      { workspaceRoot: tmp },
    );

    expect(r.ok).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("编辑前\n");
  });

  it("既有引用行不误伤(编辑前已存在的标记行不算本次引入)", async () => {
    const { exec } = makeExec();
    const p = path.join(tmp, "doc.md");
    fs.writeFileSync(p, `文档正文\n${MARKER_LINE}\n结尾\n`, "utf8");

    const r = await exec.execute(
      "StrReplace",
      { path: "doc.md", old_string: "结尾", new_string: "结尾(已更新)" },
      { workspaceRoot: tmp },
    );

    expect(r.ok).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain("结尾(已更新)");
  });

  it("正常长文档写入不被误拦(无标记行直接成功)", async () => {
    const { exec } = makeExec();
    const contents = "第一行\n" + "正常内容。".repeat(200);
    const r = await exec.execute("Write", { path: "ok.txt", contents }, { workspaceRoot: tmp });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "ok.txt"), "utf8")).toBe(contents);
  });
});

describe("写前守卫拒绝埋点(量化偶发/高频)", () => {
  it("Write 拒绝时落 transient_marker_refused", async () => {
    const { exec, rec } = makeExec();
    const r = await exec.execute("Write", { path: "x.txt", contents: WHOLE_MARKER }, { workspaceRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("REFUSED");
    expect(rec).toHaveBeenCalledWith(
      "transient_marker_refused",
      expect.objectContaining({ tool: "Write", field: "contents" }),
    );
  });

  it("StrReplace 拒绝时记录是 new_string 还是 old_string", async () => {
    const { exec, rec } = makeExec();
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello\n", "utf8");
    const r = await exec.execute(
      "StrReplace",
      { path: "a.txt", old_string: "hello", new_string: WHOLE_MARKER },
      { workspaceRoot: tmp },
    );
    expect(r.ok).toBe(false);
    expect(rec).toHaveBeenCalledWith(
      "transient_marker_refused",
      expect.objectContaining({ tool: "StrReplace", field: "new_string" }),
    );
  });

  it("MemoryWrite / TodoWrite 拒绝时同样埋点", async () => {
    const { exec, rec } = makeExec();
    const m = await exec.execute(
      "MemoryWrite",
      { name: "m1", description: "d", body: WHOLE_MARKER },
      { workspaceRoot: tmp },
    );
    expect(m.content).toContain("REFUSED");
    expect(rec).toHaveBeenCalledWith(
      "transient_marker_refused",
      expect.objectContaining({ tool: "MemoryWrite", field: "body" }),
    );

    const t = await exec.execute("TodoWrite", { op: "add", content: WHOLE_MARKER }, { workspaceRoot: tmp });
    expect(t.content).toContain("REFUSED");
    expect(rec).toHaveBeenCalledWith(
      "transient_marker_refused",
      expect.objectContaining({ tool: "TodoWrite", field: "content" }),
    );
  });
});
