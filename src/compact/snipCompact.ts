// 对照: T2 snip — 无 LLM 的原位归档: buffer 超过 snipTarget + autoCompactThreshold 时,
// LRU 归档最老消息(仅工具交换对, 用户文本不动), 原位换 marker, 内容落盘
import * as fs from "fs";
import * as path from "path";
import { Message } from "../types";
import { estimateTokens } from "../context/tokenEstimator";
import { CompactConfig } from "./watermarks";

const SNIP_PREFIX = "[SNIP: archived to";

export interface SnipResult {
  messages: Message[];
  archived: number;
  tokensSaved: number; // 本地树口径(与请求视图口径可能不同, 遥测以查询侧重算为准)
  files: string[];
}

export function snipCompact(
  messages: Message[],
  bufferTokens: number,
  cfg: CompactConfig,
  artifactsDir: string
): SnipResult {
  const threshold = cfg.snipTarget + cfg.autoCompactThreshold;
  if (bufferTokens <= threshold) {
    return { messages, archived: 0, tokensSaved: 0, files: [] };
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const out = messages.slice();
  const files: string[] = [];
  let archived = 0;
  let tokensSaved = 0;

  // 差异化价值: T1 不敢动最近 keepRecent 条内的结果, T2 敢(T0 落盘后仍占预算的"楔入"结果)
  // 已被 T1 在 API 视图清除的老结果不再归档(对请求视图无收益)
  const cutoff = messages.length - cfg.microCompactKeepRecent;

  // LRU: 从最老的可见结果找未归档的工具交换对
  for (let i = cutoff; i < out.length && archived < cfg.snipBatch; i++) {
    const m = out[i];
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.content.startsWith(SNIP_PREFIX)) continue;
      const file = path.join(artifactsDir, `snip-${b.tool_use_id}.txt`);
      fs.writeFileSync(file, b.content, "utf8");
      files.push(file);
      tokensSaved += estimateTokens(b.content);
      // 原位换 marker(只替换该 tool_result; 字节冻结; 用短文件名避免 marker 本身膨胀)
      const marker = `${SNIP_PREFIX} ${path.basename(file)}]`;
      out[i] = {
        ...m,
        content: m.content.map((x) =>
          x === b ? ({ ...x, content: marker } as typeof x) : x
        ),
      };
      archived++;
      break; // 每条消息只处理一个结果
    }
  }

  return { messages: out, archived, tokensSaved, files };
}
