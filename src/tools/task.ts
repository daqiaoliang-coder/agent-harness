// 架构参考: Task 工具 — 派发子代理在独立上下文中完成任务, 只回传最终报告
// (父上下文省 token 的核心机制; 子代理工具集与防嵌套见 agent/subagent.ts)
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";

// signal: 父级中断信号 → 透传给子代理主循环(中断传播)
export type SpawnAgent = (prompt: string, maxTurns?: number, signal?: AbortSignal) => Promise<string>;

export class TaskTool implements Tool {
  readonly name = "Task";
  readonly description =
    "派发只读子代理(explore 型)在独立上下文中探索代码/搜索资料, 返回最终报告。适合并行调查类任务; 子代理不可写文件/执行命令/反问用户。";
  readonly inputSchema = {
    type: "object",
    properties: {
      description: { type: "string", description: "任务简述(一句话)" },
      prompt: { type: "string", description: "给子代理的完整任务指令" },
      max_turns: { type: "number", description: "子代理最大轮次(默认 12)" },
    },
    required: ["description", "prompt"],
  };

  constructor(private spawnAgent: SpawnAgent) {}

  checkPermissions() {
    // 子代理工具集全只读(Read/Glob/Grep) → 静态放行; 防嵌套由子注册表不注册 Task 保证
    return { decision: "allow" as const, reason: "Task 派发只读子代理" };
  }

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const prompt = String(input.prompt ?? "");
    if (!prompt) return { content: "参数错误: 需要 prompt(给子代理的完整任务指令)", isError: true };
    const maxTurns = Math.min(Number(input.max_turns ?? 12) || 12, 50);
    try {
      const report = await this.spawnAgent(prompt, maxTurns, ctx?.signal);
      return { content: report };
    } catch (e) {
      return { content: `子代理失败: ${(e as Error).message}`, isError: true };
    }
  }
}
