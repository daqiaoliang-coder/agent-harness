// MCP 组装: 连接 settings 中的所有 mcpServers, 拉取工具列表并包装注册
// 单个 server 失败 → 警告降级(不影响其余 server 与内置工具); stop() 统一回收子进程
import { Tool } from "../tools/tool";
import { McpClient, McpServerConfig } from "./client";
import { McpTool } from "./mcpTool";

export interface McpManager {
  tools: Tool[]; // 包装后的 mcp__<server>__<tool> 列表
  stop: () => void;
}

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  log: (line: string) => void
): Promise<McpManager> {
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    const client = new McpClient(name, cfg, log);
    try {
      await client.start();
      const defs = await client.listTools();
      for (const def of defs) tools.push(new McpTool(client, name, def));
      log(`[mcp:${name}] 注册 ${defs.length} 个工具: ${defs.map((d) => `mcp__${name}__${d.name}`).join(", ")}`);
      clients.push(client);
    } catch (e) {
      log(`[mcp:${name}] 连接失败(降级跳过): ${(e as Error).message}`);
      client.stop();
    }
  }
  return {
    tools,
    stop: () => clients.forEach((c) => c.stop()),
  };
}
