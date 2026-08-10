export interface WorkflowStage {
  id: string;
  prompt: string;
  dependsOn: string[];
}

export interface WorkflowDefinition {
  goal: string;
  stages: WorkflowStage[];
}

export interface WorkflowResult {
  stageResults: Record<string, string>;
  final: string;
}

export class WorkflowRunner {
  constructor(
    private readonly deps: {
      runStage: (prompt: string) => Promise<string>;
      onProgress?: (stageId: string, status: "running" | "done" | "error") => void;
    },
  ) {}

  async run(def: WorkflowDefinition): Promise<WorkflowResult> {
    const results: Record<string, string> = {};
    const done = new Set<string>();
    const pending = [...def.stages];

    while (pending.length > 0) {
      const ready = pending.filter((s) => s.dependsOn.every((d) => done.has(d)));
      if (ready.length === 0) throw new Error("Workflow has a dependency cycle or unsatisfiable stage");
      const batchResults = await Promise.all(
        ready.map(async (stage) => {
          this.deps.onProgress?.(stage.id, "running");
          try {
            const out = await this.deps.runStage(stage.prompt);
            this.deps.onProgress?.(stage.id, "done");
            return { stage, out };
          } catch (err) {
            this.deps.onProgress?.(stage.id, "error");
            return { stage, out: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
          }
        }),
      );
      for (const { stage, out } of batchResults) {
        results[stage.id] = out;
        done.add(stage.id);
      }
      for (const stage of ready) pending.splice(pending.indexOf(stage), 1);
    }

    const final = [
      `# 工作流结果:${def.goal}`,
      ...def.stages.map((s) => `## ${s.id}\n${results[s.id] ?? "(no result)"}`),
    ].join("\n\n");
    return { stageResults: results, final };
  }
}
