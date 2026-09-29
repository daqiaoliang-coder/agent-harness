// 对照: T4 autocompact — effectiveWindow−13K 触发, fork 压缩子 Agent(继承 cache 前缀:
// system+tools 不变 → prefixKey 不变 → 服务端 KV cache 复用)
// 九段式摘要 + <analysis>草稿/<summary>双块(注入时剥 analysis) + 摘要上限 + 压缩后恢复预算
// 递归守卫(querySource==='compact' 不再触发)与熔断(连续失败 3 次)在 query.ts 主循环中实现
import * as fs from "fs";
import { Message } from "../types";
import { estimateTokens } from "../context/tokenEstimator";
import { LLMProvider } from "../llm/provider";
import { sideQuery } from "../sidequery/sideQuery";
import { CompactConfig } from "./watermarks";

// 九段式摘要模板(架构参考的 summary prompt 结构)
const AUTOCOMPACT_SYSTEM = `[[AUTOCOMPACT]] 你是压缩子 Agent。将整个对话压缩为结构化摘要。
先在 <analysis> 标签内写草稿(梳理哪些信息重要), 再在 <summary> 标签内输出最终摘要。
<summary> 必须包含以下九段:
1. Primary Request and Intent(请求意图)
2. Technical Concepts(技术概念)
3. Files and Code Sections(涉及的文件与代码)
4. Errors and fixes(错误与修复)
5. Problem Solving(已解决的问题与思路)
6. All user messages(用户消息逐字保留)
7. Pending Tasks(待办)
8. Current Work(进行中)
9. Optional Next Step(下一步)`;

export interface AutoCompactResult {
  messages: Message[]; // 压缩后的新历史
  summaryTokens: number;
  restoredFiles: string[];
  analysisStripped: boolean;
}

export async function autoCompact(
  provider: LLMProvider,
  messages: Message[],
  cfg: CompactConfig,
  archivedFiles: string[], // T0/T2 落盘的文件(恢复预算候选)
  log: (line: string) => void
): Promise<AutoCompactResult> {
  // 压缩子 Agent 看到完整本地历史(非 API 视图), 继承相同 system+tools(cache 前缀复用)
  const raw = await sideQuery(
    provider,
    [AUTOCOMPACT_SYSTEM],
    [{ role: "user", content: [{ type: "text", text: JSON.stringify(messages) }] }],
    { maxTokens: cfg.summaryTokenCap, log }
  );

  // 双块解析: 注入时剥 <analysis> 草稿, 只保留 <summary>
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  let summary = summaryMatch ? summaryMatch[1].trim() : raw.trim();
  const analysisStripped = summaryMatch !== null && /<analysis>/.test(raw);

  // 摘要上限(生产 20K; 生产中由模型重写控制, 此处截断)
  if (estimateTokens(summary) > cfg.summaryTokenCap) {
    summary = summary.slice(0, cfg.summaryTokenCap * 4);
    log(`[compact] T4 autocompact: 摘要超上限, 截断至 ${cfg.summaryTokenCap} tokens`);
  }

  // 压缩后恢复预算: 重读关键文件(≤5 个 × 每文件预算, 总预算封顶)
  const restoredFiles: string[] = [];
  let restoredTokens = 0;
  for (const file of archivedFiles.slice(0, cfg.restoreFileCap)) {
    if (!fs.existsSync(file)) continue;
    if (restoredFiles.length >= cfg.restoreFileCap) break;
    const budget = Math.min(cfg.restoreFileBudget, cfg.restoreBudget - restoredTokens);
    if (budget <= 0) break;
    const content = fs.readFileSync(file, "utf8").slice(0, budget * 4);
    restoredTokens += estimateTokens(content);
    restoredFiles.push(file);
  }

  // 新历史: 单条 user 消息 = 摘要 + 恢复的文件内容
  const parts: string[] = [`[compact summary]\n${summary}`];
  for (const f of restoredFiles) {
    parts.push(
      `\n[restored file: ${f}]\n${fs.readFileSync(f, "utf8").slice(0, cfg.restoreFileBudget * 4)}`
    );
  }
  const newMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: parts.join("\n") }] },
  ];

  log(
    `[compact] T4 autocompact: 完成 — 摘要 ${estimateTokens(summary)} tokens` +
      `(analysis 已剥离: ${analysisStripped}), 恢复 ${restoredFiles.length} 个文件` +
      `(${restoredTokens} tokens / 预算 ${cfg.restoreBudget})`
  );
  return { messages: newMessages, summaryTokens: estimateTokens(summary), restoredFiles, analysisStripped };
}
