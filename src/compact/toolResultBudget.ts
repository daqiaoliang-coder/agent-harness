// 对照: T0 工具结果预算层 — 单个工具结果超过预算 → 全量落盘 + 预览注入
// 关键: 替换串冻结(字节级一致) — 一旦替换, 后续轮次产生相同字节, 不破坏 prompt cache
import * as fs from "fs";
import * as path from "path";
import { Message } from "../types";
import { estimateTokens } from "../context/tokenEstimator";
import { CompactConfig } from "./watermarks";

const FROZEN_PREFIX = "[Tool result exceeded";

export interface BudgetResult {
  messages: Message[];
  budgeted: number; // 本次新落盘的结果数
  archivedFiles: string[]; // 落盘文件路径(供 T4 恢复预算引用)
}

export function enforceToolResultBudget(
  messages: Message[],
  cfg: CompactConfig,
  artifactsDir: string
): BudgetResult {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const archivedFiles: string[] = [];
  let budgeted = 0;

  const out = messages.map((m) => {
    if (m.role !== "user") return m;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      // 冻结检测: 已替换过的结果字节级一致, 跳过(cache 稳定的关键)
      if (b.content.startsWith(FROZEN_PREFIX)) return b;
      if (estimateTokens(b.content) <= cfg.toolResultBudget) return b;
      budgeted++;
      const file = path.join(artifactsDir, `toolresult-${b.tool_use_id}.txt`);
      fs.writeFileSync(file, b.content, "utf8");
      archivedFiles.push(file);
      const preview = b.content.slice(0, 400);
      const frozen = `${FROZEN_PREFIX} ${cfg.toolResultBudget} tokens. Full output saved to: ${file}. Preview (first 400 chars):\n${preview}]`;
      return { ...b, content: frozen } as typeof b;
    });
    return { ...m, content };
  });

  return { messages: out, budgeted, archivedFiles };
}
