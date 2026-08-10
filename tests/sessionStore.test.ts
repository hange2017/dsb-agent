import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, sessionIdToTitle } from "../src/session/sessionStore";
import type { SessionEvent } from "../src/session/sessionTypes";
import type { ProviderMessage } from "../src/agent/provider/types";

let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsess-"));
  store = new SessionStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("SessionStore", () => {
  it("creates, appends, loads", () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    store.append(id, { kind: "assistant", text: "你好!", final: true, timestamp: 2 });
    const events = store.load(id);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("user");
    expect(events[1]).toMatchObject({ kind: "assistant", text: "你好!", final: true });
  });
  it("round-trips assistant.final false for intermediate segments", () => {
    const id = store.create();
    store.append(id, { kind: "assistant", text: "mid", final: false, timestamp: 1 });
    store.append(id, { kind: "assistant", text: "end", final: true, timestamp: 2 });
    const events = store.load(id);
    expect(events[0]).toMatchObject({ kind: "assistant", text: "mid", final: false });
    expect(events[1]).toMatchObject({ kind: "assistant", text: "end", final: true });
  });
  it("lists sorted by updatedAt", () => {
    const a = store.create();
    store.append(a, { kind: "user", text: "first", timestamp: 1 });
    // 强制 a 的 mtime 更早,保证排序与写入时机无关(ext4 mtime 粒度 ~1ms,快速写入可能相同)
    fs.utimesSync(path.join(dir, `${a}.jsonl`), new Date(1000), new Date(1000));
    const b = store.create();
    store.append(b, { kind: "user", text: "second", timestamp: 2 });
    const list = store.list();
    expect(list[0].id).toBe(b);
    expect(list[1].id).toBe(a);
  });
  it("titles from first user message", () => {
    expect(sessionIdToTitle([{ kind: "user", text: "帮我重构一个模块", timestamp: 1 }])).toBe("帮我重构一个模块");
  });
  it("deletes a session", () => {
    const id = store.create();
    store.delete(id);
    expect(store.list()).toHaveLength(0);
  });
  it("skips a corrupt JSONL line instead of throwing", () => {
    const id = store.create();
    store.append(id, { kind: "user", text: "你好", timestamp: 1 });
    fs.appendFileSync(path.join(dir, `${id}.jsonl`), "{not-json}\n", "utf8");
    store.append(id, { kind: "user", text: "后一条", timestamp: 2 });
    const events = store.load(id);
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe("user");
  });
  it("list() survives a corrupt session file without throwing", () => {
    const good = store.create();
    store.append(good, { kind: "user", text: "good", timestamp: 1 });
    // 直接写坏文件,不经过 append
    const bad = `bad_${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(dir, `${bad}.jsonl`), "garbage\n{broken\n", "utf8");
    expect(() => store.list()).not.toThrow();
    const list = store.list();
    expect(list.some((s) => s.id === good)).toBe(true);
    // 坏文件的 load 不抛异常,返回 0 条有效事件
    expect(store.load(bad)).toEqual([]);
  });
  it("round-trips api history with tool pairs", () => {
    const id = store.create();
    const history: ProviderMessage[] = [
      { role: "user", content: "read a.ts" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }] },
    ];
    store.saveApiHistory(id, history);
    expect(store.loadApiHistory(id)).toEqual(history);
  });

  it("loadApiHistory returns [] when the file is missing", () => {
    const id = store.create();
    expect(store.loadApiHistory(id)).toEqual([]);
  });

  it("loadApiHistory returns [] on corrupt JSON", () => {
    const id = store.create();
    fs.writeFileSync(path.join(dir, `${id}.api.json`), "{not-json", "utf8");
    expect(store.loadApiHistory(id)).toEqual([]);
  });

  it("loadApiHistory returns [] for wrong-shape JSON", () => {
    const id = store.create();
    fs.writeFileSync(path.join(dir, `${id}.api.json`), JSON.stringify([1, 2, 3]), "utf8");
    expect(store.loadApiHistory(id)).toEqual([]);
  });

  it("delete removes both jsonl and api.json", () => {
    const id = store.create();
    store.saveApiHistory(id, [{ role: "user", content: "x" }]);
    store.delete(id);
    expect(fs.existsSync(path.join(dir, `${id}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${id}.api.json`))).toBe(false);
  });

  it("round-trips todos", () => {
    const id = store.create();
    const items = [
      { id: "1", content: "fix bug", done: false },
      { id: "2", content: "write tests", done: true },
    ];
    store.saveTodos(id, items);
    expect(store.loadTodos(id)).toEqual(items);
  });

  it("loadTodos returns [] when missing or corrupt", () => {
    const id = store.create();
    expect(store.loadTodos(id)).toEqual([]);
    fs.writeFileSync(path.join(dir, `${id}.todos.json`), "{bad", "utf8");
    expect(store.loadTodos(id)).toEqual([]);
    fs.writeFileSync(path.join(dir, `${id}.todos.json`), JSON.stringify([{ id: 1 }]), "utf8");
    expect(store.loadTodos(id)).toEqual([]);
  });

  it("delete removes todos file", () => {
    const id = store.create();
    store.saveTodos(id, [{ id: "1", content: "task", done: false }]);
    store.delete(id);
    expect(fs.existsSync(path.join(dir, `${id}.todos.json`))).toBe(false);
  });

  it("list() does not treat .api.json as a session", () => {
    const a = store.create();
    store.saveApiHistory(a, [{ role: "user", content: "x" }]);
    const b = store.create();
    expect(store.list().map((s) => s.id).sort()).toEqual([a, b].sort());
  });
});

describe("SessionStore list title peek", () => {
  it("titles from the first user event without full-file parsing", () => {
    const id = store.create();
    // 先落一条 tool 事件,再落 user(peek 需跨行找 user)
    store.append(id, { kind: "tool", name: "Read", status: "completed", timestamp: 1 });
    store.append(id, { kind: "user", text: "帮我重构一个模块  ", timestamp: 2 });
    const list = store.list();
    expect(list.find((s) => s.id === id)!.title.trim()).toBe("帮我重构一个模块");
  });

  it("falls back to 新会话 when the first user event is beyond the peek window", () => {
    const id = store.create();
    // 构造超 256KB 的前缀事件(非 user),把首个 user 挤到窗口外
    const big: SessionEvent = { kind: "assistant", text: "x".repeat(300 * 1024), final: true, timestamp: 1 };
    store.append(id, big);
    store.append(id, { kind: "user", text: "深处标题", timestamp: 2 });
    const list = store.list();
    expect(list.find((s) => s.id === id)!.title).toBe("新会话");
    // 会话本身仍可完整加载
    expect(store.load(id).some((e) => e.kind === "user" && e.text === "深处标题")).toBe(true);
  });

  it("list titles survive a corrupt first line", () => {
    const id = store.create();
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), "{broken\n", "utf8");
    store.append(id, { kind: "user", text: "ok 标题", timestamp: 1 });
    const list = store.list();
    expect(list.find((s) => s.id === id)!.title).toBe("ok 标题");
  });
});
