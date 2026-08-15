# Task 3 Brief

(来源: .dsb/plans/2026-08-14-platform-tools.md,由控制器提取)

Grep 二进制解析修复(候选顺序 + PATH 兜底)

**Files:**
- Modify: `dsb-agent/src/util/ripgrepPath.ts`
- Modify: `dsb-agent/tests/ripgrepPath.test.ts`
- Modify: `dsb-agent/src/agent/tools/executor.ts`(resolveRgBinary 加 PATH 兜底)

**Interfaces:**
- Consumes: 现有 `resolveRipgrepCandidates` / `pickRipgrepPath` / `configureRipgrepPath`。
- Produces:
  - `resolveRipgrepCandidates` 顺序保证:当前平台 `@vscode/ripgrep-${platform}-${arch}` 候选紧随 dist 之后、其它平台目录之前(现状已是,补回归用例锁定)。
  - `export function pickRipgrepPathFromEnv(existsSync?: (p: string) => boolean): string | undefined;` —— 扫描 `process.env.PATH` 找 `rg`(win32 为 `rg.exe`)。
  - `resolveRgBinary(ctx)` 在现有候选失败后追加 PATH 探测。

- [ ] **Step 1: 修改 `ripgrepPath.ts` 加 PATH 候选函数**

文件末尾加:
```ts
const PATH_DELIM = process.platform === "win32" ? ";" : ":";

/** 扫描 PATH 找 rg/rg.exe;命中返回绝对路径,否则 undefined。 */
export function pickRipgrepPathFromEnv(
  existsSync: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  const dirs = (process.env.PATH ?? "").split(PATH_DELIM).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (pathExists(candidate, existsSync)) return candidate;
  }
  return undefined;
}
```

- [ ] **Step 2: 扩展 `tests/ripgrepPath.test.ts`**

在 `describe("pickRipgrepPath")` 后加:
```ts
describe("pickRipgrepPathFromEnv", () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });
  it("finds rg.exe on PATH (win32 style)", () => {
    const bin = path.join(os.tmpdir(), "rgenv-" + Date.now());
    fs.mkdirSync(bin, { recursive: true });
    const rg = path.join(bin, process.platform === "win32" ? "rg.exe" : "rg");
    fs.writeFileSync(rg, "");
    process.env.PATH = bin + path.delimiter + (origPath ?? "");
    const found = pickRipgrepPathFromEnv();
    expect(found).toBe(rg);
    fs.rmSync(bin, { recursive: true, force: true });
  });
  it("returns undefined when not on PATH", () => {
    process.env.PATH = path.join(os.tmpdir(), "definitely-empty-" + Date.now());
    expect(pickRipgrepPathFromEnv()).toBeUndefined();
  });
});
```
(需 import:`pickRipgrepPathFromEnv` 加入顶部 import 列表。)

- [ ] **Step 3: 修改 `executor.ts` 的 `resolveRgBinary`**

在 `getConfiguredRipgrepPath()` 分支后、distDir 分支前插入 PATH 兜底:
```ts
const fromEnv = pickRipgrepPathFromEnv();
if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
```
顶部 import 加 `pickRipgrepPathFromEnv`(与 `pickRipgrepPath` 同一来源)。

- [ ] **Step 4: 验证**

```bash
npx vitest run tests/ripgrepPath.test.ts   # 预期 PASS(含新增 2 用例)
# 无 node 时用 Python 括号校验
```

- [ ] **Step 5: Commit**

```bash
git add dsb-agent/src/util/ripgrepPath.ts dsb-agent/tests/ripgrepPath.test.ts dsb-agent/src/agent/tools/executor.ts
git commit -m "fix(grep): resolve rg from PATH as fallback"
```

---
