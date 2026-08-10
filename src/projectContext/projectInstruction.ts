import * as fs from "fs";
import { firstExistingFile, projectInstructionCandidates } from "./convention";

/** 读取项目指令文件:DSB.md 优先(顶层 → .dsb/),旧 CLAUDE.md 只读回退。 */
export function readProjectInstruction(workspaceRoot: string): string {
  const file = firstExistingFile(projectInstructionCandidates(workspaceRoot));
  if (!file) return "";
  return fs.readFileSync(file, "utf8");
}
