// 架构参考:为完整 Anthropic API 消息格式; 此处最小化保留 user/assistant + tool_use/tool_result 块
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export type Role = "user" | "assistant";
export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type PermissionDecision = "allow" | "deny" | "ask";

// 用户中断(Ctrl-C / Web 停止按钮): 贯穿 provider → 工具 → 主循环的统一信号
// 区别于普通错误: 捕获方需保证消息树/transcript 一致性后优雅收尾, 不算故障
export class RunAbortedError extends Error {
  constructor(reason = "用户中断") {
    super(reason);
    this.name = "RunAbortedError";
  }
}
