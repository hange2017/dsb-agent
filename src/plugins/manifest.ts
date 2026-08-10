import * as fs from "fs";
import * as path from "path";
import type { MarketplaceManifest, PluginContent, PluginManifest } from "./types";
import { parsePluginToolsFromManifest } from "./pluginTools";

function requireObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Invalid JSON in ${file}`);
  return parsed as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) throw new Error(`${file}: missing required "${key}"`);
  return v;
}

/** 插件 source 归一为字符串:字符串原样;对象按 url/repo 提取(兼容常见市场清单
 * `{source:"url",url}` / `{source:"github",repo}`),否则回退 JSON 字符串(install 报 unsupported)。 */
function normalizePluginSource(o: unknown): string {
  if (typeof o === "string") return o;
  if (o !== null && typeof o === "object") {
    const s = o as Record<string, unknown>;
    if (typeof s.url === "string") return s.url;
    if (typeof s.repo === "string") return s.repo;
  }
  return JSON.stringify(o);
}

function loadManifestObject(dir: string): { file: string; obj: Record<string, unknown> } {
  const file = path.join(dir, "plugin.json");
  const claudeFile = path.join(dir, ".claude-plugin", "plugin.json");
  const manifestFile = fs.existsSync(claudeFile) ? claudeFile : file;
  return { file: manifestFile, obj: requireObject(manifestFile) };
}

export function parsePluginManifest(dir: string): PluginManifest {
  const { file: manifestFile, obj } = loadManifestObject(dir);
  return {
    name: requiredString(obj, "name", manifestFile),
    description: requiredString(obj, "description", manifestFile),
    version: requiredString(obj, "version", manifestFile),
    author: obj.author as PluginManifest["author"],
    repository: typeof obj.repository === "string" ? obj.repository : undefined,
  };
}

export function parseMarketplaceManifest(file: string): MarketplaceManifest {
  const obj = requireObject(file);
  const pluginsRaw = obj.plugins;
  if (!Array.isArray(pluginsRaw)) throw new Error(`${file}: missing required "plugins" array`);
  const plugins = pluginsRaw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`${file}: plugins[${i}] invalid`);
    const o = p as Record<string, unknown>;
    return {
      name: requiredString(o, "name", file),
      description: requiredString(o, "description", file),
      version: typeof o.version === "string" ? o.version : undefined,
      source: normalizePluginSource(o.source),
      author: o.author as MarketplaceManifest["plugins"][number]["author"],
      repository: typeof o.repository === "string" ? o.repository : undefined,
    };
  });
  return {
    name: requiredString(obj, "name", file),
    description: typeof obj.description === "string" ? obj.description : undefined,
    owner: obj.owner as MarketplaceManifest["owner"],
    plugins,
  };
}

export function scanPluginContent(pluginDir: string): PluginContent {
  const skills = readSkillPaths(pluginDir);
  const agents = readMdPaths(path.join(pluginDir, ".agents"));
  const commands = readMdPaths(path.join(pluginDir, "commands"));
  const hooks = readHooks(path.join(pluginDir, "hooks"));
  let tools: PluginContent["tools"] = [];
  try {
    const { obj } = loadManifestObject(pluginDir);
    const pluginName = typeof obj.name === "string" ? obj.name : path.basename(pluginDir);
    tools = parsePluginToolsFromManifest(pluginDir, pluginName, obj.tools);
  } catch {
    tools = [];
  }
  return { skills, agents, commands, hooks, tools };
}

function readSkillPaths(root: string): string[] {
  const skillsDir = path.join(root, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => `skills/${e.name}/SKILL.md`);
}

function readMdPaths(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

const HOOK_EVENT_BY_PREFIX: Record<string, string> = {
  pretooluse: "PreToolUse",
  posttooluse: "PostToolUse",
  stop: "Stop",
  sessionstart: "SessionStart",
};

function readHooks(dir: string): PluginContent["hooks"] {
  if (!fs.existsSync(dir)) return [];
  const hooks: PluginContent["hooks"] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".sh")) continue;
    const lower = f.toLowerCase();
    for (const [prefix, event] of Object.entries(HOOK_EVENT_BY_PREFIX)) {
      if (lower.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const matcher = rest.replace(/^_/, "").replace(/\.sh$/, "") || "Bash|Write|Edit";
        hooks.push({ event, matcher, command: `bash "${path.join(dir, f)}"` });
        break;
      }
    }
  }
  return hooks;
}
