import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("project scaffold", () => {
  it("package.json declares commands and no left-side view container (panel-based chat)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    // 聊天已改为右侧 WebviewPanel(ViewColumn.Beside),不再有活动栏视图容器,避免与资源管理器重叠
    expect(pkg.contributes.viewsContainers).toBeUndefined();
    const names = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(names).toContain("dsbAgent.open");
    expect(names).toContain("dsbAgent.setApiKey");
  });
});
