export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  author?: { name: string; email?: string };
  repository?: string;
}

export interface MarketplacePluginRef {
  name: string;
  description: string;
  version?: string;
  source: string; // "./path" | "owner/repo" | "https://..." | "npm:pkg" | { ... }
  author?: { name: string; email?: string };
  repository?: string;
}

export interface MarketplaceManifest {
  name: string;
  description?: string;
  owner?: { name: string; email?: string };
  plugins: MarketplacePluginRef[];
}

export interface PluginContent {
  skills: string[];
  agents: string[];
  commands: string[];
  hooks: Array<{ event: string; matcher: string; command: string }>;
  /** 插件声明的 shell 工具(已解析绝对 commandPath)。 */
  tools: PluginToolSpec[];
}

/** 插件字面工具规格(manifest tools[] → 运行时)。 */
export type PluginToolSpec = {
  pluginName: string;
  pluginDir: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 绝对路径可执行命令(已通过插件目录护栏)。 */
  commandPath: string;
  /** 可选:仅在这些平台上接口对外推送;缺省 = 全平台。 */
  platforms?: NodeJS.Platform[];
};
