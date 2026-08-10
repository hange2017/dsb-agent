import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpTransportSpec } from "./types";

export interface McpToolInfo { name: string; description?: string; inputSchema: unknown; }

export class McpClient {
  private client: Client | undefined;
  private transport: unknown;

  constructor(private readonly serverName: string) {}

  async connect(spec: McpTransportSpec): Promise<void> {
    this.client = new Client({ name: "dsb-agent", version: "0.1.0" });
    this.transport =
      spec.transport === "stdio"
        ? new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: spec.env })
        // SDK v1.30 起 headers 收进 requestInit,不再作为顶层选项
        : new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: spec.headers ? { headers: spec.headers } : undefined });
    await this.client.connect(this.transport as never);
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) return [];
    const res = await this.client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<Array<{ type: string; text?: string }>> {
    if (!this.client) throw new Error("MCP client not connected");
    const res = await this.client.callTool({ name: toolName, arguments: args });
    return Array.isArray(res.content) ? (res.content as Array<{ type: string; text?: string }>) : [{ type: "text", text: JSON.stringify(res.content) }];
  }

  async disconnect(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = undefined;
    }
  }
}
