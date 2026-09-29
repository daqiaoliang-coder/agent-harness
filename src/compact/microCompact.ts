// 对照: T1 microCompact — 清除"旧"工具结果(Read/Bash/Grep 类), 保留最近 keepRecent 条消息
// 关键: 压缩在 API 层完成 — 本地消息树不变(返回新数组, 原始 messages 不被修改)
import { Message } from "../types";
import { CompactConfig } from "./watermarks";

const CLEARED = "[Old tool result content cleared]";
const SNIP_PREFIX = "[SNIP: archived to"; // T2 已归档的不再清除(保留归档标记)

export interface MicroCompactResult {
  messages: Message[];
  cleared: number; // 视图中被清除的总数(每轮重建视图会重复计入)
  clearedIds: string[]; // 被清除的 tool_use_id(调用方用于去重遥测)
}

export function applyMicroCompact(messages: Message[], cfg: CompactConfig): MicroCompactResult {
  const cutoff = messages.length - cfg.microCompactKeepRecent;
  let cleared = 0;
  const clearedIds: string[] = [];

  const out = messages.map((m, i) => {
    if (i < cutoff && m.role === "user") {
      const content = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        if (b.content === CLEARED || b.content.startsWith(SNIP_PREFIX)) return b; // 已处理 → 字节稳定
        cleared++;
        clearedIds.push(b.tool_use_id);
        return { ...b, content: CLEARED } as typeof b;
      });
      return { ...m, content };
    }
    return m;
  });

  return { messages: out, cleared, clearedIds };
}
