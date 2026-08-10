import { describe, it, expect } from "vitest";
import { MemorySessionUiState, VscodeSessionUiState } from "../src/settings/sessionUiState";

describe("MemorySessionUiState", () => {
  it("round-trips lastSessionId", () => {
    const state = new MemorySessionUiState();
    expect(state.getLastSessionId()).toBeUndefined();
    state.setLastSessionId("sess-1");
    expect(state.getLastSessionId()).toBe("sess-1");
    state.setLastSessionId(undefined);
    expect(state.getLastSessionId()).toBeUndefined();
  });

  it("round-trips interrupted flag", () => {
    const state = new MemorySessionUiState();
    expect(state.getInterrupted()).toBeUndefined();
    const interrupted = { sessionId: "sess-2", at: 1234567890 };
    state.setInterrupted(interrupted);
    expect(state.getInterrupted()).toEqual(interrupted);
    state.setInterrupted(undefined);
    expect(state.getInterrupted()).toBeUndefined();
  });

  it("scoped 实例互不串扰(按项目隔离 lastSessionId/interrupted)", () => {
    const root = new MemorySessionUiState();
    const a = root.scoped("proj-a");
    const b = root.scoped("proj-b");
    a.setLastSessionId("sess-a");
    b.setLastSessionId("sess-b");
    expect(a.getLastSessionId()).toBe("sess-a");
    expect(b.getLastSessionId()).toBe("sess-b");
    expect(root.getLastSessionId()).toBeUndefined();
    a.setInterrupted({ sessionId: "sess-a", at: 1 });
    expect(b.getInterrupted()).toBeUndefined();
  });

  it("scoped 读不到时回退到无前缀旧 key(升级兼容),写只写 scoped key", () => {
    const root = new MemorySessionUiState();
    root.setLastSessionId("legacy-sess");
    const a = root.scoped("proj-a");
    expect(a.getLastSessionId()).toBe("legacy-sess"); // 回退旧 key
    a.setLastSessionId("new-sess");
    expect(a.getLastSessionId()).toBe("new-sess");
    expect(root.getLastSessionId()).toBe("legacy-sess"); // 根 key 未被污染
    const b = root.scoped("proj-b");
    expect(b.getLastSessionId()).toBe("legacy-sess"); // 其他项目也回退旧 key
  });
});

describe("VscodeSessionUiState", () => {
  class FakeMemento {
    private m = new Map<string, unknown>();
    get<T>(key: string): T | undefined {
      return this.m.get(key) as T | undefined;
    }
    update(key: string, value: unknown): void {
      if (value === undefined) this.m.delete(key);
      else this.m.set(key, value);
    }
  }

  it("scoped key 带 projectKey 前缀,互不覆盖", () => {
    const memento = new FakeMemento();
    const root = new VscodeSessionUiState(memento);
    const a = root.scoped("proj-a");
    const b = root.scoped("proj-b");
    a.setLastSessionId("sess-a");
    b.setLastSessionId("sess-b");
    expect(a.getLastSessionId()).toBe("sess-a");
    expect(b.getLastSessionId()).toBe("sess-b");
    expect(root.getLastSessionId()).toBeUndefined();
    expect(memento.get<string>("dsbAgent.lastSessionId.proj-a")).toBe("sess-a");
    expect(memento.get<string>("dsbAgent.lastSessionId.proj-b")).toBe("sess-b");
  });

  it("旧版无前缀 key 回退:升级后仍能恢复上次会话", () => {
    const memento = new FakeMemento();
    memento.update("dsbAgent.lastSessionId", "legacy-sess");
    const a = new VscodeSessionUiState(memento).scoped("proj-a");
    expect(a.getLastSessionId()).toBe("legacy-sess");
  });
});
