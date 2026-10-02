// 对照: T5 reactive compact — 413 等价错误的恢复路径:
// 只保留最后 4 条消息做全量摘要, 一次性守卫(失败直接抛给用户, 不再二次尝试)
import { Message } from "../types";
import { LLMProvider } from "../llm/provider";
import { sideQuery } from "../sidequery/sideQuery";

const REACTIVE_SYSTEM = `[[REACTIVE]] 你是紧急上下文压缩器。服务端刚拒绝了过大的请求。
对以下对话做全量摘要, 重点保留: 最近的工具调用、错误、未完成事项与用户最新意图。输出务必精炼。`;

export async function reactiveCompact(
  provider: LLMProvider,
  messages: Message[],
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<Message[]> {
  // 只保留最后 4 条消息(生产实现: lastMessages(4))
  const last4 = messages.slice(-4);
  const summary = await sideQuery(
    provider,
    [REACTIVE_SYSTEM],
    [{ role: "user", content: [{ type: "text", text: JSON.stringify(messages) }] }],
    { maxTokens: 1024, log, signal }
  );
  log(`[compact] T5 reactive: 全量摘要完成, 保留最后 ${last4.length} 条消息上下文`);
  return [
    {
      role: "user",
      content: [
        { type: "text", text: `[reactive compact summary]\n${summary}\n\n[最近消息]\n${JSON.stringify(last4)}` },
      ],
    },
  ];
}
