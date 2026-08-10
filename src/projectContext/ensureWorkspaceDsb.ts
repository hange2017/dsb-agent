import * as fs from "fs";
import * as path from "path";
import { CONVENTION_DIR, firstExistingFile, projectInstructionCandidates } from "./convention";

const kScaffoldSubdirs = [
  "skills",
  "rules",
  "commands",
  "agents",
  "plans",
  "specs",
  "docs",
] as const;

const kSkipDotDirs = new Set([CONVENTION_DIR, ".git", ".svn", ".hg", "node_modules"]);

const kExtensionSkillSubs = ["skills", ".claude/skills", ".claude-plugin/skills"] as const;
const kExtensionMdLeafSubs: Record<"rules" | "commands" | "agents", readonly string[]> = {
  rules: ["rules", ".claude/rules"],
  commands: ["commands", ".claude/commands"],
  agents: ["agents", ".claude/agents", ".agents"],
};

const kDsbMdStub = [
  "# 项目指令",
  "",
  "在此描述本仓库的技术栈、目录约定、禁止事项与协作偏好。",
  "Agent 会把它注入系统提示。",
  "",
  "生成文档默认路径:",
  "- 实现计划 → `.dsb/plans/`",
  "- 设计说明 → `.dsb/specs/`",
  "- 其它文档 → `.dsb/docs/`",
  "",
].join("\n");

export type EnsureWorkspaceDsbResult = {
  /** 本次是否新建了 `.dsb` 并执行种子复制。 */
  created: boolean;
  copiedSkills: number;
  copiedRules: number;
  copiedCommands: number;
  copiedAgents: number;
  wroteDsbMd: boolean;
};

export type EnsureWorkspaceDsbOpts = {
  extensions?: ReadonlyArray<{ extensionPath: string; id?: string }>;
};

function emptyResult(created: boolean): EnsureWorkspaceDsbResult {
  return {
    created,
    copiedSkills: 0,
    copiedRules: 0,
    copiedCommands: 0,
    copiedAgents: 0,
    wroteDsbMd: false,
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDotDirs(workspaceRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(".") || kSkipDotDirs.has(e.name)) continue;
    out.push(path.join(workspaceRoot, e.name));
  }
  return out;
}

/** 项目内 `<ws>/<leaf>` 与一层点目录下的同名 leaf 目录。 */
function collectProjectLeafDirs(workspaceRoot: string, leaf: string): string[] {
  return [path.join(workspaceRoot, leaf), ...listDotDirs(workspaceRoot).map((d) => path.join(d, leaf))].filter(
    isDir,
  );
}

function collectProjectSkillDirs(workspaceRoot: string): string[] {
  const dirs: string[] = [];
  for (const skillsRoot of collectProjectLeafDirs(workspaceRoot, "skills")) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillDir = path.join(skillsRoot, e.name);
      if (fs.existsSync(path.join(skillDir, "SKILL.md"))) dirs.push(skillDir);
    }
  }
  return dirs;
}

