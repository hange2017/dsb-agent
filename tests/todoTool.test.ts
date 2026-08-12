import { describe, it, expect } from "vitest";
import { TodoManager } from "../src/agent/tools/todoTool";

describe("TodoManager", () => {
  it("adds and lists", () => {
    const t = new TodoManager();
    t.add("写测试");
    const items = t.list();
    expect(items).toHaveLength(1);
    expect(items[0].done).toBe(false);
  });
  it("updates and clears", () => {
    const t = new TodoManager();
    const it = t.add("任务");
    expect(t.update(it.id, true)).toBe(true);
    expect(t.list()[0].done).toBe(true);
    expect(t.update("nope", true)).toBe(false);
    t.clear();
    expect(t.list()).toHaveLength(0);
  });
  it("renders prompt block", () => {
    const t = new TodoManager();
    t.add("a");
    expect(t.toPromptBlock()).toContain("## 任务清单");
    expect(t.toPromptBlock()).toContain("a");
  });

  it("list returns shallow copy isolated from internal state", () => {
    const t = new TodoManager();
    t.add("任务");
    const items = t.list();
    items[0].done = true;
    items[0].content = "mutated";
    expect(t.list()[0].done).toBe(false);
    expect(t.list()[0].content).toBe("任务");
  });

  it("replaceAll restores items and bumps seq from id suffixes", () => {
    const t = new TodoManager();
    t.add("old");
    t.replaceAll([
      { id: "t5", content: "restored", done: true },
      { id: "t12", content: "second", done: false },
    ]);
    expect(t.list()).toEqual([
      { id: "t5", content: "restored", done: true },
      { id: "t12", content: "second", done: false },
    ]);
    const next = t.add("new");
    expect(next.id).toBe("t13");
  });

  it("replaceAll keeps seq at least current when ids have no numeric suffix", () => {
    const t = new TodoManager();
    t.add("one");
    t.add("two");
    expect(t.list()).toHaveLength(2);
    t.replaceAll([{ id: "custom", content: "x", done: false }]);
    const next = t.add("after");
    expect(next.id).toBe("t3");
  });

  it("replaceAll copies items so external mutations do not affect manager", () => {
    const t = new TodoManager();
    const external = [{ id: "t1", content: "a", done: false }];
    t.replaceAll(external);
    external[0].done = true;
    expect(t.list()[0].done).toBe(false);
  });

  it("marking done syncs embedded markdown checkboxes in content (avoids restart loops)", () => {
    const t = new TodoManager();
    const it = t.add(
      "主任务\n- [ ] 1. 子项甲\n- [ ] 2. 子项乙",
    );
    expect(t.update(it.id, true)).toBe(true);
    const content = t.list()[0].content;
    expect(content).toContain("- [x] 1. 子项甲");
    expect(content).toContain("- [x] 2. 子项乙");
    expect(content).not.toMatch(/- \[ \]/);
  });

  it("replaceAll syncs embedded checkboxes with done flag", () => {
    const t = new TodoManager();
    t.replaceAll([
      {
        id: "t6",
        content: "主项\n- [ ] 1. a\n- [ ] 2. b",
        done: true,
      },
    ]);
    expect(t.list()[0].content).toContain("- [x] 1. a");
    expect(t.toPromptBlock()).not.toMatch(/- \[ \]/);
  });

  it("hasPending is false when all items done", () => {
    const t = new TodoManager();
    const it = t.add("x");
    expect(t.hasPending()).toBe(true);
    t.update(it.id, true);
    expect(t.hasPending()).toBe(false);
  });
});
