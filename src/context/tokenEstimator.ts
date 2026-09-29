// 架构参考:内 import { estimateTokens } — 使用真实 tokenizer;
// 此处字符启发式: 对 ASCII 系统性高估(len/4), 偏保守更安全(宁可提前压缩)
import { ContentBlock, Message } from "../types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1;
}

// 图片/文档等二进制资源固定估算值
export const IMAGE_OR_DOC_FIXED_TOKENS = 2000;

export function estimateBlockTokens(b: ContentBlock): number {
  switch (b.type) {
    case "text":
      return estimateTokens(b.text);
    case "tool_use":
      // 工具调用按序列化后的 JSON 估算
      return estimateTokens(JSON.stringify({ id: b.id, name: b.name, input: b.input }));
    case "tool_result":
      return estimateTokens(b.content) + 3;
  }
}

export function estimateMessageTokens(m: Message): number {
  // 每条消息固定开销(角色/分隔符)
  return 5 + m.content.reduce((sum, b) => sum + estimateBlockTokens(b), 0);
}

export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
