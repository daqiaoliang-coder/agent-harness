// 架构参考:的 Tool 接口(name/description/inputSchema + checkPermissions + execute)
import { ToolResult } from "../types";
import { ToolSchema } from "../context/cacheBoundary";
import { StaticCheckResult } from "../permissions/staticChecks";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  // 工具自身静态权限检查(瀑布第②层): 返回 null = 无意见
  checkPermissions(input: Record<string, unknown>): StaticCheckResult;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toSchemas(): ToolSchema[] {
    // 顺序稳定(注册序) → cache 前缀字节稳定
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
