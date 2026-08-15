import * as fs from "fs";
import * as path from "path";
import { McpClient } from "./mcpClient";
import type { McpServerConfig, McpToolInfo } from "./types";

/** 单个服务器上报的工具集:onTools 回调负载。 */
export interface McpServerTools {
  name: string;
  description?: string;
  input_schema: unknown;
  serverName: string;
}

export class McpRegistry {
  private readonly platform: NodeJS.Platform;
  constructor(platform?: NodeJS.Platform) {
    this.platform = platform ?? process.platform;
  }

  private clients = new Map<string, McpClient>();
  private toolsCbs: Array<(tools: McpServerTools[]) => void> = [];
  /** 已连接服务器上报过的工具集,供后续订阅者重放。executor 按会话惰性创建,
   * 订阅往往晚于首次 connectAll;不重放的话,首个会话之后的 executor 将拿不到 MCP 工具。 */
  private knownTools: McpServerTools[][] = [];
  configs: McpServerConfig[] = [];

  loadFromMcpJson(workspaceRoot: string): McpServerConfig[] {
    const file = path.join(workspaceRoot, ".mcp.json");
    if (!fs.existsSync(file)) {
      this.configs = [];
      return this.configs;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { servers?: Record<string, unknown> };
    const servers = parsed.servers ?? {};
    this.configs = Object.entries(servers).map(([name, raw]) => {
      const r = raw as Record<string, unknown>;
      const enabled = r.enabled !== false;
      const platforms = parsePlatforms(r.platforms);
      const trusted = r.trusted === true;
      if (typeof r.command === "string") {
        return {
          name,
          spec: { transport: "stdio", command: r.command, args: asStrArr(r.args), env: r.env as Record<string, string> | undefined },
          enabled,
          trusted,
          platforms,
        };
      }
      if (typeof r.url === "string") {
        return {
          name,
          spec: { transport: "streamable-http", url: r.url, headers: r.headers as Record<string, string> | undefined },
          enabled,
          trusted,
          platforms,
        };
      }
      throw new Error(`Invalid MCP server config for ${name}`);
    });
    return this.configs;
  }

  listEnabled(): McpServerConfig[] {
    return this.configs.filter(
      (c) => c.enabled && (!c.platforms || c.platforms.length === 0 || c.platforms.includes(this.platform)),
    );
  }

  /** 将启用中的服务器标为已信任(用户显式 mcpConnect opt-in)。 */
  trustEnabled(): void {
    for (const cfg of this.listEnabled()) cfg.trusted = true;
  }

  onTools(cb: (tools: McpServerTools[]) => void): void {
    this.toolsCbs.push(cb);
    // 重放已连接服务器的工具集:connectAll 后订阅的调用方(每个会话新建的 executor)也能拿到
    for (const tools of this.knownTools) cb(tools);
  }

  /** 显式连接全部启用服务器(用户 opt-in);先信任再断开重连,单服务器失败不影响其他。 */
  async connectAll(): Promise<void> {
    this.trustEnabled();
    await this.disconnectAll();
    for (const cfg of this.listEnabled()) {
      await this.ensureConnected(cfg.name);
    }
  }

  /**
   * 惰性补连单个服务器:已连接则 true;未连接则要求 enabled+trusted 后 spawn。
   * 未信任 / 未启用返回 false(不 spawn)。失败返回 false。
   */
  async ensureConnected(serverName: string): Promise<boolean> {
    if (this.clients.has(serverName)) return true;
    const cfg = this.configs.find((c) => c.name === serverName);
    if (!cfg || !cfg.enabled || !cfg.trusted) return false;
    if (cfg.platforms && cfg.platforms.length > 0 && !cfg.platforms.includes(this.platform)) return false;
    try {
      const client = new McpClient(cfg.name);
      await client.connect(cfg.spec);
      const tools = await client.listTools();
      this.clients.set(cfg.name, client);
      const serverTools = tools.map((t: McpToolInfo) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        serverName: cfg.name,
      }));
      this.knownTools.push(serverTools);
      for (const cb of this.toolsCbs) cb(serverTools);
      return true;
    } catch (err) {
      console.warn(`MCP server ${cfg.name} failed:`, err);
      return false;
    }
  }

  connectedCount(): number {
    return this.clients.size;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<Array<{ type: string; text?: string }>> {
    const cfg = this.configs.find((c) => c.name === serverName);
    if (cfg && (!cfg.enabled || !cfg.trusted)) {
      throw new Error(`MCP server not trusted: ${serverName}`);
    }
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server not connected: ${serverName}`);
    return client.callTool(toolName, args);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
    this.knownTools = [];
  }
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(["win32", "linux", "darwin", "freebsd", "openbsd", "sunos", "aix", "android", "cygwin", "netbsd", "haiku"]);
function parsePlatforms(raw: unknown): NodeJS.Platform[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is NodeJS.Platform => typeof x === "string" && KNOWN_PLATFORMS.has(x));
  return out.length > 0 ? out : undefined;
}

function asStrArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}
