// 架构参考:将 MCP server 工具包装为 mcp__<server>__<tool> 注入工具注册表
import { ToolResult } from "../types";
import { Tool } from "../tools/tool";
import { McpClient, McpToolDef } from "./client";

export class McpTool implements Tool {
  readonly name: string; // mcp__<server>__<tool>(参考原版架构命名约定)
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  constructor(private client: McpClient, serverName: string, def: McpToolDef) {
    this.name = `mcp__${serverName}__${def.name}`;
    this.description = `[MCP:${serverName}] ${def.description ?? def.name}`;
    this.inputSchema = def.inputSchema ?? { type: "object", properties: {} };
  }

  checkPermissions() {
    // 外部工具无法静态判定副作用 → 走瀑布(默认弹窗; 可用 allow 规则 mcp__<server>__<tool> 放行)
    return { decision: null };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.client.callTool(this.name.split("__")[2]!, input);
    return { content: r.text, isError: r.isError || undefined };
  }
}
