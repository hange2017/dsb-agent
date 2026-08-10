import * as fs from "fs";
import * as path from "path";
import { HookRunner } from "../hooks/hookRunner";
import { readProjectSettings } from "../projectContext/settingsReader";
import { PermissionRules } from "../agent/permissionRules";
import { scanSkills, scanVscodeExtensionSkills, scanPluginSkills } from "../projectContext/skillsScan";
import { SkillIndex } from "../plugins/skillIndex";
import type { PluginContent, PluginToolSpec } from "../plugins/types";
import { scanPluginContent } from "../plugins/manifest";

export interface ProjectRuntimeDeps {
  getWorkspaceCwd: () => string | undefined;
  extensions?: ReadonlyArray<{ extensionPath: string; id?: string }>;
  pluginCacheDir?: string;
  /** execFile 封装(controller 注入,沿用现有 bash -c 实现)。 */
  runHookCommand: (command: string, input: unknown) => Promise<string>;
}

export class ProjectRuntime {
  private sessionRules: PermissionRules = new PermissionRules();

  constructor(private readonly deps: ProjectRuntimeDeps) {}

  /** 从约定设置(.dsb/ 优先,.claude/ 回退)刷新项目权限规则。 */
  refreshRules(root?: string): void {
    const cwd = root ?? this.deps.getWorkspaceCwd();
    this.sessionRules = cwd ? readProjectSettings(cwd).permissionRules : new PermissionRules();
  }

  getRules(): PermissionRules {
    return this.sessionRules;
  }

  /** 已安装插件绝对目录(fail-open),供命令/代理加载复用同一份枚举。 */
  pluginDirs(): string[] {
    const out: string[] = [];
    if (!this.deps.pluginCacheDir) return out; // 未配置插件缓存,不装配(与 controller 同款 guard)
    const pluginsDir = path.join(this.deps.pluginCacheDir, "plugins");
    let markets: string[];
    try {
      if (!fs.statSync(pluginsDir).isDirectory()) return out;
      markets = fs.readdirSync(pluginsDir);
    } catch {
      return out;
    }
    for (const market of markets) {
      const marketDir = path.join(pluginsDir, market);
      let plugins: string[];
      try {
        if (!fs.statSync(marketDir).isDirectory()) continue;
        plugins = fs.readdirSync(marketDir);
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        const pluginDir = path.join(marketDir, plugin);
        try {
          if (!fs.statSync(pluginDir).isDirectory()) continue;
          out.push(pluginDir);
        } catch {
          // 单个插件目录坏条目跳过
        }
      }
    }
    return out;
  }

  /** 已安装插件内容,供注册插件 hooks(fail-open:坏条目一律跳过,绝不 throw)。 */
  pluginContents(): PluginContent[] {
    const out: PluginContent[] = [];
    for (const pluginDir of this.pluginDirs()) {
      try {
        out.push(scanPluginContent(pluginDir));
      } catch {
        // 单个插件解析失败不阻断装配
      }
    }
    return out;
  }

  /** 装配会话级 HookRunner:settings hooks 为基线,再注册插件 hooks。 */
  buildHookRunner(workspaceRoot: string): HookRunner {
    const runner = new HookRunner([...readProjectSettings(workspaceRoot).hooks], {
      run: (command: string, input: unknown) => this.deps.runHookCommand(command, input),
    });
    for (const content of this.pluginContents()) runner.addPluginHooks(content);
    return runner;
  }

  /** 当前工作区生效的 hook 规则,供 dsbAgent.hooks 命令展示。 */
  hookConfig(): Array<{ event: string; matcher: string; command: string }> {
    const cwd = this.deps.getWorkspaceCwd();
    return cwd ? this.buildHookRunner(cwd).all() : [];
  }

  /** 4 层技能合并索引(项目/用户/VSCode 扩展/插件)。 */
  getSkillIndex(): SkillIndex {
    const idx = new SkillIndex();
    const cwd = this.deps.getWorkspaceCwd();
    if (cwd) for (const info of scanSkills(cwd)) idx.add(info);
    for (const info of scanVscodeExtensionSkills(this.deps.extensions ?? [])) idx.add(info);
    if (this.deps.pluginCacheDir) for (const info of scanPluginSkills(this.deps.pluginCacheDir)) idx.add(info);
    return idx;
  }

  skillList(): Array<{ name: string; description: string }> {
    return this.getSkillIndex().listForPrompt();
  }

  /** 已安装插件声明的字面工具规格(扁平列表)。 */
  pluginToolSpecs(): PluginToolSpec[] {
    const out: PluginToolSpec[] = [];
    for (const content of this.pluginContents()) {
      out.push(...content.tools);
    }
    return out;
  }
}
