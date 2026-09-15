import { describe, it, expect } from "vitest";
import {
  DEPRECATED_SETTINGS,
  CONFIG_SCOPES,
  findDeprecatedValues,
  planDeprecatedCleanup,
  describeCleanup,
  scopeValue,
  type SettingInspect,
} from "../src/settings/deprecatedSettings";

describe("deprecatedSettings 登记表", () => {
  it("登记了 thinking 总闸与全局强度两个死键", () => {
    const keys = DEPRECATED_SETTINGS.map((d) => d.key);
    expect(keys).toContain("dsbAgent.thinking.enabled");
    expect(keys).toContain("dsbAgent.thinking.level");
  });

  it("每条都带 replacedBy 与 reason(日志要能指引用户迁移)", () => {
    for (const d of DEPRECATED_SETTINGS) {
      expect(d.replacedBy.length).toBeGreaterThan(0);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it("活键 compaction.thinking 不在登记表内(防误删)", () => {
    expect(DEPRECATED_SETTINGS.map((d) => d.key)).not.toContain("dsbAgent.compaction.thinking");
  });
});

describe("findDeprecatedValues", () => {
  it("未设过任何值(inspect=undefined)→ 无清理动作", () => {
    expect(findDeprecatedValues("dsbAgent.thinking.enabled", undefined)).toEqual([]);
  });

  it("inspect 存在但三作用域皆 undefined → 无清理动作(不产生无意义写盘)", () => {
    const inspect: SettingInspect = {};
    expect(findDeprecatedValues("dsbAgent.thinking.enabled", inspect)).toEqual([]);
  });

  it("只清理用户确实设过值的作用域", () => {
    const inspect: SettingInspect = { globalValue: false };
    const hits = findDeprecatedValues("dsbAgent.thinking.enabled", inspect);
    expect(hits).toEqual([{ key: "dsbAgent.thinking.enabled", scope: "global", value: false }]);
  });

  it("保留 false 值不会被当成「未设置」丢弃", () => {
    const inspect: SettingInspect = { workspaceValue: false };
    const hits = findDeprecatedValues("dsbAgent.thinking.enabled", inspect);
    expect(hits).toHaveLength(1);
    expect(hits[0].value).toBe(false);
  });

  it("三作用域同时设过 → 三处都清理", () => {
    const inspect: SettingInspect = {
      globalValue: false,
      workspaceValue: true,
      workspaceFolderValue: "high",
    };
    const hits = findDeprecatedValues("dsbAgent.thinking.level", inspect);
    expect(hits.map((h) => h.scope).sort()).toEqual([...CONFIG_SCOPES].sort());
    expect(hits.map((h) => h.value)).toEqual(
      expect.arrayContaining([false, true, "high"]),
    );
  });

  it("scopeValue 对各作用域取值正确", () => {
    const inspect: SettingInspect = { globalValue: 1, workspaceFolderValue: 3 };
    expect(scopeValue(inspect, "global")).toBe(1);
    expect(scopeValue(inspect, "workspace")).toBeUndefined();
    expect(scopeValue(inspect, "workspaceFolder")).toBe(3);
  });
});

describe("planDeprecatedCleanup", () => {
  it("逐键 inspect:汇总所有键在各作用域上的清理动作", () => {
    const store: Record<string, SettingInspect | undefined> = {
      "dsbAgent.thinking.enabled": { globalValue: false },
      "dsbAgent.thinking.level": { workspaceValue: "medium" },
    };
    const plan = planDeprecatedCleanup((key) => store[key]);
    expect(plan).toHaveLength(2);
    expect(plan.map((h) => h.key).sort()).toEqual([
      "dsbAgent.thinking.enabled",
      "dsbAgent.thinking.level",
    ]);
    expect(plan.find((h) => h.key === "dsbAgent.thinking.enabled")?.scope).toBe("global");
    expect(plan.find((h) => h.key === "dsbAgent.thinking.level")?.value).toBe("medium");
  });

  it("全部未设过 → 空计划(激活时零写盘,不影响 settings 变更事件)", () => {
    const plan = planDeprecatedCleanup(() => undefined);
    expect(plan).toEqual([]);
  });

  it("未知键返回 undefined 也不抛错", () => {
    const plan = planDeprecatedCleanup(() => undefined);
    expect(plan).toHaveLength(0);
  });
});

describe("describeCleanup", () => {
  it("每键每作用域一条可读日志,含键名/值/作用域/替代物", () => {
    const lines = describeCleanup([
      { key: "dsbAgent.thinking.enabled", scope: "global", value: false },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dsbAgent.thinking.enabled");
    expect(lines[0]).toContain("false");
    expect(lines[0]).toContain("global");
    expect(lines[0]).toContain("替代:");
  });

  it("空计划输出空数组", () => {
    expect(describeCleanup([])).toEqual([]);
  });
});
