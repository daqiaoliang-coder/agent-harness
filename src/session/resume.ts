// 架构参考: --resume — 重放 transcript 消息树恢复会话
// 压缩状态(T1-T5)与水位均为消息树的派生量 → 恢复消息树后由分支①自然重建;
// readFileState(Edit 新鲜度快照)不持久化 → 恢复后需重新 Read 才能 Edit(安全默认)
import * as fs from "fs";
import { ContentBlock, Message } from "../types";

export interface TranscriptData {
  messages: Message[]; // 完整消息树(user/assistant/tool_result)
  userPrompts: string[]; // 用户输入消息(分类器盲视输入; 排除 tool_result 行)
}

export function loadTranscript(filePath: string): TranscriptData {
  const raw = fs.readFileSync(filePath, "utf8");
  const messages: Message[] = [];
  const userPrompts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: { role?: string; content?: ContentBlock[] };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 坏行跳过(append-only 日志允许个别损坏)
    }
    if ((rec.role === "user" || rec.role === "assistant") && Array.isArray(rec.content)) {
      messages.push({ role: rec.role, content: rec.content });
      // 用户输入行 = user 消息且含 text 块(纯 tool_result 行排除)
      if (rec.role === "user") {
        const texts = rec.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
        if (texts.length > 0) userPrompts.push(texts.map((t) => t.text).join("\n"));
      }
    }
  }
  return { messages, userPrompts };
}
