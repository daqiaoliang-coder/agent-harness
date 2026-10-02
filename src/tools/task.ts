// 架构参考: Task 工具 — 派发子代理在独立上下文中完成任务, 只回传最终报告
// (父上下文省 token 的核心机制; 子代理工具集与防嵌套见 agent/subagent.ts)
import { ToolResult } from "../types";
import { Tool, ToolContext } from "./tool";

// signal: 父级中断信号 → 透传给子代理主循环(中断传播)
export type SpawnAgent = (prompt: string, maxTurns?: number, signal?: AbortSignal) => Promise<string>;

const MAX_SUB_TURNS = 50; // 子代理轮次上界(防失控; 原为 Math.min 内联, 现显式报错)

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
    // max_turns: 调度层 validator 已保证 number; 此处直调保险 + 越界报错而非 clamp
    // (负数曾静默变成 0 轮 → 子代理抛困惑的"超过最大轮次守卫(-5 轮)")
    const rawMaxTurns = input.max_turns;
    if (rawMaxTurns !== undefined && rawMaxTurns !== null) {
      const n = Number(rawMaxTurns);
      if (!Number.isInteger(n) || n < 1 || n > MAX_SUB_TURNS) {
        return {
          content: `参数错误: max_turns 须为 1-${MAX_SUB_TURNS} 的整数(收到 ${JSON.stringify(rawMaxTurns)})`,
          isError: true,
        };
      }
    }
    const maxTurns = rawMaxTurns !== undefined && rawMaxTurns !== null ? Number(rawMaxTurns) : 12;
    try {
      const report = await this.spawnAgent(prompt, maxTurns, ctx?.signal);
      return { content: report };
    } catch (e) {
      return { content: `子代理失败: ${(e as Error).message}`, isError: true };
    }
  }
}