function copySkillDir(srcDir: string, destSkillsRoot: string): boolean {
  const dest = path.join(destSkillsRoot, path.basename(srcDir));
  if (isDir(dest) || fs.existsSync(dest)) return false;
  try {
    fs.cpSync(srcDir, dest, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function copyMarkdownFiles(srcDir: string, destDir: string, namePrefix: string): number {
  let copied = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const src = path.join(srcDir, e.name);
    let destName = e.name;
    let dest = path.join(destDir, destName);
    if (fs.existsSync(dest)) {
      const safePrefix = namePrefix.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "src";
      destName = `${safePrefix}-${e.name}`;
      dest = path.join(destDir, destName);
      if (fs.existsSync(dest)) continue;
    }
    try {
      fs.copyFileSync(src, dest);
      copied += 1;
    } catch {
      // 单文件失败跳过
    }
  }
  return copied;
}

function leafPrefix(workspaceRoot: string, leafDir: string): string {
  const parent = path.dirname(leafDir);
  return path.resolve(parent) === path.resolve(workspaceRoot) ? "root" : path.basename(parent);
}

function seedDsbMd(workspaceRoot: string, dsbRoot: string): boolean {
  const dest = path.join(dsbRoot, "DSB.md");
  if (fs.existsSync(dest)) return false;
  // 优先复用已有项目指令(根目录 DSB.md / CLAUDE.md 等);排除尚未写入的 .dsb/DSB.md 自身
  const candidates = projectInstructionCandidates(workspaceRoot).filter(
    (p) => path.resolve(p) !== path.resolve(dest),
  );
  const existing = firstExistingFile(candidates);
  try {
    if (existing) {
      fs.copyFileSync(existing, dest);
    } else {
      fs.writeFileSync(dest, kDsbMdStub, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 工作区无 `.dsb/` 时创建约定目录树,并从项目约定路径 + VS Code 扩展复制
 * skills / rules / commands / agents,并写入 `.dsb/DSB.md`。
 * `.dsb` 已存在则直接返回(不重复复制)。失败 fail-open。
 */
export function ensureWorkspaceDsb(
  workspaceRoot: string,
  opts: EnsureWorkspaceDsbOpts = {},
): EnsureWorkspaceDsbResult {
  const dsbRoot = path.join(workspaceRoot, CONVENTION_DIR);
  if (isDir(dsbRoot)) return emptyResult(false);

  const result = emptyResult(true);
  try {
    fs.mkdirSync(dsbRoot, { recursive: true });
    for (const sub of kScaffoldSubdirs) {
      fs.mkdirSync(path.join(dsbRoot, sub), { recursive: true });
    }

    const destSkills = path.join(dsbRoot, "skills");
    const destRules = path.join(dsbRoot, "rules");
    const destCommands = path.join(dsbRoot, "commands");
    const destAgents = path.join(dsbRoot, "agents");

    for (const skillDir of collectProjectSkillDirs(workspaceRoot)) {
      if (copySkillDir(skillDir, destSkills)) result.copiedSkills += 1;
    }
    for (const dir of collectProjectLeafDirs(workspaceRoot, "rules")) {
      result.copiedRules += copyMarkdownFiles(dir, destRules, leafPrefix(workspaceRoot, dir));
    }
    for (const dir of collectProjectLeafDirs(workspaceRoot, "commands")) {
      result.copiedCommands += copyMarkdownFiles(dir, destCommands, leafPrefix(workspaceRoot, dir));
    }
    for (const dir of collectProjectLeafDirs(workspaceRoot, "agents")) {
      result.copiedAgents += copyMarkdownFiles(dir, destAgents, leafPrefix(workspaceRoot, dir));
    }

    for (const ext of opts.extensions ?? []) {
      for (const sub of kExtensionSkillSubs) {
        const skillsRoot = path.join(ext.extensionPath, sub);
        if (!isDir(skillsRoot)) continue;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const skillDir = path.join(skillsRoot, e.name);
          if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) continue;
          if (copySkillDir(skillDir, destSkills)) result.copiedSkills += 1;
        }
      }
      const prefix = (ext.id ?? path.basename(ext.extensionPath)).replace(/[^\w.-]+/g, "-");
      for (const leaf of ["rules", "commands", "agents"] as const) {
        const dest =
          leaf === "rules" ? destRules : leaf === "commands" ? destCommands : destAgents;
        for (const sub of kExtensionMdLeafSubs[leaf]) {
          const srcDir = path.join(ext.extensionPath, sub);
          if (!isDir(srcDir)) continue;
          const n = copyMarkdownFiles(srcDir, dest, `ext-${prefix}`);
          if (leaf === "rules") result.copiedRules += n;
          else if (leaf === "commands") result.copiedCommands += n;
          else result.copiedAgents += n;
        }
      }
    }

    result.wroteDsbMd = seedDsbMd(workspaceRoot, dsbRoot);
  } catch {
    // fail-open
  }

  return result;
}
