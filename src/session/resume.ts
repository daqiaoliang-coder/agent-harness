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

// ── 崩溃一致性修复 ──
// transcript 为逐条追加(append-only): 进程在工具执行中崩溃 → 尾部出现"有 tool_use 无配对
// tool_result"的半轮 → 消息树对 API 无效(400), 会话永久打不开。修复:
//   · 孤儿 tool_use → 补一条 error tool_result 入树并持久化(幂等: 修复后再 load 无孤儿)
//   · 孤儿 tool_result(assistant 行损坏被跳过导致) → 从内存树剔除该块(不改写既有行)
export interface RepairReport {
  filledUses: number; // 补齐的孤儿 tool_use 数
  droppedResults: number; // 剔除的孤儿 tool_result 数
}

export function repairTranscript(filePath: string, messages: Message[]): { messages: Message[]; report: RepairReport } {
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.add(b.id);
      else if (b.type === "tool_result") resultIds.add(b.tool_use_id);
    }
  }
  const orphanUses = [...useIds].filter((id) => !resultIds.has(id));
  const orphanResults = new Set([...resultIds].filter((id) => !useIds.has(id)));

  let repaired = messages;
  if (orphanResults.size > 0) {
    repaired = repaired
      .map((m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result" && orphanResults.has(b.tool_use_id))
          ? {
              ...m,
              content: m.content.filter(
                (b) => !(b.type === "tool_result" && orphanResults.has(b.tool_use_id))
              ),
            }
          : m
      )
      .filter((m) => m.content.length > 0); // 剔空(纯孤儿 tool_result 的 user 消息)
  }

  if (orphanUses.length > 0) {
    const fix: Message = {
      role: "user",
      content: orphanUses.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[crash recovery] 上轮工具执行中进程中断, 结果未落盘; 已补齐占位 error 结果以保持消息树有效。",
        is_error: true,
      })),
    };
    repaired = [...repaired, fix];
    // 持久化到 transcript: 后续 resume 不再重复修复(幂等)
    fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), role: fix.role, content: fix.content }) + "\n", "utf8");
  }

  return { messages: repaired, report: { filledUses: orphanUses.length, droppedResults: orphanResults.size } };
}
