// 架构参考:的 Tool 接口(name/description/inputSchema + checkPermissions + execute)
import { ToolResult } from "../types";
import { ToolSchema } from "../context/cacheBoundary";
import { StaticCheckResult } from "../permissions/staticChecks";

// 执行上下文: 由主循环在每次工具调用时注入
export interface ToolContext {
  // 用户中断信号(Ctrl-C / Web 停止): 长时工具(如 Bash)应在收到信号时终止并返回
  signal?: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  // 工具自身静态权限检查(瀑布第②层): 返回 null = 无意见
  checkPermissions(input: Record<string, unknown>): StaticCheckResult;
  execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
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
