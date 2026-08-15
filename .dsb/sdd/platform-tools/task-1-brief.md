# Task 1 Brief

(来源: .dsb/plans/2026-08-14-platform-tools.md,由控制器提取)

平台元数据 + 门禁纯函数 + 注册层接线

**Files:**
- Modify: `dsb-agent/src/agent/tools/types.ts`(ToolDef 加 platforms、ToolExecContext 加 platform)
- Create: `dsb-agent/src/agent/tools/platformGate.ts`
- Create: `dsb-agent/tests/platformGate.test.ts`
- Modify: `dsb-agent/src/agent/tools/executor.ts`(allToolDefs 加过滤)

**Interfaces:**
- Consumes: 现有 `ToolDef` 类型(`name`/`description`/`input_schema`)。
- Produces:
  - `export type ToolPlatform = NodeJS.Platform;`
  - `ToolDef` 增加可选字段 `platforms?: ToolPlatform[];`
  - `ToolExecContext` 增加可选字段 `platform?: NodeJS.Platform;`
  - `export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[];`
  - `ToolExecutor.allToolDefs(): ToolDef[]` 行为变更:返回 `filterToolDefs([...this.toolDefs, ...mcp, ...plugin], ctxPlatform)` 结果。

- [ ] **Step 1: 修改 `types.ts` 加平台元数据**

在 `ToolDef` 类型加:
```ts
export type ToolPlatform = NodeJS.Platform; // "win32" | "linux" | "darwin" | ...

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 可选:仅在该平台集合暴露;缺省 = 全平台。 */
  platforms?: ToolPlatform[];
};
```
`ToolExecContext` 加:
```ts
/** 平台门禁过滤与提示词构建用的平台;缺省 process.platform。测试可注入。 */
platform?: NodeJS.Platform;
```

- [ ] **Step 2: 新建 `platformGate.ts`**

```ts
import type { ToolDef } from "./types";

/** 按平台过滤工具定义:未声明 platforms 的放行;声明了仅当 platform ∈ platforms。 */
export function filterToolDefs(defs: ToolDef[], platform: NodeJS.Platform): ToolDef[] {
  return defs.filter((d) => !d.platforms || d.platforms.length === 0 || d.platforms.includes(platform));
}
```

- [ ] **Step 3: 新建 `tests/platformGate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { filterToolDefs } from "../src/agent/tools/platformGate";
import type { ToolDef } from "../src/agent/tools/types";

function def(name: string, platforms?: NodeJS.Platform[]): ToolDef {
  return { name, description: name, input_schema: {}, ...(platforms ? { platforms } : {}) };
}

describe("filterToolDefs", () => {
  it("passes through tools without platforms", () => {
    const defs = [def("a"), def("b")];
    expect(filterToolDefs(defs, "win32").map((d) => d.name)).toEqual(["a", "b"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("keeps only matching platform when declared", () => {
    const defs = [def("win-only", ["win32"]), def("all")];
    const win = filterToolDefs(defs, "win32").map((d) => d.name);
    expect(win).toContain("win-only");
    expect(win).toContain("all");
    const linux = filterToolDefs(defs, "linux").map((d) => d.name);
    expect(linux).not.toContain("win-only");
    expect(linux).toContain("all");
  });

  it("empty platforms array means all platforms", () => {
    const defs = [def("e", [])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["e"]);
  });

  it("multi-platform list keeps any match", () => {
    const defs = [def("uni", ["win32", "darwin"])];
    expect(filterToolDefs(defs, "darwin").map((d) => d.name)).toEqual(["uni"]);
    expect(filterToolDefs(defs, "linux").map((d) => d.name)).toEqual([]);
  });
});
```

- [ ] **Step 4: 修改 `executor.ts` 的 `allToolDefs()` 接线门禁**

`allToolDefs()` 改为:
```ts
allToolDefs(): ToolDef[] {
  const mcp: ToolDef[] = [];
  for (const defs of this.mcpServerDefs.values()) mcp.push(...defs);
  const plugin = [...this.pluginTools.values()].map(buildPluginToolDef);
  const all = [...this.toolDefs, ...mcp, ...plugin];
  // 平台门禁:缺省按 process.platform 过滤(当前核心工具全平台,机制供平台专用工具使用)
  return filterToolDefs(all, process.platform);
}
```
并在文件顶部 import:`import { filterToolDefs } from "./platformGate";`

- [ ] **Step 5: 验证**

```bash
# 有 node 的环境:
npx vitest run tests/platformGate.test.ts
# 预期:PASS 4 个用例。
# 无 node 的环境(本机):
python - <<'PY'
import re
for f in ["dsb-agent/src/agent/tools/types.ts","dsb-agent/src/agent/tools/platformGate.ts","dsb-agent/src/agent/tools/executor.ts","dsb-agent/tests/platformGate.test.ts"]:
    s = open(f, encoding="utf-8").read()
    s2 = re.sub(r"//[^\n]*", "", s)
    assert s2.count("{") == s2.count("}"), f"bracket mismatch in {f}"
    print(f"{f}: brackets balanced")
PY
```

- [ ] **Step 6: Commit**(若仓库可用)

```bash
git add dsb-agent/src/agent/tools/types.ts dsb-agent/src/agent/tools/platformGate.ts dsb-agent/src/agent/tools/executor.ts dsb-agent/tests/platformGate.test.ts
git commit -m "feat(tools): add platform gate metadata and filter"
```
(当前 e:\DSBAgent 非 git 仓库,此步可跳过,记录说明即可)

---
