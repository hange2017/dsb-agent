export type McpTransportSpec =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "streamable-http"; url: string; headers?: Record<string, string> };
export interface McpServerConfig { name: string; spec: McpTransportSpec; enabled: boolean; trusted: boolean; }
export interface McpToolInfo { name: string; description?: string; inputSchema: unknown; }
