import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProjectScope } from "../src/agent/projectScope";
import { SessionStore, migrateLegacySessions } from "../src/session/sessionStore";
import { MemoryStore, mergeMemoryIndex } from "../src/agent/memory/memoryStore";
import { VscodeSessionUiState, MemorySessionUiState } from "../src/settings/sessionUiState";

/**
 * 端到端冒烟:模拟 extension.activate 的装配链
 *   projectKey → sessionsDir = <sessionsRoot>/<projectKey>
 *              → memory = memoryRoot.scoped(projectKey)
 *              → sessionUiState.scoped(projectKey)
 * 验证两个项目各自完全隔离:会话/记忆/lastSessionId 互不串扰。
 */
function assemble(execRemote: () => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-e2e-"));
  const scope = new ProjectScope(async () => execRemote());
  return { root, scope };
}

describe("项目隔离端到端装配", () => {
  it("两个不同 git remote 的项目:会话、记忆、lastSessionId 互不串扰", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-e2e-"));
    const sessionsRoot = path.join(root, "sessions");
    const memRoot = path.join(root, "memory");
    const uiRoot = new MemorySessionUiState();

    // 项目 A(git remote = proj-a)
    const scopeA = new ProjectScope(async () => "https://github.com/org/proj-a.git");
    const keyA = await scopeA.resolve("/ws/proj-a");
    // 项目 B(git remote = proj-b)
    const scopeB = new ProjectScope(async () => "https://github.com/org/proj-b.git");
    const keyB = await scopeB.resolve("/ws/proj-b");
    expect(keyA).not.toBe(keyB);

    // 会话:各自 scoped 目录
    const sessionsA = new SessionStore(path.join(sessionsRoot, keyA));
    const sessionsB = new SessionStore(path.join(sessionsRoot, keyB));
    const idA = sessionsA.create();
    const idB = sessionsB.create();
    expect(sessionsA.exists(idA)).toBe(true);
    expect(sessionsA.exists(idB)).toBe(false);
    expect(sessionsB.exists(idA)).toBe(false);

    // 记忆:project scoped
    const memA = new MemoryStore(path.join(memRoot, keyA));
    const memB = new MemoryStore(path.join(memRoot, keyB));
    memA.write({ name: "note", description: "A", body: "a", updatedAt: 1 });
    memB.write({ name: "note", description: "B", body: "b", updatedAt: 1 });
    expect(memA.get("note")?.description).toBe("A");
    expect(memB.get("note")?.description).toBe("B");

    // 注入合并:项目 + 全局(无全局时仅项目)
    expect(mergeMemoryIndex(memA.index(), "")).toBe("- note: A");
    expect(mergeMemoryIndex(memB.index(), "")).toBe("- note: B");

    // lastSessionId:按项目隔离
    const uiA = uiRoot.scoped(keyA);
    const uiB = uiRoot.scoped(keyB);
    uiA.setLastSessionId(idA);
    uiB.setLastSessionId(idB);
    expect(uiA.getLastSessionId()).toBe(idA);
    expect(uiB.getLastSessionId()).toBe(idB);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("同仓库 worktree 目录归一同一个 projectKey(会话/记忆共享)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsb-e2e-"));
    const scope = new ProjectScope(async () => "git@github.com:org/repo.git");
    const keyMain = await scope.resolve("/ws/main");
    const keyWt = await scope.resolve("/ws/.dsb/worktrees/task-1");
    expect(keyMain).toBe(keyWt);

    const memRoot = path.join(root, "memory");
    const memMain = new MemoryStore(path.join(memRoot, keyMain));
    const memWt = new MemoryStore(path.join(memRoot, keyWt));
    memMain.write({ name: "note", description: "shared", body: "x", updatedAt: 1 });
    expect(memWt.get("note")?.body).toBe("x"); // worktree 会话可见主工作区记忆

    // 会话迁移:旧版根目录文件迁入当前项目目录,id 不变
    const sessionsRoot = path.join(root, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, "s_old.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(sessionsRoot, "s_old.api.json"), "[]", "utf8");
    const moved = migrateLegacySessions(sessionsRoot, keyMain);
    expect(moved).toBe(2);
    const store = new SessionStore(path.join(sessionsRoot, keyMain));
    expect(store.exists("s_old")).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("VscodeSessionUiState scoped key 在 globalState 中按项目独立", () => {
    class FakeMemento {
      private m = new Map<string, unknown>();
      get<T>(key: string): T | undefined { return this.m.get(key) as T | undefined; }
      update(key: string, value: unknown): void {
        if (value === undefined) this.m.delete(key); else this.m.set(key, value);
      }
    }
    const memento = new FakeMemento();
    const ui = new VscodeSessionUiState(memento);
    const keyA = "abc123";
    const keyB = "def456";
    ui.scoped(keyA).setLastSessionId("sess-a");
    ui.scoped(keyB).setLastSessionId("sess-b");
    expect(memento.get<string>(`dsbAgent.lastSessionId.${keyA}`)).toBe("sess-a");
    expect(memento.get<string>(`dsbAgent.lastSessionId.${keyB}`)).toBe("sess-b");
  });
});
