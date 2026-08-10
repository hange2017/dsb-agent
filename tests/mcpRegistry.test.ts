import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpRegistry, type McpServerTools } from "../src/mcp/mcpRegistry";
import { ToolExecutor } from "../src/agent/tools/executor";
import { MemoryStore } from "../src/agent/memory/memoryStore";
import { ChatController } from "../src/chat/chatController";
import { SessionStore } from "../src/session/sessionStore";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dmcp-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * 写一个真实 stdio MCP 服务器(node 进程,经 SDK CJS build)暴露 hello 工具(list + call)。
 * 用 async IIFE 包裹,避免顶层 await + require 触发 Node 的模块格式歧义(临时目录无 package.json);
 * NODE_PATH 让 /tmp 下的子进程解析到项目 node_modules 里的 SDK(CJS require 回退)。
 */
function writeEchoServer(dir: string): void {
  const serverJs = `
    const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
    const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
    (async () => {
      const server = new Server({ name: "echo-test", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "hello", description: "say hi", inputSchema: { type: "object", properties: { who: { type: "string" } } } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const who = req.params.arguments?.who ?? "world";
        return { content: [{ type: "text", text: "hi " + who }] };
      });
      const transport = new StdioServerTransport();
      await server.connect(transport);
    })();
  `;
  fs.writeFileSync(path.join(dir, "server.js"), serverJs);
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ servers: { echo: { command: "node", args: [path.join(dir, "server.js")], env: { NODE_PATH: path.join(process.cwd(), "node_modules") } } } }),
  );
}

describe("McpRegistry", () => {
  it("parses .mcp.json stdio servers", () => {
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ servers: { echo: { command: "node", args: ["server.js"] } } }));
    const reg = new McpRegistry();
    const configs = reg.loadFromMcpJson(root);
    expect(configs).toHaveLength(1);
    expect(configs[0].spec.transport).toBe("stdio");
  });
  it("parses streamable-http servers", () => {
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ servers: { remote: { url: "https://example.com/mcp" } } }));
    const reg = new McpRegistry();
    const [cfg] = reg.loadFromMcpJson(root);
    expect(cfg.spec.transport).toBe("streamable-http");
  });
  it("no .mcp.json yields empty configs", () => {
    const reg = new McpRegistry();
    expect(reg.loadFromMcpJson(root)).toEqual([]);
  });
  it("ensureConnected refuses untrusted servers", async () => {
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ servers: { echo: { command: "node", args: ["server.js"] } } }));
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    expect(reg.configs[0].trusted).toBe(false);
    expect(await reg.ensureConnected("echo")).toBe(false);
    expect(reg.connectedCount()).toBe(0);
  });

  it("connectAll trusts enabled servers then connects", async () => {
    writeEchoServer(root);
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    await reg.connectAll();
    expect(reg.configs[0].trusted).toBe(true);
    expect(reg.connectedCount()).toBe(1);
  });

  it("disabled servers are skipped by listEnabled and ensureConnected", async () => {
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({ servers: { echo: { command: "node", args: ["server.js"], enabled: false } } }),
    );
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    expect(reg.listEnabled()).toHaveLength(0);
    expect(await reg.ensureConnected("echo")).toBe(false);
  });

  it("callTool rejects untrusted servers", async () => {
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ servers: { echo: { command: "node", args: ["server.js"] } } }));
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    await expect(reg.callTool("echo", "hello", {})).rejects.toThrow(/not trusted|not connected/i);
  });

  it("connectAll connects a stdio server and replays its tools to late subscribers", async () => {
    writeEchoServer(root);
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    const early: string[] = [];
    reg.onTools((tools) => tools.forEach((t) => early.push(`${t.serverName}:${t.name}`)));
    await reg.connectAll();
    expect(early).toContain("echo:hello");
    const late: string[] = [];
    reg.onTools((tools) => tools.forEach((t) => late.push(`${t.serverName}:${t.name}`)));
    expect(late).toContain("echo:hello");
  });
});

