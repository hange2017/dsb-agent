import { describe, it, expect, vi } from "vitest";
import { WorkflowRunner, type WorkflowDefinition } from "../src/agent/workflow";

describe("WorkflowRunner", () => {
  it("runs independent stages in parallel", async () => {
    const runStage = vi.fn(async (p: string) => `result:${p}`);
    const runner = new WorkflowRunner({ runStage });
    const def: WorkflowDefinition = {
      goal: "g",
      stages: [
        { id: "a", prompt: "A", dependsOn: [] },
        { id: "b", prompt: "B", dependsOn: [] },
      ],
    };
    const r = await runner.run(def);
    expect(r.stageResults.a).toContain("A");
    expect(r.stageResults.b).toContain("B");
    expect(r.final).toContain("工作流结果");
  });
  it("respects dependencies ordering", async () => {
    const order: string[] = [];
    const runStage = vi.fn(async (p: string) => {
      order.push(p);
      return p;
    });
    const runner = new WorkflowRunner({ runStage });
    await runner.run({ goal: "g", stages: [{ id: "a", prompt: "A", dependsOn: [] }, { id: "c", prompt: "C", dependsOn: ["a"] }] });
    expect(order).toEqual(["A", "C"]);
  });
  it("throws on dependency cycle", async () => {
    const runner = new WorkflowRunner({ runStage: async () => "" });
    await expect(runner.run({ goal: "g", stages: [{ id: "a", prompt: "A", dependsOn: ["b"] }, { id: "b", prompt: "B", dependsOn: ["a"] }] })).rejects.toThrow(/cycle/);
  });
});