describe("MCP executor bridge", () => {
  class StubMcpRegistry {
    private cb: ((tools: McpServerTools[]) => void) | undefined;
    constructor(private readonly knownServer = "calc") {}
    onTools(cb: (tools: McpServerTools[]) => void): void {
      this.cb = cb;
    }
    push(tools: McpServerTools[]): void {
      this.cb?.(tools);
    }
    // 与真实 McpRegistry 一致:未知服务器不可连接(executeMcp 的防御补连会拦截)
    async ensureConnected(serverName: string): Promise<boolean> {
      return serverName === this.knownServer;
    }
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<Array<{ type: string; text?: string }>> {
      return [{ type: "text", text: `${serverName}:${toolName}:${JSON.stringify(args)}` }];
    }
  }

  it("allToolDefs merges mcp__ tools advertised by the registry", () => {
    const stub = new StubMcpRegistry();
    const exec = new ToolExecutor(
      new MemoryStore(path.join(root, ".mem")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      stub as unknown as McpRegistry,
    );
    stub.push([{ name: "add", description: "sum", input_schema: { type: "object" }, serverName: "calc" }]);
    const defs = exec.allToolDefs();
    expect(defs.map((d) => d.name)).toContain("mcp__calc__add");
    const def = defs.find((d) => d.name === "mcp__calc__add");
    expect(def?.description).toContain("[MCP calc]");
  });

  it("execute routes mcp__<server>__<tool> through the registry", async () => {
    const stub = new StubMcpRegistry();
    const exec = new ToolExecutor(
      new MemoryStore(path.join(root, ".mem")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      stub as unknown as McpRegistry,
    );
    const r = await exec.execute("mcp__calc__add", { a: 1, b: 2 }, { workspaceRoot: root });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('calc:add:{"a":1,"b":2}');
  });

  it("execute reports error when the target server is not connectable", async () => {
    const stub = new StubMcpRegistry();
    const exec = new ToolExecutor(
      new MemoryStore(path.join(root, ".mem")),
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      stub as unknown as McpRegistry,
    );
    const r = await exec.execute("mcp__missing__tool", {}, { workspaceRoot: root });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("MCP server not connected");
  });

  it("mcp__ tools are unknown when no registry is wired", async () => {
    const exec = new ToolExecutor(new MemoryStore(path.join(root, ".mem")));
    const r = await exec.execute("mcp__calc__add", {}, { workspaceRoot: root });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("MCP not configured");
  });

  it("untrusted mcp__ call does not spawn and fails", async () => {
    writeEchoServer(root);
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    expect(reg.connectedCount()).toBe(0);
    const exec = new ToolExecutor(new MemoryStore(path.join(root, ".mem")), undefined, undefined, undefined, 0, undefined, reg);
    const r = await exec.execute("mcp__echo__hello", { who: "tester" }, { workspaceRoot: root });
    expect(r.ok).toBe(false);
    expect(reg.connectedCount()).toBe(0);
  });

  it("trusted but unconnected mcp__ call defensively connects before calling the tool", async () => {
    writeEchoServer(root);
    // 在 json 中标记 trusted,模拟用户曾确认信任后尚未 spawn
    const mcpPath = path.join(root, ".mcp.json");
    const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { servers: Record<string, Record<string, unknown>> };
    parsed.servers.echo.trusted = true;
    fs.writeFileSync(mcpPath, JSON.stringify(parsed));
    const reg = new McpRegistry();
    reg.loadFromMcpJson(root);
    expect(reg.configs[0].trusted).toBe(true);
    expect(reg.connectedCount()).toBe(0);
    const exec = new ToolExecutor(new MemoryStore(path.join(root, ".mem")), undefined, undefined, undefined, 0, undefined, reg);
    const r = await exec.execute("mcp__echo__hello", { who: "tester" }, { workspaceRoot: root });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hi tester");
    expect(reg.connectedCount()).toBe(1);
  });
});

describe("ChatController lazy MCP connect", () => {
  function makeController(reg: McpRegistry) {
    const deps = {
      apiKeyStore: { getApiKey: async () => "sk-test", setApiKey: async () => {} },
      configuration: { baseUrl: () => "https://api.deepseek.com/anthropic", model: () => "m" },
      getWorkspaceCwd: () => root,
      sessionStore: new SessionStore(path.join(root, ".sessions")),
      createSession: () => ({ send: async () => {}, cancel: () => {} }),
      memory: new MemoryStore(path.join(root, ".mem")),
      mcp: reg,
    };
    return new ChatController(deps as never, () => {});
  }

  it("panel init loads config but does not spawn any MCP server", async () => {
    writeEchoServer(root);
    const reg = new McpRegistry();
    const controller = makeController(reg);
    await controller.handle({ type: "ready" } as never);
    expect(reg.configs).toHaveLength(1); // 配置已解析
    expect(reg.connectedCount()).toBe(0); // 但未 spawn
  });

  it("explicit mcpConnect connects servers and advertises tools to executors", async () => {
    writeEchoServer(root);
    const reg = new McpRegistry();
    const controller = makeController(reg);
    await controller.handle({ type: "ready" } as never);
    expect(reg.connectedCount()).toBe(0);

    const n = await controller.mcpConnect();
    expect(n).toBe(1);
    expect(reg.connectedCount()).toBe(1);

    // 之后新建的 executor(晚订阅)经重放拿到 MCP 工具定义
    const exec = new ToolExecutor(new MemoryStore(path.join(root, ".mem")), undefined, undefined, undefined, 0, undefined, reg);
    expect(exec.allToolDefs().map((d) => d.name)).toContain("mcp__echo__hello");
  });
});
